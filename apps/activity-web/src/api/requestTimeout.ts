/** Keep deadlines compatible with WebViews without AbortSignal.timeout/any. */
export async function withRequestTimeout<T>(
  caller: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const cancelled = () => caller?.reason ?? new DOMException("The request was cancelled.", "AbortError");
  if (caller?.aborted) throw cancelled();
  const controller = new AbortController();
  const abort = () => controller.abort(cancelled());
  caller?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => controller.abort(new DOMException("The request timed out.", "TimeoutError")), timeoutMs);
  try {
    // The operation includes response parsing, so a stalled response body is
    // covered by the same deadline as connecting and receiving its headers.
    return await operation(controller.signal);
  } finally {
    clearTimeout(deadline);
    caller?.removeEventListener("abort", abort);
  }
}
