/**
 * The popup when the desktop app does not answer on the saved port (R171, defect D13): it names the
 * two possible causes and offers "Use a different port" beside "Unpair"; the new port is checked by
 * one authorised request before it is saved, and the old one is kept if the check fails. No scanning
 * (R110). Rendered with react-dom in jsdom (no testing library in this package).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApi, type LocalStorageArea } from "../api.js";
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

async function mount(net: ReturnType<typeof fakeNet>, storage = memoryStorage()) {
  if (!("pairing" in storage.data)) storage.data.pairing = { port: OLD, token: TOKEN, pairedAt: "2026-11-01T10:00:00.000Z" };
  const bridge: PopupBridge = {
    api: createApi({ fetch: net.fn, storage }),
    activeTabId: async () => 7,
    send: async <T,>() => ({ active: false, count: 0 }) as T,
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
