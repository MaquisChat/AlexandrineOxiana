// @vitest-environment node
/**
 * Find and acquire, the browser's fallback (R348 i, with f and a): the list's parsing, the sending's steps with a fake
 * tab and a fake service (every refusal and outcome, the pieces, the limit), the checks on the script's port, and the
 * extension's numbers and sentences pinned to the service's (packages/shared).
 *
 * The tab's side is the REAL tab script (find-tab.ts's readTabPdf) run against a fake document, a fake fetch and an
 * in-memory port pair that copies every message through JSON, as Chrome's extension messaging does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FIND_BROWSER_LABEL_MAX, FIND_BROWSER_PAGE_HEADER, FIND_BROWSER_PAGE_MAX, FIND_BROWSER_TEXT, LIBRARY_FILE_MAX_BYTES } from "../../../packages/shared/src/index.js";
import { ApiError, unreachable } from "./api.js";
import {
  FIND_PAGE_HEADER,
  FIND_SERVICE_TEXT,
  FIND_TEXT,
  FIND_RESULT_KEY,
  createFinder,
  createResultStore,
  parseFileAnswer,
  parseFindResult,
  parseFindSend,
  parseResultForget,
  parseWaiting,
  parseWaitingRead,
  placeOfKept,
  readWaitingWith,
  sentenceAfterNoAnswer,
  ticketHash,
  type FindResult,
  type FinderDeps,
  type WaitingRead,
} from "./find.js";
import { FIND_PDF_MAX_BYTES, FIND_PIECE_BYTES, FIND_PORT, parseTabMessage, type PortLike } from "./find-protocol.js";
import { extensionRuntime, readTabPdf } from "./find-tab.js";

const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const TICKET = "0123456789abcdef0123456789abcdef";
const PAGE = "https://pdfs.publisher.example/content/article.pdf?token=tabsecret#page=3";
/** What is sent of PAGE (R357 e): its address without the query and the fragment. */
const PAGE_SENT = "https://pdfs.publisher.example/content/article.pdf";
const HELD = { outcome: "held", sentence: FIND_BROWSER_TEXT.held };

// ---- an in-memory port pair, messages copied through JSON (as Chrome's are) -------------------------------------

type Listener<T extends unknown[]> = Set<(...a: T) => void>;
interface FakePort extends PortLike {
  messages: Listener<[unknown]>;
  gone: Listener<[]>;
  sent: unknown[];
  closed: boolean;
}
function fakePort(name: string, sender?: PortLike["sender"]): FakePort {
  const messages: Listener<[unknown]> = new Set();
  const gone: Listener<[]> = new Set();
  const p: FakePort = {
    name,
    ...(sender ? { sender } : {}),
    messages,
    gone,
    sent: [],
    closed: false,
    postMessage: () => undefined,
    disconnect: () => undefined,
    onMessage: { addListener: (f) => void messages.add(f), removeListener: (f) => void messages.delete(f) },
    onDisconnect: { addListener: (f) => void gone.add(f), removeListener: (f) => void gone.delete(f) },
  };
  return p;
}
/** Two linked ends: what one posts the other receives; a disconnect fires onDisconnect on the OTHER end only. */
function portPair(name: string, sender: PortLike["sender"]): { tab: FakePort; bg: FakePort } {
  const tab = fakePort(name);
  const bg = fakePort(name, sender);
  const link = (from: FakePort, to: FakePort) => {
    from.postMessage = (m) => {
      if (from.closed) throw new Error("Attempting to use a disconnected port object");
      const copy = JSON.parse(JSON.stringify(m)) as unknown;
      from.sent.push(copy);
      setTimeout(() => {
        if (!to.closed) for (const f of [...to.messages]) f(copy);
      }, 0);
    };
    from.disconnect = () => {
      if (from.closed) return;
      from.closed = true;
      to.closed = true;
      setTimeout(() => {
        for (const f of [...to.gone]) f();
      }, 0);
    };
  };
  link(tab, bg);
  link(bg, tab);
  return { tab, bg };
}

// ---- a fake tab and a fake service ----------------------------------------------------------------------------

interface FakeTab {
  url: string | undefined;
  contentType: string;
  /** The file the tab's fetch answers with, or a Response factory (given the fetch's init, its signal among it). */
  file?: Uint8Array | ((init?: RequestInit) => Response);
  /** The browser refuses the injection (its own pages, Firefox's PDF viewer). */
  noScript?: boolean;
  /** The script is injected but never connects. */
  silent?: boolean;
  /** Content-Length to announce (default: the file's length). */
  length?: number | null;
}

/**
 * A body that yields `file` in chunks of `chunk` bytes, counting what was pulled; `stallAfter` stops yielding.
 * `follow(signal)` makes it behave as a real fetch's body does when the fetch's signal is aborted: the body is errored
 * with an AbortError (a read waiting on it ends) and the reading is stopped (`aborted`; the publisher's end is closed).
 */
function streamOf(file: Uint8Array, o: { chunk?: number; stallAfter?: number } = {}) {
  const chunk = o.chunk ?? 64 * 1024;
  let at = 0;
  let ended = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const seen = { pulled: 0, cancelled: false, aborted: false };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    pull(c) {
      if (o.stallAfter !== undefined && at >= o.stallAfter) return new Promise<void>(() => undefined);
      if (at >= file.length) {
        ended = true;
        return c.close();
      }
      const part = file.subarray(at, Math.min(at + chunk, file.length));
      at += part.length;
      seen.pulled = at;
      c.enqueue(part.slice());
      return undefined;
    },
    cancel() {
      ended = true;
      seen.cancelled = true;
    },
  });
  const follow = (signal: AbortSignal | null | undefined) =>
    signal?.addEventListener("abort", () => {
      if (ended) return;
      ended = true;
      seen.aborted = true;
      controller!.error(new DOMException("This operation was aborted", "AbortError"));
    });
  return { body, seen, follow };
}

const pdfBytes = (n: number, fill = 0x41) => {
  const b = new Uint8Array(n).fill(fill);
  b.set(new TextEncoder().encode("%PDF-1.7\n"));
  for (let i = 9; i < n; i += 997) b[i] = i % 251;
  return b;
};

