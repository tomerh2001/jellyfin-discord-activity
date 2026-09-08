import { afterEach, expect, it, vi } from "vitest";
import { logout } from "./client.js";
import { onSessionRejected } from "./sessionRecovery.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("identifies a revoked app token during logout so Leave never needs to mint a replacement", async () => {
  const listener = vi.fn(); const stop = onSessionRejected(listener);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ error: { code: "invalid_app_token", message: "Session expired." } }, { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  try {
    await expect(logout("expired-session")).rejects.toThrow("Session expired.");
    expect(listener).toHaveBeenCalledExactlyOnceWith("expired-session");
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/logout", expect.objectContaining({
      method: "POST", headers: { Authorization: "Bearer expired-session" }, signal: expect.any(AbortSignal)
    }));
  } finally { stop(); }
});

it.each([
  [403, "invalid_app_token"], [401, "discord_proxy_required"], [502, "upstream_unavailable"], [401, undefined]
])("does not mistake an unrelated logout failure (%s/%s) for a revoked app token", async (status, code) => {
  const listener = vi.fn(); const stop = onSessionRejected(listener);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code, message: "Denied." } }, { status })));
  try {
    await expect(logout("current-session")).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();
  } finally { stop(); }
});
