import {
  apiError,
  jellyfinLinkRequestSchema,
  jellyfinLinkResponseSchema,
  jellyfinStatusSchema,
  jellyfinUnlinkResponseSchema
} from "@app/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAppSession, AuthError, sendAuthError } from "../plugins/auth.js";
import { encryptString } from "../services/crypto.js";
import { authenticateByName, JellyfinError, resolveJellyfinServerUrl } from "../services/jellyfin.js";
import { getJellyfinAccountStatus, JellyfinAccountResolutionError } from "../services/jellyfinAccountResolver.js";
import { JellyfinAccountStore } from "../services/jellyfinAccountStore.js";

export const jellyfinAuthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/jellyfin/status", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const status = await getJellyfinAccountStatus(app.envConfig, session.discordUserId);

      return reply.send(jellyfinStatusSchema.parse(status));
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(401).send(sendAuthError(error));
      }

      if (error instanceof JellyfinAccountResolutionError) {
        return reply.code(error.statusCode).send(apiError(error.code, error.publicMessage));
      }

      if (error instanceof JellyfinError) {
        const statusCode = error.code === "invalid_jellyfin_credentials" ? 401 : 502;
        return reply.code(statusCode).send(apiError(error.code, error.publicMessage));
      }

      throw error;
    }
  });

  app.post("/api/jellyfin/link", async (request, reply) => {
    try {
      const session = await requireAppSession(request);

      if (app.envConfig.JELLYFIN_AUTH_MODE === "shared") {
        return reply.code(409).send(apiError("jellyfin_shared_mode_enabled", "Jellyfin account linking is disabled because shared Jellyfin mode is enabled."));
      }

      const parsed = jellyfinLinkRequestSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.code(400).send(apiError("invalid_request", "Invalid Jellyfin link request.", z.treeifyError(parsed.error)));
      }

      const serverUrl = resolveJellyfinServerUrl(app.envConfig, parsed.data.serverUrl);
      const result = await authenticateByName({
        env: app.envConfig,
        serverUrl,
        username: parsed.data.username,
        password: parsed.data.password
      });

      const store = new JellyfinAccountStore(app.envConfig);
      const account = await store.upsert({
        discordUserId: session.discordUserId,
        serverUrl,
        jellyfinUserId: result.userId,
        jellyfinUsername: result.username,
        encryptedAccessToken: encryptString(app.envConfig, result.accessToken)
      });

      return reply.send(jellyfinLinkResponseSchema.parse({
        linked: true,
        jellyfinUser: {
          id: account.jellyfinUserId,
          name: account.jellyfinUsername
        },
        serverUrl: account.serverUrl
      }));
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(401).send(sendAuthError(error));
      }

      if (error instanceof JellyfinError) {
        const statusCode = error.code === "invalid_jellyfin_credentials" ? 401 : 502;
        return reply.code(statusCode).send(apiError(error.code, error.publicMessage));
      }

      request.log.warn({ err: error }, "Jellyfin link failed");
      return reply.code(500).send(apiError("jellyfin_link_failed", "Could not link Jellyfin account."));
    }
  });

  app.delete("/api/jellyfin/link", async (request, reply) => {
    try {
      const session = await requireAppSession(request);

      if (app.envConfig.JELLYFIN_AUTH_MODE === "shared") {
        return reply.code(409).send(apiError("jellyfin_shared_mode_enabled", "Jellyfin account linking is disabled because shared Jellyfin mode is enabled."));
      }

      const store = new JellyfinAccountStore(app.envConfig);
      await store.delete(session.discordUserId);

      return reply.send(jellyfinUnlinkResponseSchema.parse({ linked: false }));
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(401).send(sendAuthError(error));
      }

      throw error;
    }
  });
};