interface Rig {
  deps: FinderDeps;
  finder: ReturnType<typeof createFinder>;
  injected: number[];
  fetches: Array<{ url: string; init: RequestInit | undefined }>;
  posts: Array<{ ticket: string; page: string; bytes: Uint8Array; type: string }>;
  saved: string[];
  /** What saveResult was given whole (R357 a: the sentence, the time and the ticket's hash). */
  kept: FindResult[];
  keepAlives: number;
  tabPorts: FakePort[];
  bgPorts: FakePort[];
  scripts: Promise<void>[];
  streams: Array<ReturnType<typeof streamOf>["seen"]>;
}

function rig(tabs: Record<number, FakeTab>, o: { post?: FinderDeps["post"]; waiting?: () => Promise<WaitingRead>; waits?: FinderDeps["waits"]; tabStall?: number } = {}): Rig {
  const r: Rig = { injected: [], fetches: [], posts: [], saved: [], kept: [], keepAlives: 0, tabPorts: [], bgPorts: [], scripts: [], streams: [] } as unknown as Rig;
  r.deps = {
    extensionId: EXT_ID,
    tabUrl: async (tabId) => tabs[tabId]?.url,
    inject: async (tabId) => {
      const tab = tabs[tabId];
      if (!tab || tab.noScript) throw new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host.");
      r.injected.push(tabId);
      if (tab.silent) return;
      r.scripts.push(
        readTabPdf(
          {
            href: tab.url!,
            contentType: tab.contentType,
            fetch: (async (url: string, init?: RequestInit) => {
              r.fetches.push({ url: String(url), init });
              if (typeof tab.file === "function") return tab.file(init);
              const s = streamOf(tab.file ?? new Uint8Array(), {});
              r.streams.push(s.seen);
              const headers = new Headers({ "content-type": "application/pdf" });
              const len = tab.length === undefined ? (tab.file?.length ?? 0) : tab.length;
              if (len !== null) headers.set("content-length", String(len));
              return new Response(s.body, { status: 200, headers });
            }) as typeof fetch,
            connect: (name) => {
              const pair = portPair(name, { id: EXT_ID, tab: { id: tabId }, frameId: 0 });
              r.tabPorts.push(pair.tab);
              r.bgPorts.push(pair.bg);
              setTimeout(() => r.finder.connect(pair.bg), 0);
              return pair.tab;
            },
          },
          o.tabStall !== undefined ? { askMs: o.tabStall } : {},
        ),
      );
      // As in Chrome: the injection's answer reaches the background AFTER the script's port and its first messages
      // (the script connects and speaks while it is being run).
      await new Promise((res) => setTimeout(res, 15));
    },
    post:
      o.post ??
      (async (ticket, page, body) => {
        r.posts.push({ ticket, page, bytes: new Uint8Array(await body.arrayBuffer()), type: body.type });
        return HELD;
      }),
    waiting: o.waiting ?? (async () => ({ waiting: [{ ticket: TICKET, label: "A work" }] })),
    saveResult: async (result) => {
      r.saved.push(result.sentence);
      r.kept.push(result);
    },
    keepAlive: () => void r.keepAlives++,
    ...(o.waits ? { waits: o.waits } : {}),
  };
  r.finder = createFinder(r.deps);
  return r;
}

const pieces = (p: FakePort) => p.sent.filter((m) => (m as { t?: string }).t === "piece") as Array<{ b64: string }>;

afterEach(async () => {
  await new Promise((res) => setTimeout(res, 5));
});

// ---------------------------------------------------------------------------------------------------------------

describe("the extension's numbers and the service's sentences are the service's (packages/shared)", () => {
  it("the limit, the label's and the address's longest, the header's name", () => {
    expect(FIND_PDF_MAX_BYTES).toBe(LIBRARY_FILE_MAX_BYTES);
    expect(FIND_PAGE_HEADER).toBe(FIND_BROWSER_PAGE_HEADER);
    // parseWaiting's and the page check's bounds (below) are those numbers.
    expect(FIND_BROWSER_LABEL_MAX).toBe(200);
    expect(FIND_BROWSER_PAGE_MAX).toBe(2048);
  });

  it("the one case the extension finds before sending in the service's words is the limit (R357 e, f: the address and a second answer that is not a PDF have the extension's own words)", () => {
    expect(FIND_SERVICE_TEXT).toEqual({ tooLarge: FIND_BROWSER_TEXT.tooLarge });
  });

  it("R357's own sentences, exactly", () => {
    expect(FIND_TEXT.userInfo).toBe("This tab's address holds a user name or password, so its file cannot be sent.");
    expect(FIND_TEXT.tooLong).toBe("This tab's address is too long for the app, so its file cannot be sent.");
    expect(FIND_TEXT.notGivenAgain).toBe("The site did not give the PDF a second time, so nothing was sent. Download the PDF and add it to the record in the app instead.");
    expect(FIND_TEXT.noAnswer).toBe("The app's answer did not arrive, and the work is no longer waiting for a PDF from this browser. The app shows what became of it.");
    expect(FIND_TEXT.unknown).toBe("The app's answer did not arrive, and whether the work is still waiting could not be read. Open this popup again to see.");
  });

  it("the extension's own sentences are R348's and the dispatch's; none says a file was added (R301)", () => {
    expect(FIND_TEXT.notHttps).toBe("This tab's address is not https, so its file cannot be sent.");
    expect(FIND_TEXT.notShowingPdf).toBe("This tab is not showing a PDF. Open the PDF itself, then try again.");
    expect(FIND_TEXT.notAllowed).toBe("This browser does not let the extension read this tab, so its PDF cannot be sent.");
    expect(FIND_TEXT.couldNotSend).toBe("The PDF could not be sent. The work is still waiting — try again.");
    // "Add it to the record" (R357 f) asks the researcher to do it; no sentence says a file WAS added.
    for (const s of [...Object.values(FIND_TEXT), ...Object.values(FIND_SERVICE_TEXT)]) expect(s).not.toMatch(/\badded\b|\badds\b|\bwas add/i);
  });
});

