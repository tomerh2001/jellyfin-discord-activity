import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSessionStarter, StartupTimeout } from "./session.js";

const api = vi.hoisted(() => ({ config: vi.fn(), exchange: vi.fn(), resume: vi.fn(), logout: vi.fn(), initialize: vi.fn(), authorize: vi.fn(), authenticate: vi.fn() }));
vi.mock("../api/client.js", () => ({ getPublicConfig: api.config, exchangeDiscordCode: api.exchange, resumeDiscordSession: api.resume, logout: api.logout }));
vi.mock("./sdk.js", () => ({ initializeDiscord: api.initialize, authorizeDiscord: api.authorize, authenticateDiscord: api.authenticate }));
const exchange = { appToken: "session", discordAccessToken: "oauth", user: { id: "viewer", username: "Viewer" }, expiresAt: "2099-01-01T00:00:00Z" };
beforeEach(() => {
  vi.clearAllMocks();
  api.config.mockResolvedValue({ publicDiscordClientId: "app" });
  api.initialize.mockResolvedValue({ instanceId: "instance", guildId: "guild", channelId: "channel" });
  api.authorize.mockResolvedValue({ code: "code" });
  api.exchange.mockResolvedValue(exchange);
  api.authenticate.mockResolvedValue(exchange.user);
  api.resume.mockResolvedValue({ ...exchange, appToken: "restored-session" });
  api.logout.mockResolvedValue(undefined);
});

it("serializes recovery with the existing OAuth token without authorizing an authenticated SDK again", async () => {
  const start = createSessionStarter();
  await start();
  const recovery = start.resume();
  expect(start.resume()).toBe(recovery);
  await expect(recovery).resolves.toMatchObject({ exchange: { appToken: "restored-session" } });
  await expect(start()).resolves.toMatchObject({ exchange: { appToken: "restored-session" } });
  expect(api.resume).toHaveBeenCalledWith("oauth", { instanceId: "instance", guildId: "guild", channelId: "channel", userId: "viewer" });
  expect(api.authorize).toHaveBeenCalledTimes(1);
  expect(api.authenticate).toHaveBeenCalledTimes(1);
});

it("keeps OAuth proof for an explicit retry when verified recovery is temporarily unavailable", async () => {
  api.resume.mockRejectedValueOnce(new Error("Discord unavailable"));
  const start = createSessionStarter(); await start();
  await expect(start.resume()).rejects.toThrow("Discord unavailable");
  await expect(start.resume()).resolves.toMatchObject({ exchange: { appToken: "restored-session" } });
  expect(api.authorize).toHaveBeenCalledTimes(1);
});

it("revokes a late recovered token rather than publishing it after the Activity was left", async () => {
  let resolve!: (value: typeof exchange) => void;
  api.resume.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const start = createSessionStarter(); await start();
  const recovery = start.resume(); start.dispose();
  resolve({ ...exchange, appToken: "late-session" });
  await expect(recovery).rejects.toThrow("closed");
  expect(api.logout).toHaveBeenCalledWith("late-session");
});

it("restores an expired cached app session using live OAuth verification", async () => {
  api.exchange.mockResolvedValueOnce({ ...exchange, expiresAt: "2000-01-01T00:00:00Z" });
  const start = createSessionStarter(); await start();
  await expect(start()).resolves.toMatchObject({ exchange: { appToken: "restored-session" } });
  expect(api.authorize).toHaveBeenCalledTimes(1);
});
afterEach(() => { vi.useRealTimers(); });

it("shares in-flight startup and retains successful authentication across a renderer remount", async () => {
  const start = createSessionStarter();
  const first = start(); expect(start()).toBe(first);
  await first; await start();
  expect(api.authorize).toHaveBeenCalledTimes(1);
  expect(api.exchange).toHaveBeenCalledTimes(1);
  expect(api.authenticate).toHaveBeenCalledTimes(1);
});

it("retries a failed RPC authentication without repeating AUTHORIZE or discarding the app token", async () => {
  api.authenticate.mockRejectedValueOnce(new Error("RPC interrupted"));
  const start = createSessionStarter();
  await expect(start()).rejects.toThrow("RPC interrupted");
  await expect(start()).resolves.toMatchObject({ exchange });
  expect(api.authorize).toHaveBeenCalledTimes(1);
  expect(api.exchange).toHaveBeenCalledTimes(1);
  expect(api.authenticate).toHaveBeenCalledTimes(2);
});

it("gets a fresh one-time code after an unsuccessful HTTP exchange", async () => {
  api.exchange.mockRejectedValueOnce(new Error("Network interrupted"));
  api.authorize.mockResolvedValueOnce({ code: "first" }).mockResolvedValueOnce({ code: "second" });
  const start = createSessionStarter();
  await expect(start()).rejects.toThrow("Network interrupted");
  await start();
  expect(api.exchange.mock.calls.map(([input]) => input.code)).toEqual(["first", "second"]);
});

it("awaits an original late SDK reply after timeout instead of issuing overlapping authorizations", async () => {
  vi.useFakeTimers();
  let resolve!: (result: { code: string }) => void;
  api.authorize.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const start = createSessionStarter();
  const first = expect(start()).rejects.toBeInstanceOf(StartupTimeout);
  await vi.advanceTimersByTimeAsync(20_001); await first;
  const retry = start(); resolve({ code: "late" });
  await expect(retry).resolves.toMatchObject({ exchange });
  expect(api.authorize).toHaveBeenCalledTimes(1);
});
