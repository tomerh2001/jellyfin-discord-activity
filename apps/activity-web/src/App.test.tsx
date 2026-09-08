import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const sdk = vi.hoisted(() => ({ close: vi.fn(), invite: vi.fn(), authorize: vi.fn(), authenticate: vi.fn() }));
vi.mock("./discord/sdk.js", () => ({
  initializeDiscord: async () => ({ instanceId: "instance", guildId: "guild", channelId: "channel", sdk: { commands: { openInviteDialog: sdk.invite } } }),
  authorizeDiscord: sdk.authorize, authenticateDiscord: sdk.authenticate, closeDiscordActivity: sdk.close,
  getConnectedParticipants: async () => [{ id: "discord-user", username: "Viewer" }]
}));
const account = { id: "connection", serverUrl: "https://jellyfin.test", serverId: "server", serverName: "Movie library", jellyfinUserId: "jf-user", jellyfinUsername: "Viewer", kind: "personal", createdAt: "2026-09-08", updatedAt: "2026-09-08" };
const party = { id: "party", instanceId: "instance", serverId: "server", serverUrl: "https://jellyfin.test", groupId: "syncplay-group" };
const launch = { baseUrl: "/jf/opaque-capability", accessToken: "opaque-capability", userId: "jf-user", serverId: "server", deviceId: "device", groupId: "syncplay-group" };
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
function fixtures(options: { otherParty?: boolean; revoke?: () => Promise<Response> } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/config")) return json({ publicBaseUrl: "https://activity.test", publicDiscordClientId: "app" });
    if (url.endsWith("/api/discord/exchange")) return json({ appToken: "app-token", discordAccessToken: "discord-token", user: { id: "discord-user", username: "Viewer" }, expiresAt: "2026-09-09T00:00:00Z" });
    if (url.endsWith("/api/connections")) return json({ connections: [account], preferredConnectionId: account.id, defaultServerUrl: account.serverUrl, communityAvailable: false });
    if (url.endsWith("/api/party")) return json({ party: options.otherParty ? { ...party, serverId: "other", serverUrl: "https://other.test" } : party });
    if (url.endsWith("/api/native/launch")) return json(launch);
    if (url.endsWith("/api/connections/preference")) return json({ ok: true });
    if (url.endsWith("/api/logout")) return options.revoke ? options.revoke() : json({ ok: true });
    throw new Error(`Unexpected request ${init?.method || "GET"} ${url}`);
  });
}

