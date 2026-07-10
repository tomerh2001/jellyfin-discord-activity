import type { JellyfinStatus } from "@app/shared";
import type { AppEnv } from "../env.js";
import { encryptString } from "./crypto.js";
import {
  authenticateByName,
  JellyfinError,
  resolveJellyfinServerUrl,
  type JellyfinAccount
} from "./jellyfin.js";
import { JellyfinAccountStore } from "./jellyfinAccountStore.js";

const sharedAccountDiscordUserId = "__shared_jellyfin_account__";

export class JellyfinAccountResolutionError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly statusCode: number
  ) {
    super(code);
  }
}

export async function resolveJellyfinAccount(env: AppEnv, discordUserId: string): Promise<JellyfinAccount> {
  if (env.JELLYFIN_AUTH_MODE === "shared") {
    return resolveSharedJellyfinAccount(env);
  }

  const store = new JellyfinAccountStore(env);
  const account = await store.get(discordUserId);

  if (!account) {
    throw new JellyfinAccountResolutionError("jellyfin_not_linked", "Link a Jellyfin account first.", 409);
  }

  return account;
}

export async function getJellyfinAccountStatus(env: AppEnv, discordUserId: string): Promise<JellyfinStatus> {
  if (env.JELLYFIN_AUTH_MODE === "shared") {
    const account = await resolveSharedJellyfinAccount(env);
    return {
      linked: true,
      authMode: "shared",
      serverUrl: account.serverUrl,
      username: account.jellyfinUsername
    };
  }

  const store = new JellyfinAccountStore(env);
  const account = await store.get(discordUserId);
  return {
    ...store.toStatus(account),
    authMode: "per-user"
  };
}

export async function withResolvedJellyfinAccount<T>(
  env: AppEnv,
  discordUserId: string,
  operation: (account: JellyfinAccount) => Promise<T>
): Promise<T> {
  const account = await resolveJellyfinAccount(env, discordUserId);

  try {
    return await operation(account);
  } catch (error) {
    if (env.JELLYFIN_AUTH_MODE === "shared" && error instanceof JellyfinError && error.code === "jellyfin_token_invalid") {
      const refreshedAccount = await authenticateSharedJellyfinAccount(env);
      return operation(refreshedAccount);
    }

    throw error;
  }
}

async function resolveSharedJellyfinAccount(env: AppEnv): Promise<JellyfinAccount> {
  assertSharedJellyfinConfig(env);

  const store = new JellyfinAccountStore(env);
  const existing = await store.get(sharedAccountDiscordUserId);

  if (existing) {
    return existing;
  }

  return authenticateSharedJellyfinAccount(env);
}

async function authenticateSharedJellyfinAccount(env: AppEnv): Promise<JellyfinAccount> {
  assertSharedJellyfinConfig(env);

  const serverUrl = resolveJellyfinServerUrl(env);
  const result = await authenticateByName({
    env,
    serverUrl,
    username: env.JELLYFIN_SHARED_USERNAME.trim(),
    password: env.JELLYFIN_SHARED_PASSWORD
  });

  const store = new JellyfinAccountStore(env);
  return store.upsert({
    discordUserId: sharedAccountDiscordUserId,
    serverUrl,
    jellyfinUserId: result.userId,
    jellyfinUsername: result.username,
    encryptedAccessToken: encryptString(env, result.accessToken)
  });
}

function assertSharedJellyfinConfig(env: AppEnv): void {
  if (!env.JELLYFIN_SHARED_USERNAME.trim() || !env.JELLYFIN_SHARED_PASSWORD) {
    throw new JellyfinAccountResolutionError(
      "jellyfin_shared_not_configured",
      "Shared Jellyfin account mode requires JELLYFIN_SHARED_USERNAME and JELLYFIN_SHARED_PASSWORD.",
      500
    );
  }
}
