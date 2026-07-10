import {
  apiError,
  claimHostRequestSchema,
  currentRoomQuerySchema,
  roomResponseSchema,
  selectMediaRequestSchema
} from "@app/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AuthError, requireAppSession, sendAuthError } from "../plugins/auth.js";
import { roomManager, RoomError } from "../services/roomManager.js";

export const roomRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/rooms/current", async (request, reply) => {
    const parsed = currentRoomQuerySchema.safeParse(request.query);

    if (!parsed.success) {
      return reply.code(400).send(apiError("invalid_request", "Invalid room request.", z.treeifyError(parsed.error)));
    }

    const room = roomManager.getOrCreate(parsed.data.instanceId);
    return reply.send(roomResponseSchema.parse({ room }));
  });

  app.post("/api/rooms/current/claim-host", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = claimHostRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send(apiError("invalid_request", "Invalid host claim request.", z.treeifyError(parsed.error)));
      }

      const room = roomManager.claimHost(parsed.data, session.discordUserId);
      return reply.send(roomResponseSchema.parse({ room }));
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(401).send(sendAuthError(error));
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

      const room = roomManager.selectMedia(parsed.data, session.discordUserId);
      return reply.send(roomResponseSchema.parse({ room }));
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(401).send(sendAuthError(error));
      }

      if (error instanceof RoomError) {
        return reply.code(403).send(apiError(error.code, error.publicMessage));
      }

      throw error;
    }
  });
};
