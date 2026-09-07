import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSecretFiles } from "../services/secretFiles.js";

describe("secret file loading", () => {
  it("loads known keys without changing input, rejects conflicts and hides failure paths", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "watch-secrets-"));
    try {
      const file = path.join(directory, "password");
      writeFileSync(file, "secret\n", { mode: 0o600 });
      const input = { JELLYFIN_SHARED_PASSWORD_FILE: file };
      expect(loadSecretFiles(input).JELLYFIN_SHARED_PASSWORD).toBe("secret");
      expect(input).not.toHaveProperty("JELLYFIN_SHARED_PASSWORD");
      expect(() => loadSecretFiles({ ...input, JELLYFIN_SHARED_PASSWORD: "conflict" })).toThrow("not both");
      expect(() => loadSecretFiles({ DISCORD_BOT_TOKEN_FILE: "/sensitive/not-present" })).toThrow("Unable to load DISCORD_BOT_TOKEN_FILE.");
    } finally { rmSync(directory, { recursive: true }); }
  });
});