describe("the list (POST /find/browser/waiting): anything but { waiting: [{ ticket, label }] } is nothing waiting", () => {
  const item = { ticket: TICKET, label: "Quillbrook Ledger of Habits" };
  it("takes the service's answer", () => {
    expect(parseWaiting({ waiting: [] })).toEqual([]);
    expect(parseWaiting({ waiting: [item] })).toEqual([item]);
    expect(parseWaiting({ waiting: [item, { ticket: "f".repeat(32), label: "(no title)" }] })).toHaveLength(2);
  });
  it("a label is taken as it is (markup, controls, direction marks), up to 200 characters counted as code points", () => {
    const odd = `<img src=x onerror=alert(1)>‮evil\u0000`;
    expect(parseWaiting({ waiting: [{ ticket: TICKET, label: odd }] })).toEqual([{ ticket: TICKET, label: odd }]);
    const astral = "𝔄".repeat(200);
    expect(parseWaiting({ waiting: [{ ticket: TICKET, label: astral }] })).toEqual([{ ticket: TICKET, label: astral }]);
    expect(parseWaiting({ waiting: [{ ticket: TICKET, label: "x".repeat(201) }] })).toEqual([]);
  });
  it.each([
    ["nothing", undefined],
    ["null", null],
    ["a string", "waiting"],
    ["an array", [item]],
    ["no list", {}],
    ["a list that is not an array", { waiting: item }],
    ["another key beside the list", { waiting: [item], more: 1 }],
    ["an item with another key", { waiting: [{ ...item, projectId: "p" }] }],
    ["no label", { waiting: [{ ticket: TICKET }] }],
    ["an empty label", { waiting: [{ ticket: TICKET, label: "" }] }],
    ["a label that is not text", { waiting: [{ ticket: TICKET, label: 7 }] }],
    ["an upper-case ticket", { waiting: [{ ticket: TICKET.toUpperCase(), label: "x" }] }],
    ["a short ticket", { waiting: [{ ticket: TICKET.slice(1), label: "x" }] }],
    ["a ticket with a path in it", { waiting: [{ ticket: "../../projects/0123456789abcdef01", label: "x" }] }],
    ["one good item and one bad", { waiting: [item, { ticket: 1, label: "x" }] }],
    ["more than twenty items", { waiting: Array.from({ length: 21 }, () => item) }],
  ])("%s → nothing waiting", (_what, v) => {
    expect(parseWaiting(v)).toEqual([]);
  });
});

describe("a read of the list that failed or was not understood is told apart from a real { waiting: [] } (R357 c)", () => {
  const item = { ticket: TICKET, label: "x" };
  it("the background's read: the service's answer, a failure, an answer of another shape, the app not answering", async () => {
    expect(await readWaitingWith(async () => ({ waiting: [] }))).toEqual({ waiting: [] });
    expect(await readWaitingWith(async () => ({ waiting: [item] }))).toEqual({ waiting: [item] });
    expect(await readWaitingWith(async () => ({ waiting: "yes" }))).toEqual({ waiting: [], failed: true });
    expect(await readWaitingWith(async () => undefined)).toEqual({ waiting: [], failed: true });
    expect(await readWaitingWith(async () => ({ waiting: [{ ticket: "x", label: "y" }] }))).toEqual({ waiting: [], failed: true });
    expect(await readWaitingWith(async () => Promise.reject(new ApiError("BAD_REPLY", "x", 200)))).toEqual({ waiting: [], failed: true });
    expect(await readWaitingWith(async () => Promise.reject(new ApiError("UNREACHABLE", unreachable(48123))))).toEqual({ waiting: [], unreachable: unreachable(48123) });
  });
  it("the popup's copy: no answer, or a list it does not understand, is a failed read", () => {
    expect(parseWaitingRead(undefined)).toEqual({ waiting: [], failed: true });
    expect(parseWaitingRead(null)).toEqual({ waiting: [], failed: true });
    expect(parseWaitingRead({ waiting: "yes" })).toEqual({ waiting: [], failed: true });
    expect(parseWaitingRead({ waiting: [] })).toEqual({ waiting: [] });
    expect(parseWaitingRead({ waiting: [item] })).toEqual({ waiting: [item] });
    expect(parseWaitingRead({ waiting: [], failed: true })).toEqual({ waiting: [], failed: true });
    expect(sentenceAfterNoAnswer(TICKET, parseWaitingRead(undefined))).toBe(FIND_TEXT.unknown);
  });
});

