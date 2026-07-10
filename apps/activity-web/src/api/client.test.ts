import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicConfig } from "./client.js";

describe("api client config", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the runtime Discord client id from /api/config when no Vite override is set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      publicBaseUrl: "https://djf.techdaddydigital.com",
      publicWsUrl: "wss://djf.techdaddydigital.com/ws",
      publicDiscordClientId: "1524768889580556289",
      jellyfinAuthMode: "shared"
    })));

    await expect(getPublicConfig()).resolves.toMatchObject({
      publicDiscordClientId: "1524768889580556289"
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
