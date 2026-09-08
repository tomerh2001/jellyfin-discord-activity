import { lookup as dnsLookup } from "node:dns/promises";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import type { AppEnv } from "../env.js";

export type ValidatedUpstream = Readonly<{
  serverUrl: string;
  hostname: string;
  address: string;
  family: 4 | 6;
  operatorApproved: boolean;
}>;

const MAX_UPSTREAM_POOLS = 32;
const POOL_IDLE_MS = 30_000;
const upstreamPools = new Map<string, { agent: HttpAgent; usedAt: number }>();

function hasActiveRequests(agent: HttpAgent): boolean {
  return [...Object.values(agent.sockets), ...Object.values(agent.requests)].some((entries) => entries && entries.length > 0);
}

// Pool ownership includes the validated IP, not just the hostname: a later DNS
// answer can never borrow a socket connected under a different validated pin.
// The credentials remain request headers and are never stored on the Agent.
function upstreamAgent(target: ValidatedUpstream, url: URL): HttpAgent | false {
  const key = JSON.stringify([target.serverUrl, target.hostname, target.address, target.family, target.operatorApproved]);
  const existing = upstreamPools.get(key);
  if (existing) { existing.usedAt = Date.now(); return existing.agent; }
  if (upstreamPools.size >= MAX_UPSTREAM_POOLS) {
    const idle = [...upstreamPools].filter(([, pool]) => !hasActiveRequests(pool.agent))
      .sort((left, right) => left[1].usedAt - right[1].usedAt)[0];
    // Preserve active streams when all pools are busy. This request uses the
    // original unpooled transport instead of retaining an unbounded new pool.
    if (!idle) return false;
    idle[1].agent.destroy();
    upstreamPools.delete(idle[0]);
  }
  const Agent = url.protocol === "https:" ? HttpsAgent : HttpAgent;
  const agent = new Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 8, scheduling: "lifo", timeout: POOL_IDLE_MS });
  upstreamPools.set(key, { agent, usedAt: Date.now() });
  return agent;
}

const pruneUpstreamPools = setInterval(() => {
  for (const [key, pool] of upstreamPools) {
    if (Date.now() - pool.usedAt >= POOL_IDLE_MS && !hasActiveRequests(pool.agent)) {
      pool.agent.destroy();
      upstreamPools.delete(key);
    }
  }
}, POOL_IDLE_MS);
pruneUpstreamPools.unref();

export class UpstreamPolicyError extends Error {
  constructor(readonly code: string, readonly publicMessage: string, readonly statusCode = 400) {
    super(code);
  }
}

const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) denied.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  denied.addSubnet(address, prefix, "ipv6");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, "ipv4");
  // Reject mapped IPv4, NAT64, link-local, local, multicast and transition ranges.
  return family === 6 && globalV6.check(address, "ipv6") && !denied.check(address, "ipv6");
}

export function normalizeUpstreamUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw invalidUrl(); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash
    || value.includes("\\") || hasControlCharacters(value, true) || parsed.hostname.endsWith(".")) throw invalidUrl();
  validatePath(parsed.pathname);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

/** Resolve on each operation, reject any private answer, then pin the chosen IP.
 * The sole private/HTTP exception is the exact operator-configured base URL.
 */