describe("the kept result belongs to its work: a SHA-256 of its ticket, never the ticket (R357 a, b)", () => {
  const T2 = "fedcba9876543210fedcba9876543210";
  it("the hash is 64 lower-case hex, the same for the same ticket, not the ticket", async () => {
    const h = await ticketHash(TICKET);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await ticketHash(TICKET)).toBe(h);
    expect(await ticketHash(T2)).not.toBe(h);
    expect(h).not.toContain(TICKET);
    // SHA-256 of the ticket's text, as crypto.subtle gives it.
    expect(h).toBe(Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TICKET))).toString("hex"));
  });
  it("its place at an opening: in its work's section; alone when nothing waits; dropped when a DIFFERENT work waits", async () => {
    const kept = { sentence: "s", at: 1, work: await ticketHash(TICKET) };
    expect(await placeOfKept(kept, [{ ticket: TICKET, label: "A" }])).toBe("work");
    expect(await placeOfKept(kept, [{ ticket: T2, label: "B" }, { ticket: TICKET, label: "A" }])).toBe("work");
    expect(await placeOfKept(kept, [])).toBe("alone");
    expect(await placeOfKept(kept, [{ ticket: T2, label: "B" }])).toBe("drop");
  });
  it("a kept result of the old shape (no hash), or of any other shape, is not one", async () => {
    const work = await ticketHash(TICKET);
    expect(parseFindResult({ sentence: "s", at: 1, work })).toEqual({ sentence: "s", at: 1, work });
    for (const bad of [{ sentence: "s", at: 1 }, { sentence: "s", at: 1, work: TICKET }, { sentence: "s", at: 1, work, ticket: TICKET }, { sentence: "s", at: 1, work: work.toUpperCase() }, null]) expect(parseFindResult(bad)).toBeUndefined();
  });
  it("the store: saved whole; looked at without being taken; an old shape dropped; removed only when it is the same result", async () => {
    const data: Record<string, unknown> = {};
    const area = {
      get: async (k: string) => (k in data ? { [k]: data[k] } : {}),
      set: async (o: Record<string, unknown>) => void Object.assign(data, JSON.parse(JSON.stringify(o))),
      remove: async (k: string) => void delete data[k],
    };
    const store = createResultStore(area);
    expect(await store.peek()).toBeUndefined();
    const work = await ticketHash(TICKET);
    await store.save({ sentence: "s", at: 5, work });
    expect(Object.keys(data[FIND_RESULT_KEY] as object).sort()).toEqual(["at", "sentence", "work"]);
    expect(JSON.stringify(data)).not.toContain(TICKET);
    // Looked at twice: still there (a popup closed during its opening takes nothing).
    expect(await store.peek()).toEqual({ sentence: "s", at: 5, work });
    expect(await store.peek()).toEqual({ sentence: "s", at: 5, work });
    // Another result (an older time, another work) is not removed in its place.
    expect(await store.forget({ work, at: 4 })).toBe(false);
    expect(await store.forget({ work: await ticketHash(T2), at: 5 })).toBe(false);
    expect(data[FIND_RESULT_KEY]).toBeDefined();
    expect(await store.forget({ work, at: 5 })).toBe(true);
    expect(data[FIND_RESULT_KEY]).toBeUndefined();
    // The old shape: dropped at the first look, never shown.
    data[FIND_RESULT_KEY] = { sentence: "Sent. The file waits for your check in the app's review queue.", at: 1 };
    expect(await store.peek()).toBeUndefined();
    expect(FIND_RESULT_KEY in data).toBe(false);
  });
  it("the popup's request to remove it: a hash and a time, nothing else", async () => {
    const work = await ticketHash(TICKET);
    expect(parseResultForget({ type: "find-result-forget", work, at: 5 })).toEqual({ work, at: 5 });
    for (const bad of [{ type: "find-result-forget", work: TICKET, at: 5 }, { type: "find-result-forget", work }, { type: "find-result-forget", work, at: "5" }, { type: "find-result", work, at: 5 }, null]) expect(parseResultForget(bad)).toBeUndefined();
  });
});

describe("the tab script takes the extension's runtime, not a page's element of that name (R357 g)", () => {
  const port = {} as PortLike;
  const real = { connect: () => port };
  it("chrome.runtime first, then browser.runtime; only with a connect function", () => {
    expect(extensionRuntime({ chrome: { runtime: real } })).toBe(real);
    expect(extensionRuntime({ browser: { runtime: real } })).toBe(real);
    // A page's <form id="browser"><input name="runtime"></form> in Chrome's shared named access: not taken.
    const clobbered = { runtime: { tagName: "INPUT", name: "runtime" } };
    expect(extensionRuntime({ browser: clobbered, chrome: { runtime: real } })).toBe(real);
    expect(extensionRuntime({ browser: clobbered })).toBeUndefined();
    expect(extensionRuntime({ chrome: { runtime: { connect: "no" } } })).toBeUndefined();
    expect(extensionRuntime({})).toBeUndefined();
  });
});

describe("the file's answer (200 { outcome, sentence })", () => {
  it("takes the three outcomes with their sentence", () => {
    for (const outcome of ["held", "not-kept", "gone"]) expect(parseFileAnswer({ outcome, sentence: "s" })).toEqual({ outcome, sentence: "s" });
  });
  it.each([[undefined], [{}], [{ outcome: "added", sentence: "s" }], [{ outcome: "held" }], [{ outcome: "held", sentence: 1 }], [{ outcome: "held", sentence: "" }], [{ outcome: "held", sentence: "s".repeat(1001) }], [{ outcome: "held", sentence: "s", ticket: TICKET }]])(
    "refuses %j",
    (v) => {
      expect(parseFileAnswer(v)).toBeUndefined();
    },
  );
});

describe("the popup's request to send", () => {
  it("takes a tab id and a ticket of 32 lower-case hex, nothing else", () => {
    expect(parseFindSend({ type: "find-send", tabId: 7, ticket: TICKET })).toEqual({ tabId: 7, ticket: TICKET });
    for (const bad of [{ type: "find-send", tabId: -1, ticket: TICKET }, { type: "find-send", tabId: 1.5, ticket: TICKET }, { type: "find-send", tabId: 7, ticket: "x" }, { type: "find-send", tabId: 7 }, { type: "find-send", tabId: 7, ticket: `${TICKET}/x` }, null]) {
      expect(parseFindSend(bad)).toBeUndefined();
    }
  });
});

