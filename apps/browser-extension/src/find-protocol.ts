/**
 * Find and acquire, the browser's fallback (R348 i): what the small script injected into the tab (find-tab.ts) and the
 * background (find.ts) say to each other, kept in one small module so that the tab's script holds nothing else.
 *
 * The script connects ONE port named FIND_PORT to the background and says, in this order:
 *   { t: "head", href, pdf }       its tab's address (location.href) and whether the tab shows a PDF
 *                                  (document.contentType === "application/pdf");
 *   { t: "piece", b64 }            one piece of the file, at most FIND_PIECE_BYTES, base64 (Chrome's extension messages
 *                                  are JSON, so bytes travel as text) — only after the background said { t: "more" };
 *   { t: "end" }                   the whole file has been read;
 *   { t: "fail", why }             "read" (the tab's file could not be read) or "too-large" (over FIND_PDF_MAX_BYTES).
 * The background answers { t: "more" } (read the next piece) or disconnects. Nothing else crosses: no ticket, no token,
 * no address but the tab's own.
 */

/** The port's name. */
export const FIND_PORT = "ao-find-pdf";

/**
 * The largest PDF the app takes from the browser: the service's hand-over limit, `LIBRARY_FILE_MAX_BYTES` of
 * packages/shared (200 MB). The extension does not depend on @ao/shared, so the number is written here and pinned to
 * the shared one by a test (find.test.ts).
 */
export const FIND_PDF_MAX_BYTES = 200 * 1024 * 1024;

/**
 * One piece of the file, from the tab to the background: 1 MiB. Small enough that a message (about 1.4 MB as base64)
 * stays far below Chrome's limit for one extension message (64 MiB) and that each side holds only a piece or two at a
 * time; large enough that a 200 MB file is 200 messages, each answered before the next is read.
 */
export const FIND_PIECE_BYTES = 1024 * 1024;

export type TabMessage = { t: "head"; href: string; pdf: boolean } | { t: "piece"; b64: string } | { t: "end" } | { t: "fail"; why: "read" | "too-large" };

/** The longest base64 text of one piece. */
const PIECE_B64_MAX = Math.ceil(FIND_PIECE_BYTES / 3) * 4;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A message from the tab's script, or undefined for anything of another shape (extra keys included). */
export function parseTabMessage(v: unknown): TabMessage | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const m = v as Record<string, unknown>;
  const keys = Object.keys(m).sort().join(",");
  switch (m.t) {
    case "head":
      return keys === "href,pdf,t" && typeof m.href === "string" && m.href.length <= 8192 && typeof m.pdf === "boolean" ? { t: "head", href: m.href, pdf: m.pdf } : undefined;
    case "piece":
      return keys === "b64,t" && typeof m.b64 === "string" && m.b64.length > 0 && m.b64.length <= PIECE_B64_MAX && m.b64.length % 4 === 0 && B64.test(m.b64) ? { t: "piece", b64: m.b64 } : undefined;
    case "end":
      return keys === "t" ? { t: "end" } : undefined;
    case "fail":
      return keys === "t,why" && (m.why === "read" || m.why === "too-large") ? { t: "fail", why: m.why } : undefined;
    default:
      return undefined;
  }
}

export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** The part of a runtime.Port both sides use (Chrome's, Firefox's, or a test's). */
export interface PortLike {
  name: string;
  sender?: { id?: string; tab?: { id?: number }; frameId?: number };
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (message: unknown) => void): void; removeListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void; removeListener(fn: () => void): void };
}
