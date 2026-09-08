import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, vi } from "vitest";

// Each test worker has a disposable database, including tests that only exercise /api/me.
const directory = mkdtempSync(path.join(tmpdir(), "jellyfin-watch-tests-"));
vi.mock("../env.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../env.js")>();
  return { ...actual, loadEnv: (input: NodeJS.ProcessEnv = process.env) =>
    actual.loadEnv({ DATABASE_URL: `file:${directory}/app.db`, ...input }) };
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
