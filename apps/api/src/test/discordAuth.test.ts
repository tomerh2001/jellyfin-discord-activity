import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";

describe("Discord auth routes", () => {
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
