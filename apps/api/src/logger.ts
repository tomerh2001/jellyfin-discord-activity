import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import type { FastifyRequest } from "fastify";
import pino, { type DestinationStream, type Level } from "pino";
import type { AppEnv } from "./env.js";

export type FastifyLoggerSetup =
  | { logger: ReturnType<typeof loggerOptions> }
  | { loggerInstance: pino.Logger };

export function loggerConfig(env: AppEnv): FastifyLoggerSetup {
  const options = loggerOptions(env);

  if (!env.LOG_DIR) {
    return { logger: options };
  }

  mkdirSync(env.LOG_DIR, { recursive: true });

  const appLogPath = path.join(env.LOG_DIR, "app.log");
  const errorLogPath = path.join(env.LOG_DIR, "error.log");
  const level = normalizeLevel(env.LOG_LEVEL);

  const streams: pino.StreamEntry[] = [
    { level, stream: process.stdout },
    { level, stream: createWriteStream(appLogPath, { flags: "a" }) as DestinationStream },
    { level: "error", stream: createWriteStream(errorLogPath, { flags: "a" }) as DestinationStream }
  ];

  const logger = pino(options, pino.multistream(streams));
  logger.info({ logDir: env.LOG_DIR, appLogPath, errorLogPath }, "File logging enabled");

  return { loggerInstance: logger };
}

function loggerOptions(env: AppEnv) {
  return {
    level: env.LOG_LEVEL,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "*.password",
        "*.token",
        "*.appToken",
        "*.accessToken",
        "*.clientSecret",
        "*.secret",
        "*.authorization"
      ],
      censor: "[redacted]"
    },
    serializers: {
      req(request: FastifyRequest) {
        return {
          method: request.method,
          url: redactUrl(request.url) ?? "",
          host: request.hostname ?? request.headers.host,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort ?? 0
        };
      }
    }
  };
}

function normalizeLevel(level: string): Level {
  const normalized = level.toLowerCase();
  const allowed: Level[] = ["fatal", "error", "warn", "info", "debug", "trace"];

  if ((allowed as string[]).includes(normalized)) {
    return normalized as Level;
  }

  return "info";
}

export function redactUrl(url: string | undefined): string | undefined {
  if (!url) {
    return url;
  }

  const parsed = new URL(url, "http://local.invalid");

  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveQueryKey(key)) {
      parsed.searchParams.set(key, "[redacted]");
    }
  }

  const query = parsed.searchParams.toString();
  return `${parsed.pathname}${query ? `?${query}` : ""}`;
}

function isSensitiveQueryKey(key: string): boolean {
  return ["token", "code", "access_token", "refresh_token", "client_secret"].includes(key.toLowerCase());
}
