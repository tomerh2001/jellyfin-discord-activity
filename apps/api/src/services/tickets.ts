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
  ttlSeconds: number;
};

export class StreamTicketStore {
  private readonly tickets = new Map<string, StreamTicket>();

  create(payload: StreamTicketPayload, ttlSeconds: number): { token: string; ticket: StreamTicket } {
    this.pruneExpired();

    const id = randomBytes(12).toString("base64url");
    const secret = randomBytes(24).toString("base64url");
    const now = Date.now();
    const requestedExpiry = now + ttlSeconds * 1000;
    const sessionCap = payload.sessionExpiresAt.getTime();
    const ticket: StreamTicket = {
      ...payload,
      id,
      secretHash: hashSecret(secret),
      expiresAt: new Date(Math.min(requestedExpiry, sessionCap)),
      ttlSeconds
    };

    this.tickets.set(id, ticket);

    return {
      token: `${id}.${secret}`,
      ticket
    };
  }

  get(token: string, options?: { slide?: boolean }): StreamTicket | undefined {
    const [id, secret] = token.split(".");

    if (!id || !secret) {
      return undefined;
    }

    const ticket = this.tickets.get(id);

    if (!ticket) {
      return undefined;
    }

    const now = Date.now();

    if (ticket.expiresAt.getTime() <= now || ticket.sessionExpiresAt.getTime() <= now) {
      this.tickets.delete(id);
      return undefined;
    }

    if (ticket.secretHash !== hashSecret(secret)) {
      return undefined;
    }

    if (options?.slide !== false) {
      this.slideExpiry(ticket, now);
    }

    return ticket;
  }

  clear(): void {
    this.tickets.clear();
  }

  private slideExpiry(ticket: StreamTicket, now: number): void {
    const slid = now + ticket.ttlSeconds * 1000;
    const capped = Math.min(slid, ticket.sessionExpiresAt.getTime());

    if (capped > ticket.expiresAt.getTime()) {
      ticket.expiresAt = new Date(capped);
    }
  }

  private pruneExpired(): void {
    const now = Date.now();

    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt.getTime() <= now || ticket.sessionExpiresAt.getTime() <= now) {
        this.tickets.delete(id);
      }
    }
  }
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

export const streamTicketStore = new StreamTicketStore();
