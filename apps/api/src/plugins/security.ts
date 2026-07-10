import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { apiError } from "@app/shared";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { AppEnv } from "../env.js";
import { allowedOrigins } from "../env.js";

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
        return request.url.startsWith("/media/") || request.url === "/health" || request.url === "/api/health";
      },
      keyGenerator(request) {
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
