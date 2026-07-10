import websocket from "@fastify/websocket";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const plugin: FastifyPluginAsync = async (app) => {
  await app.register(websocket, {
    options: {
      maxPayload: 16 * 1024
    }
  });
};

export const websocketPlugin = fp(plugin, {
  name: "websocket-plugin"
});
