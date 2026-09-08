import { afterEach, describe, expect, it, vi } from "vitest";
import { withRequestTimeout } from "./requestTimeout.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function stalledResponse(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

describe("mobile-compatible request deadlines", () => {
  it("cancels a stalled operation without AbortSignal.timeout or AbortSignal.any", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => { throw new Error("Not available in this WebView"); });
    const any = vi.spyOn(AbortSignal, "any").mockImplementation(() => { throw new Error("Not available in this WebView"); });
    const request = withRequestTimeout(undefined, 50, stalledResponse);
    const result = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(timeout).not.toHaveBeenCalled();
    expect(any).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards caller cancellation and removes its listener and deadline", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const reason = new DOMException("The view closed", "AbortError");
    const request = withRequestTimeout(caller.signal, 50, stalledResponse);
    const result = expect(request).rejects.toBe(reason);
    caller.abort(reason);
    await result;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    const operation = vi.fn();
    await expect(withRequestTimeout(caller.signal, 50, operation)).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
  });

  it("keeps a response body under deadline and cleans up after successful parsing", async () => {
    vi.useFakeTimers();
    let completedSignal: AbortSignal | undefined;
    const completed = await withRequestTimeout(undefined, 50, async signal => {
      completedSignal = signal;
      return { connected: true };
    });
    expect(completed).toEqual({ connected: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(completedSignal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const parsing = withRequestTimeout(undefined, 50, async signal => {
      await Promise.resolve(); // Response headers arrived; body is still pending.
      return stalledResponse(signal);
    });
    const result = expect(parsing).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(50);
    await result;
  });
});
