import { describe, expect, it } from "vitest";
import { normalizeNativeRoute } from "./nativeNavigation.js";

const LIBRARY = "11111111111111111111111111111111";
const SERVER = "selected-server";

describe("native browsing checkpoints", () => {
  it.each(["homevideos", "musicvideos", "boxsets", "playlists", "mixed", "books"])("restores the Modern %s library and selected tab", (route) => {
    const hash = `#/${route}?topParentId=${LIBRARY}&collectionType=${route}&tab=1&serverId=${SERVER}`;
    expect(normalizeNativeRoute(hash, SERVER)).toBe(hash);
    expect(normalizeNativeRoute(`#/${route}?topParentId=${LIBRARY}`, SERVER)).toBe(`#/${route}?topParentId=${LIBRARY}`);
  });

  it.each([
    `#/mixed?topParentId=${LIBRARY}&ApiKey=secret`,
    `#/books?topParentId=${LIBRARY}&serverId=another-server`,
    `#/musicvideos?topParentId=${LIBRARY}&tab=1&tab=2`,
    "#/homevideos?topParentId=https%3A%2F%2Fevil.example",
    "#/playlists?collectionType=unknown",
    "#/boxsets?tab=-1",
    "#/video",
    "#/login",
    "#/dashboard",
    "#/SyncPlay/Stop",
    "https://evil.example/#/mixed"
  ])("rejects unsafe or non-browsing checkpoint %s", (hash) => {
    expect(normalizeNativeRoute(hash, SERVER)).toBeNull();
  });
});
