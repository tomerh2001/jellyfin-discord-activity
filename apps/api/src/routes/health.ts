import { HEALTH_RESPONSE } from "@app/shared";
import type { FastifyPluginAsync } from "fastify";

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => HEALTH_RESPONSE);
  app.get("/api/health", async () => HEALTH_RESPONSE);
  app.get("/api/config", async () => ({
    publicBaseUrl: app.envConfig.PUBLIC_BASE_URL,
    publicDiscordClientId: app.envConfig.PUBLIC_DISCORD_CLIENT_ID
  }));
};
