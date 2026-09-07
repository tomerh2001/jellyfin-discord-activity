import type { ServerMessage } from "@app/shared/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { roomManager } from "../services/roomManager.js";
import { roomSocketHub } from "../ws/roomSocket.js";

describe("websocket room sync", () => {
  afterEach(() => {
    roomSocketHub.clear();
  });

  it("delivers HTTP fallback media selections to viewers already connected over WebSocket", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", LOG_LEVEL: "silent" }));
    const roomId = "http-selection-room";
    const hostToken = await createAppToken(app, "http-host", roomId);
    const guestToken = await createAppToken(app, "http-guest", roomId);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const url = (token: string) => `${websocketBaseUrl(app)}/ws?token=${encodeURIComponent(token)}&instanceId=${roomId}`;
    const host = await connectWs(url(hostToken));
    const guest = await connectWs(url(guestToken));
    await guest.next("room_state");
    const selected = await app.inject({ method: "POST", url: "/api/rooms/current/select-media",
      headers: { authorization: `Bearer ${hostToken}` }, payload: {
        instanceId: roomId, itemId: "new-movie", title: "New Movie", mediaSourceId: "new-source", audioStreamIndex: 3
      }
    });
    expect(selected.statusCode).toBe(200);
    expect(await guest.next("media_selected")).toMatchObject({ itemId: "new-movie", mediaSourceId: "new-source", audioStreamIndex: 3 });
    expect((await guest.next("room_state")).room).toMatchObject({ itemId: "new-movie", positionSeconds: 0, playState: "loading" });
    host.ws.close(); guest.ws.close();
    await app.close();
  });

  it("rejects cross-instance connections and forged hello context", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", LOG_LEVEL: "silent" }));
    const token = await createAppToken(app, "confined", "confined-room");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = websocketBaseUrl(app);
    const forbidden = await connectWs(`${baseUrl}/ws?token=${encodeURIComponent(token)}&instanceId=other-room`);
    expect((await forbidden.next("error")).code).toBe("room_access_denied");
    const client = await connectWs(`${baseUrl}/ws?token=${encodeURIComponent(token)}&instanceId=confined-room`);
    await client.next("room_state");
    client.send({ type: "hello", instanceId: "other-room", ts: Date.now() });
    expect((await client.next("error")).code).toBe("room_access_denied");
    client.send({ type: "hello", instanceId: "confined-room", guildId: "forged", ts: Date.now() });
    expect((await client.next("error")).code).toBe("room_access_denied");
    expect(roomManager.has("other-room")).toBe(false);
    forbidden.ws.close();
    client.ws.close();
    await app.close();
  });

  it("keeps duplicate host connections and hands off after the last host connection leaves", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", LOG_LEVEL: "silent" }));
    const roomId = "duplicate-host-room";
    const hostToken = await createAppToken(app, "duplicate-host", roomId);
    const guestToken = await createAppToken(app, "handoff-guest", roomId);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const url = (token: string) => `${websocketBaseUrl(app)}/ws?token=${encodeURIComponent(token)}&instanceId=${roomId}`;
    const firstHost = await connectWs(url(hostToken));
    const secondHost = await connectWs(url(hostToken));
    const guest = await connectWs(url(guestToken));
    await guest.next("room_state");
    expect(roomSocketHub.participants(roomId)).toHaveLength(2);
    firstHost.ws.close();
    await waitUntil(() => roomSocketHub.roomSize(roomId) === 2);
    expect(roomManager.get(roomId)?.hostDiscordUserId).toBe("dev-user-duplicate-host");
    secondHost.ws.close();
    expect((await guest.next("host_changed")).hostDiscordUserId).toBe("dev-user-handoff-guest");
    guest.send({ type: "select_media", itemId: "next-movie", title: "Next movie", ts: Date.now() });
    expect((await guest.next("media_selected")).itemId).toBe("next-movie");
    guest.ws.close();
    await waitUntil(() => roomSocketHub.roomSize(roomId) === 0);
    expect(roomManager.get(roomId)?.hostDiscordUserId).toBeUndefined();
    await app.close();
  });

  it("revokes open sockets immediately on logout and prevents further host control", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", LOG_LEVEL: "silent" }));
    const token = await createAppToken(app, "logout-socket", "logout-room");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const client = await connectWs(`${websocketBaseUrl(app)}/ws?token=${encodeURIComponent(token)}&instanceId=logout-room`);
    await client.next("room_state");
    const closed = new Promise<number>((resolve) => client.ws.addEventListener("close", (event) => resolve(event.code), { once: true }));
    await app.inject({ method: "POST", url: "/api/logout", headers: { authorization: `Bearer ${token}` } });
    expect(await closed).toBe(1008);
    expect(roomSocketHub.roomSize("logout-room")).toBe(0);
    expect(roomManager.get("logout-room")?.hostDiscordUserId).toBeUndefined();
    await app.close();
  });

  it("closes an already connected socket when its session expires", async () => {
    const app = await buildApp(loadEnv({ NODE_ENV: "test", DEV_AUTH_MOCK: "true", LOG_LEVEL: "silent", APP_SESSION_TTL_SECONDS: "2" }));
    const token = await createAppToken(app, "live-expiry", "live-expiry-room");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const client = await connectWs(`${websocketBaseUrl(app)}/ws?token=${encodeURIComponent(token)}&instanceId=live-expiry-room`);
    await client.next("room_state");
    const closed = new Promise<number>((resolve) => client.ws.addEventListener("close", (event) => resolve(event.code), { once: true }));
    expect(await closed).toBe(1008);
    expect(roomSocketHub.roomSize("live-expiry-room")).toBe(0);
    await app.close();
  });

  it("syncs host playback events to participants and rejects participant commands", async () => {
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough"
    }));
    const hostToken = await createAppToken(app, "host");
    const guestToken = await createAppToken(app, "guest");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = websocketBaseUrl(app);
    const host = await connectWs(`${baseUrl}/ws?token=${encodeURIComponent(hostToken)}&instanceId=room-ws-1`);
    const guest = await connectWs(`${baseUrl}/ws?token=${encodeURIComponent(guestToken)}&instanceId=room-ws-1`);

    expect((await guest.next("room_state")).room).toMatchObject({
      instanceId: "room-ws-1",
      playState: "idle"
    });

    host.send({
      type: "claim_host",
      ts: Date.now()
    });

    expect((await guest.next("host_changed")).hostDiscordUserId).toBe("dev-user-host");

    host.send({
      type: "select_media",
      itemId: "movie-1",
      mediaSourceId: "media-1",
      title: "Example Movie",
      audioStreamIndex: 2,
      subtitleStreamIndex: 4,
      ts: Date.now()
    });

    expect(await guest.next("media_selected")).toMatchObject({
      itemId: "movie-1",
      mediaSourceId: "media-1",
      title: "Example Movie",
      audioStreamIndex: 2,
      subtitleStreamIndex: 4
    });

    host.send({
      type: "player_event",
      action: "play",
      positionSeconds: 12.5,
      ts: Date.now()
    });

    expect(await guest.next("player_event")).toMatchObject({
      action: "play",
      positionSeconds: 12.5
    });

    guest.send({
      type: "player_event",
      action: "pause",
      positionSeconds: 99,
      ts: Date.now()
    });

    expect(await guest.next("error")).toMatchObject({
      code: "not_room_host"
    });

    guest.send({
      type: "ping",
      clientTs: 123,
      ts: Date.now()
    });

    expect(await guest.next("pong")).toMatchObject({
      clientTs: 123
    });

    guest.ws.close();
    const reconnectedGuest = await connectWs(`${baseUrl}/ws?token=${encodeURIComponent(guestToken)}&instanceId=room-ws-1`);
    expect((await reconnectedGuest.next("room_state")).room).toMatchObject({
      hostDiscordUserId: "dev-user-host",
      itemId: "movie-1",
      mediaSourceId: "media-1",
      audioStreamIndex: 2,
      subtitleStreamIndex: 4,
      playState: "playing",
      positionSeconds: 12.5
    });

    host.ws.close();
    reconnectedGuest.ws.close();
    await app.close();
  });

  it("rejects invalid websocket messages safely", async () => {
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough"
    }));
    const token = await createAppToken(app, "invalid-message", "room-invalid-message");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const client = await connectWs(`${websocketBaseUrl(app)}/ws?token=${encodeURIComponent(token)}&instanceId=room-invalid-message`);

    client.ws.send("not-json");

    expect(await client.next("error")).toMatchObject({
      code: "invalid_json"
    });

    client.ws.close();
    await app.close();
  });

  it("rejects websocket connections over the participant limit", async () => {
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough",
      ROOM_MAX_PARTICIPANTS: "1"
    }));
    const firstToken = await createAppToken(app, "first", "room-full");
    const secondToken = await createAppToken(app, "second", "room-full");
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = websocketBaseUrl(app);
    const first = await connectWs(`${baseUrl}/ws?token=${encodeURIComponent(firstToken)}&instanceId=room-full`);
    const second = await connectWs(`${baseUrl}/ws?token=${encodeURIComponent(secondToken)}&instanceId=room-full`);

    expect(await second.next("error")).toMatchObject({
      code: "room_full"
    });

    first.ws.close();
    second.ws.close();
    await app.close();
  });

  it("rejects expired app sessions on websocket connect", async () => {
    const app = await buildApp(loadEnv({
      NODE_ENV: "test",
      DEV_AUTH_MOCK: "true",
      APP_SESSION_SECRET: "test-session-secret-that-is-long-enough",
      APP_SESSION_TTL_SECONDS: "1"
    }));
    const token = await createAppToken(app, "expired-ws", "room-expired");
    await app.listen({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const client = await connectWs(`${websocketBaseUrl(app)}/ws?token=${encodeURIComponent(token)}&instanceId=room-expired`);

    expect(await client.next("error")).toMatchObject({
      code: "invalid_app_token"
    });

    client.ws.close();
    await app.close();
  });
});

