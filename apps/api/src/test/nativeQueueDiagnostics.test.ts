import { describe, expect, it } from "vitest";
import { isNativeQueuePath, nativeQueueShape } from "../services/nativeQueueDiagnostics.js";

describe("native queue diagnostics", () => {
  it("classifies malformed queues without including body values or untrusted header text", () => {
    expect(nativeQueueShape({ headers: { "content-type": "application/json; charset=UTF-8" }, body: { PlayingQueue: ["private-item-id", null], token: "private-token" } }))
      .toEqual({ mediaType: "application/json", bodyType: "object", queueShape: "non_string_items", itemCount: 2 });
    expect(nativeQueueShape({ headers: { "content-type": "secret-header-value" }, body: "private-body-value" }))
      .toEqual({ mediaType: "other", bodyType: "string", queueShape: "missing" });
    expect(nativeQueueShape({ headers: {}, body: { ItemIds: [] } }))
      .toEqual({ mediaType: "missing", bodyType: "object", queueShape: "string_array", itemCount: 0 });
  });
  it("limits diagnosis to queue commands without recording their capability or query", () => {
    expect(isNativeQueuePath("/jf/private-capability/SyncPlay/SetNewQueue?api_key=secret")).toBe(true);
    expect(isNativeQueuePath("/SyncPlay/Queue")).toBe(true);
    expect(isNativeQueuePath("/SyncPlay/QueueExtra")).toBe(false);
    expect(isNativeQueuePath("/SyncPlay/Join")).toBe(false);
  });
});
