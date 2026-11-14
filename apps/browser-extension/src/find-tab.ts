/**
 * The small script injected into the active tab when the researcher presses "Send this tab's PDF" (R348 i), built as
 * find-tab.js (find-tab-entry.ts). It runs in the extension's isolated world — the page's own scripts cannot see it —
 * and it reads exactly two things of the page: `location.href` and `document.contentType`. It never takes an address
 * from the popup, the service or the page: the only address it fetches is its own tab's, with the browser's session
 * (`credentials: "include"`, in the tab's own origin).
 *
 * It connects ONE port to the background (find-protocol.ts), says its address and whether the tab shows a PDF, and,
 * if it does, reads the file piece by piece, sending each piece only when the background asks for the next. It holds at
 * most one piece (FIND_PIECE_BYTES) and the network's current chunk. It knows nothing of the work, the ticket or the
 * token. When it ends — the file sent, a refusal, the background gone, or no word from the background for `askMs` — it
 * stops the reading, removes its listeners and closes the port: nothing of it is left in the page.
 */
import { FIND_PDF_MAX_BYTES, FIND_PIECE_BYTES, FIND_PORT, bytesToB64, type PortLike } from "./find-protocol.js";

export interface TabEnv {
  href: string;
  contentType: string;
  fetch: typeof fetch;
  connect(name: string): PortLike;
}

/** How long the script waits for the background's next "more" before it gives up (the background's own waits are shorter). */
export const TAB_ASK_MS = 120_000;

export async function readTabPdf(env: TabEnv, o: { askMs?: number } = {}): Promise<void> {
  const askMs = o.askMs ?? TAB_ASK_MS;
  const port = env.connect(FIND_PORT);
  const ac = new AbortController();
  let gone = false;
  let asked = 0;
  let wake: (() => void) | undefined;
  const onMessage = (m: unknown) => {
    if (typeof m === "object" && m !== null && (m as { t?: unknown }).t === "more") asked++;
    else gone = true;
    wake?.();
  };
  const onGone = () => {
    gone = true;
    ac.abort();
    wake?.();
  };
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onGone);
  const say = (m: unknown) => {
    if (!gone) port.postMessage(m);
  };
  /** Waits for the background's next "more"; false when it went away or did not ask in time. */
  const more = async (): Promise<boolean> => {
    const deadline = Date.now() + askMs;
    while (asked === 0 && !gone) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((res) => {
        const t = setTimeout(res, left);
        wake = () => {
          clearTimeout(t);
          res();
        };
      });
      wake = undefined;
    }
    if (gone) return false;
    asked--;
    return true;
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const href = env.href;
    const pdf = env.contentType === "application/pdf";
    say({ t: "head", href, pdf });
    if (!pdf || !(await more())) return;
    let res: Response;
    try {
      res = await env.fetch(href, { credentials: "include", signal: ac.signal });
    } catch {
      say({ t: "fail", why: "read" });
      return;
    }
    if (!res.ok || !res.body) {
      say({ t: "fail", why: "read" });
      return;
    }
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > FIND_PDF_MAX_BYTES) {
      say({ t: "fail", why: "too-large" });
      return;
    }
    reader = res.body.getReader();
    const piece = new Uint8Array(FIND_PIECE_BYTES);
    let fill = 0;
    let total = 0;
    const flush = async (): Promise<boolean> => {
      say({ t: "piece", b64: bytesToB64(piece.subarray(0, fill)) });
      fill = 0;
      return more();
    };
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        if (!gone) say({ t: "fail", why: "read" });
        return;
      }
      if (chunk.done) break;
      const value = chunk.value;
      total += value.length;
      if (total > FIND_PDF_MAX_BYTES) {
        say({ t: "fail", why: "too-large" });
        return;
      }
      let at = 0;
      while (at < value.length) {
        const n = Math.min(FIND_PIECE_BYTES - fill, value.length - at);
        piece.set(value.subarray(at, at + n), fill);
        fill += n;
        at += n;
        if (fill === FIND_PIECE_BYTES && !(await flush())) return;
      }
    }
    if (fill > 0 && !(await flush())) return;
    say({ t: "end" });
  } catch {
    say({ t: "fail", why: "read" });
  } finally {
    ac.abort();
    void reader?.cancel().catch(() => undefined);
    // The last word reaches the background before the port closes: the background closes it once it has read it
    // (or, if it does not, the script does after askMs).
    const deadline = Date.now() + askMs;
    while (!gone && Date.now() < deadline) {
      await new Promise<void>((res) => {
        const t = setTimeout(res, deadline - Date.now());
        wake = () => {
          clearTimeout(t);
          res();
        };
      });
      wake = undefined;
    }
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onGone);
    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
  }
}
