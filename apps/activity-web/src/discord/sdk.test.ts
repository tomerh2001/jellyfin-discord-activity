import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicEnv } from "../api/types.js";

const fixture = vi.hoisted(() => ({ constructed: vi.fn(), ready: vi.fn(), close: vi.fn() }));
vi.mock("@discord/embedded-app-sdk", () => ({
  DiscordSDK: class {
    instanceId = "instance"; guildId = "guild"; channelId = "channel";
    constructor() { fixture.constructed(); }
    ready = fixture.ready; close = fixture.close;
  },
  RPCCloseCodes: { CLOSE_NORMAL: 1000 }
}));
vi.mock("../env.js", () => ({ env: { devDiscordMock: false, devMode: false } }));
const config = { publicDiscordClientId: "client", publicBaseUrl: "https://activity.test" } as PublicEnv;
const originalLocation = window.location.href;
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); window.history.replaceState(null, "", "/?frame_id=frame"); });
afterEach(() => { window.history.replaceState(null, "", originalLocation); });

it("shares one pending SDK handshake and reuses its authenticated document connection", async () => {
  let resolve!: () => void;
  fixture.ready.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const { initializeDiscord, closeDiscordActivity } = await import("./sdk.js");
  const first = initializeDiscord(config); const second = initializeDiscord(config);
  expect(fixture.constructed).toHaveBeenCalledTimes(1); expect(fixture.ready).toHaveBeenCalledTimes(1);
  resolve();
  const [left, right] = await Promise.all([first, second]);
  expect(left.sdk).toBe(right.sdk);
  expect((await initializeDiscord(config)).sdk).toBe(left.sdk);
  expect(fixture.constructed).toHaveBeenCalledTimes(1);
  closeDiscordActivity(left);
  expect(fixture.close).toHaveBeenCalledExactlyOnceWith(1000, "Left watch party");
  fixture.ready.mockResolvedValue(undefined);
  expect((await initializeDiscord(config)).sdk).not.toBe(left.sdk);
  expect(fixture.constructed).toHaveBeenCalledTimes(2);
});
