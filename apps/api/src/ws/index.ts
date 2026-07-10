import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { generateId } from "../services/crypto.js";
import { verifyAppToken } from "../services/appSession.js";
import { sessionStore } from "../services/sessionStore.js";
import { roomManager } from "../services/roomManager.js";
import {
  broadcastParticipants,
  handleRawMessage,
  sendRoomSnapshot
} from "./handlers.js";
import { roomSocketHub, type RoomSocket, type WebSocketLike } from "./roomSocket.js";

const wsQuerySchema = z.object({
  token: z.string().min(1),
  instanceId: z.string().min(1)
});

export const wsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ws", { websocket: true }, async (socket, request) => {
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

    if (roomSocketHub.roomSize(parsed.data.instanceId) >= app.envConfig.ROOM_MAX_PARTICIPANTS) {
      closeWithError(socket, "room_full", "Room is full.");
      return;
    }

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
    sendRoomSnapshot(client);

    socket.on("message", (raw: unknown) => {
      try {
        handleRawMessage(app.envConfig, client, raw);
      } catch (error) {
        request.log.warn({ err: error }, "WebSocket message handling failed");
        socket.close(1011, "message handling failed");
      }
    });

    socket.on("close", () => {
      roomSocketHub.remove(client);
      broadcastParticipants(client.instanceId);
    });

    socket.on("error", () => {
      roomSocketHub.remove(client);
      broadcastParticipants(client.instanceId);
    });
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
