import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { exchangeDiscordCode } from "../services/discord.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Discord auth routes", () => {
  it("exchanges Embedded SDK codes without injecting a configured portal redirect URI", async () => {
    const env = loadEnv({ NODE_ENV: "test", DISCORD_REDIRECT_URI: "https://portal.example/callback" });
    const upstream = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe(env.DISCORD_CLIENT_ID);
      expect(body.get("code")).toBe("embedded-sdk-code");
      expect(body.has("redirect_uri")).toBe(false);
      return new Response(JSON.stringify({ access_token: "oauth-token", token_type: "Bearer", expires_in: 3600, scope: "identify" }));
    });
    vi.stubGlobal("fetch", upstream);
    await expect(exchangeDiscordCode(env, "embedded-sdk-code")).resolves.toMatchObject({ accessToken: "oauth-token", scope: "identify" });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("preserves an explicitly supplied redirect URI for its matching code exchange", async () => {
    const env = loadEnv({ NODE_ENV: "test", DISCORD_REDIRECT_URI: "https://portal.example/callback" });
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(new URLSearchParams(String(init?.body)).get("redirect_uri")).toBe(env.DISCORD_REDIRECT_URI);
      return new Response(JSON.stringify({ access_token: "oauth-token", token_type: "Bearer", expires_in: 3600 }));
    }));
    await exchangeDiscordCode(env, "browser-code", env.DISCORD_REDIRECT_URI);
  });

  it("rejects an unrecognized explicit redirect URI before attempting OAuth exchange", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "false" }));
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    try {
      const response = await app.inject({ method: "POST", url: "/api/discord/exchange", payload: {
        code: "code", instanceId: "instance-1", redirectUri: "https://unrecognized.example/callback"
      } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("invalid_redirect_uri");
      expect(upstream).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("exchanges a dev mock code for an app token and identifies /api/me", async () => {
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough"
    }));

    const exchange = await app.inject({
      method: "POST",
      url: "/api/discord/exchange",
      payload: {
        code: "dev-mock:dev-user-host",
        instanceId: "instance-1",
        guildId: "guild-1",
        channelId: "channel-1",
        mockUser: {
          id: "dev-user-host",
          username: "DevHost",
          globalName: "Dev Host",
          avatar: null
        }
      }
    });

    expect(exchange.statusCode).toBe(200);
    const body = exchange.json();
    expect(body.user.username).toBe("DevHost");
    expect(body.appToken).toEqual(expect.any(String));

    const me = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        authorization: `Bearer ${body.appToken}`
      }
    });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      discordUser: {
        id: "dev-user-host",
        username: "DevHost"
      },
      jellyfinLinked: false,
      discordContext: {
        instanceId: "instance-1"
      }
    });

    await app.close();
  });

  it("rejects /api/me without a bearer app token", async () => {
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough"
    }));

    const response = await app.inject("/api/me");

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "missing_app_token"
      }
    });

    await app.close();
  });

  it("rejects expired app sessions", async () => {
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough",
      APP_SESSION_TTL_SECONDS: "1"
    }));

    const exchange = await app.inject({
      method: "POST",
      url: "/api/discord/exchange",
      payload: {
        code: "dev-mock:dev-user-expired",
        instanceId: "instance-expired",
        mockUser: {
          id: "dev-user-expired",
          username: "ExpiredUser",
          avatar: null
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: {
        authorization: `Bearer ${exchange.json().appToken as string}`
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_app_token"
      }
    });

    await app.close();
  });
});
