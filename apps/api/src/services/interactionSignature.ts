import { createPublicKey, verify } from "node:crypto";

export function verifyInteractionSignature(publicKey: string, signature: string, timestamp: string, body: Buffer, now = Date.now()): boolean {
  if (!/^[a-f0-9]{64}$/i.test(publicKey) || !/^[a-f0-9]{128}$/i.test(signature) || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "hex")
    ]), format: "der", type: "spki" });
    return verify(null, Buffer.concat([Buffer.from(timestamp), body]), key, Buffer.from(signature, "hex"));
  } catch { return false; }
}
