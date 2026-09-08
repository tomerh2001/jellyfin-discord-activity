import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const discordEdgeHeader = "x-jellyfin-discord-edge";

/** Encode at least 32 random bytes as hex or unpadded base64url. */
export function isStrongDiscordEdgeSecret(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43,512}$/.test(value) || new Set(value).size < 12
    || /development|change[-_]?me|replace[-_]?me|example|placeholder/i.test(value)) return false;
  if (/^[a-f0-9]+$/i.test(value)) return value.length >= 64 && value.length % 2 === 0;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= 32 && decoded.toString("base64url") === value;
}

/** The edge must overwrite this header only after verifying trusted Worker provenance.
 * Never treat the client-controlled CF-Worker, Origin or Referer header as proof.
 */
export function createDiscordEdgeVerifier(secret: string): (headers: IncomingHttpHeaders) => boolean {
  if (!isStrongDiscordEdgeSecret(secret)) {
    throw new Error("DISCORD_PROXY_EDGE_SECRET must encode at least 32 random bytes as hex or base64url.");
  }
  const expected = createHash("sha256").update(secret).digest();
  return (headers) => {
    const presented = headers[discordEdgeHeader];
    if (typeof presented !== "string" || presented.length > 512) return false;
    // Fixed-size hashes keep the comparison constant-time even for wrong-length input.
    return timingSafeEqual(expected, createHash("sha256").update(presented).digest());
  };
}
