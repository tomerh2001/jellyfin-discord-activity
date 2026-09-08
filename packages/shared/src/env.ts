import { z } from "zod";

export const publicEnvSchema = z.object({
  publicBaseUrl: z.string().url(),
  publicDiscordClientId: z.string().min(1)
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;
