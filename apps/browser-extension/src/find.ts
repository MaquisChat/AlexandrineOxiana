/**
 * Find and acquire, the browser's fallback (R348 i, with f and a): the researcher signed in to their library in THIS
 * browser and opened the work's PDF; the app made the work wait for it ("Get through my library in my own browser").
 * On the researcher's click on "Send this tab's PDF" in the popup — and only then (R110) — the background:
 *   1. checks the active tab's address — https, no user name or password, at most 2,048 characters once its query
 *      and fragment are removed (what will be sent, R357 e), each refusal in the extension's own words — BEFORE
 *      anything is injected;
 *   2. injects the small tab script (find-tab.js) into that tab (`scripting.executeScript` under `activeTab`, the
 *      default isolated world). The script reads `location.href` and `document.contentType` and nothing else, connects
 *      ONE port to the background and, if the tab shows a PDF, fetches `location.href` with the browser's session
 *      (`credentials: "include"`) and passes the bytes in pieces (find-protocol.ts);
 *   3. accepts that port only from its own extension, from the tab it injected into for this sending, from the tab's
 *      top frame, and only one; anything of another shape ends the reading;
 *   4. checks the first five bytes are `%PDF-` (else FIND_TEXT.notGivenAgain: the tab shows a PDF, so bytes that are
 *      not one are the site's answer to a second request, R357 f) and stops past FIND_PDF_MAX_BYTES (the service's
 *      sentence),
 *      keeping each piece as a Blob (the bytes leave the worker's memory piece by piece; never in storage, never logged);
 *   5. makes ONE `POST /find/browser/file/<ticket>` (api.ts) with the PDF, `Content-Type: application/pdf` and
 *      `x-ao-page: <the tab's address without its query and fragment>` (R357 e: the file itself is fetched from the
 *      full address), and says the service's sentence as it is.
 * The ticket and the token stay in the extension: the tab's script receives only `{ t: "more" }`.
 *
 * Every wait has an end (FIND_WAITS). A POST that brings no answer (the service may close the connection on a refusal
 * before the body's end, or the worker was stopped) claims no result: the list is read again and the sentence says
 * truly whether the work still waits (`sentenceAfterNoAnswer`); a read that failed or was not understood says so
 * (FIND_TEXT.unknown), never "no longer waiting" (R357 c).
 *
 * The sentence of a sending is kept in storage.session for the popup's next opening with its time and a SHA-256 of its
 * ticket (never the ticket, never the title), so that it is shown only where it is true (R357 a, b; `placeOfKept`).
 *
 * R301: a file sent to the app is never "added": it waits in the app's review queue for the researcher's own decision.
 */
import { ApiError } from "./api.js";
import { FIND_PDF_MAX_BYTES, FIND_PIECE_BYTES, FIND_PORT, b64ToBytes, parseTabMessage, type PortLike, type TabMessage } from "./find-protocol.js";

/** The header that carries the tab's address (the service's FIND_BROWSER_PAGE_HEADER, pinned by a test). */
export const FIND_PAGE_HEADER = "x-ao-page";
/** The service's longest tab address and longest label (FIND_BROWSER_PAGE_MAX, FIND_BROWSER_LABEL_MAX). */
const PAGE_MAX = 2048;
const LABEL_MAX = 200;
/** "Today none or one" (R348 f 1): a longer list than this is not the service's. */
const LIST_MAX = 20;
/** The longest sentence taken from the service's answer. */
const SENTENCE_MAX = 1000;
export const FIND_TICKET = /^[0-9a-f]{32}$/;

/**
 * Every wait of a sending, in milliseconds, and its end:
 *  list — the list's read (at the popup's opening, and again after a POST without an answer): then nothing waits (at
 *         the opening) or FIND_TEXT.unknown (after a POST);
 *  tab — the tab's address from the browser; inject — the injection; connect — the script's port and its first word:
 *         then FIND_TEXT.notAllowed (the browser did not let the script in);
 *  piece — each piece of the file; read — the whole reading: then FIND_TEXT.couldNotRead;
 *  post — the POST, from its start to its answer: then it is stopped and the list read again;
 *  keepAlive — how often the background calls the browser while a sending runs, so the idle worker is not stopped.
 */
