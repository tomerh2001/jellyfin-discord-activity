// @vitest-environment node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, it, vi } from "vitest";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string; runScripts: "outside-only" }) => { window: Window & typeof globalThis };
};

it("builds a standalone classic-script facade without creating a UI, accessing storage or starting Discord", async () => {
  const result = await build({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)), logLevel: "silent", build: { write: false } });
  const results = Array.isArray(result) ? result : [result];
  const outputs = results.flatMap(value => "output" in value ? value.output : []);
  const chunks = outputs.filter(value => value.type === "chunk");
  expect(chunks).toHaveLength(1);
  const chunk = chunks[0]!;
  expect(chunk.fileName).toBe("activity-session.js");
  const { window } = new JSDOM("<!doctype html><body><main>Native Jellyfin</main></body>", { url: "https://activity.test", runScripts: "outside-only" });
  const before = window.document.documentElement.outerHTML;
  const href = window.location.href;
  try {
    const fetcher = vi.fn(); window.fetch = fetcher;
    const postMessage = vi.spyOn(window, "postMessage");
    for (const property of ["localStorage", "sessionStorage"]) Object.defineProperty(window, property, { get: () => { throw new Error("Storage is unavailable"); } });
    window.eval(chunk.code);
    const facade = window.JellyfinWatch;
    expect(Object.keys(facade).sort()).toEqual([
      "StartupTimeout", "clearActivitySession", "closeDiscordActivity", "connectAccount", "connectCommunity", "deleteConnection",
      "getConnectedParticipants", "getConnections", "getParty", "joinParty", "launchNative", "logout", "matchesPartyServer", "normalizeNativeRoute",
      "observeActivityPresentation", "onSessionRejected", "pollQuickConnect", "resumeActivitySession", "saveNativeRestore", "savePreference", "startActivitySession", "startQuickConnect"
    ]);
    expect(Object.values(facade).every(value => typeof value === "function")).toBe(true);
    expect(window.document.documentElement.outerHTML).toBe(before);
    expect(window.location.href).toBe(href);
    expect(fetcher).not.toHaveBeenCalled(); expect(postMessage).not.toHaveBeenCalled();
  } finally {
    window.close(); vi.restoreAllMocks();
  }
});
