import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionsPanel } from "./ConnectionsPanel.js";
import * as api from "../api/native.js";

const connection: api.Connection = { id: "one", serverUrl: "https://jf.test", serverId: "server", serverName: "Jellyfin", jellyfinUserId: "user", jellyfinUsername: "Viewer", kind: "personal", createdAt: "now", updatedAt: "now" };
const data: api.Connections = { connections: [], defaultServerUrl: connection.serverUrl, communityAvailable: true, preferredConnectionId: null };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("preserves password whitespace and clears it after a successful account connection", async () => {
  const connect = vi.spyOn(api, "connectAccount").mockResolvedValue(connection);
  const onSelect = vi.fn().mockResolvedValue(undefined);
  render(<ConnectionsPanel token="token" data={data} party={null} onSelect={onSelect} onRefresh={async () => undefined} />);
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: " Viewer " } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "  password  " } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(connection));
  expect(connect).toHaveBeenCalledWith("token", { serverUrl: connection.serverUrl, username: "Viewer", password: "  password  " });
  expect(screen.getByLabelText("Password")).toHaveValue("");
});

it("polls Quick Connect and selects the authorized account without handling a server secret", async () => {
  vi.useFakeTimers();
  vi.spyOn(api, "startQuickConnect").mockResolvedValue({ id: "pending-id", code: "123456", expiresAt: new Date(Date.now() + 60000).toISOString() });
  const poll = vi.spyOn(api, "pollQuickConnect").mockResolvedValueOnce({ status: "pending" }).mockResolvedValueOnce({ status: "connected", connection });
  const onSelect = vi.fn().mockResolvedValue(undefined);
  render(<ConnectionsPanel token="token" data={data} party={null} onSelect={onSelect} onRefresh={async () => undefined} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use Quick Connect" })); });
  expect(screen.getByText("123456")).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(poll).toHaveBeenCalledTimes(1); expect(onSelect).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(onSelect).toHaveBeenCalledWith(connection); expect(screen.queryByText("123456")).not.toBeInTheDocument();
});
