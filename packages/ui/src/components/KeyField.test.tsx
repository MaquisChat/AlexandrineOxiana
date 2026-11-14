/**
 * The key field (Find and acquire Task F13; R78, R290 a, R302 e): the Zotero key field generalised. A key typed into it
 * is handed to `store` once and is then nowhere: not in the field, not in any element's text or attribute, not in
 * storage, not in a console call. The Zotero field is a thin wrapper of it (its own tests are unchanged).
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../api/client";
import { KeyField } from "./KeyField";

const KEY = "kf-RECOGNISABLE-key-7Qp2Lm9X";

/** Every attribute and text of the page, joined. */
function everything(): string {
  const parts: string[] = [document.documentElement.outerHTML];
  for (const el of document.querySelectorAll<HTMLElement>("*")) {
    for (const a of el.getAttributeNames()) parts.push(el.getAttribute(a) ?? "");
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) parts.push(el.value, el.defaultValue);
  }
  return parts.join("\n");
}

let consoleCalls: unknown[][] = [];
beforeEach(() => {
  consoleCalls = [];
  for (const k of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void consoleCalls.push(a));
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

function api(opts: { stored?: boolean; refuse?: Error } = {}) {
  let stored = opts.stored ?? false;
  return {
    stored: vi.fn(async () => stored),
    store: vi.fn(async (_v: string) => {
      if (opts.refuse) throw opts.refuse;
      stored = true;
    }),
    remove: vi.fn(async () => {
      stored = false;
    }),
  };
}

const WORDS = {
  storedYes: "An Example key is saved on this computer.",
  storedNo: "No Example key is saved on this computer.",
  store: "Store the Example key",
  replace: "Replace the Example key",
  remove: "Remove the Example key",
};

describe("KeyField", () => {
  it("the key is never shown after saving: the field is empty, and the key is in no element, attribute, storage or console call", async () => {
    const a = api();
    const onChanged = vi.fn();
    const user = userEvent.setup();
    render(<KeyField label="Example API key" help="Kept only in this computer's password store." stored={a.stored} store={a.store} remove={a.remove} words={WORDS} onChanged={onChanged} />);
    await screen.findByText(WORDS.storedNo);
    const field = screen.getByLabelText("Example API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    await user.type(field, KEY);
    await user.click(screen.getByRole("button", { name: WORDS.store }));
    await screen.findByText(WORDS.storedYes);
    expect(a.store).toHaveBeenCalledTimes(1);
    expect(a.store).toHaveBeenCalledWith(KEY);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onChanged.mock.calls[0]).toEqual([]);
    expect(field.value).toBe("");
    expect(everything()).not.toContain(KEY);
    expect(JSON.stringify(consoleCalls)).not.toContain(KEY);
    expect(JSON.stringify({ ...localStorage })).not.toContain(KEY);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(KEY);
    // What is said afterwards: only that a key is saved.
    expect(screen.getByRole("button", { name: WORDS.replace })).toBeTruthy();
  });

  it("a key of the wrong shape is refused with the shape's sentence and nothing is sent", async () => {
    const a = api();
    const user = userEvent.setup();
    render(<KeyField label="Example API key" help="h" stored={a.stored} store={a.store} remove={a.remove} words={WORDS} shape={(v) => (v.length >= 8 ? null : "Too short to be a key.")} />);
    await screen.findByText(WORDS.storedNo);
    await user.type(screen.getByLabelText("Example API key"), "short");
    await user.click(screen.getByRole("button", { name: WORDS.store }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too short to be a key.");
    expect(a.store).not.toHaveBeenCalled();
  });

  it("the key leaves the field when it is sent, even when the service refuses it; the refusal is the service's sentence", async () => {
    const a = api({ refuse: new ApiClientError(503, { code: "UNAVAILABLE", message: "No secure key store is available on this computer." }) });
    const user = userEvent.setup();
    render(<KeyField label="Example API key" help="h" stored={a.stored} store={a.store} remove={a.remove} words={WORDS} />);
    await screen.findByText(WORDS.storedNo);
    await user.type(screen.getByLabelText("Example API key"), KEY);
    await user.click(screen.getByRole("button", { name: WORDS.store }));
    expect((await screen.findByRole("alert")).textContent).toBe("No secure key store is available on this computer.");
    expect((screen.getByLabelText("Example API key") as HTMLInputElement).value).toBe("");
    expect(everything()).not.toContain(KEY);
  });

  it("R314 b: while a key is typed, and after a shape refusal, no attribute of any element holds it; after storing the field is empty", async () => {
    const a = api();
    const user = userEvent.setup();
    render(<KeyField label="Example API key" help="h" stored={a.stored} store={a.store} remove={a.remove} words={WORDS} shape={(v) => (v.endsWith("!") ? "Not a key." : null)} />);
    await screen.findByText(WORDS.storedNo);
    const field = screen.getByLabelText("Example API key") as HTMLInputElement;
    await user.type(field, `${KEY}!`);
    expect(field.value).toBe(`${KEY}!`);
    expect(document.documentElement.outerHTML).not.toContain(KEY);
    await user.click(screen.getByRole("button", { name: WORDS.store }));
    expect((await screen.findByRole("alert")).textContent).toBe("Not a key.");
    expect(field.value).toBe(`${KEY}!`);
    expect(document.documentElement.outerHTML).not.toContain(KEY);
    expect(a.store).not.toHaveBeenCalled();
    await user.clear(field);
    await user.type(field, `${KEY}{Enter}`);
    await screen.findByText(WORDS.storedYes);
    expect(a.store).toHaveBeenCalledWith(KEY);
    expect(field.value).toBe("");
    expect(everything()).not.toContain(KEY);
  });

  it("Remove asks nothing more and removes once", async () => {
    const a = api({ stored: true });
    const user = userEvent.setup();
    render(<KeyField label="Example API key" help="h" stored={a.stored} store={a.store} remove={a.remove} words={WORDS} />);
    await screen.findByText(WORDS.storedYes);
    await user.dblClick(screen.getByRole("button", { name: WORDS.remove }));
    await screen.findByText(WORDS.storedNo);
    expect(a.remove).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("with no password store, says the service's sentence (503)", async () => {
    const stored = vi.fn(async () => {
      throw new ApiClientError(503, { code: "UNAVAILABLE", message: "No secure key store is available on this computer." });
    });
    render(<KeyField label="Example API key" help="h" stored={stored} store={vi.fn()} remove={vi.fn()} words={WORDS} />);
    expect((await screen.findByRole("alert")).textContent).toBe("No secure key store is available on this computer.");
  });
});
