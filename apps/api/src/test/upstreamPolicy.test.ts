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

  it("maps only the exact configured public alias to the approved default before DNS lookup", async () => {
    const operator = { ...env(), JELLYFIN_PUBLIC_SERVER_URL: "https://media.example/jellyfin" };
    dns.mockResolvedValue([{ address: "10.40.0.9", family: 4 }]);
    const canonical = await validateUpstream(operator, operator.JELLYFIN_DEFAULT_SERVER_URL);
    const alias = await validateUpstream(operator, "https://MEDIA.example:443/jellyfin/");
    expect(alias).toEqual(canonical);
    expect(alias).toMatchObject({ serverUrl: "http://operator.internal:8096/jellyfin", operatorApproved: true });
    expect(dns.mock.calls.map(([hostname]) => hostname)).toEqual(["operator.internal", "operator.internal"]);
    await expect(validateUpstream({ ...operator, JELLYFIN_ALLOW_CUSTOM_SERVERS: false }, operator.JELLYFIN_PUBLIC_SERVER_URL))
      .resolves.toEqual(canonical);
  });

  it("does not expand public alias approval to another scheme, port, host, or path", async () => {
    const operator = { ...env(), JELLYFIN_PUBLIC_SERVER_URL: "https://media.example/jellyfin" };
    dns.mockResolvedValue([{ address: "10.40.0.9", family: 4 }]);
    for (const serverUrl of ["http://media.example/jellyfin", "https://media.example:8443/jellyfin",
      "https://media.example", "https://media.example/jellyfin/admin", "https://other.example/jellyfin",
      "https://media.example.evil.example/jellyfin"]) {
      await expect(validateUpstream(operator, serverUrl)).rejects.toMatchObject({ code: "jellyfin_server_not_allowed" });
    }
    for (const serverUrl of ["https://secret@media.example/jellyfin", "https://media.example/jellyfin?target=internal",
      "https://media.example/jellyfin#fragment"]) {
      await expect(validateUpstream(operator, serverUrl)).rejects.toMatchObject({ code: "invalid_jellyfin_url" });
    }
    expect(dns.mock.calls.every(([hostname]) => hostname !== "operator.internal")).toBe(true);
    await expect(validateUpstream(env(), "https://media.example/jellyfin"))
      .rejects.toMatchObject({ code: "jellyfin_server_not_allowed" });
  });

  it("requires HTTPS for the operator's optional user-facing alias", () => {
    expect(loadEnv({ NODE_ENV: "test" }).JELLYFIN_PUBLIC_SERVER_URL).toBe("");
    expect(() => loadEnv({ NODE_ENV: "test", JELLYFIN_PUBLIC_SERVER_URL: "http://media.example" })).toThrow();
    expect(() => loadEnv({ NODE_ENV: "test", JELLYFIN_PUBLIC_SERVER_URL: "ftp://media.example" })).toThrow();
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

  it("reuses a validated connection while keeping each request's credentials separate", async () => {
    let connections = 0;
    const received: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      received.push(request.headers.authorization);
      response.end("ok");
    });
    server.on("connection", () => { connections++; });
    const port = await listen(server);
    const operator = { ...env(), JELLYFIN_DEFAULT_SERVER_URL: `http://pinned.example:${port}` };
    dns.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const target = await validateUpstream(operator, operator.JELLYFIN_DEFAULT_SERVER_URL);
    for (const authorization of ["fixture-first", "fixture-second", "fixture-first"]) {
      expect(await (await upstreamFetch(target, "/Items", { headers: { Authorization: authorization } })).text()).toBe("ok");
    }
    expect(connections).toBe(1);
    expect(received).toEqual(["fixture-first", "fixture-second", "fixture-first"]);
    expect(dns).toHaveBeenCalledTimes(1);
  });

  it("never reuses a pooled connection for a different validated DNS pin", async () => {
    const addresses: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      addresses.push(request.socket.localAddress);
      response.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const port = (server.address() as { port: number }).port;
    const operator = { ...env(), JELLYFIN_DEFAULT_SERVER_URL: `http://pinned.example:${port}` };
    dns.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const first = await validateUpstream(operator, operator.JELLYFIN_DEFAULT_SERVER_URL);
    await (await upstreamFetch(first, "/Items")).text();
    dns.mockResolvedValueOnce([{ address: "127.0.0.2", family: 4 }]);
    const second = await validateUpstream(operator, operator.JELLYFIN_DEFAULT_SERVER_URL);
    await (await upstreamFetch(second, "/Items")).text();
    await (await upstreamFetch(first, "/Items")).text();
    expect(addresses).toEqual(["127.0.0.1", "127.0.0.2", "127.0.0.1"]);
    expect(dns).toHaveBeenCalledTimes(2);
  });

  it("cancels a reused streaming socket without poisoning later requests", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/slow") { response.writeHead(200); response.write("first"); }
      else response.end("ok");
    });
    const port = await listen(server);
    const operator = { ...env(), JELLYFIN_DEFAULT_SERVER_URL: `http://127.0.0.1:${port}` };
    const target = await validateUpstream(operator, operator.JELLYFIN_DEFAULT_SERVER_URL);
    await (await upstreamFetch(target, "/ready")).text();
    const controller = new AbortController();
    const response = await upstreamFetch(target, "/slow", { signal: controller.signal });
    const body = response.text();
    controller.abort();
    await expect(body).rejects.toThrow();
    expect(await (await upstreamFetch(target, "/ready")).text()).toBe("ok");
  });

  it("bounds concurrent sockets while completing a larger request burst", async () => {
    let connections = 0;
    const server = createServer((_request, response) => { setTimeout(() => response.end("ok"), 20); });
    server.on("connection", () => { connections++; });
    const port = await listen(server);
    const operator = { ...env(), JELLYFIN_DEFAULT_SERVER_URL: `http://127.0.0.1:${port}` };
    const target = await validateUpstream(operator, operator.JELLYFIN_DEFAULT_SERVER_URL);
    const results = await Promise.all(Array.from({ length: 70 }, async () => (await upstreamFetch(target, "/Items")).text()));
    expect(results).toEqual(Array(70).fill("ok"));
    expect(connections).toBeGreaterThan(1);
    expect(connections).toBeLessThanOrEqual(64);
  });

  it("never evicts active streams when more validated destinations fill the pool registry", async () => {
    const held: import("node:http").ServerResponse[] = [];
    const server = createServer((_request, response) => { response.write("first"); held.push(response); });
    const port = await listen(server);
    const responses: Response[] = [];
    for (let index = 0; index < 33; index++) {
      const operator = { ...env(), JELLYFIN_DEFAULT_SERVER_URL: `http://127.0.0.1:${port}/server-${index}` };
      const target = await validateUpstream(operator, operator.JELLYFIN_DEFAULT_SERVER_URL);
      responses.push(await upstreamFetch(target, "/stream"));
    }
    expect(held).toHaveLength(33);
    expect(held.every((response) => !response.destroyed)).toBe(true);
    for (const response of held) response.end("last");
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(Array(33).fill("firstlast"));
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
