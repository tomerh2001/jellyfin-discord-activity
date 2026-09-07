import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { createAppSession, verifyAppToken } from "../services/appSession.js";
import { sessionStore } from "../services/sessionStore.js";
import { allowedDiscordActor, verifyDiscordActivityContext } from "../services/discord.js";

const applicationId = "111111111111111111";
const userId = "222222222222222222";
const guildId = "333333333333333333";
const channelId = "444444444444444444";
const context = { instanceId: "i-123-gc-guild-channel", guildId, channelId };
const envInput = {
  NODE_ENV: "production",
  DISCORD_CLIENT_ID: applicationId,
  PUBLIC_DISCORD_CLIENT_ID: applicationId,
  DISCORD_CLIENT_SECRET: "test-OAuth-8Rd5bW2oY6hZ9kV4mJ3nQ7xP",
  DISCORD_BOT_TOKEN: "test-bot-token-4iJ8mK2nP5qR7sT9uV1wX3yZ",
  DISCORD_PUBLIC_KEY: "0123456789abcdef".repeat(4),
  APP_SESSION_SECRET: "test-session-8Rd5bW2oY6hZ9kV4mJ3nQ7xP",
  TOKEN_ENCRYPTION_KEY: Buffer.from("0123456789abcdefghijklmnopqrstuv").toString("base64"),
  DISCORD_ALLOWED_GUILD_IDS: guildId,
  PUBLIC_BASE_URL: "https://watch.example.test",
  LOG_LEVEL: "silent"
};
const instance = { application_id: applicationId, instance_id: context.instanceId, location: { guild_id: guildId, channel_id: channelId }, users: [userId] };

afterEach(() => { vi.unstubAllGlobals(); });

describe("production configuration", () => {
  it("fails closed for mock auth, missing allowlists and development secrets", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow("Invalid production configuration");
    expect(() => loadEnv({ ...envInput, DEV_AUTH_MOCK: "true" })).toThrow("DEV_AUTH_MOCK");
    expect(() => loadEnv({ ...envInput, DISCORD_ALLOWED_GUILD_IDS: "" })).toThrow("DISCORD_ALLOWED_GUILD_IDS");
    expect(() => loadEnv({ ...envInput, APP_SESSION_SECRET: "development-session-secret-change-me" })).toThrow("APP_SESSION_SECRET");
    expect(() => loadEnv({ ...envInput, TOKEN_ENCRYPTION_KEY: "" })).toThrow("TOKEN_ENCRYPTION_KEY");
    expect(() => loadEnv({ ...envInput, DISCORD_BOT_TOKEN: "" })).toThrow("DISCORD_BOT_TOKEN");
    expect(() => loadEnv({ ...envInput, DISCORD_PUBLIC_KEY: "" })).toThrow("DISCORD_PUBLIC_KEY");
    expect(() => loadEnv(envInput)).not.toThrow();
  });

  it("permits only an allowed actor or an authoritative allowed guild", () => {
    const env = loadEnv({ ...envInput, DISCORD_ALLOWED_USER_IDS: "555555555555555555" });
    expect(allowedDiscordActor(env, userId, guildId)).toBe(true);
    expect(allowedDiscordActor(env, userId, "unknown-guild")).toBe(false);
    expect(allowedDiscordActor(env, "555555555555555555")).toBe(true);
  });
});

describe("Activity instance verification", () => {
  it("uses the bot-authenticated instance response as context authority", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(instance));
    vi.stubGlobal("fetch", fetchMock);
    expect(await verifyDiscordActivityContext(loadEnv(envInput), { instanceId: context.instanceId }, userId)).toEqual(context);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://discord.com/api/v10/applications/${applicationId}/activity-instances/${context.instanceId}`,
      expect.objectContaining({ headers: { Authorization: `Bot ${envInput.DISCORD_BOT_TOKEN}` } })
    );
  });

  it.each([
    { ...instance, users: ["somebody-else"] },
    { ...instance, application_id: "different-app" },
    { ...instance, instance_id: "different-instance" },
    { ...instance, location: { ...instance.location, guild_id: "forged-guild" } },
    { ...instance, location: { ...instance.location, channel_id: "forged-channel" } }
  ])("rejects an unrelated or forged activity context %#", async (payload) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(verifyDiscordActivityContext(loadEnv(envInput), context, userId)).rejects.toThrow("discord_activity_forbidden");
  });

  it("rejects an otherwise valid instance outside the allowlist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(instance)));
    await expect(verifyDiscordActivityContext(loadEnv({ ...envInput, DISCORD_ALLOWED_GUILD_IDS: "999999999999999999" }), context, userId)).rejects.toThrow("discord_actor_forbidden");
  });

  it("does not fall back to client context when Discord cannot verify the instance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status: 404 })));
    await expect(verifyDiscordActivityContext(loadEnv(envInput), context, userId)).rejects.toThrow("discord_activity_verification_failed");
  });

  it("revokes a session when its participant membership cannot be renewed", async () => {
    const env = loadEnv({ ...envInput, NODE_ENV: "test" });
    const { session, appToken } = await createAppSession({ env, user: { id: userId, username: "Member" }, discordContext: context });
    session.createdAt = new Date(Date.now() - 61_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...instance, users: [] })));
    await expect(verifyAppToken(env, appToken)).rejects.toThrow("discord_activity_forbidden");
    expect(sessionStore.getSession(session.id)).toBeUndefined();
  });

  it("does not return a session revoked while an Activity renewal is in flight", async () => {
    const env = loadEnv({ ...envInput, NODE_ENV: "test" });
    const { session, appToken } = await createAppSession({ env, user: { id: userId, username: "Member" }, discordContext: context });
    session.createdAt = new Date(Date.now() - 61_000);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      sessionStore.deleteSession(session.id);
      return Response.json(instance);
    }));
    await expect(verifyAppToken(env, appToken)).rejects.toThrow("invalid_session");
  });

  it("binds the OAuth user to an authoritative active instance before issuing a session", async () => {
    const app = await buildApp(loadEnv({ ...envInput, NODE_ENV: "test" }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "oauth-token", token_type: "Bearer", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ id: userId, username: "Member" }))
      .mockResolvedValueOnce(Response.json(instance));
    vi.stubGlobal("fetch", fetchMock);
    const response = await app.inject({ method: "POST", url: "/api/discord/exchange", payload: { code: "real-oauth-code", instanceId: context.instanceId } });
    expect(response.statusCode).toBe(200);
    const me = await app.inject({ url: "/api/me", headers: { authorization: `Bearer ${response.json().appToken}` } });
    expect(me.json().discordContext).toEqual(context);
    await app.close();
  });
});
