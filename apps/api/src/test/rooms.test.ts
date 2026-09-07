import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";

describe("room routes", () => {
  it("requires authentication and rejects cross-instance or forged channel operations", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", LOG_LEVEL: "silent" }));
    const token = await createAppToken(app, "bound", "bound-room");
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject("/api/rooms/current?instanceId=bound-room")).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/rooms/current?instanceId=other-room", headers })).statusCode).toBe(403);
    for (const payload of [
      { instanceId: "other-room" },
      { instanceId: "bound-room", guildId: "forged-guild" },
      { instanceId: "bound-room", channelId: "forged-channel" }
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/rooms/current/claim-host", headers, payload });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("room_access_denied");
    }
    expect((await app.inject({ method: "POST", url: "/api/rooms/current/select-media", headers,
      payload: { instanceId: "other-room", itemId: "movie-1", title: "Test" } })).statusCode).toBe(403);
    await app.close();
  });

  it("lets a host claim and select media", async () => {
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough"
    }));
    const appToken = await createAppToken(app, "host", "room-1");

    const current = await app.inject({ url: "/api/rooms/current?instanceId=room-1", headers: { authorization: `Bearer ${appToken}` } });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({
      room: {
        instanceId: "room-1",
        playState: "idle"
      }
    });

    const claim = await app.inject({
      method: "POST",
      url: "/api/rooms/current/claim-host",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        instanceId: "room-1",
        guildId: "guild-1",
        channelId: "channel-1"
      }
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().room.hostDiscordUserId).toBe("dev-user-host");

    const select = await app.inject({
      method: "POST",
      url: "/api/rooms/current/select-media",
      headers: {
        authorization: `Bearer ${appToken}`
      },
      payload: {
        instanceId: "room-1",
        itemId: "movie-1",
        title: "Example Movie",
        runtimeTicks: 72000000000,
        mediaSourceId: "media-1",
        audioStreamIndex: 2,
        subtitleStreamIndex: 4
      }
    });
    expect(select.statusCode).toBe(200);
    expect(select.json()).toMatchObject({
      room: {
        itemId: "movie-1",
        title: "Example Movie",
        mediaSourceId: "media-1",
        audioStreamIndex: 2,
        subtitleStreamIndex: 4,
        playState: "loading"
      }
    });

    await app.close();
  });

  it("rejects non-host media selection", async () => {
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough"
    }));
    const hostToken = await createAppToken(app, "host", "room-2");
    const guestToken = await createAppToken(app, "guest", "room-2");

    await app.inject({
      method: "POST",
      url: "/api/rooms/current/claim-host",
      headers: {
        authorization: `Bearer ${hostToken}`
      },
      payload: {
        instanceId: "room-2"
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/current/select-media",
      headers: {
        authorization: `Bearer ${guestToken}`
      },
      payload: {
        instanceId: "room-2",
        itemId: "movie-1",
        title: "Example Movie"
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: "not_room_host"
      }
    });

    await app.close();
  });
});

async function createAppToken(app: Awaited<ReturnType<typeof buildApp>>, suffix: string, instanceId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/discord/exchange",
    payload: {
      code: `dev-mock:dev-user-${suffix}`,
      instanceId,
      guildId: "guild-1",
      channelId: "channel-1",
      mockUser: {
        id: `dev-user-${suffix}`,
        username: `Dev${suffix}`,
        avatar: null
      }
    }
  });

  return response.json().appToken as string;
}
