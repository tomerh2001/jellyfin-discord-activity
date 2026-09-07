import type { DiscordContext, DiscordUser } from "@app/shared";
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

  // Embedded SDK codes follow Discord's Activity token-exchange example,
  // which omits redirect_uri. A configured portal redirect is only a placeholder;
  // send a redirect here only when it was explicitly part of the authorization.
  if (redirectUri) {
    body.set("redirect_uri", redirectUri);
  }

  const response = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
    signal: AbortSignal.timeout(10_000)
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
    },
    signal: AbortSignal.timeout(10_000)
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

/** The allowlists are alternatives: a named user OR a participant in a named guild. */
export function allowedDiscordActor(env: AppEnv, userId: string, guildId?: string): boolean {
  const parseIds = (raw: string) => raw.split(",").map((id) => id.trim()).filter(Boolean);
  const users = parseIds(env.DISCORD_ALLOWED_USER_IDS);
  const guilds = parseIds(env.DISCORD_ALLOWED_GUILD_IDS);
  if (users.length === 0 && guilds.length === 0) return env.NODE_ENV !== "production";
  return users.includes(userId) || Boolean(guildId && guilds.includes(guildId));
}

const activityInstanceSchema = z.object({
  application_id: z.string().min(1),
  instance_id: z.string().min(1),
  location: z.object({
    channel_id: z.string().min(1),
    guild_id: z.string().min(1).nullable().optional()
  }),
  users: z.array(z.string().min(1))
});

/** Never trust SDK-shaped values from a request as proof of Discord membership. */
export async function verifyDiscordActivityContext(
  env: AppEnv,
  context: DiscordContext,
  userId: string
): Promise<DiscordContext> {
  if (!env.DISCORD_BOT_TOKEN) throw new DiscordActivityError("discord_bot_not_configured", 503);
  const response = await fetch(
    `https://discord.com/api/v10/applications/${encodeURIComponent(env.DISCORD_CLIENT_ID)}/activity-instances/${encodeURIComponent(context.instanceId)}`,
    { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` }, signal: AbortSignal.timeout(10_000) }
  );
  if (!response.ok) {
    throw new DiscordActivityError("discord_activity_verification_failed", response.status === 404 ? 403 : 503);
  }
  const parsed = activityInstanceSchema.safeParse(await response.json());
  if (!parsed.success) throw new DiscordActivityError("discord_activity_verification_failed", 503);
  const instance = parsed.data;
  if (instance.application_id !== env.DISCORD_CLIENT_ID || instance.instance_id !== context.instanceId
    || !instance.users.includes(userId)
    || (context.guildId !== undefined && context.guildId !== instance.location.guild_id)
    || (context.channelId !== undefined && context.channelId !== instance.location.channel_id)) {
    throw new DiscordActivityError("discord_activity_forbidden", 403);
  }
  if (!allowedDiscordActor(env, userId, instance.location.guild_id ?? undefined)) {
    throw new DiscordActivityError("discord_actor_forbidden", 403);
  }
  return {
    instanceId: instance.instance_id,
    channelId: instance.location.channel_id,
    ...(instance.location.guild_id ? { guildId: instance.location.guild_id } : {})
  };
}

export class DiscordActivityError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
}
