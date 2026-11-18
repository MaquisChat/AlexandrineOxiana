/**
 * The popup when the desktop app does not answer on the saved port (R171, defect D13): it names the
 * two possible causes and offers "Use a different port" beside "Unpair"; the new port is checked by
 * one authorised request before it is saved, and the old one is kept if the check fails. No scanning
 * (R110). Rendered with react-dom in jsdom (no testing library in this package).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, unreachable, type LocalStorageArea } from "../api.js";
import { ticketHash, type FindResult } from "../find.js";
import type { BackgroundRequest } from "../types.js";
import { Popup, type PopupBridge } from "./Popup.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123456789-_";
const OLD = 48123;
const NEW = 51234;
const PROJECTS = { projects: [{ id: "p1", name: "Estuary", captureMethods: ["browser_capture", "downloader"] }] };

function memoryStorage(): LocalStorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(key: string) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, JSON.parse(JSON.stringify(items)));
    },
    async remove(key: string) {
      delete data[key];
    },
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

/** A fetch answered by `answer` per port; `null` means nothing answers there. A gate can hold answers back. */
function fakeNet(answer: (port: number, path: string) => { status: number; body: unknown } | null) {
  const calls: Call[] = [];
  let gate: Promise<void> | undefined;
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: String(input), init });
    if (gate) await gate;
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const r = answer(Number(url.port), url.pathname);
    if (!r) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return {
    fn,
    calls,
    hold() {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
}

async function mount(net: ReturnType<typeof fakeNet>, storage = memoryStorage(), opts: { sent?: BackgroundRequest[]; prefs?: PopupBridge["prefs"] } = {}) {
  if (!("pairing" in storage.data)) storage.data.pairing = { port: OLD, token: TOKEN, pairedAt: "2026-11-01T10:00:00.000Z" };
  const bridge: PopupBridge = {
    api: createApi({ fetch: net.fn, storage }),
    prefs: opts.prefs ?? storage,
    activeTabId: async () => 7,
    send: async <T,>(msg: BackgroundRequest) => {
      opts.sent?.push(msg);
      return { active: false, count: 0 } as T;
    },
    pendingLinks: async () => ({}),
    copy: async () => {},
  };
  root = createRoot(host);
  await act(async () => root!.render(<Popup bridge={bridge} />));
  await settle();
  return storage;
}

const buttons = () => [...host.querySelectorAll("button")];
const button = (name: string) => buttons().find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name);
const alerts = () => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");
const status = () => host.querySelector('[role="status"]')?.textContent ?? "";

