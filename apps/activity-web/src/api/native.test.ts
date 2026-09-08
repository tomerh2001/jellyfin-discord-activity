import { afterEach, expect, it, vi } from "vitest";
import { connectAccount, getConnections, getParty, joinParty, launchNative, matchesPartyServer, deleteConnection, pollQuickConnect } from "./native.js";
import { onSessionRejected } from "./sessionRecovery.js";

const connection = { id: "account", serverUrl: "https://jellyfin.test", serverId: "server", serverName: "Library", jellyfinUserId: "jf-user", jellyfinUsername: "Viewer", kind: "personal", createdAt: "2026-09-08", updatedAt: "2026-09-08" };
const party = { id: "party", instanceId: "instance", serverId: "server", serverUrl: "https://jellyfin.test", groupId: "group" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("sends Jellyfin credentials only in an authenticated broker POST, never its URL or a direct upstream request", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ connection })); vi.stubGlobal("fetch", fetcher);
  const input = { serverUrl: connection.serverUrl, username: "Viewer", password: "fixture-password" };
  await expect(connectAccount("app-token", input)).resolves.toEqual(connection);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/connections", expect.objectContaining({
    method: "POST", headers: { Authorization: "Bearer app-token", "Content-Type": "application/json" }, body: JSON.stringify(input), signal: expect.any(AbortSignal)
  }));
});

it("retains explicit party binding and requires both server identity and URL to match", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ party: null })).mockResolvedValueOnce(Response.json({ party }));
  vi.stubGlobal("fetch", fetcher);
  expect(await getParty("app-token")).toBeNull();
  expect(await joinParty("app-token", "account")).toEqual(party);
  expect(fetcher.mock.calls[1]).toEqual(["/api/party", expect.objectContaining({ method: "POST", body: JSON.stringify({ connectionId: "account" }) })]);
  expect(matchesPartyServer({ ...connection, kind: "personal" }, party)).toBe(true);
  expect(matchesPartyServer({ ...connection, kind: "personal", serverUrl: "https://other.test" }, party)).toBe(false);
  expect(matchesPartyServer({ ...connection, kind: "personal", serverId: "different" }, party)).toBe(false);
});

it("rejects a native launch pointing outside the opaque same-origin gateway", async () => {
  const launch = { baseUrl: "/jf/capability", accessToken: "capability", userId: "jf-user", serverId: "server", deviceId: "device", groupId: "group" };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(launch))
    .mockResolvedValueOnce(Response.json({ ...launch, baseUrl: "https://untrusted.test/jf/capability" }));
  vi.stubGlobal("fetch", fetcher);
  expect(await launchNative("app-token", "account", "device")).toEqual(launch);
  await expect(launchNative("app-token", "account", "device")).rejects.toThrow();
});

it("notifies recovery only for a rejected app session and removes the listener on teardown", async () => {
  const listener = vi.fn(); const stop = onSessionRejected(listener);
  const fetcher = vi.fn().mockImplementation(async () => Response.json({ error: { code: "invalid_app_token", message: "Session expired." } }, { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(getConnections("expired-session")).rejects.toThrow("Session expired.");
    expect(listener).toHaveBeenCalledExactlyOnceWith("expired-session");
    for (const [status, code] of [[403, "invalid_app_token"], [401, "discord_proxy_required"]] as const) {
      fetcher.mockResolvedValueOnce(Response.json({ error: { code, message: "Denied." } }, { status }));
      await expect(getConnections("different-session")).rejects.toThrow("Denied.");
    }
    expect(listener).toHaveBeenCalledTimes(1);
    stop(); await expect(getConnections("expired-session")).rejects.toThrow("Session expired.");
    expect(listener).toHaveBeenCalledTimes(1);
  } finally { stop(); }
});

it("encodes connection paths and honors cancellation before a Quick Connect poll", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true })); vi.stubGlobal("fetch", fetcher);
  await deleteConnection("app-token", "account/other");
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/connections/account%2Fother");
  const controller = new AbortController(); controller.abort();
  await expect(pollQuickConnect("app-token", "poll", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
