import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { AppEnv } from "../env.js";

export function generateId(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

export function encryptString(env: AppEnv, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenEncryptionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

export function decryptString(env: AppEnv, ciphertext: string): string {
  const [version, iv, tag, encrypted] = ciphertext.split(".");

  if (version !== "v1" || !iv || !tag || !encrypted) {
    throw new Error("Unsupported ciphertext format.");
  }

  const decipher = createDecipheriv("aes-256-gcm", tokenEncryptionKey(env), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function tokenEncryptionKey(env: AppEnv): Buffer {
  const decoded = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64");

  if (decoded.length === 32) {
    return decoded;
  }

  if (env.NODE_ENV === "production") {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }

  return createHash("sha256")
    .update(env.TOKEN_ENCRYPTION_KEY || "development-token-encryption-key")
    .digest();
}
