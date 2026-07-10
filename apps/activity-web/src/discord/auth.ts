import type { ActivityDiscordContext } from "./sdk.js";

export type AuthState = "idle" | "pending" | "authenticated" | "error";

export type AuthenticatedActivity = {
  appToken: string;
  discordAccessToken?: string;
  user: NonNullable<ActivityDiscordContext["user"]>;
  expiresAt: string;
};
