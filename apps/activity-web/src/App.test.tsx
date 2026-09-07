import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the Activity scaffold after boot", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url.endsWith("/api/health")) {
        return jsonResponse({ ok: true });
      }

      if (url.endsWith("/api/config")) {
        return jsonResponse({
          publicBaseUrl: "http://localhost:3000",
          publicWsUrl: "ws://localhost:3000/ws",
          publicDiscordClientId: "dev-client-id",
          jellyfinAuthMode: "per-user"
        });
      }

      if (url.includes("/api/rooms/current?")) {
        return jsonResponse({
          room: {
            instanceId: "dev-instance-1",
            playState: "idle",
            positionSeconds: 0,
            updatedAt: "2026-07-09T12:00:00.000Z"
          }
        });
      }

      return jsonResponse({
        error: {
          code: "not_found",
          message: "Not found"
        }
      }, 404);
    }));

    render(<App />);

    await screen.findByRole("button", { name: "Authenticate" });
    expect(screen.getAllByText("Dev Host").length).toBeGreaterThan(0);
  });

  it("authenticates with the dev mock Discord flow", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url.endsWith("/api/health")) {
        return jsonResponse({ ok: true });
      }

      if (url.endsWith("/api/config")) {
        return jsonResponse({
          publicBaseUrl: "http://localhost:3000",
          publicWsUrl: "ws://localhost:3000/ws",
          publicDiscordClientId: "dev-client-id",
          jellyfinAuthMode: "per-user"
        });
      }

      if (url.includes("/api/rooms/current?")) {
        return jsonResponse({
          room: {
            instanceId: "dev-instance-1",
            playState: "idle",
            positionSeconds: 0,
            updatedAt: "2026-07-09T12:00:00.000Z"
          }
        });
      }

      if (url.endsWith("/api/discord/exchange")) {
        return jsonResponse({
          appToken: "app-token",
          discordAccessToken: "discord-token",
          user: {
            id: "dev-user-host",
            username: "DevHost",
            globalName: "Dev Host",
            avatar: null
          },
          expiresAt: "2026-07-09T12:00:00.000Z"
        });
      }

      if (url.endsWith("/api/me")) {
        return jsonResponse({
          discordUser: {
            id: "dev-user-host",
            username: "DevHost",
            globalName: "Dev Host",
            avatar: null
          },
          jellyfinLinked: false,
          discordContext: {
            instanceId: "dev-instance-1"
          },
          appSessionExpiresAt: "2026-07-09T12:00:00.000Z"
        });
      }

      if (url.endsWith("/api/jellyfin/status")) {
        return jsonResponse({
          linked: false
        });
      }

      return jsonResponse({
        error: {
          code: "not_found",
          message: "Not found"
        }
      }, 404);
    }));

    render(<App />);

    const button = await screen.findByRole("button", { name: "Authenticate" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Logout" })).toBeInTheDocument();
    });
  });

  it("hides the Jellyfin link form in shared auth mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url.endsWith("/api/health")) {
        return jsonResponse({ ok: true });
      }

      if (url.endsWith("/api/config")) {
        return jsonResponse({
          publicBaseUrl: "http://localhost:3000",
          publicWsUrl: "ws://localhost:3000/ws",
          publicDiscordClientId: "dev-client-id",
          jellyfinAuthMode: "shared"
        });
      }

      if (url.includes("/api/rooms/current?")) {
        return jsonResponse({
          room: {
            instanceId: "dev-instance-1",
            playState: "idle",
            positionSeconds: 0,
            updatedAt: "2026-07-09T12:00:00.000Z"
          }
        });
      }

      if (url.endsWith("/api/discord/exchange")) {
        return jsonResponse({
          appToken: "app-token",
          discordAccessToken: "discord-token",
          user: {
            id: "dev-user-host",
            username: "DevHost",
            globalName: "Dev Host",
            avatar: null
          },
          expiresAt: "2026-07-09T12:00:00.000Z"
        });
      }

      if (url.endsWith("/api/me")) {
        return jsonResponse({
          discordUser: {
            id: "dev-user-host",
            username: "DevHost",
            globalName: "Dev Host",
            avatar: null
          },
          jellyfinLinked: true,
          discordContext: {
            instanceId: "dev-instance-1"
          },
          appSessionExpiresAt: "2026-07-09T12:00:00.000Z"
        });
      }

      if (url.endsWith("/api/jellyfin/status")) {
        return jsonResponse({
          linked: true,
          authMode: "shared",
          serverUrl: "https://jellyfin.example.com",
          username: "discord-watch"
        });
      }

      if (url.endsWith("/api/jellyfin/libraries")) {
        return jsonResponse({
          libraries: [{
            id: "movies",
            name: "Movies",
            collectionType: "movies"
          }]
        });
      }

      return jsonResponse({
        error: {
          code: "not_found",
          message: "Not found"
        }
      }, 404);
    }));

    render(<App />);

    const button = await screen.findByRole("button", { name: "Authenticate" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Logout" })).toBeInTheDocument();
    });
    expect(screen.queryByText("Jellyfin shared account")).not.toBeInTheDocument();
    expect(screen.queryAllByRole("button", { name: "Link Jellyfin" })).toHaveLength(0);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
