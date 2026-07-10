import {
  apiError,
  jellyfinItemDetailsResponseSchema,
  jellyfinItemsQuerySchema,
  jellyfinItemsResponseSchema,
  jellyfinLibrariesResponseSchema
} from "@app/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AuthError, requireAppSession, sendAuthError } from "../plugins/auth.js";
import { getItem, getItemImage, getLibraries, JellyfinError, searchItems } from "../services/jellyfin.js";
import { JellyfinAccountResolutionError, withResolvedJellyfinAccount } from "../services/jellyfinAccountResolver.js";

const imageQuerySchema = z.object({
  width: z.coerce.number().int().positive().optional(),
  height: z.coerce.number().int().positive().optional(),
  tag: z.string().optional()
});

export const jellyfinLibraryRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/jellyfin/libraries", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const libraries = await withResolvedJellyfinAccount(app.envConfig, session.discordUserId, (account) => (
        getLibraries(app.envConfig, account)
      ));

      return reply.send(jellyfinLibrariesResponseSchema.parse({ libraries }));
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(401).send(sendAuthError(error));
      }

      if (error instanceof JellyfinAccountResolutionError) {
        return reply.code(error.statusCode).send(apiError(error.code, error.publicMessage));
      }

      if (error instanceof JellyfinError) {
        const statusCode = error.code === "jellyfin_token_invalid" ? 401 : 502;
        return reply.code(statusCode).send(apiError(error.code, error.publicMessage));
      }

      request.log.warn({ err: error }, "Jellyfin libraries request failed");
      return reply.code(500).send(apiError("jellyfin_libraries_failed", "Could not load Jellyfin libraries."));
    }
  });

  app.get("/api/jellyfin/items", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const parsed = jellyfinItemsQuerySchema.safeParse(request.query);

      if (!parsed.success) {
        return reply.code(400).send(apiError("invalid_request", "Invalid Jellyfin item search request.", z.treeifyError(parsed.error)));
      }

      const result = await withResolvedJellyfinAccount(app.envConfig, session.discordUserId, (account) => (
        searchItems(app.envConfig, account, parsed.data)
      ));

      return reply.send(jellyfinItemsResponseSchema.parse(result));
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(401).send(sendAuthError(error));
      }

      if (error instanceof JellyfinAccountResolutionError) {
        return reply.code(error.statusCode).send(apiError(error.code, error.publicMessage));
      }

      if (error instanceof JellyfinError) {
        const statusCode = error.code === "jellyfin_token_invalid" ? 401 : 502;
        return reply.code(statusCode).send(apiError(error.code, error.publicMessage));
      }

      request.log.warn({ err: error }, "Jellyfin item search failed");
      return reply.code(500).send(apiError("jellyfin_items_failed", "Could not load Jellyfin items."));
    }
  });

  app.get<{ Params: { itemId: string } }>("/api/jellyfin/items/:itemId/image", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const itemId = request.params.itemId;
      const parsed = imageQuerySchema.safeParse(request.query);

      if (!itemId) {
        return reply.code(400).send(apiError("invalid_request", "Missing Jellyfin item id."));
      }

      if (!parsed.success) {
        return reply.code(400).send(apiError("invalid_request", "Invalid Jellyfin image request.", z.treeifyError(parsed.error)));
      }

      const image = await withResolvedJellyfinAccount(app.envConfig, session.discordUserId, (account) => (
        getItemImage(app.envConfig, account, itemId, parsed.data)
      ));

      reply
        .header("Content-Type", image.contentType)
        .header("Cache-Control", "private, max-age=86400");

      if (image.etag) {
        reply.header("ETag", image.etag);
      }

      return reply.send(image.body);
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(401).send(sendAuthError(error));
      }

      if (error instanceof JellyfinAccountResolutionError) {
        return reply.code(error.statusCode).send(apiError(error.code, error.publicMessage));
      }

      if (error instanceof JellyfinError) {
        const statusCode = error.code === "jellyfin_image_not_found" ? 404 : error.code === "jellyfin_token_invalid" ? 401 : 502;
        return reply.code(statusCode).send(apiError(error.code, error.publicMessage));
      }

      request.log.warn({ err: error }, "Jellyfin image request failed");
      return reply.code(500).send(apiError("jellyfin_image_failed", "Could not load Jellyfin image."));
    }
  });

  app.get<{ Params: { itemId: string } }>("/api/jellyfin/items/:itemId", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const itemId = request.params.itemId;

      if (!itemId) {
        return reply.code(400).send(apiError("invalid_request", "Missing Jellyfin item id."));
      }

      const item = await withResolvedJellyfinAccount(app.envConfig, session.discordUserId, (account) => (
        getItem(app.envConfig, account, itemId)
      ));

      return reply.send(jellyfinItemDetailsResponseSchema.parse({ item }));
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(401).send(sendAuthError(error));
      }

      if (error instanceof JellyfinAccountResolutionError) {
        return reply.code(error.statusCode).send(apiError(error.code, error.publicMessage));
      }

      if (error instanceof JellyfinError) {
        const statusCode = error.code === "jellyfin_item_not_found" ? 404 : error.code === "jellyfin_token_invalid" ? 401 : 502;
        return reply.code(statusCode).send(apiError(error.code, error.publicMessage));
      }

      request.log.warn({ err: error }, "Jellyfin item details failed");
      return reply.code(500).send(apiError("jellyfin_item_failed", "Could not load Jellyfin item."));
    }
  });
};
