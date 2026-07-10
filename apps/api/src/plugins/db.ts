import type { FastifyPluginAsync } from "fastify";

export const dbPlugin: FastifyPluginAsync = async (app) => {
  app.decorate("db", null);
};
