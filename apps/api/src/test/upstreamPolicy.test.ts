import { createServer, type Server } from "node:http";
import { lookup } from "node:dns/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../env.js";
import { isPublicAddress, normalizeUpstreamUrl, readUpstreamJson, upstreamFetch, upstreamUrl,
  upstreamWebSocketOptions, validateUpstream, type ValidatedUpstream } from "../services/upstreamPolicy.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
const dns = vi.mocked(lookup as (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>);
const servers: Server[] = [];
const env = () => loadEnv({ NODE_ENV: "test", JELLYFIN_DEFAULT_SERVER_URL: "http://operator.internal:8096/jellyfin" });

afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

describe("Jellyfin upstream policy", () => {
  it.each(["0.0.0.0", "10.1.2.3", "100.100.100.100", "127.0.0.1", "169.254.169.254", "172.16.0.1",
    "192.168.1.1", "192.0.0.8", "198.18.0.1", "203.0.113.10", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::808:808", "fc00::1", "fe80::1",
    "ff02::1", "2001:db8::1", "2001::1", "2002:7f00:1::1", "3fff::1", "invalid"])("rejects non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("allows global address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(["https://127.1", "https://2130706433", "https://0x7f000001", "https://[::ffff:127.0.0.1]"])("blocks alternate private-IP spelling %s", async (serverUrl) => {
    await expect(validateUpstream(env(), serverUrl)).rejects.toMatchObject({ code: "jellyfin_server_not_allowed" });
    expect(dns).not.toHaveBeenCalled();
  });

  it("rejects mixed DNS answers and a later public-to-private rebinding", async () => {
    dns.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(validateUpstream(env(), "https://mixed.example")).rejects.toMatchObject({ code: "jellyfin_server_not_allowed" });
    dns.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
    await expect(validateUpstream(env(), "https://rebind.example")).resolves.toMatchObject({ address: "8.8.8.8" });
    dns.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);
    await expect(validateUpstream(env(), "https://rebind.example")).rejects.toMatchObject({ code: "jellyfin_server_not_allowed" });
  });

  it("allows the exact operator URL, while denying other HTTP/private URLs and disabled custom servers", async () => {
    dns.mockResolvedValue([{ address: "10.40.0.9", family: 4 }]);
    await expect(validateUpstream(env(), "http://operator.internal:8096/jellyfin/")).resolves.toMatchObject({ operatorApproved: true });
    for (const serverUrl of ["http://operator.internal:8096/other", "http://public.example", "https://operator.internal:8096/jellyfin"]) {
      await expect(validateUpstream(env(), serverUrl)).rejects.toMatchObject({ code: "jellyfin_server_not_allowed" });
    }
    await expect(validateUpstream({ ...env(), JELLYFIN_ALLOW_CUSTOM_SERVERS: false }, "https://public.example"))
      .rejects.toMatchObject({ code: "jellyfin_server_not_allowed" });
  });

  it.each(["ftp://public.example", "https://user:password@public.example", "https://public.example?a=b",
    "https://public.example/#fragment", "https://public.example./", "https://public.example/a%2fb", "https://public.example/a\\b",
    " https://public.example", "https://public.example/a%250a"])("rejects ambiguous base URL %s", (url) => {
    expect(() => normalizeUpstreamUrl(url)).toThrow();
  });

  it("keeps API/media paths under the configured base and never accepts a second origin", () => {
    const target: ValidatedUpstream = { serverUrl: "https://media.example/jellyfin", hostname: "media.example", address: "8.8.8.8", family: 4, operatorApproved: false };
    expect(upstreamUrl(target, "/Users/Me?value=%2f").toString()).toBe("https://media.example/jellyfin/Users/Me?value=%2f");
    for (const value of ["https://evil.example/jellyfin", "https://media.example/admin", "../admin", "/%2e%2e/admin", "/a%252fb", "/a\\b"]) {
      expect(() => upstreamUrl(target, value)).toThrow();
    }
  });

  it("pins HTTP and WebSocket DNS lookup after validation and preserves the intended Host", async () => {
    const received: { host: string | undefined; authorization: string | undefined }[] = [];
    const port = await listen(createServer((request, response) => {
      received.push({ host: request.headers.host, authorization: request.headers.authorization });
      response.setHeader("Set-Cookie", "upstream-secret=hidden");
      response.end(JSON.stringify({ ok: true }));
    }));
    const operator = { ...env(), JELLYFIN_DEFAULT_SERVER_URL: `http://pinned.example:${port}/jellyfin` };
    dns.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const target = await validateUpstream(operator, operator.JELLYFIN_DEFAULT_SERVER_URL);
    dns.mockResolvedValue([{ address: "127.0.0.2", family: 4 }]);
    const response = await upstreamFetch(target, "/System/Info/Public", { headers: { Host: "evil.example", Authorization: "fixture-token" } });
    expect(await readUpstreamJson(response)).toEqual({ ok: true });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(received).toEqual([{ host: `pinned.example:${port}`, authorization: "fixture-token" }]);
    expect(dns).toHaveBeenCalledTimes(1);
    const options = upstreamWebSocketOptions(target);
    const callback = vi.fn();
    options.lookup("pinned.example", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: "127.0.0.1", family: 4 }]);
    expect(options.servername).toBe("pinned.example");
    options.lookup("evil.example", {}, callback);
    expect(callback.mock.lastCall?.[0]).toBeInstanceOf(Error);
  });

  it("rejects redirects without forwarding credentials to their destination", async () => {
    let leaked = 0;
    const destination = await listen(createServer((_request, response) => { leaked++; response.end("unexpected"); }));
    const port = await listen(createServer((_request, response) => {
      response.writeHead(307, { Location: `http://127.0.0.1:${destination}/password` }); response.end();
    }));
    const operator = { ...env(), JELLYFIN_DEFAULT_SERVER_URL: `http://127.0.0.1:${port}` };
    const target = await validateUpstream(operator, operator.JELLYFIN_DEFAULT_SERVER_URL);
    await expect(upstreamFetch(target, "/Users/AuthenticateByName", { method: "POST", body: "private-password", headers: { Authorization: "private-token" } }))
      .rejects.toMatchObject({ code: "jellyfin_redirect_rejected" });
    expect(leaked).toBe(0);
  });

  it("aborts stalled transfers and bounds JSON bodies", async () => {
    const port = await listen(createServer((_request, _response) => undefined));
    const operator = { ...env(), JELLYFIN_DEFAULT_SERVER_URL: `http://127.0.0.1:${port}` };
    const target = await validateUpstream(operator, operator.JELLYFIN_DEFAULT_SERVER_URL);
    await expect(upstreamFetch(target, "/slow", { signal: AbortSignal.timeout(30) })).rejects.toMatchObject({ code: "jellyfin_server_unreachable" });
    await expect(readUpstreamJson(new Response(JSON.stringify({ long: "x".repeat(100) })), 32))
      .rejects.toMatchObject({ code: "invalid_jellyfin_response" });
  });
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_listener_failed");
  return address.port;
}