export async function validateUpstream(env: AppEnv, value: string): Promise<ValidatedUpstream> {
  const serverUrl = normalizeUpstreamUrl(value);
  const operatorApproved = serverUrl === normalizeUpstreamUrl(env.JELLYFIN_DEFAULT_SERVER_URL);
  const url = new URL(serverUrl);
  if (!operatorApproved && (!env.JELLYFIN_ALLOW_CUSTOM_SERVERS || url.protocol !== "https:")) {
    throw new UpstreamPolicyError("jellyfin_server_not_allowed", "Use an allowed Jellyfin server with HTTPS.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let answers: { address: string; family: number }[];
  let dnsDeadline: NodeJS.Timeout | undefined;
  try {
    answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([
        dnsLookup(hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => {
          dnsDeadline = setTimeout(() => reject(new Error("dns_timeout")), 5000);
          dnsDeadline.unref();
        })
      ]);
  } catch { throw new UpstreamPolicyError("jellyfin_server_unreachable", "Could not resolve the Jellyfin server.", 502); }
  finally { clearTimeout(dnsDeadline); }
  if (!answers.length || answers.some((answer) => !isIP(answer.address) || (!operatorApproved && !isPublicAddress(answer.address)))) {
    throw new UpstreamPolicyError("jellyfin_server_not_allowed", "This server address is not allowed.");
  }
  const first = answers[0]!;
  return Object.freeze({ serverUrl, hostname, address: first.address, family: first.family as 4 | 6, operatorApproved });
}

/** Reuse this exact lookup for WebSocket upgrades; never let the client select an Agent. */
export function upstreamWebSocketOptions(target: ValidatedUpstream): { lookup: LookupFunction; servername?: string } {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (_hostname !== target.hostname) {
      callback(new Error("upstream_hostname_mismatch"), "", 4);
    } else if (options.all) {
      callback(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  };
  return { lookup, ...(isIP(target.hostname) ? {} : { servername: target.hostname }) };
}

export function upstreamUrl(target: ValidatedUpstream, path: string | URL): URL {
  const base = new URL(`${target.serverUrl}/`);
  validatePath(path instanceof URL ? path.pathname : path.split(/[?#]/)[0]!);
  let url: URL;
  try {
    url = path instanceof URL ? new URL(path) : /^[a-z][a-z\d+.-]*:/i.test(path)
      ? new URL(path) : new URL(path.replace(/^\//, ""), base);
  } catch { throw invalidUrl(); }
  validatePath(url.pathname);
  const basePath = base.pathname.replace(/\/$/, "");
  if (url.origin !== base.origin || url.username || url.password || url.hash
    || (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))) {
    throw new UpstreamPolicyError("invalid_upstream_path", "The requested Jellyfin path is not allowed.");
  }
  return url;
}

/** Streaming HTTP transport. DNS is never re-resolved after policy validation.
 * No redirect is followed, including same-origin redirects carrying credentials.
 */
export async function upstreamFetch(target: ValidatedUpstream, path: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = upstreamUrl(target, path);
  const headers = new Headers(init.headers);
  for (const name of ["host", "connection", "proxy-authorization", "proxy-connection", "transfer-encoding", "upgrade"]) headers.delete(name);
  headers.set("accept-encoding", "identity");
  const method = init.method ?? "GET";
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("upstream_aborted"));
  if (init.signal?.aborted) abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(abort, 4 * 60 * 60 * 1000);
  deadline.unref();
  const cleanup = () => { clearTimeout(deadline); init.signal?.removeEventListener("abort", abort); };
  return new Promise<Response>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, { method, headers: Object.fromEntries(headers), ...upstreamWebSocketOptions(target),
      agent: upstreamAgent(target, url), signal: controller.signal }, (response) => {
      clearTimeout(headerDeadline);
      response.on("close", cleanup);
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400 && status !== 304) {
        response.destroy(); cleanup();
        reject(new UpstreamPolicyError("jellyfin_redirect_rejected", "The Jellyfin server redirected the request. Check its URL.", 502));
        return;
      }
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined && !["set-cookie", "connection", "transfer-encoding"].includes(name)) {
          responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      const noBody = method === "HEAD" || [204, 205, 304].includes(status);
      if (noBody) response.resume();
      const body = noBody ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, headers: responseHeaders }));
    });
    const headerDeadline = setTimeout(() => req.destroy(new Error("upstream_header_timeout")), 15_000);
    headerDeadline.unref();
    req.setTimeout(30_000, () => req.destroy(new Error("upstream_idle_timeout")));
    req.on("error", () => {
      clearTimeout(headerDeadline); cleanup();
      reject(new UpstreamPolicyError("jellyfin_server_unreachable", "The Jellyfin server request failed.", 502));
    });
    if (init.body == null) req.end();
    else if (typeof init.body === "string" || init.body instanceof URLSearchParams) req.end(String(init.body));
    else if (init.body instanceof ArrayBuffer) req.end(Buffer.from(init.body));
    else if (ArrayBuffer.isView(init.body)) req.end(Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength));
    else if (init.body instanceof ReadableStream) {
      const body = Readable.fromWeb(init.body as import("node:stream/web").ReadableStream);
      body.on("error", () => req.destroy(new Error("upstream_request_body_failed")));
      req.on("close", () => body.destroy());
      body.pipe(req);
    }
    else req.destroy(new Error("unsupported_request_body"));
  });
}

export async function readUpstreamJson(response: Response, limit = 256 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new UpstreamPolicyError("invalid_jellyfin_response", "The server returned an invalid response.", 502);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error("response_too_large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new UpstreamPolicyError("invalid_jellyfin_response", "The server returned an invalid response.", 502);
  }
}

function validatePath(value: string): void {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw invalidUrl(); }
  if (decoded.includes("\\") || hasControlCharacters(decoded) || /%(?:2f|5c|2e|25)/i.test(value)
    || decoded.split("/").some((part) => part === "." || part === "..")) throw invalidUrl();
}

function hasControlCharacters(value: string, includeSpace = false): boolean {
  return [...value].some((character) => character.charCodeAt(0) <= (includeSpace ? 32 : 31) || character.charCodeAt(0) === 127);
}

function invalidUrl(): UpstreamPolicyError {
  return new UpstreamPolicyError("invalid_jellyfin_url", "Enter a valid Jellyfin server URL without credentials, a query, or a fragment.");
}
