import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HLS_BODY_IDLE_TIMEOUT_MS, nativeMediaChunks, nativeSegmentIdleTimeout } from "../services/nativeMediaStream.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

function body() {
  return new Readable({ read() { /* The test supplies upstream bytes. */ } });
}

describe("native HLS body recovery", () => {
  it.each([
    "/Videos/item/hls1/main/0.mp4",
    "/videos/item/hls1/main/-1.mp4",
    "/Videos/item/hls/main/0.ts",
    "/Audio/item/hls1/main/0.aac"
  ])("bounds only media/init segment bodies: %s", path => {
    expect(nativeSegmentIdleTimeout(path)).toBe(HLS_BODY_IDLE_TIMEOUT_MS);
  });

  it.each([
    "/Videos/item/stream.mp4",
    "/Audio/item/stream.mp3",
    "/Videos/item/main.m3u8",
    "/Videos/item/hls1/main/key.bin",
    "/Videos/item/hls1/main/0.vtt"
  ])("leaves progressive streams and non-media responses unchanged: %s", path => {
    expect(nativeSegmentIdleTimeout(path)).toBeUndefined();
  });

  it.each([false, true])("fails an upstream body that stops before/after its first chunk (%s)", async partial => {
    const source = body();
    const chunks = nativeMediaChunks(source, HLS_BODY_IDLE_TIMEOUT_MS);
    if (partial) {
      source.push(Buffer.from("partial segment"));
      expect((await chunks.next()).value?.toString()).toBe("partial segment");
    }
    const failure = expect(chunks.next()).rejects.toMatchObject({ code: "native_segment_stalled", statusCode: 502 });
    await vi.advanceTimersByTimeAsync(HLS_BODY_IDLE_TIMEOUT_MS - 1);
    expect(source.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(source.destroyed).toBe(true);
  });

  it("lets a progressing segment outlive the inactivity allowance and clears its timer at EOF", async () => {
    const source = body();
    const chunks = nativeMediaChunks(source, HLS_BODY_IDLE_TIMEOUT_MS);
    for (let i = 0; i < 4; i++) {
      const reading = chunks.next();
      await vi.advanceTimersByTimeAsync(8_000);
      source.push(Buffer.from(String(i)));
      expect((await reading).value?.toString()).toBe(String(i));
    }
    const finished = chunks.next();
    source.push(null);
    expect((await finished).done).toBe(true);
    expect(source.destroyed).toBe(true);
  });

  it("does not count downstream backpressure as an upstream stall", async () => {
    const source = body();
    const chunks = nativeMediaChunks(source, HLS_BODY_IDLE_TIMEOUT_MS);
    source.push(Buffer.from("first"));
    await chunks.next();
    // The consumer has not asked for more bytes.
    await vi.advanceTimersByTimeAsync(HLS_BODY_IDLE_TIMEOUT_MS * 3);
    expect(source.destroyed).toBe(false);
    source.push(Buffer.from("second"));
    expect((await chunks.next()).value?.toString()).toBe("second");
    await chunks.return(undefined);
    expect(source.destroyed).toBe(true);
  });
});

describe("native stream cleanup", () => {
  it("cancels the underlying web body on viewer/client abort and clears the pending timer", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    const web = new ReadableStream<Uint8Array>({ cancel });
    const source = Readable.fromWeb(web, { signal: controller.signal });
    const chunks = nativeMediaChunks(source, HLS_BODY_IDLE_TIMEOUT_MS);
    const failure = expect(chunks.next()).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await failure;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(source.destroyed).toBe(true);
  });

  it("cancels the web body when a fragment stalls", async () => {
    const cancel = vi.fn();
    const web = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from("first")); },
      cancel
    });
    const source = Readable.fromWeb(web);
    const chunks = nativeMediaChunks(source, HLS_BODY_IDLE_TIMEOUT_MS);
    expect((await chunks.next()).value?.toString()).toBe("first");
    const failure = expect(chunks.next()).rejects.toMatchObject({ code: "native_segment_stalled" });
    await vi.advanceTimersByTimeAsync(HLS_BODY_IDLE_TIMEOUT_MS);
    await failure;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not apply a movie lifetime or body timeout to a progressive stream", async () => {
    const source = body();
    const chunks = nativeMediaChunks(source, nativeSegmentIdleTimeout("/Videos/item/stream.mkv"));
    const reading = chunks.next();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(source.destroyed).toBe(false);
    source.push(Buffer.from("late movie bytes"));
    expect((await reading).value?.toString()).toBe("late movie bytes");
    await chunks.return(undefined);
  });

  it("clears the timer and source after upstream failure", async () => {
    const source = body();
    const chunks = nativeMediaChunks(source, HLS_BODY_IDLE_TIMEOUT_MS);
    const failure = expect(chunks.next()).rejects.toThrow("upstream failed");
    source.destroy(new Error("upstream failed"));
    await failure;
    expect(source.destroyed).toBe(true);
  });
});
