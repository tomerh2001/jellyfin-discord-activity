import {
  apiError,
  claimHostRequestSchema,
  currentRoomQuerySchema,
  roomResponseSchema,
  selectMediaRequestSchema
} from "@app/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AuthError, requireAppSession, requireRoomContext, sendAuthError } from "../plugins/auth.js";
import { broadcastParticipants, broadcastRoomState } from "../ws/handlers.js";
import { roomSocketHub } from "../ws/roomSocket.js";
import { roomManager, RoomError } from "../services/roomManager.js";

export const roomRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/rooms/current", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = currentRoomQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send(apiError("invalid_request", "Invalid room request.", z.treeifyError(parsed.error)));
      }
      const context = requireRoomContext(session, parsed.data);
      const room = roomManager.getOrCreate(context.instanceId, context);
      return reply.send(roomResponseSchema.parse({ room }));
    } catch (error) {
      if (error instanceof AuthError) return reply.code(error.statusCode).send(sendAuthError(error));
      if (error instanceof RoomError) return reply.code(403).send(apiError(error.code, error.publicMessage));
      throw error;
    }
  });

  app.post("/api/rooms/current/claim-host", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = claimHostRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send(apiError("invalid_request", "Invalid host claim request.", z.treeifyError(parsed.error)));
      }

      const context = requireRoomContext(session, parsed.data);
      const room = roomManager.claimHost(context, session.discordUserId);
      broadcastRoomState(context.instanceId);
      broadcastParticipants(context.instanceId);
      roomSocketHub.broadcast(context.instanceId, {
        type: "host_changed", hostDiscordUserId: session.discordUserId, serverTs: Date.now()
      });
      return reply.send(roomResponseSchema.parse({ room }));
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(error.statusCode).send(sendAuthError(error));
      }

      if (error instanceof RoomError) {
        return reply.code(409).send(apiError(error.code, error.publicMessage));
      }

      throw error;
    }
  });

  app.post("/api/rooms/current/select-media", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = selectMediaRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send(apiError("invalid_request", "Invalid media selection request.", z.treeifyError(parsed.error)));
      }

      requireRoomContext(session, parsed.data);
      const room = roomManager.selectMedia(parsed.data, session.discordUserId);
      roomSocketHub.broadcast(room.instanceId, {
        type: "media_selected", itemId: parsed.data.itemId, title: parsed.data.title,
        ...(room.mediaSourceId ? { mediaSourceId: room.mediaSourceId } : {}),
        ...(room.runtimeTicks ? { runtimeTicks: room.runtimeTicks } : {}),
        ...(room.audioStreamIndex !== undefined ? { audioStreamIndex: room.audioStreamIndex } : {}),
        ...(room.subtitleStreamIndex !== undefined ? { subtitleStreamIndex: room.subtitleStreamIndex } : {}),
        serverTs: Date.now()
      });
      broadcastRoomState(room.instanceId);
      return reply.send(roomResponseSchema.parse({ room }));
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(error.statusCode).send(sendAuthError(error));
      }

      if (error instanceof RoomError) {
        return reply.code(403).send(apiError(error.code, error.publicMessage));
      }

      throw error;
    }
  });
};
