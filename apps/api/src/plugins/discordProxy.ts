import { apiError } from "@app/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { AppEnv } from "../env.js";
import { createDiscordProxyVerifier } from "../services/discordProxySignature.js";
import { createDiscordEdgeVerifier } from "../services/discordEdgeAuth.js";

/** Global onRequest hook runs before JSON parsing, CORS, static files and WS upgrade. */
export function discordProxyPlugin(env: AppEnv): FastifyPluginAsync {
  return fp(async (app) => {
    if (env.NODE_ENV !== "production" && !env.DISCORD_REQUIRE_PROXY_AUTH) return;
    const verifyProxy = env.DISCORD_PROXY_AUTH_MODE === "cloudflare-worker"
      ? createDiscordEdgeVerifier(env.DISCORD_PROXY_EDGE_SECRET)
      : createDiscordProxyVerifier(env.DISCORD_PUBLIC_KEY);
    app.addHook("onSend", async (_request, reply, payload) => {
      // A shared cached asset would skip authentication on the next request.
      reply.header("Cache-Control", "private, no-store");
      reply.header("CDN-Cache-Control", "no-store");
      reply.header("Cloudflare-CDN-Cache-Control", "no-store");
      return payload;
    });
    app.addHook("onRequest", async (request, reply) => {
      if (request.url.split("?", 1)[0] === "/health") {
        if (request.url === "/health" && (request.method === "GET" || request.method === "HEAD")
          && isDirectLoopback(request)) return;
      } else if (request.url === "/api/discord/interactions" && request.method === "POST") {
        // Discord interaction callbacks have independent exact-body signatures.
        // The handler rejects unsigned/invalid callbacks; this is not public auth.
        return;
      } else if (verifyProxy(request.headers)) {
        return;
      }
      return reply.code(401).send(apiError("discord_proxy_required", "Open this Activity inside Discord."));
    });
  }, { name: "discord-proxy-authentication" });
}

function isDirectLoopback(request: FastifyRequest): boolean {
  // trustProxy/request.ip can be influenced by forwarded headers. The health
  // exception deliberately uses only the TCP peer and rejects any proxy headers.
  const remoteAddress = request.raw.socket.remoteAddress;
  if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1" && remoteAddress !== "::ffff:127.0.0.1") return false;
  return !Object.keys(request.headers).some((name) => name === "forwarded"
    || name.startsWith("x-forwarded-") || name === "x-real-ip"
    || name === "cf-connecting-ip" || name === "true-client-ip");
}
