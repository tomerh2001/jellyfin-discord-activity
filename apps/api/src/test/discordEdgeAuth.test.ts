import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { loggerConfig } from "../logger.js";
import { createAppSession } from "../services/appSession.js";
import { createDiscordEdgeVerifier, discordEdgeHeader } from "../services/discordEdgeAuth.js";

const secret = randomBytes(32).toString("hex");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const input = { NODE_ENV: "test", LOG_LEVEL: "silent", DISCORD_REQUIRE_PROXY_AUTH: "true",
  DISCORD_PROXY_AUTH_MODE: "cloudflare-worker", DISCORD_PROXY_EDGE_SECRET: secret, DISCORD_PUBLIC_KEY: publicHex };
const attested = { [discordEdgeHeader]: secret };

afterEach(() => { vi.unstubAllGlobals(); });

describe("Cloudflare Worker origin attestation", () => {
  it("accepts only the complete origin secret, never client claims or duplicate values", () => {
    const verify = createDiscordEdgeVerifier(secret);
    expect(verify(attested)).toBe(true);
    for (const value of [undefined, "", "forged", secret.slice(1), `${secret}x`, secret.toUpperCase(), [secret, secret], `${secret}, ${secret}`, "x".repeat(513)]) {
      expect(verify({ [discordEdgeHeader]: value })).toBe(false);
    }
    expect(verify({ "cf-worker": "discordsays.com", origin: "https://123.discordsays.com", referer: "https://discord.com" })).toBe(false);
    expect(() => createDiscordEdgeVerifier("")).toThrow("DISCORD_PROXY_EDGE_SECRET");
  });

  it("rejects direct UI, API, media and forged edge headers while admitting attested requests", async () => {
    const app = await buildApp(loadEnv(input));
    try {
      for (const url of ["/", "/assets/app.js", "/api/config", "/api/health", "/media/direct/stolen/stream", "/unknown", "/ws"]) {
        expect((await app.inject({ url })).statusCode, url).toBe(401);
        expect((await app.inject({ url, headers: { [discordEdgeHeader]: "forged", "cf-worker": "discordsays.com" } })).statusCode, url).toBe(401);
      }
      const response = await app.inject({ url: "/api/config", headers: attested });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["cloudflare-cdn-cache-control"]).toBe("no-store");
      expect((await app.inject({ url: "/api/health", headers: attested })).statusCode).toBe(200);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const payload = Buffer.from(JSON.stringify({ created_at: Number(timestamp), expires_at: Number(timestamp) + 300 }));
      expect((await app.inject({ url: "/api/config", headers: {
        "x-signature-timestamp": timestamp, "x-discord-proxy-payload": payload.toString("base64"),
        "x-signature-ed25519": sign(null, payload, privateKey).toString("base64")
      } })).statusCode).toBe(401);
      expect((await app.inject({ url: "/media/direct/stolen/stream", headers: attested })).statusCode).toBe(403);
      const sessionRequired = await app.inject({ url: "/api/me", headers: attested });
      expect(sessionRequired.statusCode).toBe(401);
      expect(sessionRequired.json().error.code).toBe("missing_app_token");
    } finally { await app.close(); }
  });

  it("keeps health private and interactions independently signed", async () => {
    const app = await buildApp(loadEnv({ ...input, TRUST_PROXY: "true" }));
    try {
      expect((await app.inject({ url: "/health", remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
      expect((await app.inject({ url: "/health", remoteAddress: "198.51.100.4", headers: attested })).statusCode).toBe(401);
      expect((await app.inject({ url: "/health", remoteAddress: "127.0.0.1", headers: { ...attested, "x-forwarded-for": "127.0.0.1" } })).statusCode).toBe(401);
      const payload = JSON.stringify({ id: "edge-ping", application_id: "dev-client-id", type: 1 });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers = { "content-type": "application/json", "x-signature-timestamp": timestamp,
        "x-signature-ed25519": sign(null, Buffer.from(timestamp + payload), privateKey).toString("hex") };
      expect((await app.inject({ method: "POST", url: "/api/discord/interactions", headers, payload })).json()).toEqual({ type: 1 });
      expect((await app.inject({ method: "POST", url: "/api/discord/interactions", headers: { ...attested, "content-type": "application/json" }, payload })).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/discord/interactions?other=1", headers, payload })).statusCode).toBe(401);
    } finally { await app.close(); }
  });

  it("still verifies OAuth identity and the authoritative Activity server after edge authentication", async () => {
    const app = await buildApp(loadEnv({ ...input, DISCORD_BOT_TOKEN: "bot", DISCORD_ALLOWED_GUILD_IDS: "allowed" }));
    try {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(Response.json({ access_token: "oauth-token", token_type: "Bearer", expires_in: 3600 }))
        .mockResolvedValueOnce(Response.json({ id: "member", username: "Member" }))
        .mockResolvedValueOnce(Response.json({ application_id: "dev-client-id", instance_id: "instance", location: { channel_id: "channel", guild_id: "forbidden" }, users: ["member"] })));
      const response = await app.inject({ method: "POST", url: "/api/discord/exchange", headers: attested, payload: { code: "oauth-code", instanceId: "instance" } });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("discord_actor_forbidden");
    } finally { await app.close(); }
  });

  it("enforces edge authentication before a real WebSocket upgrade", async () => {
    const env = loadEnv({ ...input, DEV_AUTH_MOCK: "true" });
    const app = await buildApp(env);
    try {
      const { appToken } = await createAppSession({ env, user: { id: "edge-ws", username: "Member" }, discordContext: { instanceId: "edge-ws-room" } });
      const base = await app.listen({ host: "127.0.0.1", port: 0 });
      const url = `${base}/ws?instanceId=edge-ws-room&token=${encodeURIComponent(appToken)}`;
      expect(await upgradeStatus(url, {})).toBe(401);
      expect(await upgradeStatus(url, { [discordEdgeHeader]: "forged", "cf-worker": "discordsays.com" })).toBe(401);
      expect(await upgradeStatus(url, attested)).toBe(101);
    } finally { await app.close(); }
  });

  it("defaults to signature mode and never uses an edge header as its fallback", async () => {
    const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DISCORD_REQUIRE_PROXY_AUTH: "true", DISCORD_PUBLIC_KEY: publicHex, DISCORD_PROXY_EDGE_SECRET: secret });
    expect(env.DISCORD_PROXY_AUTH_MODE).toBe("signature");
    const app = await buildApp(env);
    try { expect((await app.inject({ url: "/api/config", headers: attested })).statusCode).toBe(401); }
    finally { await app.close(); }
  });

  it("requires strong edge configuration and cannot disable the production gate", async () => {
    for (const value of ["", "short", "a".repeat(64), "0123456789abcdef".repeat(3), "x".repeat(513)]) {
      expect(() => loadEnv({ ...input, NODE_ENV: "production", DISCORD_PROXY_EDGE_SECRET: value })).toThrow("DISCORD_PROXY_EDGE_SECRET");
    }
    expect(() => loadEnv({ ...input, DISCORD_PROXY_AUTH_MODE: "off" })).toThrow();
    expect(loadEnv({ ...input, DISCORD_PROXY_EDGE_SECRET: randomBytes(32).toString("base64url") }).DISCORD_PROXY_AUTH_MODE).toBe("cloudflare-worker");
    const directory = mkdtempSync(path.join(tmpdir(), "discord-edge-test-"));
    const app = await buildApp({ ...loadEnv(input), NODE_ENV: "production", DISCORD_REQUIRE_PROXY_AUTH: false, DATABASE_URL: `file:${directory}/app.db` });
    try { expect((await app.inject("/api/config")).statusCode).toBe(401); }
    finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("redacts attestation credentials even when a diagnostic log includes headers or env", () => {
    const setup = loggerConfig(loadEnv({ NODE_ENV: "test", LOG_LEVEL: "info" }));
    if (!("logger" in setup)) throw new Error("Expected an in-memory test logger");
    const lines: string[] = [];
    const logger = pino({ ...setup.logger, serializers: {} }, { write(line) { lines.push(line); } });
    logger.info({ req: { headers: attested }, env: { DISCORD_PROXY_EDGE_SECRET: secret }, DISCORD_PROXY_EDGE_SECRET: secret });
    expect(lines.join("")).not.toContain(secret);
    expect(lines.join("")).toContain("[redacted]");
  });
});

function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { agent: false, headers: { ...headers, connection: "Upgrade", upgrade: "websocket",
      "sec-websocket-version": "13", "sec-websocket-key": Buffer.alloc(16, 7).toString("base64") } });
    request.setTimeout(3000, () => request.destroy(new Error("WebSocket response timed out")));
    request.on("upgrade", (_response, socket) => { socket.destroy(); resolve(101); });
    request.on("response", (response) => { response.resume(); resolve(response.statusCode!); });
    request.on("error", reject);
    request.end();
  });
}