describe("native Activity shell", () => {
  beforeEach(() => { sdk.authorize.mockResolvedValue({ code: "oauth-code" }); sdk.authenticate.mockResolvedValue({ id: "discord-user", username: "Viewer" }); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
  it("authorizes once under StrictMode and opens the saved account in the existing native party", async () => {
    const fetcher = fixtures(); vi.stubGlobal("fetch", fetcher);
    render(<StrictMode><App /></StrictMode>);
    const frame = await screen.findByTitle("Jellyfin");
    expect(frame).toHaveAttribute("src", "/jellyfin-web/index.html");
    expect(frame.getAttribute("src")).not.toContain(launch.accessToken);
    expect(sdk.authorize).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/api/party") && init?.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Invite friends" }));
    await waitFor(() => expect(sdk.invite).toHaveBeenCalledTimes(1));
  });
  it("never replaces an existing party with the joiner's unrelated preferred server", async () => {
    const fetcher = fixtures({ otherParty: true }); vi.stubGlobal("fetch", fetcher);
    render(<App />);
    const server = await screen.findByRole("textbox", { name: "Server URL" });
    expect(server).toHaveValue("https://other.test"); expect(server).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: /Movie library.*Viewer.*Another server/ })).toBeDisabled();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/api/native/launch"))).toBe(false);
    expect(fetcher.mock.calls.some(([url, init]) => String(url).endsWith("/api/party") && init?.method === "POST")).toBe(false);
  });
  it("requires explicit confirmation before switching everyone to a saved server with the same server ID at another URL", async () => {
    const alternate = { ...account, id: "other-connection", serverUrl: "https://another.test", serverName: "Another library" };
    const fallback = fixtures();
    let current = party;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/connections")) return json({ connections: [account, alternate], preferredConnectionId: account.id, defaultServerUrl: account.serverUrl, communityAvailable: false });
      if (String(input).endsWith("/api/party")) {
        if (init?.method === "POST") current = { ...party, id: "replacement", groupId: "replacement-group", serverUrl: alternate.serverUrl };
        return json({ party: current });
      }
      return fallback(input, init);
    });
    vi.stubGlobal("fetch", fetcher); render(<App />); await screen.findByTitle("Jellyfin");
    fireEvent.click(screen.getByRole("button", { name: "Accounts" }));
    expect(screen.getByRole("button", { name: /Another library.*Viewer.*Another server/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Change server" }));
    expect(screen.getByRole("textbox", { name: "Server URL" })).not.toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: /Another library.*Viewer/ }));
    await screen.findByRole("dialog", { name: "Change server for everyone?" });
    const changes = () => fetcher.mock.calls.filter(([url, init]) => String(url).endsWith("/api/party") && init?.method === "POST");
    expect(changes()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Confirm change server" }));
    await waitFor(() => expect(changes()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Another library · Viewer")).toBeInTheDocument();
  });
  it("removes an obsolete native player when another viewer changes the party binding", async () => {
    const fallback = fixtures(); let current = party;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith("/api/party") ? Promise.resolve(json({ party: current })) : fallback(input, init)));
    let poll: (() => Promise<void>) | undefined;
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => Promise<void>, delay: number) => {
      if (delay === 5000) poll = callback;
      return interval(callback, delay);
    }) as typeof setInterval);
    render(<App />); await screen.findByTitle("Jellyfin");
    current = { ...party, id: "new-party", groupId: "new-group", serverUrl: "https://changed.test" };
    await act(async () => { await poll?.(); });
    await screen.findByText("The party’s server changed. Choose your account to join the new watch party.");
    expect(screen.queryByTitle("Jellyfin")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Server URL" })).toHaveValue("https://changed.test");
  });
  it("waits for revocation, prevents duplicate leave requests and removes the native player", async () => {
    let resolve!: (value: Response) => void;
    const revoke = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal("fetch", fixtures({ revoke })); render(<App />);
    await screen.findByTitle("Jellyfin");
    const leave = screen.getByRole("button", { name: "Leave watch party" });
    fireEvent.click(leave); fireEvent.click(leave);
    expect(revoke).toHaveBeenCalledTimes(1); expect(sdk.close).not.toHaveBeenCalled();
    resolve(json({ ok: true }));
    await screen.findByText("You left the watch party");
    expect(sdk.close).toHaveBeenCalledTimes(1); expect(screen.queryByTitle("Jellyfin")).not.toBeInTheDocument();
  });
  it("retains a retryable native session when revocation fails and handles SDK close failure safely", async () => {
    const revoke = vi.fn().mockResolvedValueOnce(json({ error: { message: "Unavailable" } }, 503)).mockResolvedValueOnce(json({ ok: true }));
    sdk.close.mockImplementationOnce(() => { throw { message: "internal credential-bearing detail" }; });
    vi.stubGlobal("fetch", fixtures({ revoke })); render(<App />); await screen.findByTitle("Jellyfin");
    fireEvent.click(screen.getByRole("button", { name: "Leave watch party" }));
    await screen.findByText("Could not confirm sign-out. Try leaving again.");
    expect(screen.getByTitle("Jellyfin")).toBeInTheDocument(); expect(sdk.close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Leave watch party" }));
    await screen.findByText("You left the watch party");
    expect(screen.getByRole("alert")).toHaveTextContent("You are signed out.");
    expect(screen.queryByText(/credential-bearing/)).not.toBeInTheDocument();
    expect(sdk.authorize).toHaveBeenCalledTimes(1);
  });
});
