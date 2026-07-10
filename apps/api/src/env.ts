import { z } from "zod";

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
  PUBLIC_WS_URL: z.string().url().default("ws://localhost:3000/ws"),
  PUBLIC_DISCORD_CLIENT_ID: z.string().default("dev-client-id"),
  DISCORD_CLIENT_ID: z.string().default("dev-client-id"),
  DISCORD_CLIENT_SECRET: z.string().default("dev-client-secret"),
  DISCORD_REDIRECT_URI: z.string().url().default("http://localhost:3000/api/discord/callback"),
  APP_SESSION_SECRET: z.string().min(16).default("development-session-secret-change-me"),
  APP_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 8),
  DEV_AUTH_MOCK: booleanFromString.default(false),
  TOKEN_ENCRYPTION_KEY: z.string().default(""),
  DATABASE_URL: z.string().default("file:/data/app.db"),
  JELLYFIN_DEFAULT_SERVER_URL: z.string().url().default("http://localhost:8096"),
  JELLYFIN_ALLOW_CUSTOM_SERVERS: booleanFromString.default(false),
  JELLYFIN_AUTH_MODE: z.enum(["per-user", "shared"]).default("per-user"),
  JELLYFIN_SHARED_USERNAME: z.string().default(""),
  JELLYFIN_SHARED_PASSWORD: z.string().default(""),
  STREAM_TICKET_TTL_SECONDS: z.coerce.number().int().positive().default(14_400),
  STREAM_MAX_BITRATE: z.coerce.number().int().positive().default(20_000_000),
  STREAM_MAX_WIDTH: z.coerce.number().int().positive().default(1920),
  STREAM_MAX_HEIGHT: z.coerce.number().int().positive().default(1080),
  STREAM_PROXY_MODE: z.enum(["hls-first", "direct"]).default("hls-first"),
  ROOM_MAX_PARTICIPANTS: z.coerce.number().int().positive().default(20),
  ROOM_IDLE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  SYNC_STATE_UPDATE_MS: z.coerce.number().int().positive().default(1000),
  SYNC_HARD_SEEK_THRESHOLD_SECONDS: z.coerce.number().positive().default(2.0),
  SYNC_SOFT_DRIFT_THRESHOLD_SECONDS: z.coerce.number().positive().default(0.08),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default("1 minute"),
  ALLOWED_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000")
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(input);
}

export function allowedOrigins(env: AppEnv): string[] {
  return env.ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