async function connectWs(url: string) {
  const messages: ServerMessage[] = [];
  const waiters = new Map<string, Array<(message: ServerMessage) => void>>();
  const ws = new WebSocket(url);

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    const typeWaiters = waiters.get(message.type) ?? [];
    const waiter = typeWaiters.shift();

    if (waiter) {
      waiter(message);
    } else { messages.push(message); }

    if (typeWaiters.length > 0) {
      waiters.set(message.type, typeWaiters);
    } else {
      waiters.delete(message.type);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out opening websocket")), 1000);
    ws.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket open failed"));
    }, { once: true });
  });

  return {
    ws,
    send(message: unknown) {
      ws.send(JSON.stringify(message));
    },
    next<T extends ServerMessage["type"]>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
      const existingIndex = messages.findIndex((message) => message.type === type);

      if (existingIndex >= 0) {
        const [message] = messages.splice(existingIndex, 1);
        return Promise.resolve(message as Extract<ServerMessage, { type: T }>);
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 1000);
        const nextWaiter = (message: ServerMessage) => {
          clearTimeout(timeout);
          resolve(message as Extract<ServerMessage, { type: T }>);
        };
        const typeWaiters = waiters.get(type) ?? [];
        typeWaiters.push(nextWaiter);
        waiters.set(type, typeWaiters);
      });
    }
  };
}

function websocketBaseUrl(app: Awaited<ReturnType<typeof buildApp>>): string {
  const address = app.server.address();

  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP address.");
  }

  return `ws://127.0.0.1:${address.port}`;
}

async function createAppToken(app: Awaited<ReturnType<typeof buildApp>>, suffix: string, instanceId = "room-ws-1"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/discord/exchange",
    payload: {
      code: `dev-mock:dev-user-${suffix}`,
      instanceId,
      mockUser: {
        id: `dev-user-${suffix}`,
        username: `Dev${suffix}`,
        avatar: null
      }
    }
  });

  return response.json().appToken as string;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for socket cleanup");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