export const FIND_WAITS = { list: 5_000, tab: 5_000, inject: 15_000, connect: 10_000, piece: 60_000, read: 10 * 60_000, post: 5 * 60_000, keepAlive: 20_000 };

/** The extension's own sentences (R348 i and the dispatch) — none says a file was "added" (R301). */
export const FIND_TEXT = {
  heading: "Find and acquire",
  button: "Send this tab's PDF",
  sending: "Sending the PDF…",
  notHttps: "This tab's address is not https, so its file cannot be sent.",
  userInfo: "This tab's address holds a user name or password, so its file cannot be sent.",
  tooLong: "This tab's address is too long for the app, so its file cannot be sent.",
  notGivenAgain: "The file the site gave when the extension read it again does not start as a PDF does, so nothing was sent. Download the PDF and add it to the record in the app instead.",
  notShowingPdf: "This tab is not showing a PDF. Open the PDF itself, then try again.",
  notAllowed: "The extension could not read this tab, so its PDF cannot be sent: this browser did not let it read the page, or the tab was closed or changed page meanwhile. Open the PDF in a tab again and press “Send this tab's PDF” again, or download the PDF and add it to the record in the app.",
  couldNotRead: "The PDF could not be read from this tab, so nothing was sent. Try again.",
  couldNotSend: "The PDF could not be sent. The work is still waiting — try again.",
  noAnswer: "The app's answer did not arrive, and the work is no longer waiting for a PDF from this browser. The app shows what became of it.",
  unknown: "The app's answer did not arrive, and whether the work is still waiting could not be read. Open this popup again to see.",
  busy: "A PDF is already being sent from this browser. Wait for it to finish.",
  notPaired: "The desktop app no longer knows this extension. Pair it again.",
} as const;

/**
 * The service's own sentence (packages/shared FIND_BROWSER_TEXT, pinned by a test) for the one case the extension finds
 * itself before it sends anything in the service's words — the limit. The address and a second answer that is not a
 * PDF have the extension's own words (R357 e, f).
 */
export const FIND_SERVICE_TEXT = {
  tooLarge: "That PDF is larger than 200 MB, so the app does not take it. The work is still waiting.",
} as const;

export interface Waiting {
  ticket: string;
  label: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysAre = (o: Record<string, unknown>, keys: string) => Object.keys(o).sort().join(",") === keys;
const codePoints = (s: string) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

/** The list's answer: exactly `{ waiting: [{ ticket, label }] }`, else undefined (not understood). */
function waitingOf(v: unknown): Waiting[] | undefined {
  if (!isPlainObject(v) || !keysAre(v, "waiting") || !Array.isArray(v.waiting) || v.waiting.length > LIST_MAX) return undefined;
  const out: Waiting[] = [];
  for (const item of v.waiting as unknown[]) {
    if (!isPlainObject(item) || !keysAre(item, "label,ticket")) return undefined;
    const { ticket, label } = item;
    if (typeof ticket !== "string" || !FIND_TICKET.test(ticket) || typeof label !== "string" || label.length === 0 || codePoints(label) > LABEL_MAX) return undefined;
    out.push({ ticket, label });
  }
  return out;
}

/** The list's answer: exactly `{ waiting: [{ ticket, label }] }`, else nothing waits. */
export function parseWaiting(v: unknown): Waiting[] {
  return waitingOf(v) ?? [];
}

export type FileAnswer = { outcome: "held" | "not-kept" | "gone"; sentence: string };

/** The file route's 200 answer, or undefined when it is not one. */
export function parseFileAnswer(v: unknown): FileAnswer | undefined {
  if (!isPlainObject(v) || !keysAre(v, "outcome,sentence")) return undefined;
  const { outcome, sentence } = v;
  if (outcome !== "held" && outcome !== "not-kept" && outcome !== "gone") return undefined;
  if (typeof sentence !== "string" || sentence.length === 0 || sentence.length > SENTENCE_MAX) return undefined;
  return { outcome, sentence };
}

/** The popup's request: `{ type: "find-send", tabId, ticket }`. */
export function parseFindSend(v: unknown): { tabId: number; ticket: string } | undefined {
  if (!isPlainObject(v) || v.type !== "find-send") return undefined;
  const { tabId, ticket } = v;
  if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId < 0) return undefined;
  if (typeof ticket !== "string" || !FIND_TICKET.test(ticket)) return undefined;
  return { tabId, ticket };
}

