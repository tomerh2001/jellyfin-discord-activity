// @vitest-environment node
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { expect, it, vi } from "vitest";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string; runScripts: "outside-only" }) => { window: Window & typeof globalThis };
};

it("loads a passive facade outside Discord and overlaps one Activity handshake with native loading inside its frame", async () => {
  const result = await build({ configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)), logLevel: "silent", build: { write: false } });
  const results = Array.isArray(result) ? result : [result];
  const outputs = results.flatMap(value => "output" in value ? value.output : []);
  const chunks = outputs.filter(value => value.type === "chunk");
  expect(chunks).toHaveLength(1);
  const chunk = chunks[0]!;
  expect(chunk.fileName).toBe("activity-session.js");
  for (const inActivity of [false, true]) {
    const { window } = new JSDOM("<!doctype html><body><main>Native Jellyfin</main></body>", { url: `https://activity.test/${inActivity ? '?frame_id=frame' : ''}`, runScripts: "outside-only" });
    const before = window.document.documentElement.outerHTML;
    const href = window.location.href;
    try {
      const fetcher = vi.fn(() => new Promise<Response>(() => {})); window.fetch = fetcher;
      const postMessage = vi.spyOn(window, "postMessage");
      for (const property of ["localStorage", "sessionStorage"]) Object.defineProperty(window, property, { get: () => { throw new Error("Storage is unavailable"); } });
      window.eval(chunk.code);
      const facade = window.JellyfinWatch;
      expect(Object.keys(facade).sort()).toEqual([
        "StartupTimeout", "clearActivitySession", "closeDiscordActivity", "connectAccount", "connectCommunity", "createWatchPresence", "deleteConnection",
        "getConnectedParticipants", "getConnections", "getParty", "joinParty", "launchNative", "logout", "matchesPartyServer", "normalizeNativeRoute",
        "observeActivityPresentation", "onSessionRejected", "pollQuickConnect", "resumeActivitySession", "saveNativeRestore", "savePreference", "startActivitySession", "startQuickConnect"
      ]);
      expect(Object.values(facade).every(value => typeof value === "function")).toBe(true);
      expect(window.document.documentElement.outerHTML).toBe(before);
      expect(window.location.href).toBe(href);
      if (inActivity) {
        expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/config", expect.any(Object));
        // A slow native bundle must not delay the config/Discord connection, and
        // its eventual controller start must share that same pending handshake.
        void facade.startActivitySession().catch(() => {});
        expect(fetcher).toHaveBeenCalledTimes(1);
      } else expect(fetcher).not.toHaveBeenCalled();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      window.close(); vi.restoreAllMocks();
    }
  }
});
