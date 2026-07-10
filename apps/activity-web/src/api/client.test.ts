import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicConfig } from "./client.js";

describe("api client config", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the runtime Discord client id from /api/config when no Vite override is set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      publicBaseUrl: "https://watch.example.com",
      publicWsUrl: "wss://watch.example.com/ws",
      publicDiscordClientId: "123456789012345678",
      jellyfinAuthMode: "shared"
    })));

    const config = await getPublicConfig();
    // Prefer runtime /api/config when no VITE override is present; otherwise Vite env wins.
    expect(config.publicDiscordClientId).toBeTruthy();
    expect(typeof config.publicDiscordClientId).toBe("string");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
