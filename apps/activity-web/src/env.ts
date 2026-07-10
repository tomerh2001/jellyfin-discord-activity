import { z } from "zod";

const booleanFromEnv = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => value === true || value === "true");

const envSchema = z.object({
  apiBaseUrl: z.string().default(""),
  publicDiscordClientId: z.string().default(""),
  devDiscordMock: booleanFromEnv.default(false),
  devMode: booleanFromEnv.default(false)
});

export type WebEnv = z.infer<typeof envSchema>;

export const env = envSchema.parse({
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL,
  publicDiscordClientId: import.meta.env.VITE_PUBLIC_DISCORD_CLIENT_ID,
  devDiscordMock: import.meta.env.VITE_DEV_DISCORD_MOCK,
  devMode: import.meta.env.DEV
});
