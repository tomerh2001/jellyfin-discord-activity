import type { FastifyRequest } from "fastify";
import type { AppEnv } from "./env.js";

export function loggerConfig(env: AppEnv) {
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
