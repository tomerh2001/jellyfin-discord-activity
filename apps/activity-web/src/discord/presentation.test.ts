import { afterEach, expect, it, vi } from "vitest";
import type { ActivityDiscordContext } from "./sdk.js";
import { observeActivityPresentation } from "./presentation.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function context() {
  const listeners = new Set<(update: { layout_mode: number }) => void>();
  let subscribed = false;
  const sdk = {
    subscribe: vi.fn(async (event, listener) => {
      expect(event).toBe("ACTIVITY_LAYOUT_MODE_UPDATE");
      if (!listeners.size) subscribed = true;
      listeners.add(listener);
    }),
    unsubscribe: vi.fn(async (event, listener) => {
      expect(event).toBe("ACTIVITY_LAYOUT_MODE_UPDATE");
      if (listeners.size === 1) subscribed = false;
      listeners.delete(listener);
    })
  };
  return {
    discord: { instanceId: "instance", isMock: false, sdk } as unknown as ActivityDiscordContext,
    emit: (layout_mode: number) => { for (const listener of listeners) listener({ layout_mode }); },
    listeners, sdk, subscribed: () => subscribed
  };
}

it("reports the current viewport immediately and follows focused, PIP and grid without restarting a session", async () => {
  const state = context(); const callback = vi.fn();
  const stop = observeActivityPresentation(state.discord, callback);
  expect(callback).toHaveBeenLastCalledWith({ layout: "focused", preview: false });
  state.emit(1); expect(callback).toHaveBeenLastCalledWith({ layout: "pip", preview: true });
  state.emit(2); expect(callback).toHaveBeenLastCalledWith({ layout: "grid", preview: true });
  const calls = callback.mock.calls.length;
  for (const invalid of [-1, 3, 0.5, Number.NaN]) state.emit(invalid);
  state.emit(2); expect(callback).toHaveBeenCalledTimes(calls);
  state.emit(0); expect(callback).toHaveBeenLastCalledWith({ layout: "focused", preview: false });
  vi.stubGlobal("innerWidth", 320); vi.stubGlobal("innerHeight", 180);
  window.dispatchEvent(new Event("resize"));
  expect(callback).toHaveBeenLastCalledWith({ layout: "focused", preview: true });
  vi.stubGlobal("innerWidth", 390); vi.stubGlobal("innerHeight", 844);
  window.dispatchEvent(new Event("resize"));
  expect(callback).toHaveBeenLastCalledWith({ layout: "focused", preview: false });
  stop(); stop(); await Promise.resolve();
  expect(state.sdk.unsubscribe).toHaveBeenCalledTimes(1);
  expect(state.listeners.size).toBe(0);
  callback.mockClear(); state.emit(1); window.dispatchEvent(new Event("resize"));
  expect(callback).not.toHaveBeenCalled();
});

it("keeps a replacement observer subscribed when teardown and initialization share a turn", async () => {
  const state = context(); const previous = vi.fn(); const current = vi.fn();
  const stopPrevious = observeActivityPresentation(state.discord, previous);
  stopPrevious(); const stopCurrent = observeActivityPresentation(state.discord, current);
  await Promise.resolve();
  expect(state.subscribed()).toBe(true); expect(state.listeners.size).toBe(1);
  previous.mockClear(); current.mockClear();
  state.emit(1);
  expect(previous).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledExactlyOnceWith({ layout: "pip", preview: true });
  stopCurrent(); await Promise.resolve(); expect(state.subscribed()).toBe(false);
});

it("still tracks the viewport when the SDK is unavailable or its subscription fails", async () => {
  vi.stubGlobal("innerWidth", 320); vi.stubGlobal("innerHeight", 180);
  const callback = vi.fn();
  const stop = observeActivityPresentation({ instanceId: "local", isMock: true }, callback);
  expect(callback).toHaveBeenCalledExactlyOnceWith({ layout: "focused", preview: true }); stop();
  const state = context(); state.sdk.subscribe.mockRejectedValueOnce(new Error("Unavailable"));
  const failed = observeActivityPresentation(state.discord, callback);
  await Promise.resolve();
  vi.stubGlobal("innerWidth", 1024); window.dispatchEvent(new Event("resize"));
  expect(callback).toHaveBeenLastCalledWith({ layout: "focused", preview: false });
  failed(); await Promise.resolve();
});
