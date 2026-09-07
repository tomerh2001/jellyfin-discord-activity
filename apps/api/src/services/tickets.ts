import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sessionStore } from "./sessionStore.js";

export type StreamTicketPayload = {
  appSessionId: string;
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
  assets: Map<string, string>;
  assetIds: Map<string, string>;
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
      ttlSeconds,
      assets: new Map(),
      assetIds: new Map()
    };

    this.tickets.set(id, ticket);

    return {
      token: `${id}.${secret}`,
      ticket
    };
  }

  get(token: string, options?: { slide?: boolean }): StreamTicket | undefined {
    const [id, secret, extra] = token.split(".");

    if (!id || !secret || extra !== undefined) {
      return undefined;
    }

    const ticket = this.tickets.get(id);

    if (!ticket) {
      return undefined;
    }

    const now = Date.now();

    if (ticket.expiresAt.getTime() <= now || !this.sessionIsActive(ticket)) {
      this.tickets.delete(id);
      return undefined;
    }

    if (!timingSafeEqual(Buffer.from(ticket.secretHash), Buffer.from(hashSecret(secret)))) {
      return undefined;
    }

    if (options?.slide !== false) {
      this.slideExpiry(ticket, now);
    }

    return ticket;
  }

  sessionIsActive(ticket: StreamTicket): boolean {
    return ticket.sessionExpiresAt.getTime() > Date.now() && Boolean(sessionStore.getSession(ticket.appSessionId));
  }

  // Only the server manifest rewriter can mint an asset ID. Clients never provide
  // an upstream path or query, and IDs from another ticket do not authorize reads.
  issueAsset(ticket: StreamTicket, target: string): string {
    const existing = ticket.assetIds.get(target);
    if (existing) return existing;
    if (ticket.assets.size >= 20_000) throw new Error("stream_asset_limit");
    const id = randomBytes(18).toString("base64url");
    ticket.assets.set(id, target);
    ticket.assetIds.set(target, id);
    return id;
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
      if (ticket.expiresAt.getTime() <= now || !this.sessionIsActive(ticket)) {
        this.tickets.delete(id);
      }
    }
  }
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

export const streamTicketStore = new StreamTicketStore();
