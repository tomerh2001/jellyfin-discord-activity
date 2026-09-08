import { readFileSync } from "node:fs";

const secretKeys = ["DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN", "DISCORD_PROXY_EDGE_SECRET", "APP_SESSION_SECRET", "TOKEN_ENCRYPTION_KEY", "JELLYFIN_SHARED_PASSWORD"] as const;

/** Load only known secrets, without logging their contents or file paths. */
export function loadSecretFiles(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result = { ...input };
  for (const key of secretKeys) {
    const file = input[`${key}_FILE`];
    if (!file) continue;
    if (input[key]) throw new Error(`Configure only ${key} or ${key}_FILE, not both.`);
    try {
      const value = readFileSync(file, "utf8").replace(/\r?\n$/, "");
      if (!value) throw new Error("empty secret");
      result[key] = value;
    } catch {
      throw new Error(`Unable to load ${key}_FILE.`);
    }
  }
  return result;
}
