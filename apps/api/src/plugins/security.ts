import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { apiError } from "@app/shared";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { AppEnv } from "../env.js";
import { allowedOrigins } from "../env.js";
import { createHash } from "node:crypto";

export function securityPlugin(env: AppEnv): FastifyPluginAsync {
  return fp(async (app) => {
    await app.register(helmet, {
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: false,
      crossOriginResourcePolicy: false,
      frameguard: false
    });

    await app.register(cors, {
      credentials: true,
      origin(origin, callback) {
        if (!origin) {
          callback(null, true);
          return;
        }

        callback(null, allowedOrigins(env).includes(origin));
      }
    });

    await app.register(rateLimit, {
      max: env.RATE_LIMIT_MAX,
      timeWindow: env.RATE_LIMIT_WINDOW,
      allowList(request) {
        // Static chunks and media segments have their own ingress/capability checks;
        // they must not consume the JSON/control request budget while watching.
        return request.url.startsWith("/jellyfin-web/")
          || /^\/jf\/[^/]+\/(?:Videos\/|Audio\/|Items\/[^/]+\/Images(?:\/|\?))/i.test(request.url)
          || request.url === "/health" || request.url === "/api/health";
      },
      keyGenerator(request) {
        const capability = /^\/jf\/([^/]+)\//.exec(request.url)?.[1];
        if (capability) return `viewer:${createHash("sha256").update(capability).digest("hex")}`;
        return request.ip;
      },
      errorResponseBuilder() {
        return apiError("rate_limit_exceeded", "Too many requests. Try again shortly.");
      }
    });
  }, {
    name: "security-plugin"
  });
}