describe("after a POST that brought no answer, the list is read again and the popup says truly whether the work waits", () => {
  it("still waiting / not waiting / the app not answering", () => {
    expect(sentenceAfterNoAnswer(TICKET, { waiting: [{ ticket: TICKET, label: "x" }] })).toBe(FIND_TEXT.couldNotSend);
    expect(sentenceAfterNoAnswer(TICKET, { waiting: [] })).toBe(FIND_TEXT.noAnswer);
    expect(sentenceAfterNoAnswer(TICKET, { waiting: [], unreachable: unreachable(48123) })).toBe(unreachable(48123));
    // A list that could not be read for another reason claims nothing.
    expect(sentenceAfterNoAnswer(TICKET, { waiting: [], failed: true })).toBe(FIND_TEXT.unknown);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("sending the tab's PDF: the whole way with the real tab script, a fake tab and a fake service", () => {
  it("held: ONE POST with exactly the file's bytes, application/pdf, the ticket and the tab's address; the file went in pieces of at most 1 MiB", async () => {
    const file = pdfBytes(2.5 * 1024 * 1024 + 17);
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", file } });
    const reply = await r.finder.send(7, TICKET);
    await Promise.all(r.scripts);
    expect(reply).toEqual({ sentence: FIND_BROWSER_TEXT.held });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]!.ticket).toBe(TICKET);
    // The tab's address without its query and fragment (R357 e); the file itself fetched from the full address.
    expect(r.posts[0]!.page).toBe(PAGE_SENT);
    expect(r.posts[0]!.type).toBe("application/pdf");
    expect(Buffer.from(r.posts[0]!.bytes).equals(Buffer.from(file))).toBe(true);
    // The tab read its own address, with the browser's session, and nothing else.
    expect(r.fetches).toEqual([{ url: PAGE, init: expect.objectContaining({ credentials: "include" }) }]);
    // Pieces: never one message with the whole file.
    const sent = pieces(r.tabPorts[0]!);
    expect(sent).toHaveLength(3);
    for (const p of sent) expect(Buffer.from(p.b64, "base64").length).toBeLessThanOrEqual(FIND_PIECE_BYTES);
    // Nothing of the ticket reached the tab's side: the tab received only "more".
    expect(JSON.stringify(r.bgPorts[0]!.sent)).not.toContain(TICKET);
    expect(new Set(r.bgPorts[0]!.sent.map((m) => JSON.stringify(m)))).toEqual(new Set([JSON.stringify({ t: "more" })]));
    // The result is kept for the next opening: its sentence, its time and its ticket's hash — never the ticket (R357 a).
    expect(r.saved).toEqual([FIND_BROWSER_TEXT.held]);
    expect(Object.keys(r.kept[0]!).sort()).toEqual(["at", "sentence", "work"]);
    expect(r.kept[0]!.work).toBe(await ticketHash(TICKET));
    expect(JSON.stringify(r.kept)).not.toContain(TICKET);
    // Nothing is left listening in the tab; the port is closed.
    expect(r.tabPorts[0]!.messages.size).toBe(0);
    expect(r.tabPorts[0]!.gone.size).toBe(0);
    expect(r.tabPorts[0]!.closed).toBe(true);
    expect(r.finder.sending()).toBeUndefined();
  });

  it("not-kept and gone: the service's sentence, as it is", async () => {
    for (const answer of [
      { outcome: "not-kept", sentence: "The file sent from your browser was not kept: it is not a PDF or EPUB." },
      { outcome: "gone", sentence: FIND_BROWSER_TEXT.gone },
    ]) {
      const r = rig({ 7: { url: PAGE, contentType: "application/pdf", file: pdfBytes(1000) } }, { post: async () => answer });
      expect(await r.finder.send(7, TICKET)).toEqual({ sentence: answer.sentence });
      await Promise.all(r.scripts);
    }
  });

  it("a tab whose address is not https: said before anything is injected; nothing read, nothing sent", async () => {
    for (const url of ["http://pdfs.publisher.example/a.pdf", "file:///home/x/a.pdf", "chrome://settings/", "data:application/pdf,%25PDF-"]) {
      const r = rig({ 7: { url, contentType: "application/pdf", file: pdfBytes(100) } });
      expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.notHttps });
      expect(r.injected).toEqual([]);
      expect(r.posts).toEqual([]);
    }
  });

  it("an address with a user name or password, or still longer than 2,048 without its query: the extension's own words, nothing injected (R357 e)", async () => {
    for (const [url, sentence] of [
      ["https://someone:pw@pdfs.publisher.example/a.pdf", FIND_TEXT.userInfo],
      ["https://someone@pdfs.publisher.example/a.pdf", FIND_TEXT.userInfo],
      [`https://pdfs.publisher.example/${"a".repeat(2049)}`, FIND_TEXT.tooLong],
      [`https://pdfs.publisher.example/${"a".repeat(2049)}?q=1`, FIND_TEXT.tooLong],
    ] as const) {
      const r = rig({ 7: { url, contentType: "application/pdf", file: pdfBytes(100) } });
      expect(await r.finder.send(7, TICKET)).toEqual({ sentence });
      expect(r.injected).toEqual([]);
      expect(r.posts).toEqual([]);
    }
  });

  it("an address with a 3,000-character query is sent: x-ao-page holds no query and no fragment; the file is fetched from the full address (R357 e)", async () => {
    const url = `https://pdfs.publisher.example/content/signed.pdf?Signature=${"s".repeat(3000)}&Expires=1#page=2`;
    const file = pdfBytes(5000);
    const r = rig({ 7: { url, contentType: "application/pdf", file } });
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_BROWSER_TEXT.held });
    await Promise.all(r.scripts);
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]!.page).toBe("https://pdfs.publisher.example/content/signed.pdf");
    expect(r.posts[0]!.page).not.toMatch(/[?#]/);
    expect(r.fetches.map((f) => f.url)).toEqual([url]);
  });

  it("the script's own address is checked on what will be sent: a user name there is refused in the extension's words", async () => {
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", silent: true } });
    const done = r.finder.send(7, TICKET);
    await new Promise((res) => setTimeout(res, 5));
    const pair = portPair(FIND_PORT, { id: EXT_ID, tab: { id: 7 }, frameId: 0 });
    r.finder.connect(pair.bg);
    pair.tab.postMessage({ t: "head", href: "https://someone@pdfs.publisher.example/a.pdf", pdf: true });
    expect(await done).toEqual({ sentence: FIND_TEXT.userInfo });
    expect(r.posts).toEqual([]);
  });

  it("the browser does not tell the extension the tab's address, or refuses the script, or the script never answers: R348's sentence, never an unhandled error", async () => {
    const quick = { connect: 30 };
    for (const tab of [{ url: undefined, contentType: "" }, { url: PAGE, contentType: "application/pdf", noScript: true }, { url: PAGE, contentType: "application/pdf", silent: true }] as FakeTab[]) {
      const r = rig({ 7: tab }, { waits: quick });
      expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.notAllowed });
      expect(r.posts).toEqual([]);
      expect(r.finder.sending()).toBeUndefined();
    }
  });

  it("a tab that is not showing a PDF: said, the tab's file not even fetched, nothing sent", async () => {
    const r = rig({ 7: { url: PAGE, contentType: "text/html", file: pdfBytes(100) } });
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.notShowingPdf });
    await Promise.all(r.scripts);
    expect(r.fetches).toEqual([]);
    expect(r.posts).toEqual([]);
    expect(r.tabPorts[0]!.messages.size).toBe(0);
  });

  it("a tab that shows a PDF whose bytes, read again, do not begin with %PDF- (a page the second time): R357 f's sentence; reading stops at the first piece; nothing sent", async () => {
    const file = new Uint8Array(5 * 1024 * 1024).fill(0x3c);
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", file } });
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.notGivenAgain });
    await Promise.all(r.scripts);
    expect(pieces(r.tabPorts[0]!)).toHaveLength(1);
    expect(r.streams[0]!.pulled).toBeLessThan(file.length);
    expect(r.streams[0]!.cancelled).toBe(true);
    expect(r.posts).toEqual([]);
  });

  it("a site that answers the second request with a page (HTML, status 200): R357 f's sentence, not \"not a PDF\"", async () => {
    const page = new TextEncoder().encode("<!doctype html><title>Article</title><p>Read the article online.</p>");
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", file: () => new Response(page, { status: 200, headers: { "content-type": "text/html" } }) } });
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.notGivenAgain });
    await Promise.all(r.scripts);
    expect(r.posts).toEqual([]);
  });

  it("an empty file, or one shorter than five bytes, read again from a tab showing a PDF: R357 f's sentence", async () => {
    for (const file of [new Uint8Array(0), new TextEncoder().encode("%PDF")]) {
      const r = rig({ 7: { url: PAGE, contentType: "application/pdf", file } });
      expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.notGivenAgain });
      await Promise.all(r.scripts);
      expect(r.posts).toEqual([]);
    }
  });

  it("a file announced larger than the limit: refused before a piece is read", async () => {
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", file: pdfBytes(1000), length: FIND_PDF_MAX_BYTES + 1 } });
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_SERVICE_TEXT.tooLarge });
    await Promise.all(r.scripts);
    expect(pieces(r.tabPorts[0]!)).toEqual([]);
    expect(r.posts).toEqual([]);
  });

  it("a file larger than the limit with no length announced: the tab's script stops past the limit and says so; nothing sent", async () => {
    const big = { length: FIND_PDF_MAX_BYTES + 1 } as Uint8Array;
    // A lazy body of limit + 1 bytes (the same piece again and again), with no Content-Length.
    const piece = pdfBytes(1024 * 1024);
    let at = 0;
    const r = rig(
      {
        7: {
          url: PAGE,
          contentType: "application/pdf",
          file: () =>
            new Response(
              new ReadableStream<Uint8Array>({
                pull(c) {
                  if (at >= big.length) return c.close();
                  const n = Math.min(piece.length, big.length - at);
                  at += n;
                  c.enqueue(piece.slice(0, n));
                },
              }),
            ),
        },
      },
      {},
    );
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_SERVICE_TEXT.tooLarge });
    await Promise.all(r.scripts);
    expect(pieces(r.tabPorts[0]!).length).toBe(200);
    expect(r.posts).toEqual([]);
  }, 60_000);

  it("a script that sends more than the limit anyway: the background stops reading past the limit (its own count)", async () => {
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", silent: true } });
    const done = r.finder.send(7, TICKET);
    await new Promise((res) => setTimeout(res, 5));
    const pair = portPair(FIND_PORT, { id: EXT_ID, tab: { id: 7 }, frameId: 0 });
    let asked = 0;
    const one = Buffer.from(pdfBytes(FIND_PIECE_BYTES)).toString("base64");
    // It stops by itself a few pieces past the limit (so a background that did not stop would go on to POST).
    pair.tab.onMessage.addListener(() => {
      asked++;
      if (asked > FIND_PDF_MAX_BYTES / FIND_PIECE_BYTES + 3) pair.tab.postMessage({ t: "end" });
      else pair.tab.postMessage({ t: "piece", b64: one });
    });
    pair.tab.sent = { push: () => 0 } as unknown as unknown[]; // not kept: 200 MB of text
    r.finder.connect(pair.bg);
    pair.tab.postMessage({ t: "head", href: PAGE, pdf: true });
    expect(await done).toEqual({ sentence: FIND_SERVICE_TEXT.tooLarge });
    expect(asked).toBe(FIND_PDF_MAX_BYTES / FIND_PIECE_BYTES + 1);
    expect(pair.tab.closed).toBe(true);
    expect(r.posts).toEqual([]);
  }, 60_000);

  it("the tab's fetch refused (the publisher answers 403) or fails: nothing sent, a plain sentence", async () => {
    for (const file of [() => new Response("no", { status: 403 }), () => Promise.reject(new TypeError("Failed to fetch")) as unknown as Response]) {
      const r = rig({ 7: { url: PAGE, contentType: "application/pdf", file } });
      expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.couldNotRead });
      await Promise.all(r.scripts);
      expect(r.posts).toEqual([]);
    }
  });

  it("a tab whose file stops arriving: the wait for a piece ends, the tab's reading is stopped, nothing sent", async () => {
    // One whole piece arrives, then the file stops: the tab's next read never ends by itself. The piece wait is set
    // well above the first piece's honest work (its base64 and its copy, tens of milliseconds; more on a busy machine),
    // so the wait that ends is the one for the SECOND piece, as asserted below, never the first.
    const file = pdfBytes(3 * 1024 * 1024);
    const stallAfter = FIND_PIECE_BYTES + 64 * 1024;
    const s = streamOf(file, { stallAfter });
    const file7 = (init?: RequestInit) => {
      s.follow(init?.signal);
      return new Response(s.body);
    };
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", file: file7 } }, { waits: { piece: 1_000 } });
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.couldNotRead });
    expect(pieces(r.tabPorts[0]!)).toHaveLength(1);
    expect(r.bgPorts[0]!.sent.filter((m) => (m as { t?: string }).t === "more")).toHaveLength(2);
    expect(s.seen.pulled).toBe(stallAfter);
    // The background's disconnect aborts the tab's fetch; its read ends and the script ends.
    await Promise.all(r.scripts);
    expect(s.seen.aborted).toBe(true);
    expect(r.tabPorts[0]!.messages.size).toBe(0);
    expect(r.posts).toEqual([]);
  });

  it("the tab closed or navigated mid-way (the port goes): nothing sent", async () => {
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", silent: true } });
    const done = r.finder.send(7, TICKET);
    await new Promise((res) => setTimeout(res, 5));
    const pair = portPair(FIND_PORT, { id: EXT_ID, tab: { id: 7 }, frameId: 0 });
    pair.tab.onMessage.addListener(() => {
      pair.tab.postMessage({ t: "piece", b64: Buffer.from(pdfBytes(10)).toString("base64") });
      pair.tab.disconnect();
    });
    r.finder.connect(pair.bg);
    pair.tab.postMessage({ t: "head", href: PAGE, pdf: true });
    expect(await done).toEqual({ sentence: FIND_TEXT.couldNotRead });
    expect(r.posts).toEqual([]);
  });

  it("the tab moved to an address that is not https before the script read it: refused on the script's own address", async () => {
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", silent: true } });
    const done = r.finder.send(7, TICKET);
    await new Promise((res) => setTimeout(res, 5));
    const pair = portPair(FIND_PORT, { id: EXT_ID, tab: { id: 7 }, frameId: 0 });
    r.finder.connect(pair.bg);
    pair.tab.postMessage({ t: "head", href: "http://pdfs.publisher.example/a.pdf", pdf: true });
    expect(await done).toEqual({ sentence: FIND_TEXT.notHttps });
    expect(pair.tab.sent).toHaveLength(1);
    expect(r.posts).toEqual([]);
  });
});

