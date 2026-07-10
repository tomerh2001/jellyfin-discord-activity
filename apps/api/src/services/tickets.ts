import { createHash, randomBytes } from "node:crypto";

export type StreamTicketPayload = {
  serverUrl: string;
  jellyfinUserId: string;
  encryptedAccessToken: string;
  itemId: string;
  mediaSourceId: string;
  sessionExpiresAt: Date;
  hlsPath?: string;
  directPath?: string;
};

export type StreamTicket = StreamTicketPayload & {
  id: string;
  secretHash: string;
  expiresAt: Date;
};

export class StreamTicketStore {
  private readonly tickets = new Map<string, StreamTicket>();

  create(payload: StreamTicketPayload, ttlSeconds: number): { token: string; ticket: StreamTicket } {
    this.pruneExpired();

    const id = randomBytes(12).toString("base64url");
    const secret = randomBytes(24).toString("base64url");
    const ticket: StreamTicket = {
      ...payload,
      id,
      secretHash: hashSecret(secret),
      expiresAt: new Date(Date.now() + ttlSeconds * 1000)
    };

    this.tickets.set(id, ticket);

    return {
      token: `${id}.${secret}`,
      ticket
    };
  }

  get(token: string): StreamTicket | undefined {
    const [id, secret] = token.split(".");

    if (!id || !secret) {
      return undefined;
    }

    const ticket = this.tickets.get(id);

    if (!ticket) {
      return undefined;
    }

    if (ticket.expiresAt.getTime() <= Date.now() || ticket.sessionExpiresAt.getTime() <= Date.now()) {
      this.tickets.delete(id);
      return undefined;
    }

    if (ticket.secretHash !== hashSecret(secret)) {
      return undefined;
    }

    return ticket;
  }

  clear(): void {
    this.tickets.clear();
  }

  private pruneExpired(): void {
    const now = Date.now();

    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt.getTime() <= now) {
        this.tickets.delete(id);
      }
    }
  }
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

export const streamTicketStore = new StreamTicketStore();
