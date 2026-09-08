import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeClient } from "./NativeClient.js";

const launch = { baseUrl: "/jf/private-capability", accessToken: "private-capability", userId: "user", serverId: "server", deviceId: "device", groupId: "group" };
const presentation = { layout: "focused" as const, preview: false };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("shares the launch only with its own same-origin child and validates status nonce", () => {
  const onStatus = vi.fn(); render(<NativeClient launch={launch} onStatus={onStatus} onVideoChange={vi.fn()} presentation={presentation} />);
  const child = (screen.getByTitle("Jellyfin") as HTMLIFrameElement).contentWindow!;
  const send = vi.spyOn(child, "postMessage");
  const data = { channel: "jellyfin-watch-native", type: "ready", nonce: "unique-child-nonce" };
  fireEvent(window, new MessageEvent("message", { data, origin: window.location.origin, source: window }));
  fireEvent(window, new MessageEvent("message", { data, origin: "https://untrusted.test", source: child }));
  expect(send).not.toHaveBeenCalled();
  fireEvent(window, new MessageEvent("message", { data, origin: window.location.origin, source: child }));
  expect(send).toHaveBeenCalledWith({ ...data, type: "bootstrap", launch, presentation }, window.location.origin);
  fireEvent(window, new MessageEvent("message", { data: { ...data, type: "status", status: "connected", nonce: "another-child-nonce" }, origin: window.location.origin, source: child }));
  expect(onStatus).not.toHaveBeenCalled();
  fireEvent(window, new MessageEvent("message", { data: { ...data, type: "status", status: "connected" }, origin: window.location.origin, source: child }));
  expect(onStatus).toHaveBeenCalledWith("connected");
});

it("resizes the same authenticated frame for preview and accepts video state only from that frame", () => {
  const onVideoChange = vi.fn(); const onStatus = vi.fn();
  const { rerender } = render(<NativeClient launch={launch} onStatus={onStatus} onVideoChange={onVideoChange} presentation={presentation} />);
  const frame = screen.getByTitle("Jellyfin") as HTMLIFrameElement;
  const child = frame.contentWindow!; const send = vi.spyOn(child, "postMessage");
  const data = { channel: "jellyfin-watch-native", type: "ready", nonce: "unique-child-nonce" };
  const event = { origin: window.location.origin, source: child };
  fireEvent(window, new MessageEvent("message", { ...event, data }));
  onVideoChange.mockClear(); send.mockClear();
  for (const invalid of [{ origin: "https://untrusted.test" }, { source: window }, { data: { ...data, type: "video", nonce: "another-child-nonce", active: true } }, { data: { ...data, type: "video", active: "true" } }]) {
    fireEvent(window, new MessageEvent<unknown>("message", { ...event, data: { ...data, type: "video", active: true }, ...invalid }));
  }
  expect(onVideoChange).not.toHaveBeenCalled();
  fireEvent(window, new MessageEvent("message", { ...event, data: { ...data, type: "video", active: true } }));
  expect(onVideoChange).toHaveBeenLastCalledWith(true);
  const pip = { layout: "pip" as const, preview: true };
  rerender(<NativeClient launch={launch} onStatus={onStatus} onVideoChange={onVideoChange} presentation={pip} />);
  expect(screen.getByTitle("Jellyfin")).toBe(frame); expect(frame.contentWindow).toBe(child);
  expect(send).toHaveBeenCalledExactlyOnceWith({ ...data, type: "presentation", presentation: pip }, window.location.origin);
  fireEvent(window, new MessageEvent("message", { ...event, data: { ...data, type: "video", active: false } }));
  expect(onVideoChange).toHaveBeenLastCalledWith(false);
});
