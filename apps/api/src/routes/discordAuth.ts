import {
  apiError,
  discordExchangeRequestSchema,
  logoutResponseSchema,
  meResponseSchema
} from "@app/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createAppSession, getBearerToken, verifyAppToken } from "../services/appSession.js";
import { DiscordOAuthError, exchangeDiscordCode, getDiscordCurrentUser } from "../services/discord.js";
import { sessionStore } from "../services/sessionStore.js";
import { AuthError, getAppSessionUser, requireAppSession, sendAuthError } from "../plugins/auth.js";
import { JellyfinAccountStore } from "../services/jellyfinAccountStore.js";

export const discordAuthRoutes: FastifyPluginAsync = async (app) => {
  app.post("/api/discord/exchange", async (request, reply) => {
    const parsed = discordExchangeRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(apiError("invalid_request", "Invalid Discord exchange request.", z.treeifyError(parsed.error)));
    }

    const discordContext = {
      instanceId: parsed.data.instanceId,
      ...(parsed.data.guildId ? { guildId: parsed.data.guildId } : {}),
      ...(parsed.data.channelId ? { channelId: parsed.data.channelId } : {})
    };

    try {
      const shouldMock = app.envConfig.DEV_AUTH_MOCK;
      const tokenResult = shouldMock
        ? {
            accessToken: `dev-discord-token-${Date.now()}`,
            tokenType: "Bearer",
            expiresIn: app.envConfig.APP_SESSION_TTL_SECONDS
          }
        : await exchangeDiscordCode(app.envConfig, parsed.data.code, parsed.data.redirectUri);

      const user = shouldMock
        ? parsed.data.mockUser ?? {
            id: "dev-user-host",
            username: "DevHost",
            avatar: null
          }
        : await getDiscordCurrentUser(tokenResult.accessToken);

      const { appToken, session } = await createAppSession({
        env: app.envConfig,
        user,
        discordContext
      });

      return reply.send({
        appToken,
        discordAccessToken: tokenResult.accessToken,
        user,
        expiresAt: session.expiresAt.toISOString()
      });
    } catch (error) {
      request.log.warn({ err: error }, "Discord exchange failed");

      if (error instanceof DiscordOAuthError) {
        return reply.code(502).send(apiError(error.code, "Discord authentication failed."));
      }

      return reply.code(500).send(apiError("discord_exchange_failed", "Discord authentication failed."));
    }
  });

  app.get("/api/me", async (request, reply) => {
    try {
      const session = await requireAppSession(request);
      const user = getAppSessionUser(session);

      if (!user) {
        return reply.code(401).send(apiError("invalid_app_token", "Invalid or expired app token."));
      }

      const jellyfinStore = new JellyfinAccountStore(app.envConfig);
      const jellyfinAccount = await jellyfinStore.get(session.discordUserId);
      const response = meResponseSchema.parse({
        discordUser: user,
        jellyfinLinked: app.envConfig.JELLYFIN_AUTH_MODE === "shared" || Boolean(jellyfinAccount),
        ...(session.discordContext ? { discordContext: session.discordContext } : {}),
        appSessionExpiresAt: session.expiresAt.toISOString()
      });

      return reply.send(response);
    } catch (error) {
      if (error instanceof AuthError) {
        return reply.code(401).send(sendAuthError(error));
      }

      throw error;
    }
  });

  app.post("/api/logout", async (request, reply) => {
    const token = getBearerToken(request.headers.authorization);

    if (token) {
      try {
        const session = await verifyAppToken(app.envConfig, token);
        sessionStore.deleteSession(session.id);
      } catch {
        request.log.debug("Ignoring logout for invalid app token.");
      }
    }

    return reply.send(logoutResponseSchema.parse({ ok: true }));
  });
};
