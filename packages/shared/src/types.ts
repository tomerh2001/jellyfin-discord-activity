import { z } from "zod";

export const discordUserSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  globalName: z.string().nullable().optional(),
  avatar: z.string().nullable().optional()
});

export const discordContextSchema = z.object({
  instanceId: z.string().min(1),
  guildId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional()
});

export const discordExchangeRequestSchema = discordContextSchema.extend({
  code: z.string().min(1),
  redirectUri: z.string().url().optional(),
  mockUser: discordUserSchema.optional()
});

export const discordExchangeResponseSchema = z.object({
  appToken: z.string().min(1),
  discordAccessToken: z.string().min(1).optional(),
  user: discordUserSchema,
  expiresAt: z.string().datetime()
});

export const meResponseSchema = z.object({
  discordUser: discordUserSchema,
  jellyfinLinked: z.boolean(),
  discordContext: discordContextSchema.optional(),
  appSessionExpiresAt: z.string().datetime()
});

export const logoutResponseSchema = z.object({
  ok: z.literal(true)
});

export const healthSchema = z.object({
  ok: z.literal(true)
});

export type DiscordUser = z.infer<typeof discordUserSchema>;
export type DiscordContext = z.infer<typeof discordContextSchema>;
export type DiscordExchangeRequest = z.infer<typeof discordExchangeRequestSchema>;
export type DiscordExchangeResponse = z.infer<typeof discordExchangeResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
export type HealthResponse = z.infer<typeof healthSchema>;
