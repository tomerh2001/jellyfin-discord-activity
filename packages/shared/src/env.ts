import { z } from "zod";

export const publicEnvSchema = z.object({
  publicBaseUrl: z.string().url(),
  publicWsUrl: z.string().url(),
  publicDiscordClientId: z.string().min(1),
  jellyfinAuthMode: z.enum(["per-user", "shared"])
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;
