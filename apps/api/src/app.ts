import { apiError } from "@app/shared";
import Fastify from "fastify";
import { loadEnv, type AppEnv } from "./env.js";
import { loggerConfig } from "./logger.js";
import { roomCleanupPlugin } from "./plugins/roomCleanup.js";
import { securityPlugin } from "./plugins/security.js";
import { staticFrontendPlugin } from "./plugins/static.js";
import { websocketPlugin } from "./plugins/websocket.js";
import { discordAuthRoutes } from "./routes/discordAuth.js";
import { discordInteractionRoutes } from "./routes/discordInteractions.js";
import { roomManager } from "./services/roomManager.js";
import { healthRoutes } from "./routes/health.js";
import { jellyfinAuthRoutes } from "./routes/jellyfinAuth.js";
import { jellyfinLibraryRoutes } from "./routes/jellyfinLibrary.js";
import { playbackRoutes } from "./routes/playback.js";
import { roomRoutes } from "./routes/rooms.js";
import { wsRoutes } from "./ws/index.js";

export async function buildApp(env: AppEnv = loadEnv()) {
  const app = Fastify({
    ...loggerConfig(env),
    trustProxy: env.TRUST_PROXY
  });

  app.decorate("envConfig", env);
  if (env.NODE_ENV !== "test") {
    roomManager.configurePersistence(env.DATABASE_URL);
    app.addHook("onClose", async () => { roomManager.flushPersistence(); });
  }
  app.decorateRequest("appSession");
  app.setErrorHandler((error, request, reply) => {
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

  await app.register(securityPlugin(env));
  await app.register(websocketPlugin);
  await app.register(healthRoutes);
  await app.register(discordAuthRoutes);
  await app.register(discordInteractionRoutes);
  await app.register(jellyfinAuthRoutes);
  await app.register(jellyfinLibraryRoutes);
  await app.register(playbackRoutes);
  await app.register(roomRoutes);
  await app.register(wsRoutes);
  await app.register(staticFrontendPlugin);
  await app.register(roomCleanupPlugin(env));

  return app;
}
