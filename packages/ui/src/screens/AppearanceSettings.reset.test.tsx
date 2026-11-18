/**
 * A settings file that cannot be read (Task 68, defect D16): the appearance settings and the list of
 * added fonts. The service refuses a change it cannot write over what it read (503 UNAVAILABLE,
 * reason "appearance" or "fonts"); the screen says so and offers a confirmed reset of that one file.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, type ApiClient } from "../api/client";
import { DEFAULT_APPEARANCE, type AppearanceSettings } from "../theme/appearance";
import { AppearanceProvider } from "../theme/AppearanceProvider";
import { AppearanceSettingsScreen } from "./AppearanceSettings";

const ID = "0123456789abcdef0123456789abcdef";
const ID2 = "fedcba9876543210fedcba9876543210";
const BRILL = { id: ID, name: "Brill", format: "woff2", size: 4, addedAt: "2026-11-11T10:00:00.000Z" };

const unreadable = (reason: "appearance" | "fonts") =>
  new ApiClientError(503, { code: "UNAVAILABLE", reason, message: reason === "fonts" ? "The list of added fonts could not be read, so it was not changed." : "The appearance settings could not be read, so they were not changed." });

class FakeFontFace {
  constructor(
    readonly family: string,
    readonly source: ArrayBuffer | string,
  ) {}
  async load() {
    return this;
  }
}

beforeEach(() => {
  vi.stubGlobal("FontFace", FakeFontFace);
  Object.defineProperty(document, "fonts", { configurable: true, value: { add: () => undefined, delete: () => undefined } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (document as { fonts?: unknown }).fonts;
});

/** A service double: `appearanceUnreadable` / `fontsUnreadable` until the file is reset. */
function setup(o: { appearanceUnreadable?: boolean; fontsUnreadable?: boolean; otherSaveError?: boolean; resetFails?: boolean } = {}) {
  let cur: AppearanceSettings = structuredClone(DEFAULT_APPEARANCE);
  const state = { appearanceUnreadable: !!o.appearanceUnreadable, fontsUnreadable: !!o.fontsUnreadable, list: [BRILL] as Array<typeof BRILL>, resets: [] as unknown[] };
  const put = vi.fn(async (patch: Partial<AppearanceSettings>) => {
    if (o.otherSaveError) throw new ApiClientError(500, { code: "INTERNAL", message: "Something went wrong." });
    if (state.appearanceUnreadable) throw unreadable("appearance");
    cur = { ...cur, ...patch, fonts: { ...cur.fonts, ...(patch.fonts ?? {}) } } as AppearanceSettings;
    return structuredClone(cur);
  });
  const get = vi.fn(async () => structuredClone(cur));
  const request = vi.fn(async (method: string, path: string, opts?: { body?: { path?: string; name?: string; file?: string } }) => {
    if (method === "POST" && path === "/settings/reset") {
      state.resets.push(opts?.body);
      await new Promise((r) => setTimeout(r, 20));
      if (o.resetFails) throw new ApiClientError(503, { code: "UNAVAILABLE", message: "The file could not be set aside, so nothing was reset." });
      if (opts?.body?.file === "fonts") {
        state.fontsUnreadable = false;
        state.list = [];
      }
      if (opts?.body?.file === "appearance") {
        state.appearanceUnreadable = false;
        cur = structuredClone(DEFAULT_APPEARANCE);
      }
      return { reset: true, keptAs: `${opts?.body?.file}.json.unreadable-20261112-101530` };
    }
    if (state.fontsUnreadable && path.startsWith("/settings/fonts")) throw unreadable("fonts");
    if (method === "GET" && path === "/settings/fonts") return { fonts: state.list };
    if (method === "POST" && path === "/settings/fonts") {
      const f = { ...BRILL, id: ID2, name: opts?.body?.name ?? "Junicode" };
      state.list = [...state.list, f];
      return f;
    }
    if (method === "DELETE" && path.startsWith("/settings/fonts/")) {
      state.list = state.list.filter((x) => `/settings/fonts/${x.id}` !== path);
      return { removed: true };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const bytes = vi.fn(async () => new Blob([new Uint8Array([0x77, 0x4f, 0x46, 0x32])], { type: "font/woff2" }));
  const client = { appearance: { get, put }, request, bytes } as unknown as ApiClient;
  render(
    <AppearanceProvider client={client} initial={DEFAULT_APPEARANCE}>
      <AppearanceSettingsScreen />
    </AppearanceProvider>,
  );
  return { state, put, request };
}

describe("the appearance settings cannot be read (Task 68)", () => {
  const RESET = "Reset appearance settings…";

  it("a refused change says why and offers the reset; another failure does not offer it", async () => {
    setup({ otherSaveError: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await screen.findByRole("button", { name: "Try saving again" });
    expect(screen.queryByRole("button", { name: RESET })).toBeNull();
  });

  it("the reset asks first, says what is lost and what is kept; focus goes in, stays, and comes back on cancel", async () => {
    const { state } = setup({ appearanceUnreadable: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    const btn = await screen.findByRole("button", { name: RESET });
    expect(btn.closest('[role="alert"]')!.textContent).toMatch(/could not be read/);
    await user.click(btn);
    const dialog = await screen.findByRole("dialog", { name: "Reset appearance settings?" });
    expect(dialog.textContent).toMatch(/back to the defaults/i);
    expect(dialog.textContent).toMatch(/kept, renamed/i);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: RESET }));
    expect(state.resets).toEqual([]);
  });

  it("a held or repeated Enter on the reset button opens the dialog on its heading and resets nothing; Tab then Enter resets once (R376 c)", async () => {
    const { state } = setup({ appearanceUnreadable: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    const btn = await screen.findByRole("button", { name: RESET });
    btn.focus();
    await user.keyboard("{Enter>4}{/Enter}{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Reset appearance settings?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Reset appearance settings?" }));
    expect(state.resets).toEqual([]);
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Reset appearance" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(state.resets).toEqual([{ file: "appearance", confirm: true }]));
  });

  it("confirmed: one reset, then the change that was refused is saved; the notice goes and focus lands on the heading", async () => {
    const { state, put } = setup({ appearanceUnreadable: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await user.click(await screen.findByRole("button", { name: RESET }));
    const dialog = await screen.findByRole("dialog");
    await user.dblClick(within(dialog).getByRole("button", { name: "Reset appearance" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.resets).toEqual([{ file: "appearance", confirm: true }]);
    await waitFor(() => expect(put).toHaveBeenLastCalledWith({ theme: "dark" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: RESET })).toBeNull());
    expect(screen.queryByRole("button", { name: "Try saving again" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Appearance" }));
  });

  it("a reset that fails says why inside the dialog", async () => {
    setup({ appearanceUnreadable: true, resetFails: true });
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await user.click(await screen.findByRole("button", { name: RESET }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Reset appearance" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/could not be set aside/);
  });
});

describe("the list of added fonts cannot be read (Task 68)", () => {
  const RESET = "Reset the list of added fonts…";
  const region = () => screen.findByRole("region", { name: "Your own font files" });

  it("nothing is offered while the list can be read", async () => {
    setup();
    await within(await region()).findByText("Brill");
    expect(screen.queryByRole("button", { name: RESET })).toBeNull();
  });

  it("an unreadable list is said in plain words with the reset", async () => {
    setup({ fontsUnreadable: true });
    const r = await region();
    const btn = await within(r).findByRole("button", { name: RESET });
    expect(btn.closest('[role="alert"]')!.textContent).toMatch(/could not be read/);
  });

  it("a remove refused because the list became unreadable offers the reset too", async () => {
    const { state } = setup();
    const user = userEvent.setup();
    const r = await region();
    await within(r).findByText("Brill");
    state.fontsUnreadable = true;
    await user.click(within(r).getByRole("button", { name: "Remove Brill" }));
    expect(await within(r).findByRole("button", { name: RESET })).toBeTruthy();
    expect(within(r).getByText("Brill")).toBeTruthy(); // nothing removed from the list shown
  });

  it("a held or repeated Enter on the list reset opens the dialog on its heading and resets nothing; Tab then Enter resets once (R376 c)", async () => {
    const { state } = setup({ fontsUnreadable: true });
    const user = userEvent.setup();
    const btn = await within(await region()).findByRole("button", { name: RESET });
    btn.focus();
    await user.keyboard("{Enter>4}{/Enter}{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Reset the list of added fonts?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Reset the list of added fonts?" }));
    expect(state.resets).toEqual([]);
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Reset the list" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(state.resets).toEqual([{ file: "fonts", confirm: true }]));
  });

  it("the reset asks first: what is lost, what happens to the kept copies; focus is managed; confirmed, the list starts empty", async () => {
    const { state } = setup({ fontsUnreadable: true });
    const user = userEvent.setup();
    const r = await region();
    const btn = await within(r).findByRole("button", { name: RESET });
    await user.click(btn);
    const dialog = await screen.findByRole("dialog", { name: "Reset the list of added fonts?" });
    expect(dialog.textContent).toMatch(/list of font files you added/i);
    expect(dialog.textContent).toMatch(/copies of those files stay/i);
    expect(dialog.textContent).toMatch(/kept, renamed/i);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(within(r).getByRole("button", { name: RESET }));

    await user.click(within(r).getByRole("button", { name: RESET }));
    await user.dblClick(within(await screen.findByRole("dialog")).getByRole("button", { name: "Reset the list" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state.resets).toEqual([{ file: "fonts", confirm: true }]);
    await waitFor(() => expect(within(r).queryByRole("button", { name: RESET })).toBeNull());
    expect(within(r).getByRole("status").textContent).toMatch(/reset.*add your font files again/i);
    expect(document.activeElement).toBe(within(r).getByRole("heading", { name: "Your own font files" }));
  });
});