/** A read of the list: what waits; and, when it could not be read, why (the app's unreachable sentence, or another failure). */
export interface WaitingRead {
  waiting: Waiting[];
  unreachable?: string;
  failed?: true;
}

/**
 * The background's read of the list (`list`: api.findWaiting): what waits; the app not answering (its sentence); or a
 * failure — an error, or an answer that is not understood — told apart from a real `{ waiting: [] }` (R357 c).
 */
export async function readWaitingWith(list: () => Promise<unknown>): Promise<WaitingRead> {
  try {
    const waiting = waitingOf(await list());
    return waiting ? { waiting } : { waiting: [], failed: true };
  } catch (e) {
    if (e instanceof ApiError && e.code === "UNREACHABLE") return { waiting: [], unreachable: e.message };
    return { waiting: [], failed: true };
  }
}

/** The popup's copy of a read, as the background sent it; no answer, or one not understood, is a failed read (R357 c). */
export function parseWaitingRead(v: unknown): WaitingRead {
  if (!isPlainObject(v)) return { waiting: [], failed: true };
  const waiting = waitingOf({ waiting: v.waiting });
  const out: WaitingRead = { waiting: waiting ?? [] };
  if (typeof v.unreachable === "string" && v.unreachable.length <= SENTENCE_MAX) out.unreachable = v.unreachable;
  if (v.failed === true || waiting === undefined) out.failed = true;
  return out;
}

/** After a POST that brought no answer: whether the work still waits, by a fresh read of the list. */
export function sentenceAfterNoAnswer(ticket: string, read: WaitingRead): string {
  if (read.waiting.some((w) => w.ticket === ticket)) return FIND_TEXT.couldNotSend;
  if (read.unreachable) return read.unreachable;
  if (read.failed) return FIND_TEXT.unknown;
  return FIND_TEXT.noAnswer;
}

export interface FindReply {
  sentence: string;
}
export function parseFindReply(v: unknown): FindReply | undefined {
  return isPlainObject(v) && typeof v.sentence === "string" && v.sentence.length > 0 && v.sentence.length <= SENTENCE_MAX ? { sentence: v.sentence } : undefined;
}

/**
 * What storage.session keeps of the last sending, for the popup's next opening: its sentence, its time and `work`, a
 * SHA-256 (hex) of its ticket — never the ticket, never the title (R357 a) — nothing else.
 */
export interface FindResult {
  sentence: string;
  at: number;
  work: string;
}
export const FIND_RESULT_KEY = "findResult";
const HASH = /^[0-9a-f]{64}$/;
/** A kept result; one of the old shape (no hash) or of any other shape is not one. */
export function parseFindResult(v: unknown): FindResult | undefined {
  return isPlainObject(v) && keysAre(v, "at,sentence,work") && typeof v.sentence === "string" && v.sentence.length > 0 && v.sentence.length <= SENTENCE_MAX && typeof v.at === "number" && Number.isFinite(v.at) && typeof v.work === "string" && HASH.test(v.work)
    ? { sentence: v.sentence, at: v.at, work: v.work }
    : undefined;
}