function inputLabelled(text: RegExp): HTMLInputElement | undefined {
  for (const label of host.querySelectorAll("label")) if (text.test(label.textContent ?? "")) return label.querySelector("input") ?? undefined;
  return undefined;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(el: HTMLElement | undefined): Promise<void> {
  expect(el, "element to click").toBeDefined();
  await act(async () => el!.click());
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => void form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

const appClosed = fakeNetFactory(null);
function fakeNetFactory(newPort: { status: number; body: unknown } | null) {
  return () => fakeNet((port, path) => (port === NEW && path === "/projects" ? newPort : null));
}

describe("the desktop app does not answer on the saved port (R171)", () => {
  it("names the place of the app's pairing page in Task 65's words, with no brackets inside brackets (re-review M10)", async () => {
    const net = appClosed();
    await mount(net);
    const notice = alerts().join(" ");
    const message = unreachable(OLD);
    for (const text of [notice, message]) {
      // Task 65's words for where the pairing page is (the popup's own hint before pairing).
      expect(text).toContain("“Browser extension” page, at the top of its library window,");
      expect(text).not.toMatch(/\([^)]*\(/);
    }
  });

  it("says “no library open” once when the app answers without a library (re-review M9)", async () => {
    const net = fakeNet((port) => (port === OLD ? { status: 503, body: { error: { code: "LIBRARY_OFFLINE", message: "No library is open." } } } : null));
    await mount(net);
    expect((host.textContent ?? "").match(/no library is open/gi)).toHaveLength(1);
  });

  it("names the two possible causes and offers “Use a different port” beside “Unpair”", async () => {
    const net = appClosed();
    await mount(net);
    expect(net.calls.map((c) => c.url)).toEqual([`http://127.0.0.1:${OLD}/projects`]);
    const text = alerts().join(" ");
    expect(text).toContain(`port ${OLD}`);
    expect(text).toMatch(/closed/i);
    expect(text).toMatch(/port changed/i);
    expect(text).toMatch(/no need to pair again/i);
    expect(button("Use a different port")).toBeDefined();
    expect(button("Unpair")).toBeDefined();
    // Side by side, in the same place.
    expect(button("Use a different port")!.parentElement).toBe(button("Unpair")!.parentElement);
    // Never more than once on the page: the status line does not repeat it.
    expect(status()).not.toContain(`port ${OLD}`);
  });

  it("is not offered while the app answers", async () => {
    const net = fakeNet((port) => (port === OLD ? { status: 200, body: PROJECTS } : null));
    await mount(net);
    expect(host.textContent).toContain("Estuary");
    expect(button("Use a different port")).toBeUndefined();
    expect(alerts().join(" ")).not.toMatch(/not answering/);
  });

  it("the new port is checked by one authorised request, saved, and the browser is connected again; focus is managed", async () => {
    const net = fakeNetFactory({ status: 200, body: PROJECTS })();
    const storage = await mount(net);
    await click(button("Use a different port"));
    const input = inputLabelled(/new port/i)!;
    expect(input).toBeDefined();
    expect(document.activeElement).toBe(input);
    await type(input, String(NEW));
    await submit(input.form!);
    await settle();
    const checks = net.calls.slice(1);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.url).toBe(`http://127.0.0.1:${NEW}/projects`);
    expect(new Headers(checks[0]!.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(storage.data.pairing).toEqual({ port: NEW, token: TOKEN, pairedAt: "2026-11-01T10:00:00.000Z" });
    expect(status()).toMatch(/connected again/i);
    expect(status()).toContain(String(NEW));
    expect(host.textContent).toContain(`port ${NEW}`);
    expect(host.textContent).toContain("Estuary");
    expect(inputLabelled(/new port/i)).toBeUndefined();
    expect(button("Use a different port")).toBeUndefined();
    expect(alerts().join(" ")).not.toMatch(/not answering/);
    // Focus is not lost to the page body: it lands on the line that says which port is used now.
    expect(document.activeElement?.textContent).toContain(`port ${NEW}`);
  });

  it("a failed check keeps the old port and says why in plain words; focus stays in the field", async () => {
    const net = appClosed();
    const storage = await mount(net);
    await click(button("Use a different port"));
    const input = inputLabelled(/new port/i)!;
    await type(input, String(NEW));
    await submit(input.form!);
    await settle();
    expect(storage.data.pairing).toMatchObject({ port: OLD, token: TOKEN });
    const err = alerts().find((a) => a.includes(`port ${NEW}`));
    expect(err).toMatch(new RegExp(`keeps port ${OLD}`));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby");
    expect(described && document.getElementById(described)?.textContent).toBe(err);
    expect(document.activeElement).toBe(input);
    expect(button("Use a different port")).toBeDefined();
  });

  it("connected again while no library is open: says so once, without also saying no project allows capture (review M2)", async () => {
    const net = fakeNetFactory({ status: 503, body: { error: { code: "LIBRARY_OFFLINE", message: "No library is open." } } })();
    const storage = await mount(net);
    await click(button("Use a different port"));
    const input = inputLabelled(/new port/i)!;
    await type(input, String(NEW));
    await submit(input.form!);
    await settle();
    expect(storage.data.pairing).toMatchObject({ port: NEW });
    expect(status()).toMatch(/connected again/i);
    expect(host.textContent).toMatch(/no library is open/i);
    expect(host.textContent).not.toMatch(/No project allows browser capture/);
  });

  it("a refused token on the new port keeps the pairing (it may be another program)", async () => {
    const net = fakeNetFactory({ status: 401, body: { error: { code: "UNAUTHORIZED", message: "A valid token is needed." } } })();
    const storage = await mount(net);
    await click(button("Use a different port"));
    const input = inputLabelled(/new port/i)!;
    await type(input, String(NEW));
    await submit(input.form!);
    await settle();
    expect(storage.data.pairing).toMatchObject({ port: OLD, token: TOKEN });
    expect(alerts().join(" ")).toMatch(/did not accept/i);
  });

  it("a bad port is refused before anything is asked", async () => {
    const net = appClosed();
    await mount(net);
    await click(button("Use a different port"));
    const input = inputLabelled(/new port/i)!;
    await type(input, "99999");
    await submit(input.form!);
    await settle();
    expect(net.calls).toHaveLength(1);
    expect(alerts().join(" ")).toMatch(/between 1 and 65535/);
  });

  it("a second submit while the check runs sends no second request", async () => {
    const net = fakeNetFactory({ status: 200, body: PROJECTS })();
    await mount(net);
    await click(button("Use a different port"));
    const input = inputLabelled(/new port/i)!;
    await type(input, String(NEW));
    const release = net.hold();
    await submit(input.form!);
    await submit(input.form!);
    await click(button("Check and save"));
    expect(net.calls.slice(1)).toHaveLength(1);
    release();
    await settle();
    expect(net.calls.slice(1)).toHaveLength(1);
    expect(status()).toMatch(/connected again/i);
  });

  it("Cancel (or Escape) closes the field and returns focus to “Use a different port”; a check under way is dropped and saves nothing", async () => {
    const net = fakeNetFactory({ status: 200, body: PROJECTS })();
    const storage = await mount(net);
    await click(button("Use a different port"));
    let input = inputLabelled(/new port/i)!;
    await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(inputLabelled(/new port/i)).toBeUndefined();
    expect(document.activeElement).toBe(button("Use a different port"));

    await click(button("Use a different port"));
    input = inputLabelled(/new port/i)!;
    await type(input, String(NEW));
    const release = net.hold();
    await submit(input.form!);
    await click(button("Cancel"));
    expect(document.activeElement).toBe(button("Use a different port"));
    release();
    await settle();
    expect(storage.data.pairing).toMatchObject({ port: OLD });
    expect(status()).not.toMatch(/connected again/i);
    expect(button("Use a different port")).toBeDefined();
  });

  it("an answer that arrives after the popup closed changes nothing", async () => {
    const net = fakeNetFactory({ status: 200, body: PROJECTS })();
    const storage = await mount(net);
    await click(button("Use a different port"));
    const input = inputLabelled(/new port/i)!;
    await type(input, String(NEW));
    const release = net.hold();
    await submit(input.form!);
    act(() => root!.unmount());
    root = undefined;
    release();
    await settle();
    expect(storage.data.pairing).toMatchObject({ port: OLD });
  });
});

// Task 65: where the pairing screen is found.
const unpaired: PopupBridge = {
  api: { getPairing: async () => null } as unknown as PopupBridge["api"],
  prefs: memoryStorage(),
  activeTabId: async () => undefined,
  send: async () => undefined as never,
  pendingLinks: async () => ({}),
  copy: async () => undefined,
};

describe("the popup before pairing", () => {
  it("sends the researcher to the place the desktop app really has: “Browser extension” at the top of the library window", async () => {
    root = createRoot(host);
    await act(async () => root!.render(<Popup bridge={unpaired} />));
    expect(host.querySelector("h1")?.textContent).toBe("Pair with the desktop app");
    const hint = host.querySelector(".hint")?.textContent ?? "";
    // The link's exact text in the library header (packages/ui/src/screens/Library.tsx) and the
    // pairing page's button (packages/ui/src/screens/ExtensionPairing.tsx).
    expect(hint).toContain("“Browser extension”");
    expect(hint).toContain("“Show a pairing code”");
    expect(hint).toMatch(/port number and a 6-digit code/);
    expect(hint).not.toMatch(/Settings/);
  });
});

// Task 71, defect D18 (R189): the popup remembers the last choice for "Also download media with the
// downloader" in storage.local, per browser profile; the project's rules still decide.
describe("the popup remembers the downloader choice (R189, D18)", () => {
  const BOTH = { projects: [...PROJECTS.projects, { id: "p2", name: "Pages only", captureMethods: ["browser_capture"] }] };
  const answers = (body: unknown = PROJECTS) => fakeNet((port) => (port === OLD ? { status: 200, body } : null));
  const box = () => inputLabelled(/also download media with the downloader/i);
  const captures = (sent: BackgroundRequest[]) => sent.filter((m) => m.type === "capture-page");
  async function reopen(storage: ReturnType<typeof memoryStorage>, sent: BackgroundRequest[] = []) {
    act(() => root?.unmount());
    root = undefined;
    host.replaceChildren();
    await mount(answers(), storage, { sent });
  }
  async function choose(projectId: string) {
    const select = host.querySelector("select")!;
    await act(async () => {
      select.value = projectId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("is ticked with nothing stored, and a capture then asks for the downloader", async () => {
    const sent: BackgroundRequest[] = [];
    const storage = await mount(answers(), memoryStorage(), { sent });
    expect(box()!.checked).toBe(true);
    expect(box()!.disabled).toBe(false);
    await click(button("Capture this page"));
    expect(captures(sent)).toEqual([{ type: "capture-page", tabId: 7, projectId: "p1", alsoDownload: true }]);
    // Opening the popup stores nothing; only the researcher's own change does.
    expect(storage.data).not.toHaveProperty("alsoDownload");
  });

  it("an untick is stored in storage.local and shown at the next open; the capture sends what is shown", async () => {
    const storage = await mount(answers());
    await click(box());
    expect(box()!.checked).toBe(false);
    expect(storage.data.alsoDownload).toBe(false);
    const sent: BackgroundRequest[] = [];
    await reopen(storage, sent);
    expect(box()!.checked).toBe(false);
    await click(button("Capture this page"));
    expect(captures(sent)).toEqual([{ type: "capture-page", tabId: 7, projectId: "p1", alsoDownload: false }]);
    // The token is where it was: the choice sits beside it, under its own key.
    expect(storage.data.pairing).toMatchObject({ port: OLD, token: TOKEN });
  });

  it("a tick is stored likewise and shown at the next open", async () => {
    const storage = memoryStorage();
    storage.data.alsoDownload = false;
    await mount(answers(), storage);
    expect(box()!.checked).toBe(false);
    await click(box());
    expect(storage.data.alsoDownload).toBe(true);
    const sent: BackgroundRequest[] = [];
    await reopen(storage, sent);
    expect(box()!.checked).toBe(true);
    await click(button("Capture this page"));
    expect(captures(sent)).toEqual([{ type: "capture-page", tabId: 7, projectId: "p1", alsoDownload: true }]);
  });

  it("a project whose rules do not allow the downloader offers no choice and sends no downloader request, whatever is stored", async () => {
    const storage = memoryStorage();
    storage.data.alsoDownload = true;
    const sent: BackgroundRequest[] = [];
    await mount(answers(BOTH), storage, { sent });
    await choose("p2");
    expect(box()!.checked).toBe(false);
    expect(box()!.disabled).toBe(true);
    expect(host.textContent).toContain("This project's rules do not allow the downloader");
    await click(button("Capture this page"));
    expect(captures(sent)).toEqual([{ type: "capture-page", tabId: 7, projectId: "p2", alsoDownload: false }]);
    // Nothing the project's rules settle is written back as the researcher's choice.
    expect(storage.data.alsoDownload).toBe(true);
    // Back on the project that allows it, the stored choice is shown again.
    await choose("p1");
    expect(box()!.checked).toBe(true);
  });

  it("a project that does not allow the downloader still sends none when “unticked” is stored", async () => {
    const storage = memoryStorage();
    storage.data.alsoDownload = false;
    const sent: BackgroundRequest[] = [];
    await mount(answers(BOTH), storage, { sent });
    await choose("p2");
    expect(box()!.disabled).toBe(true);
    await click(button("Capture this page"));
    expect(captures(sent)).toEqual([{ type: "capture-page", tabId: 7, projectId: "p2", alsoDownload: false }]);
    expect(storage.data.alsoDownload).toBe(false);
  });

  it.each([["false"], ["true"], [0], [1], [null], [{}], [[false]]])("an odd stored value (%j) falls back to ticked", async (odd) => {
    const storage = memoryStorage();
    storage.data.alsoDownload = odd;
    await mount(answers(), storage);
    expect(box()!.checked).toBe(true);
  });

  it("a storage read that fails falls back to ticked and breaks nothing", async () => {
    const storage = memoryStorage();
    const prefs = { ...storage, get: async () => Promise.reject(new Error("storage is unavailable")) };
    const sent: BackgroundRequest[] = [];
    await mount(answers(), storage, { sent, prefs });
    expect(host.textContent).toContain("Estuary");
    expect(box()!.checked).toBe(true);
    expect(status()).toBe("");
    await click(button("Capture this page"));
    expect(captures(sent)).toEqual([{ type: "capture-page", tabId: 7, projectId: "p1", alsoDownload: true }]);
  });

  it("a read that throws before it returns a promise also falls back to ticked", async () => {
    const storage = memoryStorage();
    const prefs = {
      ...storage,
      get: () => {
        throw new Error("no storage here");
      },
    };
    await mount(answers(), storage, { prefs });
    expect(host.textContent).toContain("Estuary");
    expect(box()!.checked).toBe(true);
  });

  it("a storage write that fails still changes the box for this time, and says nothing alarming", async () => {
    const storage = memoryStorage();
    const prefs = { ...storage, set: async () => Promise.reject(new Error("quota")) };
    const sent: BackgroundRequest[] = [];
    await mount(answers(), storage, { sent, prefs });
    await click(box());
    await settle();
    expect(box()!.checked).toBe(false);
    expect(status()).toBe("");
    await click(button("Capture this page"));
    expect(captures(sent)).toEqual([{ type: "capture-page", tabId: 7, projectId: "p1", alsoDownload: false }]);
  });

  it("a stored value read late does not undo a change the researcher already made", async () => {
    const storage = memoryStorage();
    storage.data.alsoDownload = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const prefs = { ...storage, get: async (key: string) => (await gate, storage.get(key)) };
    await mount(answers(), storage, { prefs });
    await click(box());
    expect(box()!.checked).toBe(false);
    release();
    await settle();
    expect(box()!.checked).toBe(false);
    expect(storage.data.alsoDownload).toBe(false);
  });
});

// Find and acquire, the browser's fallback (R348 i): the popup asks the background for the works waiting for a PDF
// from this browser; when one waits, its FIRST section offers "Send this tab's PDF". Nothing waiting (or the list not
// readable): the popup is exactly as before.
describe("Find and acquire: a work waiting for a PDF from this browser (R348 i)", () => {
  const TICKET = "0123456789abcdef0123456789abcdef";
  const T2 = "fedcba9876543210fedcba9876543210";
  const LABEL = "Quillbrook Ledger of Habits";
  const HELD_SENTENCE = "Sent. The file waits for your check in the app's review queue.";

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((a, b) => {
      resolve = a;
      reject = b;
    });
    return { promise, resolve, reject };
  }

  /** A stand-in for the background's answers to the popup's find-* messages. */
  /** A kept result as the background saves it (R357 a): the sentence, the time, the ticket's hash. */
  const keptFor = async (ticket: string, sentence: string, at = Date.now()): Promise<FindResult> => ({ sentence, at, work: await ticketHash(ticket) });

  function fakeBackground(init: { waiting?: Array<{ ticket: string; label: string }>; read?: unknown; status?: string | null; result?: unknown } = {}) {
    const bg = {
      waiting: init.waiting ?? [],
      read: init.read,
      status: init.status ?? null,
      result: (init.result ?? null) as unknown,
      sent: [] as BackgroundRequest[],
      replies: [] as Array<ReturnType<typeof deferred<unknown>>>,
      /** When set, the list's answer waits for it. */
      waitingGate: undefined as Promise<void> | undefined,
      waitingReads: 0,
      resultTakes: 0,
      forgets: 0,
    };
    const send = async <T,>(msg: BackgroundRequest): Promise<T> => {
      bg.sent.push(msg);
      switch (msg.type) {
        case "find-waiting":
          bg.waitingReads++;
          if (bg.waitingGate) await bg.waitingGate;
          if (bg.read instanceof Error) throw bg.read;
          return (bg.read ?? { waiting: bg.waiting }) as T;
        case "find-status":
          return { sending: bg.status } as T;
        // As the background's store (find.ts createResultStore): looked at, not taken; removed only when the same one.
        case "find-result":
          bg.resultTakes++;
          return bg.result as T;
        case "find-result-forget": {
          bg.forgets++;
          const r = bg.result as { work?: string; at?: number } | null;
          if (r && r.work === msg.work && r.at === msg.at) bg.result = null;
          return true as T;
        }
        case "find-send": {
          const d = deferred<unknown>();
          bg.replies.push(d);
          return d.promise as Promise<T>;
        }
        default:
          return { active: false, count: 0 } as T;
      }
    };
    return { bg, send };
  }

  async function mountWith(send: PopupBridge["send"], o: { tab?: number | undefined } = {}) {
    const net = fakeNet((port) => (port === OLD ? { status: 200, body: PROJECTS } : null));
    const storage = memoryStorage();
    storage.data.pairing = { port: OLD, token: TOKEN, pairedAt: "2026-11-01T10:00:00.000Z" };
    const bridge: PopupBridge = {
      api: createApi({ fetch: net.fn, storage }),
      prefs: storage,
      activeTabId: async () => ("tab" in o ? o.tab : 7),
      send,
      pendingLinks: async () => ({}),
      copy: async () => {},
    };
    root = createRoot(host);
    await act(async () => root!.render(<Popup bridge={bridge} />));
    await settle();
    return net;
  }
  async function remount(send: PopupBridge["send"]) {
    act(() => root?.unmount());
    root = undefined;
    host.replaceChildren();
    await mountWith(send);
  }
  /** The popup as it was before this task: a background that knows no find-* message. */
  async function baseline(): Promise<string> {
    await mountWith(async <T,>() => ({ active: false, count: 0 }) as T);
    const html = host.innerHTML;
    act(() => root?.unmount());
    root = undefined;
    host.replaceChildren();
    return html;
  }
  const section = () => host.querySelector("main")?.firstElementChild as HTMLElement | null;
  const live = () => section()?.querySelector('[aria-live="polite"]')?.textContent ?? "";
  const findSends = (sent: BackgroundRequest[]) => sent.filter((m) => m.type === "find-send");

  it("nothing waiting: the popup is exactly as before, and the list is asked of the background, not fetched by the popup", async () => {
    const before = await baseline();
    const { bg, send } = fakeBackground();
    const net = await mountWith(send);
    expect(host.innerHTML).toBe(before);
    expect(host.textContent).not.toContain("Find and acquire");
    expect(bg.waitingReads).toBe(1);
    expect(net.calls.map((c) => c.url)).toEqual([`http://127.0.0.1:${OLD}/projects`]);
  });

  it.each([
    ["the app not answering", { waiting: [], unreachable: unreachable(OLD) }],
    ["the list not readable", { waiting: [], failed: true }],
    ["an answer of another shape", { waiting: "yes" }],
    ["the background failing", new Error("Could not establish connection. Receiving end does not exist.")],
  ])("%s: the popup is exactly as before; the list's failure is not shown as an error of its own", async (_what, read) => {
    const before = await baseline();
    const { send } = fakeBackground({ read });
    await mountWith(send);
    expect(host.innerHTML).toBe(before);
  });

  it("a waiting work: the FIRST section is “Find and acquire”, with “Waiting for a PDF: <label>” and the button", async () => {
    const { send } = fakeBackground({ waiting: [{ ticket: TICKET, label: LABEL }] });
    await mountWith(send);
    const s = section()!;
    expect(s.tagName).toBe("SECTION");
    expect(s.querySelector("h2")?.textContent).toBe("Find and acquire");
    expect(s.getAttribute("aria-labelledby")).toBe(s.querySelector("h2")?.id);
    expect(s.textContent).toContain(`Waiting for a PDF: ${LABEL}`);
    const b = button("Send this tab's PDF");
    expect(b?.textContent).toBe("Send this tab's PDF");
    expect(b?.disabled).toBe(false);
    expect(s.contains(b!)).toBe(true);
    // The rest of the popup is still there, after it.
    expect(host.textContent).toContain("Estuary");
  });

  it("the label is TEXT: markup is not made into elements, a right-to-left override stays inside it, 200 characters are shown whole", async () => {
    const label = `<img src=x onerror="alert(1)"><b>bold</b>‮evil.pdf ${"ॐ".repeat(160)}`.slice(0, 200);
    const { send } = fakeBackground({ waiting: [{ ticket: TICKET, label }] });
    await mountWith(send);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("b")).toBeNull();
    const bdi = section()!.querySelector("bdi");
    expect(bdi?.textContent).toBe(label);
    expect(bdi?.childNodes).toHaveLength(1);
    expect(bdi?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    // The override cannot reach past the label: the button's name is its own.
    expect(button("Send this tab's PDF")).toBeDefined();
  });

  it("a press: the button busy, a second press ignored; “held”: the service's sentence once, in a polite live region, and no button", async () => {
    const { bg, send } = fakeBackground({ waiting: [{ ticket: TICKET, label: LABEL }] });
    await mountWith(send);
    const b = button("Send this tab's PDF")!;
    await act(async () => {
      b.click();
      b.click();
    });
    await settle();
    expect(findSends(bg.sent)).toEqual([{ type: "find-send", tabId: 7, ticket: TICKET }]);
    const busy = section()!.querySelector("button")!;
    expect(busy.textContent).toBe("Sending the PDF…");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.disabled).toBe(true);
    await click(busy);
    expect(findSends(bg.sent)).toHaveLength(1);
    // The service held it: the work no longer waits; the background kept the result for a next opening.
    bg.waiting = [];
    bg.result = await keptFor(TICKET, HELD_SENTENCE);
    await act(async () => bg.replies[0]!.resolve({ sentence: HELD_SENTENCE }));
    await settle();
    expect(live()).toBe(HELD_SENTENCE);
    expect(section()!.querySelector("h2")?.textContent).toBe("Find and acquire");
    expect(section()!.querySelector("button")).toBeNull();
    expect(host.textContent!.split(HELD_SENTENCE)).toHaveLength(2);
    // The result kept for a next opening was removed: it will not be said again.
    expect(bg.result).toBeNull();
    expect(host.textContent).not.toMatch(/\badded\b/i);
  });

  it("a refusal that leaves the work waiting: the service's sentence, and the button usable again", async () => {
    const refusal = "The PDF did not arrive whole. The work is still waiting. Try again.";
    const { bg, send } = fakeBackground({ waiting: [{ ticket: TICKET, label: LABEL }] });
    await mountWith(send);
    await click(button("Send this tab's PDF"));
    await act(async () => bg.replies[0]!.resolve({ sentence: refusal }));
    await settle();
    expect(live()).toBe(refusal);
    const again = button("Send this tab's PDF");
    expect(again?.disabled).toBe(false);
    await click(again);
    expect(findSends(bg.sent)).toHaveLength(2);
  });

  it("several waiting: one line and one button each, each button named with its label, each sending its own ticket", async () => {
    const { bg, send } = fakeBackground({ waiting: [{ ticket: TICKET, label: LABEL }, { ticket: T2, label: "Second work" }] });
    await mountWith(send);
    expect(section()!.textContent).toContain(`Waiting for a PDF: ${LABEL}`);
    expect(section()!.textContent).toContain("Waiting for a PDF: Second work");
    const first = button(`Send this tab's PDF for “${LABEL}”`);
    const second = button("Send this tab's PDF for “Second work”");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    await click(second);
    expect(findSends(bg.sent)).toEqual([{ type: "find-send", tabId: 7, ticket: T2 }]);
  });

  it.each([
    ["still waiting", [{ ticket: TICKET, label: LABEL }], undefined, "The PDF could not be sent. The work is still waiting — try again."],
    ["no longer waiting", [], undefined, "The app's answer did not arrive, and the work is no longer waiting for a PDF from this browser. The app shows what became of it."],
    ["the app not answering", [], { waiting: [], unreachable: unreachable(OLD) }, unreachable(OLD)],
    // R357 c: the list not read, or not understood — unknown, never "no longer waiting".
    ["the list not read (the background's ask throws)", [], new Error("Could not establish connection. Receiving end does not exist."), "The app's answer did not arrive, and whether the work is still waiting could not be read. Open this popup again to see."],
    ["the list not understood", [], { waiting: "yes" }, "The app's answer did not arrive, and whether the work is still waiting could not be read. Open this popup again to see."],
    ["the background's read failed", [], { waiting: [], failed: true }, "The app's answer did not arrive, and whether the work is still waiting could not be read. Open this popup again to see."],
  ])("the background did not answer (stopped mid-way): the list is read again and the popup claims no result — %s", async (_what, after, read, sentence) => {
    const { bg, send } = fakeBackground({ waiting: [{ ticket: TICKET, label: LABEL }] });
    await mountWith(send);
    await click(button("Send this tab's PDF"));
    bg.waiting = after;
    if (read) bg.read = read;
    await act(async () => bg.replies[0]!.reject(new Error("The message port closed before a response was received.")));
    await settle();
    expect(live()).toBe(sentence);
  });

  it("the popup closed meanwhile, nothing waits now: the result is shown at the next opening in the section without a button, once", async () => {
    const { bg, send } = fakeBackground({ result: await keptFor(TICKET, HELD_SENTENCE) });
    await mountWith(send);
    expect(section()!.querySelector("h2")?.textContent).toBe("Find and acquire");
    expect(live()).toBe(HELD_SENTENCE);
    expect(section()!.querySelector("button")).toBeNull();
    expect(bg.result).toBeNull();
    // A mere opening does not move the focus (R357 d).
    expect(document.activeElement).toBe(document.body);
    await remount(send);
    expect(host.textContent).not.toContain(HELD_SENTENCE);
    expect(host.textContent).not.toContain("Find and acquire");
  });

  it("the kept result of the work that still waits: shown in that work's section, with its line and button, once (R357 a)", async () => {
    const refusal = "The PDF did not arrive whole. The work is still waiting. Try again.";
    const { bg, send } = fakeBackground({ waiting: [{ ticket: TICKET, label: LABEL }], result: await keptFor(TICKET, refusal) });
    await mountWith(send);
    expect(section()!.textContent).toContain(`Waiting for a PDF: ${LABEL}`);
    expect(live()).toBe(refusal);
    expect(button("Send this tab's PDF")?.disabled).toBe(false);
    expect(bg.result).toBeNull();
  });

  it("the kept result of ANOTHER work while a different work waits: dropped unseen — shown nowhere, removed (R357 a)", async () => {
    const { bg, send } = fakeBackground({ waiting: [{ ticket: T2, label: "Second work" }], result: await keptFor(TICKET, HELD_SENTENCE) });
    await mountWith(send);
    expect(section()!.textContent).toContain("Waiting for a PDF: Second work");
    expect(host.textContent).not.toContain(HELD_SENTENCE);
    expect(live()).toBe("");
    expect(bg.result).toBeNull();
    await remount(send);
    expect(host.textContent).not.toContain(HELD_SENTENCE);
  });

  it("a kept result of the old shape (no hash) is not shown (the background drops it, find.test.ts)", async () => {
    const { send } = fakeBackground({ waiting: [], result: { sentence: HELD_SENTENCE, at: Date.now() } });
    await mountWith(send);
    expect(host.textContent).not.toContain(HELD_SENTENCE);
    expect(host.textContent).not.toContain("Find and acquire");
  });

  it("an opening that ends before the list's answer takes nothing: the result is there for the next opening (R357 b)", async () => {
    const { bg, send } = fakeBackground({ result: await keptFor(TICKET, HELD_SENTENCE) });
    let release!: () => void;
    bg.waitingGate = new Promise<void>((r) => (release = r));
    await mountWith(send);
    expect(bg.resultTakes).toBe(1);
    // The popup closes before the list's answer.
    act(() => root?.unmount());
    root = undefined;
    host.replaceChildren();
    release();
    bg.waitingGate = undefined;
    await settle();
    expect(bg.forgets).toBe(0);
    expect(bg.result).not.toBeNull();
    // The next opening shows it.
    await mountWith(send);
    expect(live()).toBe(HELD_SENTENCE);
    expect(bg.result).toBeNull();
  });

  it("after a press, the focus is on the result's sentence (R357 d)", async () => {
    const { bg, send } = fakeBackground({ waiting: [{ ticket: TICKET, label: LABEL }] });
    await mountWith(send);
    const b = button("Send this tab's PDF")!;
    b.focus();
    expect(document.activeElement).toBe(b);
    await click(b);
    bg.waiting = [];
    await act(async () => bg.replies[0]!.resolve({ sentence: HELD_SENTENCE }));
    await settle();
    const said = section()!.querySelector(".find-said") as HTMLElement;
    expect(said.textContent).toBe(HELD_SENTENCE);
    expect(said.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(said);
  });

  it("after a refusal that leaves the work waiting, the focus is on the sentence too; the button is usable again", async () => {
    const refusal = "The PDF did not arrive whole. The work is still waiting. Try again.";
    const { bg, send } = fakeBackground({ waiting: [{ ticket: TICKET, label: LABEL }] });
    await mountWith(send);
    await click(button("Send this tab's PDF"));
    await act(async () => bg.replies[0]!.resolve({ sentence: refusal }));
    await settle();
    expect(document.activeElement).toBe(section()!.querySelector(".find-said"));
    expect(button("Send this tab's PDF")?.disabled).toBe(false);
  });

  it("opened while a sending runs: its button is busy until it ends, then its result is shown", async () => {
    const { bg, send } = fakeBackground({ waiting: [{ ticket: TICKET, label: LABEL }], status: TICKET });
    await mountWith(send);
    const busy = section()!.querySelector("button")!;
    expect(busy.textContent).toBe("Sending the PDF…");
    expect(busy.disabled).toBe(true);
    expect(bg.resultTakes).toBe(0);
    bg.status = null;
    bg.waiting = [];
    bg.result = await keptFor(TICKET, HELD_SENTENCE);
    await act(async () => void (await new Promise((r) => setTimeout(r, 1300))));
    await settle();
    expect(live()).toBe(HELD_SENTENCE);
    expect(section()!.querySelector("button")).toBeNull();
    expect(bg.result).toBeNull();
  });

  it("no active tab known: the button cannot be pressed", async () => {
    const { send } = fakeBackground({ waiting: [{ ticket: TICKET, label: LABEL }] });
    await mountWith(send, { tab: undefined });
    expect(button("Send this tab's PDF")?.disabled).toBe(true);
  });
});
