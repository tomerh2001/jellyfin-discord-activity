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

/** Only safe GETs retry. An OAuth code POST may have succeeded before timeout. */
async function discordJson(url: string, init: RequestInit, retryGet = false): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const attempts = retryGet ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(retryGet ? 6_000 : 12_000) });
      const retryDelay = response.status === 429 ? retryAfterDelay(response.headers.get("retry-after")) : 200;
      if (retryGet && attempt + 1 < attempts && (response.status >= 500 || (response.status === 429 && retryDelay !== undefined))) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        continue;
      }
      const payload: unknown = await response.json().catch((error: unknown) => {
        if (response.ok) throw error;
        return {};
      });
      return { ok: response.ok, status: response.status, payload };
    } catch {
      if (attempt + 1 === attempts) throw new DiscordTransportError();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new DiscordTransportError();
}

// Never retry a rate limit earlier than Discord requested, or extend startup
// indefinitely. Longer/missing waits surface as a retryable sign-in failure.
function retryAfterDelay(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 1000 ? milliseconds : undefined;
}

/** Verify the bearer belongs to this application before using it to resume. */
export async function verifyDiscordAuthorization(env: AppEnv, accessToken: string): Promise<DiscordUser> {
  let response: Awaited<ReturnType<typeof discordJson>>;
  try { response = await discordJson("https://discord.com/api/v10/oauth2/@me", { headers: { Authorization: `Bearer ${accessToken}` } }, true); }
  catch { throw new DiscordOAuthError("discord_authorization_unavailable", 503, undefined); }
  if (!response.ok) throw new DiscordOAuthError("discord_authorization_failed", response.status === 401 ? 401 : 503, undefined);
  const parsed = z.object({ application: z.object({ id: z.string() }), scopes: z.array(z.string()), expires: z.string(), user: discordUserResponseSchema }).safeParse(response.payload);
  if (!parsed.success || parsed.data.application.id !== env.DISCORD_CLIENT_ID || !parsed.data.scopes.includes("identify")
    || !Number.isFinite(Date.parse(parsed.data.expires)) || Date.parse(parsed.data.expires) <= Date.now()) {
    throw new DiscordOAuthError("discord_authorization_forbidden", 403, undefined);
  }
  const user = await getDiscordCurrentUser(accessToken);
  if (user.id !== parsed.data.user.id) throw new DiscordOAuthError("discord_authorization_forbidden", 403, undefined);
  return user;
}

class DiscordTransportError extends Error {
  constructor() { super("Discord request timed out or was unavailable"); }
}

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

  let response: Awaited<ReturnType<typeof discordJson>>;
  try { response = await discordJson("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  }); } catch { throw new DiscordOAuthError("discord_token_exchange_unavailable", 503, undefined); }
  const { payload } = response;

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
  let response: Awaited<ReturnType<typeof discordJson>>;
  try { response = await discordJson("https://discord.com/api/users/@me", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  }, true); } catch { throw new DiscordOAuthError("discord_user_fetch_unavailable", 503, undefined); }
  const { payload } = response;

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
  let response: Awaited<ReturnType<typeof discordJson>>;
  try { response = await discordJson(
    `https://discord.com/api/v10/applications/${encodeURIComponent(env.DISCORD_CLIENT_ID)}/activity-instances/${encodeURIComponent(context.instanceId)}`,
    { headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } }, true
  ); } catch { throw new DiscordActivityError("discord_activity_verification_unavailable", 503); }
  if (!response.ok) {
    throw new DiscordActivityError("discord_activity_verification_failed", response.status === 404 ? 403 : 503);
  }
  const parsed = activityInstanceSchema.safeParse(response.payload);
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
