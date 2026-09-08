import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeClient } from "./NativeClient.js";

const launch = { baseUrl: "/jf/private-capability", accessToken: "private-capability", userId: "user", serverId: "server", deviceId: "device", groupId: "group" };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("shares the launch only with its own same-origin child and validates status nonce", () => {
  const onStatus = vi.fn(); render(<NativeClient launch={launch} onStatus={onStatus} />);
  const child = (screen.getByTitle("Jellyfin") as HTMLIFrameElement).contentWindow!;
  const send = vi.spyOn(child, "postMessage");
  const data = { channel: "jellyfin-watch-native", type: "ready", nonce: "unique-child-nonce" };
  fireEvent(window, new MessageEvent("message", { data, origin: window.location.origin, source: window }));
  fireEvent(window, new MessageEvent("message", { data, origin: "https://untrusted.test", source: child }));
  expect(send).not.toHaveBeenCalled();
  fireEvent(window, new MessageEvent("message", { data, origin: window.location.origin, source: child }));
  expect(send).toHaveBeenCalledWith({ ...data, type: "bootstrap", launch }, window.location.origin);
  fireEvent(window, new MessageEvent("message", { data: { ...data, type: "status", status: "connected", nonce: "another-child-nonce" }, origin: window.location.origin, source: child }));
  expect(onStatus).not.toHaveBeenCalled();
  fireEvent(window, new MessageEvent("message", { data: { ...data, type: "status", status: "connected" }, origin: window.location.origin, source: child }));
  expect(onStatus).toHaveBeenCalledWith("connected");
});
