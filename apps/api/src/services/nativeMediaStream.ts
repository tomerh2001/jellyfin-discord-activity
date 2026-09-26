import { Readable } from "node:stream";
import { NativeError } from "./nativeParty.js";

export const HLS_BODY_IDLE_TIMEOUT_MS = 15_000;

/** Only finite HLS media/init fragments get a body watchdog, not full movies. */
export function nativeSegmentIdleTimeout(path: string): number | undefined {
  return /^\/(?:Videos|Audio)\/[a-zA-Z0-9_-]+\/hls1?\/(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_-]+\.(?:ts|mp4|m4s|m4a|aac|mp3)$/i.test(path)
    ? HLS_BODY_IDLE_TIMEOUT_MS : undefined;
}

/**
 * Time only a pending upstream read. No timer runs while a yielded chunk waits
 * for downstream demand, and every chunk starts a fresh inactivity allowance.
 */
export async function* nativeMediaChunks(source: Readable, idleTimeoutMs?: number): AsyncGenerator<Buffer> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let next: IteratorResult<Buffer>;
      try {
        const reading = iterator.next() as Promise<IteratorResult<Buffer>>;
        next = idleTimeoutMs === undefined ? await reading : await new Promise<IteratorResult<Buffer>>((resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new NativeError("native_segment_stalled", 502);
            reject(error);
            source.destroy(error);
          }, idleTimeoutMs);
          timeout.unref();
          void reading.then(resolve, reject);
        });
      } finally {
        clearTimeout(timeout);
      }
      if (next.done) return;
      yield next.value;
    }
  } finally {
    source.destroy();
    await iterator.return?.();
  }
}
