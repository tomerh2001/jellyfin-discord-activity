import { generateKeyPairSync, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { createAppSession } from "../services/appSession.js";
import { createDiscordProxyVerifier } from "../services/discordProxySignature.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const verifyProxy = createDiscordProxyVerifier(publicHex);
const now = Math.floor(Date.now() / 1000);
const envInput = { NODE_ENV: "test", DISCORD_REQUIRE_PROXY_AUTH: "true", DISCORD_PUBLIC_KEY: publicHex, LOG_LEVEL: "silent" };

function signed(payload: unknown = { created_at: now, expires_at: now + 300 }, encoding: "hex" | "base64" = "base64") {
  const bytes = Buffer.from(JSON.stringify(payload));
  return {
    "x-signature-timestamp": String((payload as { created_at?: unknown }).created_at),
    "x-signature-ed25519": sign(null, bytes, privateKey).toString(encoding),
    "x-discord-proxy-payload": bytes.toString("base64")
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("Discord proxy signature protocol", () => {
  it("verifies decoded payload bytes with both encodings in Discord's documentation", () => {
    for (const encoding of ["base64", "hex"] as const) {
      expect(verifyProxy(signed(undefined, encoding), now)).toEqual({ createdAt: now, expiresAt: now + 300 });
    }
    expect(() => createDiscordProxyVerifier("")).toThrow("DISCORD_PUBLIC_KEY");
  });

  it("rejects a different application key, altered payload, timestamp and signature", () => {
    const otherKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    expect(createDiscordProxyVerifier(otherKey)(signed(), now)).toBeUndefined();
    const headers = signed();
    expect(verifyProxy({ ...headers, "x-discord-proxy-payload": Buffer.from(JSON.stringify({ created_at: now, expires_at: now + 999 })).toString("base64") }, now)).toBeUndefined();
    expect(verifyProxy({ ...headers, "x-signature-timestamp": String(now - 1) }, now)).toBeUndefined();
    expect(verifyProxy({ ...headers, "x-signature-ed25519": Buffer.alloc(64).toString("base64") }, now)).toBeUndefined();
  });

  it.each([
    {},
    { "x-signature-timestamp": "1" },
    { ...signed(), "x-signature-timestamp": [String(now), String(now)] },
    { ...signed(), "x-discord-proxy-payload": `${signed()["x-discord-proxy-payload"]}\n` },
    { ...signed(), "x-discord-proxy-payload": "a".repeat(9000) },
    { ...signed(), "x-signature-ed25519": "not-a-signature" },
    { ...signed(), "x-signature-timestamp": "0" },
    signed({ created_at: String(now), expires_at: now + 300 }),
    signed({ created_at: now, expires_at: String(now + 300) }),
    signed({ created_at: now + 31, expires_at: now + 300 }),
    signed({ created_at: now - 300, expires_at: now }),
    signed({ created_at: now, expires_at: now - 1 }),
    signed({ created_at: now + 1, expires_at: now + 1 }),
    signed({ created_at: now, expires_at: null })
  ])("rejects missing, malformed or invalid time headers %#", (headers) => {
    expect(verifyProxy(headers, now)).toBeUndefined();
  });

  it("rejects signed malformed JSON and non-object payloads", () => {
    for (const bytes of [Buffer.from("not-json"), Buffer.from("[]"), Buffer.from("null"), Buffer.from([0xff])]) {
      expect(verifyProxy({
        "x-signature-timestamp": String(now),
        "x-signature-ed25519": sign(null, bytes, privateKey).toString("base64"),
        "x-discord-proxy-payload": bytes.toString("base64")
      }, now)).toBeUndefined();
    }
  });

  it("accepts token reuse within its documented lifetime, then rejects replay at expiry", () => {
    const headers = signed();
    expect(verifyProxy(headers, now)).toBeDefined();
    expect(verifyProxy(headers, now + 299)).toBeDefined();
    expect(verifyProxy(headers, now + 300)).toBeUndefined();
  });
});

describe("Discord-only ingress", () => {
  it("requires proxy proof on UI, assets, APIs, media, unknown routes and every HTTP method", async () => {
    const app = await buildApp(loadEnv(envInput));
    try {
      for (const url of ["/", "/assets/app.js", "/api/config", "/api/health", "/media/direct/stolen/stream", "/unknown", "/ws"]) {
        const response = await app.inject({ url, remoteAddress: "198.51.100.4" });
        expect(response.statusCode, url).toBe(401);
        expect(response.headers["cache-control"]).toBe("private, no-store");
      }
      for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
        expect((await app.inject({ method, url: "/api/config" })).statusCode, method).toBe(401);
      }
      const admitted = await app.inject({ url: "/api/config", headers: signed() });
      expect(admitted.statusCode).toBe(200);
      expect(admitted.headers["cache-control"]).toBe("private, no-store");
      expect(admitted.headers["cloudflare-cdn-cache-control"]).toBe("no-store");
    } finally { await app.close(); }
  });

  it("does not trust referrer, origin, user agent or forwarded loopback IP", async () => {
    const app = await buildApp(loadEnv({ ...envInput, TRUST_PROXY: "true" }));
    try {
      const headers = {
        "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1", "cf-connecting-ip": "127.0.0.1",
        origin: "https://111111111111111111.discordsays.com", referer: "https://discord.com/channels/allowed/voice",
        "user-agent": "Discord"
      };
      expect((await app.inject({ url: "/api/config", headers, remoteAddress: "198.51.100.4" })).statusCode).toBe(401);
      expect((await app.inject({ url: "/health", headers, remoteAddress: "198.51.100.4" })).statusCode).toBe(401);
      expect((await app.inject({ url: "/health", headers, remoteAddress: "127.0.0.1" })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("makes only the exact local Docker health check available without a proxy token", async () => {
    const app = await buildApp(loadEnv(envInput));
    try {
      for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
        expect((await app.inject({ url: "/health", remoteAddress })).statusCode).toBe(200);
      }
      for (const url of ["/health", "/health?anything=1"]) {
        expect((await app.inject({ url, remoteAddress: "198.51.100.4", headers: signed() })).statusCode).toBe(401);
      }
      expect((await app.inject({ url: "/api/health", remoteAddress: "127.0.0.1" })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("requires independent exact-body Discord signatures on the sole callback exception", async () => {
    const app = await buildApp(loadEnv(envInput));
    try {
      const payload = JSON.stringify({ id: "ping", application_id: "dev-client-id", type: 1 });
      const timestamp = String(now);
      const headers = { "content-type": "application/json", "x-signature-timestamp": timestamp,
        "x-signature-ed25519": sign(null, Buffer.from(timestamp + payload), privateKey).toString("hex") };
      expect((await app.inject({ method: "POST", url: "/api/discord/interactions", payload, headers })).json()).toEqual({ type: 1 });
      expect((await app.inject({ method: "POST", url: "/api/discord/interactions", payload, headers: { "content-type": "application/json" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/discord/interactions", payload, headers: { ...signed(), "content-type": "application/json" } })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/api/config", headers })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/discord/interactions?bypass=1", payload, headers })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("keeps OAuth, session and server authorization after accepting a proxy token", async () => {
    const app = await buildApp(loadEnv({ ...envInput, DISCORD_BOT_TOKEN: "bot", DISCORD_ALLOWED_GUILD_IDS: "allowed" }));
    try {
      const denied = await app.inject({ url: "/api/me", headers: signed() });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().error.code).toBe("missing_app_token");
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(Response.json({ access_token: "oauth-token", token_type: "Bearer", expires_in: 3600 }))
        .mockResolvedValueOnce(Response.json({ id: "member", username: "Member" }))
        .mockResolvedValueOnce(Response.json({ application_id: "dev-client-id", instance_id: "instance", location: { channel_id: "channel", guild_id: "forbidden" }, users: ["member"] })));
      const oauth = await app.inject({ method: "POST", url: "/api/discord/exchange", headers: signed(), payload: { code: "oauth-code", instanceId: "instance" } });
      expect(oauth.statusCode).toBe(403);
      expect(oauth.json().error.code).toBe("discord_actor_forbidden");
    } finally { await app.close(); }
  });

  it("authenticates real WebSocket upgrades before accepting the connection", async () => {
    const env = loadEnv({ ...envInput, DEV_AUTH_MOCK: "true" });
    const app = await buildApp(env);
    try {
      const { appToken } = await createAppSession({ env, user: { id: "proxy-ws", username: "Member" }, discordContext: { instanceId: "proxy-ws-room" } });
      const base = await app.listen({ host: "127.0.0.1", port: 0 });
      const url = `${base}/ws?instanceId=proxy-ws-room&token=${encodeURIComponent(appToken)}`;
      expect(await upgradeStatus(url, {})).toBe(401);
      expect(await upgradeStatus(url, signed())).toBe(101);
    } finally { await app.close(); }
  });

  it("cannot disable production ingress authentication with a false flag", async () => {
    const env = loadEnv(envInput);
    const directory = mkdtempSync(path.join(tmpdir(), "discord-proxy-test-"));
    const app = await buildApp({ ...env, NODE_ENV: "production", DATABASE_URL: `file:${directory}/app.db`, DISCORD_REQUIRE_PROXY_AUTH: false });
    try {
      expect((await app.inject("/api/config")).statusCode).toBe(401);
    } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { agent: false, headers: {
      ...headers, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13",
      "sec-websocket-key": Buffer.alloc(16, 5).toString("base64")
    } });
    request.on("upgrade", (_response, socket) => { socket.destroy(); resolve(101); });
    request.on("response", (response) => { response.resume(); resolve(response.statusCode!); });
    request.on("error", reject);
    request.end();
  });
}
