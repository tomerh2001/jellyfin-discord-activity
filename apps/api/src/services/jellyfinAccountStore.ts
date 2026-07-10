import type { JellyfinStatus } from "@app/shared";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppEnv } from "../env.js";
import { generateId } from "./crypto.js";

export type StoredJellyfinAccount = {
  id: string;
  discordUserId: string;
  serverUrl: string;
  jellyfinUserId: string;
  jellyfinUsername: string;
  encryptedAccessToken: string;
  tokenCreatedAt: string;
  lastVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type StoreFile = {
  jellyfinAccounts: StoredJellyfinAccount[];
};

function emptyStore(): StoreFile {
  return {
    jellyfinAccounts: []
  };
}

export class JellyfinAccountStore {
  constructor(private readonly env: AppEnv) {}

  async get(discordUserId: string): Promise<StoredJellyfinAccount | undefined> {
    const store = await this.read();
    return store.jellyfinAccounts.find((account) => account.discordUserId === discordUserId);
  }

  async upsert(input: {
    discordUserId: string;
    serverUrl: string;
    jellyfinUserId: string;
    jellyfinUsername: string;
    encryptedAccessToken: string;
  }): Promise<StoredJellyfinAccount> {
    const store = await this.read();
    const now = new Date().toISOString();
    const existingIndex = store.jellyfinAccounts.findIndex((account) => account.discordUserId === input.discordUserId);

    const existing = existingIndex >= 0 ? store.jellyfinAccounts[existingIndex] : undefined;
    const account: StoredJellyfinAccount = {
      id: existing?.id ?? generateId(),
      discordUserId: input.discordUserId,
      serverUrl: input.serverUrl,
      jellyfinUserId: input.jellyfinUserId,
      jellyfinUsername: input.jellyfinUsername,
      encryptedAccessToken: input.encryptedAccessToken,
      tokenCreatedAt: existing?.tokenCreatedAt ?? now,
      lastVerifiedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };

    if (existingIndex >= 0) {
      store.jellyfinAccounts[existingIndex] = account;
    } else {
      store.jellyfinAccounts.push(account);
    }

    await this.write(store);
    return account;
  }

  async delete(discordUserId: string): Promise<void> {
    const store = await this.read();
    const next = store.jellyfinAccounts.filter((account) => account.discordUserId !== discordUserId);

    if (next.length === store.jellyfinAccounts.length) {
      return;
    }

    await this.write({ jellyfinAccounts: next });
  }

  toStatus(account: StoredJellyfinAccount | undefined): JellyfinStatus {
    if (!account) {
      return { linked: false, authMode: "per-user" };
    }

    return {
      linked: true,
      authMode: "per-user",
      serverUrl: account.serverUrl,
      username: account.jellyfinUsername
    };
  }

  private async read(): Promise<StoreFile> {
    try {
      const raw = await readFile(this.filePath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreFile>;

      return {
        jellyfinAccounts: Array.isArray(parsed.jellyfinAccounts) ? parsed.jellyfinAccounts : []
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return emptyStore();
      }

      throw error;
    }
  }

  private async write(store: StoreFile): Promise<void> {
    const filePath = this.filePath();
    await mkdir(path.dirname(filePath), { recursive: true });

    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(tmpPath, filePath);
  }

  private filePath(): string {
    const databasePath = this.env.DATABASE_URL.startsWith("file:")
      ? this.env.DATABASE_URL.slice("file:".length)
      : this.env.DATABASE_URL;

    return path.join(path.dirname(databasePath), "jellyfin-accounts.json");
  }
}
