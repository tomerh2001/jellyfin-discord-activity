import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const maxPayloadLength = 8192;

export type DiscordProxyToken = { createdAt: number; expiresAt: number };

/** Discord signs the decoded proxy payload, unlike interaction signatures.
 * https://docs.discord.com/developers/activities/development-guides/multiplayer-experience
 * The documented token does not bind an HTTP method, URL, body, or unique nonce.
 * It may be reused until expiry, and never replaces user/instance authorization.
 */
export function createDiscordProxyVerifier(publicKeyHex: string) {
  if (!/^[a-f0-9]{64}$/i.test(publicKeyHex)) {
    throw new Error("Discord proxy authentication requires DISCORD_PUBLIC_KEY.");
  }
  const key = createPublicKey({
    key: Buffer.concat([ed25519SpkiPrefix, Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki"
  });
  return (headers: IncomingHttpHeaders, nowSeconds = Math.floor(Date.now() / 1000)): DiscordProxyToken | undefined => {
    return verifyProxyToken(key, headers, nowSeconds);
  };
}

function verifyProxyToken(key: KeyObject, headers: IncomingHttpHeaders, nowSeconds: number): DiscordProxyToken | undefined {
  const signatureHeader = headers["x-signature-ed25519"];
  const timestamp = headers["x-signature-timestamp"];
  const payloadHeader = headers["x-discord-proxy-payload"];
  if (typeof signatureHeader !== "string" || typeof timestamp !== "string" || typeof payloadHeader !== "string"
    || !/^\d{1,16}$/.test(timestamp) || payloadHeader.length > maxPayloadLength
    || signatureHeader.length > 128) return undefined;
  const payload = decodeBase64(payloadHeader);
  // The official JS example uses base64 signatures; its Python example uses hex.
  // Both encodings must produce exactly the same 64 signature bytes.
  const signature = /^[a-f0-9]{128}$/i.test(signatureHeader)
    ? Buffer.from(signatureHeader, "hex") : decodeBase64(signatureHeader);
  if (!payload?.length || signature?.length !== 64 || !verify(null, payload, key, signature)) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const token = parsed as Record<string, unknown>;
    const createdAt = token.created_at;
    const expiresAt = token.expires_at;
    if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt <= 0
      || typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt)
      || String(createdAt) !== timestamp || createdAt > nowSeconds + 30
      || expiresAt <= nowSeconds || expiresAt <= createdAt) return undefined;
    return { createdAt, expiresAt };
  } catch {
    return undefined;
  }
}

function decodeBase64(value: string): Buffer | undefined {
  // Node's permissive base64 decoder silently accepts invalid characters. Reject
  // those and alternate encodings before interpreting any signed payload bytes.
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : undefined;
}