describe("the background accepts the script's port only from its own extension and the tab it injected into for this sending", () => {
  /** Starts a sending and waits until it expects the script's port; `done` is its reply. */
  async function started(r: Rig): Promise<{ done: Promise<unknown> }> {
    const done = r.finder.send(7, TICKET);
    await new Promise((res) => setTimeout(res, 5));
    return { done };
  }
  const head = (p: FakePort) => p.postMessage({ t: "head", href: PAGE, pdf: true });

  it("a port from ANOTHER tab is disconnected at once and changes nothing; the right tab's file is then sent", async () => {
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", silent: true } });
    const { done } = await started(r);
    const other = portPair(FIND_PORT, { id: EXT_ID, tab: { id: 8 }, frameId: 0 });
    head(other.tab);
    r.finder.connect(other.bg);
    await new Promise((res) => setTimeout(res, 5));
    expect(other.bg.closed).toBe(true);
    expect(other.tab.messages.size).toBe(0);
    // The injected tab's script then connects and sends its file.
    const right = portPair(FIND_PORT, { id: EXT_ID, tab: { id: 7 }, frameId: 0 });
    const file = pdfBytes(300);
    right.tab.onMessage.addListener(function on() {
      right.tab.onMessage.removeListener(on);
      right.tab.postMessage({ t: "piece", b64: Buffer.from(file).toString("base64") });
      right.tab.onMessage.addListener(() => right.tab.postMessage({ t: "end" }));
    });
    r.finder.connect(right.bg);
    head(right.tab);
    expect(await done).toEqual({ sentence: FIND_BROWSER_TEXT.held });
    expect(Buffer.from(r.posts[0]!.bytes).equals(Buffer.from(file))).toBe(true);
  });

  it.each([
    ["another extension", { id: "ponmlkjihgfedcbaponmlkjihgfedcba", tab: { id: 7 }, frameId: 0 }, FIND_PORT],
    ["no extension id", { tab: { id: 7 }, frameId: 0 }, FIND_PORT],
    ["a frame inside the tab", { id: EXT_ID, tab: { id: 7 }, frameId: 3 }, FIND_PORT],
    ["no tab (an extension page)", { id: EXT_ID, frameId: 0 }, FIND_PORT],
    ["another port name", { id: EXT_ID, tab: { id: 7 }, frameId: 0 }, "ao-other"],
  ])("a port from %s is disconnected and not read", async (_what, sender, name) => {
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", silent: true } }, { waits: { connect: 40 } });
    const { done } = await started(r);
    const p = portPair(name, sender as PortLike["sender"]);
    head(p.tab);
    r.finder.connect(p.bg);
    expect(await done).toEqual({ sentence: FIND_TEXT.notAllowed });
    expect(p.bg.closed).toBe(true);
    expect(p.tab.sent).toHaveLength(1);
    expect(r.posts).toEqual([]);
  });

  it("a port when nothing is being sent is disconnected", async () => {
    const r = rig({});
    const p = portPair(FIND_PORT, { id: EXT_ID, tab: { id: 7 }, frameId: 0 });
    r.finder.connect(p.bg);
    expect(p.bg.closed).toBe(true);
  });

  it("a second port from the same tab during the same sending is disconnected", async () => {
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", silent: true } }, { waits: { piece: 60 } });
    const { done } = await started(r);
    const first = portPair(FIND_PORT, { id: EXT_ID, tab: { id: 7 }, frameId: 0 });
    r.finder.connect(first.bg);
    const second = portPair(FIND_PORT, { id: EXT_ID, tab: { id: 7 }, frameId: 0 });
    r.finder.connect(second.bg);
    expect(second.bg.closed).toBe(true);
    head(first.tab);
    expect(await done).toEqual({ sentence: FIND_TEXT.couldNotRead });
  });

  it.each([
    ["a head of the wrong shape", [{ t: "head", href: PAGE }]],
    ["a head with another key", [{ t: "head", href: PAGE, pdf: true, ticket: TICKET }]],
    ["a piece before the head", [{ t: "piece", b64: "JVBERi0=" }]],
    ["a piece that is not base64", [{ t: "head", href: PAGE, pdf: true }, { t: "piece", b64: "%PDF-not-base64" }]],
    ["a piece larger than 1 MiB", [{ t: "head", href: PAGE, pdf: true }, { t: "piece", b64: Buffer.alloc(FIND_PIECE_BYTES + 3).toString("base64") }]],
    ["a second head", [{ t: "head", href: PAGE, pdf: true }, { t: "head", href: PAGE, pdf: true }]],
    ["text instead of an object", [{ t: "head", href: PAGE, pdf: true }, "%PDF-1.7"]],
  ])("%s: the reading ends, nothing is sent", async (_what, msgs) => {
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", silent: true } });
    const { done } = await started(r);
    const p = portPair(FIND_PORT, { id: EXT_ID, tab: { id: 7 }, frameId: 0 });
    r.finder.connect(p.bg);
    for (const m of msgs) p.tab.postMessage(m);
    expect(await done).toEqual({ sentence: FIND_TEXT.couldNotRead });
    expect(p.bg.closed).toBe(true);
    expect(r.posts).toEqual([]);
  });
});