/** SHA-256 of a ticket's text, as lower-case hex: what ties a kept result to its work without keeping the ticket. */
export async function ticketHash(ticket: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Where a kept result is shown at an opening (R357 a): in its work's section when that work still waits ("work");
 * alone in the section, without a button, when nothing waits ("alone"); and when a DIFFERENT work waits, nowhere — it is
 * dropped unseen ("drop"; the app's own row says what became of the earlier work).
 */
export async function placeOfKept(kept: FindResult, waiting: readonly Waiting[]): Promise<"work" | "alone" | "drop"> {
  if (waiting.length === 0) return "alone";
  for (const w of waiting) if ((await ticketHash(w.ticket)) === kept.work) return "work";
  return "drop";
}

/** The popup's request to remove the kept result it has shown or dropped: `{ type: "find-result-forget", work, at }`. */
export function parseResultForget(v: unknown): { work: string; at: number } | undefined {
  if (!isPlainObject(v) || v.type !== "find-result-forget") return undefined;
  const { work, at } = v;
  return typeof work === "string" && HASH.test(work) && typeof at === "number" && Number.isFinite(at) ? { work, at } : undefined;
}

/** The part of storage.session the kept result uses. */
export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * The kept result in storage.session (the background's side). `peek` looks without taking (R357 b: it is removed only
 * when the popup has shown it or deliberately dropped it — `forget` — so a popup closed during its opening, or a second
 * popup, cannot lose it); a value of the old shape, or any other, is removed at the first look and never shown;
 * `forget` removes only the same result (its hash and its time), never a newer one saved meanwhile.
 */
export function createResultStore(area: SessionArea) {
  async function peek(): Promise<FindResult | undefined> {
    const raw = (await area.get(FIND_RESULT_KEY))[FIND_RESULT_KEY];
    if (raw === undefined) return undefined;
    const v = parseFindResult(raw);
    if (!v) await area.remove(FIND_RESULT_KEY);
    return v;
  }
  return {
    save: (r: FindResult): Promise<void> => area.set({ [FIND_RESULT_KEY]: { sentence: r.sentence, at: r.at, work: r.work } }),
    peek,
    async forget(which: { work: string; at: number }): Promise<boolean> {
      const v = await peek();
      if (!v || v.work !== which.work || v.at !== which.at) return false;
      await area.remove(FIND_RESULT_KEY);
      return true;
    },
  };
}

/**
 * What is sent of the tab's address (R357 e): the address without its query and fragment (origin and path — the service
 * records only the cleaned address, and a publisher's signed address can be very long), or the sentence that refuses
 * it: not https; a user name or password in it; still longer than the service's 2,048 characters.
 */
export function pageToSend(address: string | undefined): { page: string } | { refused: string } {
  if (address === undefined || address === "") return { refused: FIND_TEXT.notAllowed };
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return { refused: FIND_TEXT.notHttps };
  }
  if (u.protocol !== "https:") return { refused: FIND_TEXT.notHttps };
  if (u.username !== "" || u.password !== "") return { refused: FIND_TEXT.userInfo };
  const page = `${u.origin}${u.pathname}`;
  if (page.length > PAGE_MAX) return { refused: FIND_TEXT.tooLong };
  return { page };
}

// ---- the sending ------------------------------------------------------------------------------------------------

export interface FinderDeps {
  /** This extension's id (runtime.id): a port from anything else is not read. */
  extensionId: string;
  /** The tab's address as the browser gives it (under activeTab), or undefined when it does not. */
  tabUrl(tabId: number): Promise<string | undefined>;
  /** Injects find-tab.js into the tab's top frame (scripting.executeScript, files). */
  inject(tabId: number): Promise<void>;
  /** The one POST (api.ts's sendFindPdf); rejects with ApiError. */
  post(ticket: string, page: string, body: Blob, signal: AbortSignal): Promise<unknown>;
  /** A fresh read of the list. */
  waiting(): Promise<WaitingRead>;
  /** Keeps the result for the popup's next opening (storage.session): its sentence, its time, its ticket's hash. */
  saveResult(result: FindResult): Promise<void>;
  /** Called every `waits.keepAlive` while a sending runs: a cheap call to the browser, so the worker is not stopped as idle. */
  keepAlive(): void;
  waits?: Partial<typeof FIND_WAITS>;
}

class Stop extends Error {
  constructor(readonly sentence: string) {
    super(sentence);
  }
}

function within<T>(p: Promise<T>, ms: number, sentence: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Stop(sentence)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Stop ? e : new Stop(sentence));
      },
    );
  });
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

