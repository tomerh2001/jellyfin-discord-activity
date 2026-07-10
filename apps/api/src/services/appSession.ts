import type { DiscordContext, DiscordUser } from "@app/shared";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { AppEnv } from "../env.js";
import { generateId } from "./crypto.js";
import { sessionStore, type AppSession } from "./sessionStore.js";

const appSessionClaimsSchema = z.object({
  sid: z.string().min(1),
  sub: z.string().min(1),
  exp: z.number().int().positive()
});

function secretKey(env: AppEnv): Uint8Array {
  return new TextEncoder().encode(env.APP_SESSION_SECRET);
}

export async function createAppSession(input: {
  env: AppEnv;
  user: DiscordUser;
  discordContext?: DiscordContext;
}): Promise<{ appToken: string; session: AppSession }> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = new Date((nowSeconds + input.env.APP_SESSION_TTL_SECONDS) * 1000);
  const sessionId = generateId();

  sessionStore.upsertUser(input.user);

  const session = sessionStore.createSession({
    id: sessionId,
    discordUserId: input.user.id,
    ...(input.discordContext ? { discordContext: input.discordContext } : {}),
    expiresAt
  });

  const appToken = await new SignJWT({ sid: session.id })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(input.user.id)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(Math.floor(session.expiresAt.getTime() / 1000))
    .sign(secretKey(input.env));

  return { appToken, session };
}

export async function verifyAppToken(env: AppEnv, appToken: string): Promise<AppSession> {
  const verified = await jwtVerify(appToken, secretKey(env), {
    algorithms: ["HS256"]
  });

  const claims = appSessionClaimsSchema.parse(verified.payload);
  const session = sessionStore.getSession(claims.sid);

  if (!session || session.discordUserId !== claims.sub) {
    throw new AppSessionError("invalid_session");
  }

  return session;
}

export function getBearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  const [scheme, token] = header.split(" ");

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return undefined;
  }

  return token;
}

export class AppSessionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