describe("the POST's refusals and failures", () => {
  const tabs = () => ({ 7: { url: PAGE, contentType: "application/pdf", file: pdfBytes(4000) } });

  it.each([
    [400, "browser-cut-off", FIND_BROWSER_TEXT.cutOff],
    [400, "browser-page", FIND_BROWSER_TEXT.page],
    [404, "browser-not-waiting", FIND_BROWSER_TEXT.notWaiting],
    [409, "browser-busy", FIND_BROWSER_TEXT.busy],
    [413, "browser-too-large", FIND_BROWSER_TEXT.tooLarge],
    [400, "browser-not-pdf", FIND_BROWSER_TEXT.notPdf],
    [503, "browser-inbox", FIND_BROWSER_TEXT.inbox],
  ])("%i %s: the service's sentence, as it is", async (status, reason, message) => {
    const code = status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : status === 413 ? "PAYLOAD_TOO_LARGE" : status === 503 ? "UNAVAILABLE" : "VALIDATION";
    const r = rig(tabs(), {
      post: async () => {
        throw new ApiError(code, message, status, reason, true);
      },
    });
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: message });
    await Promise.all(r.scripts);
  });

  it("401: the pairing is no longer known", async () => {
    const r = rig(tabs(), {
      post: async () => {
        throw new ApiError("UNAUTHORIZED", "A valid token is needed.", 401, undefined, true);
      },
    });
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: "The desktop app no longer knows this extension. Pair it again." });
    await Promise.all(r.scripts);
  });

  it.each([
    ["still waiting", { waiting: [{ ticket: TICKET, label: "x" }] }, FIND_TEXT.couldNotSend],
    ["no longer waiting", { waiting: [] }, FIND_TEXT.noAnswer],
    ["the app not answering", { waiting: [], unreachable: unreachable(48123) }, unreachable(48123)],
    ["the list not read", { waiting: [], failed: true }, FIND_TEXT.unknown],
  ])("no answer (the connection closed while the browser was still sending): the list is read again — %s", async (_what, read, sentence) => {
    let reads = 0;
    const r = rig(tabs(), {
      post: async () => {
        throw new ApiError("UNREACHABLE", unreachable(48123));
      },
      waiting: async () => (reads++, read as WaitingRead),
    });
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence });
    expect(reads).toBe(1);
    expect(r.saved).toEqual([sentence]);
    await Promise.all(r.scripts);
  });

  it("no answer, and the list's answer then not understood (the background's own read): unknown, never \"no longer waiting\" (R357 c)", async () => {
    for (const list of [{ waiting: "yes" }, { waiting: [{ ticket: TICKET }] }, "<html>", null]) {
      const r = rig(tabs(), {
        post: async () => {
          throw new ApiError("UNREACHABLE", unreachable(48123));
        },
        waiting: () => readWaitingWith(async () => list),
      });
      expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.unknown });
      await Promise.all(r.scripts);
    }
    const r = rig(tabs(), {
      post: async () => {
        throw new ApiError("UNREACHABLE", unreachable(48123));
      },
      waiting: () => readWaitingWith(async () => ({ waiting: [] })),
    });
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.noAnswer });
    await Promise.all(r.scripts);
  });

  it("an answer that is not understood is no answer: the list is read again", async () => {
    const r = rig(tabs(), { post: async () => ({ outcome: "added", sentence: "Added." }) as never, waiting: async () => ({ waiting: [] }) });
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.noAnswer });
    await Promise.all(r.scripts);
  });

  it("the POST's wait has an end: it is stopped, and the list is read again", async () => {
    let aborted = false;
    const r = rig(tabs(), {
      post: (_t, _p, _b, signal) =>
        new Promise((_res, rej) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            rej(new ApiError("ABORTED", "Stopped."));
          });
        }),
      waits: { post: 40 },
    });
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.couldNotSend });
    expect(aborted).toBe(true);
    await Promise.all(r.scripts);
  });
});

