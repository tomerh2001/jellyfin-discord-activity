import type { DiscordContext, DiscordUser } from "@app/shared";

export type AppSession = {
  id: string;
  discordUserId: string;
  discordContext?: DiscordContext;
  expiresAt: Date;
  createdAt: Date;
};

export class SessionStore {
  private readonly users = new Map<string, DiscordUser>();
  private readonly sessions = new Map<string, AppSession>();

  upsertUser(user: DiscordUser): DiscordUser {
    const existing = this.users.get(user.id);
    const merged = {
      ...existing,
      ...user
    };

    this.users.set(user.id, merged);
    return merged;
  }

  getUser(discordUserId: string): DiscordUser | undefined {
    return this.users.get(discordUserId);
  }

  createSession(input: {
    id: string;
    discordUserId: string;
    discordContext?: DiscordContext;
    expiresAt: Date;
  }): AppSession {
    const session: AppSession = {
      id: input.id,
      discordUserId: input.discordUserId,
      ...(input.discordContext ? { discordContext: input.discordContext } : {}),
      expiresAt: input.expiresAt,
      createdAt: new Date()
    };

    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): AppSession | undefined {
    const session = this.sessions.get(id);

    if (!session) {
      return undefined;
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }

    return session;
  }

  deleteSession(id: string): void {
    this.sessions.delete(id);
  }
}

export const sessionStore = new SessionStore();
