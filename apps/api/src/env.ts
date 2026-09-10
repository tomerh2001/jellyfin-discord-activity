import { z } from "zod";
import { isStrongDiscordEdgeSecret } from "./services/discordEdgeAuth.js";

const booleanFromString = z
  .string()
  .optional()
  .transform((value) => value === "true");

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),
  /** When set, structured logs are appended to LOG_DIR/app.log and errors to LOG_DIR/error.log (plus stdout). */
  LOG_DIR: z.string().default(""),
  TRUST_PROXY: booleanFromString.default(false),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
  PUBLIC_DISCORD_CLIENT_ID: z.string().default("dev-client-id"),
  DISCORD_CLIENT_ID: z.string().default("dev-client-id"),
  DISCORD_BOT_TOKEN: z.string().default(""),
  DISCORD_PUBLIC_KEY: z.string().regex(/^$|^[a-fA-F0-9]{64}$/).default(""),
  // Production always requires the selected Activity ingress proof. Enable this only
  // to exercise the same ingress boundary during local development/tests.
  DISCORD_REQUIRE_PROXY_AUTH: booleanFromString.default(false),
  DISCORD_PROXY_AUTH_MODE: z.enum(["signature", "cloudflare-worker"]).default("signature"),
  DISCORD_PROXY_EDGE_SECRET: z.string().default(""),
  DISCORD_ALLOWED_GUILD_IDS: z.string().default(""),
  DISCORD_ALLOWED_USER_IDS: z.string().default(""),
  DISCORD_CLIENT_SECRET: z.string().default("dev-client-secret"),
  DISCORD_REDIRECT_URI: z.string().url().default("http://localhost:3000/api/discord/callback"),
  APP_SESSION_SECRET: z.string().min(16).default("development-session-secret-change-me"),
  APP_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 8),
  DEV_AUTH_MOCK: booleanFromString.default(false),
  TOKEN_ENCRYPTION_KEY: z.string().default(""),
  DATABASE_URL: z.string().default("file:/data/app.db"),
  JELLYFIN_DEFAULT_SERVER_URL: z.string().url().default("http://localhost:8096"),
  // An exact user-facing alias for the approved default, never another upstream.
  JELLYFIN_PUBLIC_SERVER_URL: z.union([z.literal(""), z.url({ protocol: /^https$/ })]).default(""),
  JELLYFIN_ALLOW_CUSTOM_SERVERS: booleanFromString.default(true),
  JELLYFIN_AUTH_MODE: z.enum(["per-user", "shared"]).default("per-user"),
  JELLYFIN_SHARED_USERNAME: z.string().default(""),
  JELLYFIN_SHARED_PASSWORD: z.string().default(""),
  ROOM_MAX_PARTICIPANTS: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000")
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  const env = envSchema.parse(input);
  if (env.DISCORD_PROXY_AUTH_MODE === "cloudflare-worker" && !isStrongDiscordEdgeSecret(env.DISCORD_PROXY_EDGE_SECRET)) {
    throw new Error("DISCORD_PROXY_EDGE_SECRET must encode at least 32 random bytes as hex or base64url for cloudflare-worker mode.");
  }
  if (env.NODE_ENV === "production") {
    const problems: string[] = [];
    const realSecret = (value: string) => value.length >= 32
      && !/development|change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example|placeholder/i.test(value)
      && new Set(value).size >= 12;
    if (env.DEV_AUTH_MOCK) problems.push("DEV_AUTH_MOCK must be disabled");
    if (!realSecret(env.APP_SESSION_SECRET)) problems.push("APP_SESSION_SECRET must be a strong random secret of at least 32 characters");
    if (!realSecret(env.DISCORD_CLIENT_SECRET)) problems.push("DISCORD_CLIENT_SECRET must be configured");
    if (!realSecret(env.DISCORD_BOT_TOKEN)) problems.push("DISCORD_BOT_TOKEN must be configured");
    if (!/^[a-f0-9]{64}$/i.test(env.DISCORD_PUBLIC_KEY)) problems.push("DISCORD_PUBLIC_KEY must be a 64-character hexadecimal public key");
    if (!/^\d{17,20}$/.test(env.DISCORD_CLIENT_ID)) problems.push("DISCORD_CLIENT_ID must be a Discord application ID");
    if (env.PUBLIC_DISCORD_CLIENT_ID !== env.DISCORD_CLIENT_ID) problems.push("PUBLIC_DISCORD_CLIENT_ID must match DISCORD_CLIENT_ID");
    if (Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64").length !== 32 || !realSecret(env.TOKEN_ENCRYPTION_KEY)) {
      problems.push("TOKEN_ENCRYPTION_KEY must encode a random 32-byte key in base64");
    }
    const ids = `${env.DISCORD_ALLOWED_GUILD_IDS},${env.DISCORD_ALLOWED_USER_IDS}`.split(",").map((id) => id.trim()).filter(Boolean);
    if (!ids.length || ids.some((id) => !/^\d{17,20}$/.test(id))) {
      problems.push("Set DISCORD_ALLOWED_GUILD_IDS and/or DISCORD_ALLOWED_USER_IDS to valid Discord IDs");
    }
    if (!env.PUBLIC_BASE_URL.startsWith("https://")) problems.push("PUBLIC_BASE_URL must use HTTPS");
    if (env.JELLYFIN_AUTH_MODE === "shared" && (!env.JELLYFIN_SHARED_USERNAME || !env.JELLYFIN_SHARED_PASSWORD)) {
      problems.push("Shared Jellyfin username and password must be configured");
    }
    if (problems.length) throw new Error(`Invalid production configuration: ${problems.join("; ")}`);
  }
  return env;
}

export function allowedOrigins(env: AppEnv): string[] {
  return env.ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
