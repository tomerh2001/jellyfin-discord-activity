import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { verifyInteractionSignature } from "../services/interactionSignature.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
function signed(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return { "content-type": "application/json", "x-signature-timestamp": timestamp,
    "x-signature-ed25519": sign(null, Buffer.from(timestamp + body), privateKey).toString("hex") };
}

describe("Discord signed interactions", () => {
  it("rejects tampering, invalid keys and stale requests", () => {
    const body = "{}";
    const headers = signed(body);
    expect(verifyInteractionSignature(publicHex, headers["x-signature-ed25519"], headers["x-signature-timestamp"], Buffer.from(body))).toBe(true);
    expect(verifyInteractionSignature(publicHex, headers["x-signature-ed25519"], headers["x-signature-timestamp"], Buffer.from("{ }"))).toBe(false);
    expect(verifyInteractionSignature(publicHex, headers["x-signature-ed25519"], "1", Buffer.from(body))).toBe(false);
    expect(verifyInteractionSignature("bad", "bad", "1", Buffer.from(body))).toBe(false);
  });
  it("verifies exact raw bytes, handles pings and checks the application's identity", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test", DISCORD_PUBLIC_KEY: publicHex }));
    try {
      const body = JSON.stringify({ id: "ping-1", application_id: "dev-client-id", type: 1 }, null, 2);
      expect((await app.inject({ method: "POST", url: "/api/discord/interactions", payload: body, headers: signed(body) })).json()).toEqual({ type: 1 });
      expect((await app.inject({ method: "POST", url: "/api/discord/interactions", payload: `${body} `, headers: signed(body) })).statusCode).toBe(401);
      const foreign = JSON.stringify({ id: "ping-2", application_id: "other", type: 1 });
      expect((await app.inject({ method: "POST", url: "/api/discord/interactions", payload: foreign, headers: signed(foreign) })).statusCode).toBe(400);
    } finally { await app.close(); }
  });
  it("launches allowed callers and refuses a server outside the allowlist", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test", DISCORD_PUBLIC_KEY: publicHex, DISCORD_ALLOWED_GUILD_IDS: "allowed" }));
    try {
      const interaction = { id: "launch", application_id: "dev-client-id", type: 2, guild_id: "allowed", member: { user: { id: "user" } }, data: { name: "Watch Jellyfin" } };
      const payload = JSON.stringify(interaction);
      expect((await app.inject({ method: "POST", url: "/api/discord/interactions", payload, headers: signed(payload) })).json()).toEqual({ type: 12 });
      const denied = JSON.stringify({ ...interaction, id: "denied", guild_id: "other" });
      expect((await app.inject({ method: "POST", url: "/api/discord/interactions", payload: denied, headers: signed(denied) })).json()).toMatchObject({ type: 4, data: { flags: 64 } });
    } finally { await app.close(); }
  });
});