describe("one sending at a time; kept alive while it runs; its result kept for the next opening", () => {
  it("a second send while one runs is answered at once and sends nothing more", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", file: pdfBytes(500) } }, {
      post: async () => {
        await gate;
        return HELD;
      },
    });
    const first = r.finder.send(7, TICKET);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.finder.sending()).toBe(TICKET);
    expect(await r.finder.send(7, TICKET)).toEqual({ sentence: FIND_TEXT.busy });
    release();
    expect(await first).toEqual({ sentence: FIND_BROWSER_TEXT.held });
    expect(r.injected).toEqual([7]);
    // The refusal of the second press is not kept as a result.
    expect(r.saved).toEqual([FIND_BROWSER_TEXT.held]);
    expect(r.finder.sending()).toBeUndefined();
    await Promise.all(r.scripts);
  });

  it("the background is kept awake while a sending runs, and no longer after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const r = rig({ 7: { url: PAGE, contentType: "application/pdf", file: pdfBytes(500) } }, {
      post: async () => {
        await gate;
        return HELD;
      },
      waits: { keepAlive: 5 },
    });
    const done = r.finder.send(7, TICKET);
    await new Promise((res) => setTimeout(res, 60));
    expect(r.keepAlives).toBeGreaterThan(2);
    release();
    await done;
    const n = r.keepAlives;
    await new Promise((res) => setTimeout(res, 40));
    expect(r.keepAlives).toBe(n);
    await Promise.all(r.scripts);
  });

  it("each outcome's sentence is saved for the next opening (and only the sentence)", async () => {
    const r = rig({ 7: { url: "http://x.example/a.pdf", contentType: "application/pdf" } });
    await r.finder.send(7, TICKET);
    expect(r.saved).toEqual([FIND_TEXT.notHttps]);
  });

  it("parses the tab's messages strictly", () => {
    expect(parseTabMessage({ t: "end" })).toEqual({ t: "end" });
    expect(parseTabMessage({ t: "end", x: 1 })).toBeUndefined();
    expect(parseTabMessage({ t: "fail", why: "read" })).toEqual({ t: "fail", why: "read" });
    expect(parseTabMessage({ t: "fail", why: "other" })).toBeUndefined();
  });
});
