/**
 * Streamed responses with backpressure (R99): an SSE client that does not keep up is dropped once
 * its unsent buffer passes a cap (it reconnects and gets a fresh `library.state`); NDJSON progress
 * waits for the socket to drain before writing the next line.
 */
import type { ServerResponse } from "node:http";

/** Unsent bytes an event-stream client may fall behind by before it is dropped. */
export const SSE_BUFFER_CAP = 1024 * 1024;

type Res = Pick<ServerResponse, "write" | "destroy" | "writableLength" | "once" | "off" | "destroyed" | "writableEnded">;

/** Returns a sender; false once the client was dropped (or is gone). */
export function sseWriter(res: Res, cap = SSE_BUFFER_CAP): (frame: string) => boolean {
  let dropped = false;
  return (frame) => {
    if (dropped) return false;
    const ok = res.write(frame);
    if (!ok && res.writableLength > cap) {
      dropped = true;
      res.destroy();
      return false;
    }
    return true;
  };
}

/**
 * Returns a writer of one JSON line that resolves when the line may be followed by the next. Once
 * the client is gone (destroyed or ended) lines are dropped at once: the work never waits on a
 * departed client (R102 N1).
 */
export function ndjsonWriter(res: Res): (value: unknown) => Promise<void> {
  return (value) =>
    new Promise<void>((resolve) => {
      if (res.destroyed || res.writableEnded) return resolve();
      if (res.write(`${JSON.stringify(value)}\n`)) return resolve();
      if (res.destroyed || res.writableEnded) return resolve();
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        resolve();
      };
      res.once("drain", done);
      res.once("close", done);
    });
}
