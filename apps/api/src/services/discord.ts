import type { DiscordUser } from "@app/shared";
import { z } from "zod";
import type { AppEnv } from "../env.js";

const discordTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().optional(),
  scope: z.string().optional()
});

const discordUserResponseSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  global_name: z.string().nullable().optional(),
  avatar: z.string().nullable().optional()
});

export type DiscordOAuthResult = {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  scope?: string;
};

export async function exchangeDiscordCode(env: AppEnv, code: string, redirectUri?: string): Promise<DiscordOAuthResult> {
  const body = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    client_secret: env.DISCORD_CLIENT_SECRET,
    grant_type: "authorization_code",
    code
  });

  if (redirectUri) {
    body.set("redirect_uri", redirectUri);
  } else if (env.DISCORD_REDIRECT_URI) {
    body.set("redirect_uri", env.DISCORD_REDIRECT_URI);
  }

  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  const payload: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new DiscordOAuthError("discord_token_exchange_failed", response.status, payload);
  }

  const token = discordTokenResponseSchema.parse(payload);
  return {
    accessToken: token.access_token,
    tokenType: token.token_type,
    expiresIn: token.expires_in,
    ...(token.scope ? { scope: token.scope } : {})
  };
}

export async function getDiscordCurrentUser(accessToken: string): Promise<DiscordUser> {
  const response = await fetch("https://discord.com/api/users/@me", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const payload: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new DiscordOAuthError("discord_user_fetch_failed", response.status, payload);
  }

  const user = discordUserResponseSchema.parse(payload);
  return {
    id: user.id,
    username: user.username,
    ...(user.global_name !== undefined ? { globalName: user.global_name } : {}),
    ...(user.avatar !== undefined ? { avatar: user.avatar } : {})
  };
}

export class DiscordOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    readonly details: unknown
  ) {
    super(code);
  }
}