interface Current {
  tabId: number;
  ticket: string;
  /** Set while the injected script's port is expected: the one connection this sending accepts. */
  expect?: (got: Connected) => void;
  port?: PortLike;
}

interface TabReader {
  next(ms: number, sentence: string): Promise<TabMessage>;
  close(): void;
}
type Connected = { port: PortLike; r: TabReader };

export function createFinder(deps: FinderDeps) {
  const waits = { ...FIND_WAITS, ...deps.waits };
  let current: Current | undefined;

  /** The script's port: accepted only for the sending under way, from this extension, the injected tab, its top frame, once. */
  function connect(port: PortLike): void {
    const s = port.sender;
    const ok = current?.expect !== undefined && port.name === FIND_PORT && s?.id === deps.extensionId && s.tab?.id === current.tabId && s.frameId === 0;
    if (!ok) {
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
      return;
    }
    const take = current!.expect!;
    current!.expect = undefined;
    current!.port = port;
    // Listening at once: the script speaks as soon as it has connected, before the injection's answer reaches the
    // background, and a port does not keep messages for a listener added later.
    take({ port, r: readerOf(port) });
  }

  /** The port's messages as a queue; `next` waits at most `ms` for one; a disconnect or a wrong shape ends it. */
  function readerOf(port: PortLike): TabReader {
    const queue: TabMessage[] = [];
    let ended = false;
    let wake: (() => void) | undefined;
    const onMessage = (m: unknown) => {
      const msg = parseTabMessage(m);
      if (!msg) ended = true;
      else queue.push(msg);
      wake?.();
    };
    const onGone = () => {
      ended = true;
      wake?.();
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onGone);
    return {
      async next(ms: number, sentence: string): Promise<TabMessage> {
        const deadline = Date.now() + ms;
        for (;;) {
          const m = queue.shift();
          if (m) return m;
          if (ended) throw new Stop(FIND_TEXT.couldNotRead);
          const left = deadline - Date.now();
          if (left <= 0) throw new Stop(sentence);
          await new Promise<void>((res) => {
            const t = setTimeout(res, left);
            wake = () => {
              clearTimeout(t);
              res();
            };
          });
          wake = undefined;
        }
      },
      close() {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onGone);
      },
    };
  }

  const tell = (port: PortLike, m: unknown) => {
    try {
      port.postMessage(m);
    } catch {
      /* the tab went: the next wait ends */
    }
  };

  async function run(c: Current): Promise<string> {
    // 1. The tab's address, before anything is injected.
    let address: string | undefined;
    try {
      address = await within(deps.tabUrl(c.tabId), waits.tab, FIND_TEXT.notAllowed);
    } catch {
      return FIND_TEXT.notAllowed;
    }
    const before = pageToSend(address);
    if ("refused" in before) return before.refused;

    // 2. The script, and its port (expected before the injection: the script may connect before it resolves).
    const connected = new Promise<Connected>((resolve) => (c.expect = resolve));
    await within(deps.inject(c.tabId), waits.inject, FIND_TEXT.notAllowed);
    const { port, r } = await within(connected, waits.connect, FIND_TEXT.notAllowed);
    try {
      // 3. Its first word: the tab's own address and whether it shows a PDF.
      const head = await r.next(waits.connect, FIND_TEXT.notAllowed);
      if (head.t !== "head") return FIND_TEXT.couldNotRead;
      if (!head.pdf) return FIND_TEXT.notShowingPdf;
      // Checked again on the script's own address (the tab may have moved), on what will be sent.
      const now = pageToSend(head.href);
      if ("refused" in now) return now.refused === FIND_TEXT.notAllowed ? FIND_TEXT.couldNotRead : now.refused;
      const page = now.page;

      // 4. The pieces: the first five bytes, the limit, each piece kept as a Blob.
      const parts: Blob[] = [];
      const head5: number[] = [];
      let total = 0;
      const until = Date.now() + waits.read;
      for (;;) {
        tell(port, { t: "more" });
        const left = until - Date.now();
        if (left <= 0) return FIND_TEXT.couldNotRead;
        const m = await r.next(Math.min(waits.piece, left), FIND_TEXT.couldNotRead);
        if (m.t === "head") return FIND_TEXT.couldNotRead;
        if (m.t === "fail") return m.why === "too-large" ? FIND_SERVICE_TEXT.tooLarge : FIND_TEXT.couldNotRead;
        if (m.t === "end") break;
        let bytes: Uint8Array;
        try {
          bytes = b64ToBytes(m.b64);
        } catch {
          return FIND_TEXT.couldNotRead;
        }
        if (bytes.length === 0 || bytes.length > FIND_PIECE_BYTES) return FIND_TEXT.couldNotRead;
        total += bytes.length;
        if (total > FIND_PDF_MAX_BYTES) return FIND_SERVICE_TEXT.tooLarge;
        for (let i = 0; head5.length < PDF_MAGIC.length && i < bytes.length; i++) head5.push(bytes[i]!);
        // The tab shows a PDF (its head said so): bytes that are not one are the site's answer to a second request (R357 f).
        if (head5.length === PDF_MAGIC.length && head5.some((b, i) => b !== PDF_MAGIC[i])) return FIND_TEXT.notGivenAgain;
        parts.push(new Blob([bytes as Uint8Array<ArrayBuffer>]));
      }
      if (head5.length < PDF_MAGIC.length) return FIND_TEXT.notGivenAgain;
      r.close();
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }

      // 5. ONE POST.
      const body = new Blob(parts, { type: "application/pdf" });
      parts.length = 0;
      return await postOnce(c.ticket, page, body);
    } finally {
      r.close();
    }
  }

  async function postOnce(ticket: string, page: string, body: Blob): Promise<string> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), waits.post);
    try {
      const answer = parseFileAnswer(await deps.post(ticket, page, body, ac.signal));
      if (answer) return answer.sentence;
    } catch (e) {
      // An answer from the service: its sentence as it is (401: the pairing is no longer known).
      if (e instanceof ApiError && e.status !== undefined) {
        if (e.status === 401) return FIND_TEXT.notPaired;
        return e.message;
      }
    } finally {
      clearTimeout(t);
    }
    // No answer (or one not understood): claim nothing; read the list again.
    let read: WaitingRead;
    try {
      read = await within(deps.waiting(), waits.list, FIND_TEXT.unknown);
    } catch {
      read = { waiting: [], failed: true };
    }
    return sentenceAfterNoAnswer(ticket, read);
  }

  async function send(tabId: number, ticket: string): Promise<FindReply> {
    if (current) return { sentence: FIND_TEXT.busy };
    const c: Current = { tabId, ticket };
    current = c;
    const keep = setInterval(() => deps.keepAlive(), waits.keepAlive);
    let sentence: string;
    try {
      sentence = await run(c);
    } catch (e) {
      sentence = e instanceof Stop ? e.sentence : FIND_TEXT.couldNotRead;
    } finally {
      clearInterval(keep);
      c.expect = undefined;
      try {
        c.port?.disconnect();
      } catch {
        /* already gone */
      }
      current = undefined;
    }
    await ticketHash(ticket)
      .then((work) => deps.saveResult({ sentence, at: Date.now(), work }))
      .catch(() => undefined);
    return { sentence };
  }

  return {
    send,
    connect,
    /** The ticket being sent for, while a sending runs. */
    sending: (): string | undefined => current?.ticket,
  };
}

export type Finder = ReturnType<typeof createFinder>;
