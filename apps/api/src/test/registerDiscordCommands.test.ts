import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDiscordCommands } from "../services/registerDiscordCommands.js";

const base = "https://discord.com/api/v10/applications/application";
const entry = { id: "entry-id", type: 4, name: "Launch", description: "Start watching", handler: 2,
  contexts: [0], integration_types: [0], default_member_permissions: "1024", nsfw: false };
afterEach(() => { vi.unstubAllGlobals(); });

function mockDiscord(existing: unknown[]) {
  const requests: { url: string; method: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, method: init.method ?? "GET", ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return Response.json(init.method === "GET" ? existing : {});
  }));
  return requests;
}

describe("Discord command registration", () => {
  it("replaces the automatic-message handler while retaining global entry point restrictions", async () => {
    const requests = mockDiscord([entry]);
    expect(await registerDiscordCommands("application", "test-bot-token")).toBe(5);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ url: `${base}/commands`, method: "PUT" });
    expect(requests[1]!.body).toContainEqual({ type: 4, name: "Launch", description: "Start watching", handler: 1,
      contexts: [0], integration_types: [0], default_member_permissions: "1024", nsfw: false });
  });

  it("fixes the global entry handler during guild registration without replacing global commands", async () => {
    const requests = mockDiscord([entry, { id: "unrelated", type: 1, name: "other", description: "Other command" }]);
    expect(await registerDiscordCommands("application", "test-bot-token", "guild")).toBe(4);
    expect(requests.map(({ url, method }) => ({ url, method }))).toEqual([
      { url: `${base}/commands`, method: "GET" },
      { url: `${base}/commands/entry-id`, method: "PATCH" },
      { url: `${base}/guilds/guild/commands`, method: "PUT" }
    ]);
    expect(requests[1]!.body).toEqual({ handler: 1 });
    expect(requests[2]!.body).not.toContainEqual(expect.objectContaining({ type: 4 }));
  });

  it("creates a missing entry point without allowing user installs or private-channel contexts", async () => {
    const requests = mockDiscord([]);
    await registerDiscordCommands("application", "test-bot-token", "guild");
    expect(requests[1]).toMatchObject({ url: `${base}/commands`, method: "POST", body: {
      type: 4, name: "launch", handler: 1, contexts: [0], integration_types: [0]
    } });
  });

  it("stops after a failed command read instead of silently replacing unknown settings", async () => {
    const fetch = vi.fn(async () => Response.json({}, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(registerDiscordCommands("application", "test-bot-token", "guild")).rejects.toThrow("HTTP 403");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
