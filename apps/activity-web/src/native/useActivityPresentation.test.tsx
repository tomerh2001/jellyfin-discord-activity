import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ActivityDiscordContext } from "../discord/sdk.js";
import { fullscreenUnavailable, toggleActivityFullscreen, useActivityPresentation } from "./useActivityPresentation.js";

afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const key of ["fullscreenElement", "fullscreenEnabled", "exitFullscreen"]) Reflect.deleteProperty(document, key);
});

it("uses Discord's current layout event and viewport fallback without losing the subscription under StrictMode", async () => {
  const listeners = new Set<(event: { layout_mode: number }) => void>();
  const subscribe = vi.fn(async (_name, callback) => { listeners.add(callback); });
  const unsubscribe = vi.fn(async (_name, callback) => { listeners.delete(callback); });
  const discord = { instanceId: "instance", isMock: false, sdk: { subscribe, unsubscribe } } as unknown as ActivityDiscordContext;
  const { result, unmount } = renderHook(() => useActivityPresentation(discord), { wrapper: StrictMode });
  await act(async () => undefined);
  expect(listeners.size).toBe(1);
  expect(subscribe).toHaveBeenCalledWith("ACTIVITY_LAYOUT_MODE_UPDATE", expect.any(Function));
  act(() => { for (const listener of listeners) listener({ layout_mode: 1 }); });
  expect(result.current.presentation).toEqual({ layout: "pip", preview: true });
  act(() => { for (const listener of listeners) listener({ layout_mode: 2 }); });
  expect(result.current.presentation).toEqual({ layout: "grid", preview: true });
  act(() => { for (const listener of listeners) listener({ layout_mode: 0 }); });
  expect(result.current.presentation).toEqual({ layout: "focused", preview: false });
  vi.stubGlobal("innerWidth", 320); vi.stubGlobal("innerHeight", 180);
  act(() => { window.dispatchEvent(new Event("resize")); });
  expect(result.current.presentation.preview).toBe(true);
  vi.stubGlobal("innerHeight", 700);
  act(() => { window.dispatchEvent(new Event("resize")); });
  expect(result.current.presentation.preview).toBe(false);
  unmount(); await act(async () => undefined);
  expect(listeners.size).toBe(0);
});

it("requests actual fullscreen synchronously and reflects exit through fullscreenchange", async () => {
  const shell = document.createElement("main");
  const enter = vi.fn(async () => undefined); const exit = vi.fn(async () => undefined);
  Object.defineProperty(shell, "requestFullscreen", { value: enter, configurable: true });
  const enabled = vi.fn(() => true);
  const current = vi.fn<() => Element | null>(() => null);
  Object.defineProperty(document, "fullscreenEnabled", { get: enabled, configurable: true });
  Object.defineProperty(document, "fullscreenElement", { get: current, configurable: true });
  Object.defineProperty(document, "exitFullscreen", { value: exit, configurable: true });
  const { result } = renderHook(() => useActivityPresentation({ instanceId: "mock", isMock: true }));
  const request = toggleActivityFullscreen(shell);
  expect(enter).toHaveBeenCalledExactlyOnceWith({ navigationUI: "hide" });
  expect(result.current.fullscreen).toBe(false);
  await request;
  current.mockReturnValue(shell); act(() => { document.dispatchEvent(new Event("fullscreenchange")); });
  expect(result.current.fullscreen).toBe(true);
  await toggleActivityFullscreen(shell); expect(exit).toHaveBeenCalledOnce();
  current.mockReturnValue(null); act(() => { document.dispatchEvent(new Event("fullscreenchange")); });
  expect(result.current.fullscreen).toBe(false);
  enabled.mockReturnValue(false);
  await expect(toggleActivityFullscreen(shell)).rejects.toThrow(fullscreenUnavailable);
  expect(enter).toHaveBeenCalledTimes(1);
});
