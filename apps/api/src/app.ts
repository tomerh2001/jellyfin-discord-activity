import { apiError } from "@app/shared";
import Fastify, { type FastifyBaseLogger, type RawServerDefault } from "fastify";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEnv, type AppEnv } from "./env.js";
import { loggerConfig } from "./logger.js";
import { discordProxyPlugin } from "./plugins/discordProxy.js";
import { securityPlugin } from "./plugins/security.js";
import { staticFrontendPlugin } from "./plugins/static.js";
import { websocketPlugin } from "./plugins/websocket.js";
import { discordAuthRoutes } from "./routes/discordAuth.js";
import { discordInteractionRoutes } from "./routes/discordInteractions.js";
import { healthRoutes } from "./routes/health.js";
import { connectionRoutes } from "./routes/connections.js";
import { nativePartyRoutes } from "./routes/nativeParty.js";
import { nativeJellyfinRoutes } from "./routes/nativeJellyfin.js";
import { getNativePartyService } from "./services/nativeParty.js";
import { AuthError, sendAuthError } from "./plugins/auth.js";

export async function buildApp(env: AppEnv = loadEnv()) {
  const app = Fastify<RawServerDefault, IncomingMessage, ServerResponse, FastifyBaseLogger>({
    ...loggerConfig(env),
    trustProxy: env.TRUST_PROXY
  });

  app.decorate("envConfig", env);
  app.decorateRequest("appSession");
  getNativePartyService(app);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthError) return reply.code(error.statusCode).send(sendAuthError(error));
    const appShapedError = error as unknown as { error?: { code?: string; message?: string }; statusCode?: number };
    const message = error instanceof Error ? error.message : "Request failed";

    if (appShapedError.error?.code && appShapedError.error.message) {
      const statusCode = appShapedError.statusCode ?? (appShapedError.error.code === "rate_limit_exceeded" ? 429 : 500);
      return reply.code(statusCode).send(appShapedError);
    }

    if (typeof appShapedError.statusCode === "number" && appShapedError.statusCode >= 400 && appShapedError.statusCode < 500) {
      return reply.code(appShapedError.statusCode).send(apiError("request_failed", message));
    }

    request.log.error({ err: error }, "request failed");
    return reply.code(500).send(apiError("internal_error", "Internal server error."));
  });

  await app.register(websocketPlugin);
  await app.register(discordProxyPlugin(env));
  await app.register(securityPlugin(env));
  await app.register(healthRoutes);
  await app.register(discordAuthRoutes);
  await app.register(discordInteractionRoutes);
  await app.register(connectionRoutes);
  await app.register(nativePartyRoutes);
  await app.register(nativeJellyfinRoutes);
  await app.register(staticFrontendPlugin);

  return app;
}
