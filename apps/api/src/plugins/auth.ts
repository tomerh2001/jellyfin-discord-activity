import { apiError } from "@app/shared";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { AppEnv } from "../env.js";
import { getBearerToken, verifyAppToken } from "../services/appSession.js";
import { sessionStore, type AppSession } from "../services/sessionStore.js";

declare module "fastify" {
  interface FastifyInstance {
    envConfig: AppEnv;
  }

  interface FastifyRequest {
    appSession?: AppSession;
  }
}

export function authPlugin(env: AppEnv): FastifyPluginAsync {
  return async (app) => {
    app.decorate("envConfig", env);
    app.decorateRequest("appSession");
  };
}

export async function requireAppSession(request: FastifyRequest): Promise<AppSession> {
  const token = getBearerToken(request.headers.authorization);

  if (!token) {
    throw new AuthError("missing_app_token", "Missing bearer app token.");
  }

  try {
    const session = await verifyAppToken(request.server.envConfig, token);
    request.appSession = session;
    return session;
  } catch {
    throw new AuthError("invalid_app_token", "Invalid or expired app token.");
  }
}

export function getAppSessionUser(session: AppSession) {
  return sessionStore.getUser(session.discordUserId);
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string
  ) {
    super(code);
  }
}

export function sendAuthError(error: AuthError) {
  return apiError(error.code, error.publicMessage);
}
