import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireRoomContext } from "../plugins/auth.js";
import { generateId } from "../services/crypto.js";
import { verifyAppToken } from "../services/appSession.js";
import { sessionStore } from "../services/sessionStore.js";
import { roomManager } from "../services/roomManager.js";
import {
  disconnectClient,
  reconcileRoomHost,
  validateSocketSession,
  handleRawMessage,
  sendRoomSnapshot
} from "./handlers.js";
import { roomSocketHub, type RoomSocket, type WebSocketLike } from "./roomSocket.js";

const wsQuerySchema = z.object({
  token: z.string().min(1),
  instanceId: z.string().min(1)
});

export const wsRoutes: FastifyPluginAsync = async (app) => {
  const unsubscribe = sessionStore.onRevoke((sessionId) => {
    for (const client of roomSocketHub.clients()) {
      if (client.session.id === sessionId) {
        disconnectClient(client);
        client.socket.close(1008, "invalid_app_token");
      }
    }
  });
  app.addHook("onClose", async () => { unsubscribe(); });
  app.get("/ws", { websocket: true }, async (socket, request) => {
    // Install listeners before async authentication so early messages/close events are not lost.
    const pending: unknown[] = [];
    let receive = (raw: unknown) => {
      if (pending.length >= 8) closeWithError(socket, "too_many_messages", "Wait for authentication before sending more messages.");
      else pending.push(raw);
    };
    socket.on("message", (raw: unknown) => { receive(raw); });
    socket.on("error", () => { /* Cleanup is attached once authentication completes. */ });
    const parsed = wsQuerySchema.safeParse(Object.fromEntries(new URL(request.url, "ws://localhost").searchParams));

    if (!parsed.success) {
      closeWithError(socket, "invalid_request", "Missing WebSocket token or instanceId.");
      return;
    }

    let session;

    try {
      session = await verifyAppToken(app.envConfig, parsed.data.token);
    } catch {
      closeWithError(socket, "invalid_app_token", "Invalid or expired app token.");
      return;
    }

    try { requireRoomContext(session, { instanceId: parsed.data.instanceId }); }
    catch {
      closeWithError(socket, "room_access_denied", "This session cannot access that Discord Activity room.");
      return;
    }

    if (roomSocketHub.roomSize(parsed.data.instanceId) >= app.envConfig.ROOM_MAX_PARTICIPANTS) {
      closeWithError(socket, "room_full", "Room is full.");
      return;
    }

    if (socket.readyState !== 1) return;
    const user = sessionStore.getUser(session.discordUserId);
    const client: RoomSocket = {
      clientId: generateId(),
      instanceId: parsed.data.instanceId,
      session,
      username: user?.globalName ?? user?.username ?? session.discordUserId,
      ...(user?.avatar !== undefined ? { avatar: user.avatar } : {}),
      connectedAt: new Date().toISOString(),
      socket
    };

    roomManager.getOrCreate(parsed.data.instanceId, session.discordContext);
    roomSocketHub.add(client);
    // Reconnecting duplicate tabs keep ownership; departed hosts cannot lock the room.
    reconcileRoomHost(client.instanceId);
    sendRoomSnapshot(client);

    const expiryTimer = setTimeout(() => {
      sessionStore.deleteSession(session.id);
      disconnectClient(client);
      socket.close(1008, "invalid_app_token");
    }, Math.max(1, Math.min(2_147_483_647, session.expiresAt.getTime() - Date.now())));
    expiryTimer.unref();
    let verifying = false;
    let alive = true;
    socket.on("pong", () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!validateSocketSession(app.envConfig, client)) return;
      if (!alive) {
        disconnectClient(client);
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
      if (!verifying) {
        verifying = true;
        void verifyAppToken(app.envConfig, parsed.data.token)
          .catch(() => {
            disconnectClient(client);
            socket.close(1008, "invalid_app_token");
          })
          .finally(() => { verifying = false; });
      }
    }, 30_000);
    heartbeat.unref();
    const cleanup = () => {
      clearTimeout(expiryTimer);
      clearInterval(heartbeat);
      disconnectClient(client);
    };

    receive = (raw: unknown) => {
      try {
        handleRawMessage(app.envConfig, client, raw);
      } catch (error) {
        request.log.warn({ err: error }, "WebSocket message handling failed");
        socket.close(1011, "message handling failed");
      }
    };

    socket.on("close", cleanup);
    socket.on("error", cleanup);
    for (const raw of pending) receive(raw);
    pending.length = 0;
  });
};

function closeWithError(socket: WebSocketLike, code: string, message: string): void {
  if (socket.readyState === 1) {
    socket.send(JSON.stringify({
      type: "error",
      code,
      message,
      serverTs: Date.now()
    }));
  }

  if (typeof socket.close === "function") {
    socket.close(1008, code);
  }
}
