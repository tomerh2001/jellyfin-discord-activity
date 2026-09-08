import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DiscordSDK } from "@discord/embedded-app-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { initializeDiscord } from "./discord/sdk.js";

vi.mock("./discord/sdk.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./discord/sdk.js")>(),
  initializeDiscord: vi.fn()
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("leaving an authenticated Discord Activity", () => {
  it("revokes once before closing the Activity and never offers reauthorization on the old RPC", async () => {
    let finishLogout!: (response: Response) => void;
    let revoked = false;
    const logoutResponse = new Promise<Response>((resolve) => { finishLogout = resolve; });
    const { close, authorize, request } = setup(() => logoutResponse);
    close.mockImplementation(() => { expect(revoked).toBe(true); });
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Authenticate" }));
    const leave = await screen.findByRole("button", { name: "Leave watch party" });
    expect(container.querySelector(".workspace")).not.toBeNull();

    fireEvent.click(leave);
    fireEvent.click(leave);
    expect(screen.getByRole("button", { name: "Leaving" })).toBeDisabled();
    expect(close).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([url]) => String(url).endsWith("/api/logout"))).toHaveLength(1);

    revoked = true;
    finishLogout(json({ ok: true }));
    await screen.findByRole("heading", { name: "You left the watch party" });
    expect(close).toHaveBeenCalledExactlyOnceWith(1000, "Left watch party");
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Authenticate" })).not.toBeInTheDocument();
    expect(container.querySelector(".workspace")).toBeNull();
  });

  it("keeps the authenticated session available for retry when revocation fails", async () => {
    let failed = true;
    const { close, authorize } = setup(async () => failed
      ? json({ error: { code: "unavailable", message: "Unavailable" } }, 503)
      : json({ ok: true }));
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Authenticate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Leave watch party" }));

    await screen.findByText("Could not confirm sign-out. Try leaving again.");
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Leave watch party" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Authenticate" })).not.toBeInTheDocument();
    expect(container.querySelector(".workspace")).not.toBeNull();

    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Leave watch party" }));
    await screen.findByRole("heading", { name: "You left the watch party" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("stays signed out with reopen guidance when Discord cannot close the frame", async () => {
    const { close } = setup(async () => json({ ok: true }));
    close.mockImplementation(() => { throw { code: 4000, message: "Sensitive internal detail" }; });
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Authenticate" }));
    fireEvent.click(await screen.findByRole("button", { name: "Leave watch party" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
      "You are signed out. Close this Activity before opening /watch again."
    ));
    expect(screen.queryByRole("button", { name: "Authenticate" })).not.toBeInTheDocument();
    expect(container.querySelector(".workspace")).toBeNull();
    expect(container.textContent).not.toContain("Sensitive internal detail");
  });
});

function setup(logoutResponse: () => Promise<Response>) {
  let authenticated = false;
  const close = vi.fn();
  const authorize = vi.fn(async () => {
    if (authenticated) throw { code: 4002, message: "Already authenticated" };
    return { code: "fresh-code" };
  });
  vi.mocked(initializeDiscord).mockResolvedValue({
    instanceId: "instance", guildId: "guild", channelId: "channel", isMock: false,
    sdk: {
      close,
      commands: {
        authorize,
        authenticate: vi.fn(async () => {
          authenticated = true;
          return { user: { id: "viewer", username: "Viewer" } };
        }),
        getActivityInstanceConnectedParticipants: vi.fn(async () => ({ participants: [] }))
      }
    } as unknown as DiscordSDK
  });
  const request = vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/api/health")) return json({ ok: true });
    if (url.endsWith("/api/config")) return json({ publicBaseUrl: "http://localhost:3000",
      publicWsUrl: "ws://localhost:3000/ws", publicDiscordClientId: "app", jellyfinAuthMode: "shared" });
    if (url.endsWith("/api/discord/exchange")) return json({ appToken: "app-session", discordAccessToken: "oauth-token",
      user: { id: "viewer", username: "Viewer" }, expiresAt: "2026-09-09T00:00:00Z" });
    if (url.endsWith("/api/me")) return json({ discordUser: { id: "viewer", username: "Viewer" }, jellyfinLinked: true,
      discordContext: { instanceId: "instance" }, appSessionExpiresAt: "2026-09-09T00:00:00Z" });
    if (url.includes("/api/rooms/current?")) return json({ room: { instanceId: "instance", playState: "idle",
      positionSeconds: 0, updatedAt: "2026-09-08T00:00:00Z" } });
    if (url.endsWith("/api/logout")) return logoutResponse();
    return json({ error: { code: "not_found", message: "Not found" } }, 404);
  });
  vi.stubGlobal("fetch", request);
  return { close, authorize, request };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
