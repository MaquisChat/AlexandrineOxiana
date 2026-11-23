import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, type ApiClient } from "../api/client";
import { DEFAULT_APPEARANCE, type AppearanceSettings } from "../theme/appearance";
import { AppearanceProvider } from "../theme/AppearanceProvider";
import { ACCENT_DEBOUNCE_MS, AppearanceSettingsScreen } from "./AppearanceSettings";

/** Lets real time pass (debounce, pending saves) inside act. */
const settle = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

const root = () => document.documentElement;
const prop = (name: string) => root().style.getPropertyValue(name);

/** What today's service does: it keeps family/source/file of each font and drops `generic`. */
function withoutGeneric(s: AppearanceSettings): AppearanceSettings {
  const out = structuredClone(s);
  for (const f of Object.values(out.fonts)) delete (f as { generic?: string }).generic;
  return out;
}

function setup(initial: AppearanceSettings = DEFAULT_APPEARANCE, opts: { serviceDropsGeneric?: boolean } = {}) {
  let cur = structuredClone(initial);
  const answer = (s: AppearanceSettings) => (opts.serviceDropsGeneric ? withoutGeneric(s) : structuredClone(s));
  const put = vi.fn(async (patch: Partial<AppearanceSettings>) => {
    cur = { ...cur, ...patch, fonts: { ...cur.fonts, ...(patch.fonts ?? {}) } } as AppearanceSettings;
    if (patch.accent === null) delete cur.accent;
    return answer(cur);
  });
  const get = vi.fn(async () => answer(cur));
  const client = { appearance: { get, put } } as unknown as ApiClient;
  const utils = render(
    <AppearanceProvider client={client} initial={initial}>
      <AppearanceSettingsScreen />
    </AppearanceProvider>,
  );
  return { ...utils, put, get };
}

describe("Appearance settings screen", () => {
  it("choosing Dark sets data-theme=\"dark\" and saves it", async () => {
    const { put } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    expect(root().dataset.theme).toBe("dark");
    expect(put).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("High contrast selects the high-contrast variant of the current theme", async () => {
    setup({ ...DEFAULT_APPEARANCE, theme: "dark" });
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "High contrast" }));
    expect(root().dataset.theme).toBe("dark-hc");
  });

  it("the default interface stack starts with 'Goudy Old Style', 'Sorts Mill Goudy'", () => {
    setup();
    expect(prop("--font-interface").startsWith("'Goudy Old Style', 'Sorts Mill Goudy'")).toBe(true);
    const select = screen.getByRole("combobox", { name: "Interface typeface" }) as HTMLSelectElement;
    expect(select.selectedOptions[0]!.textContent).toMatch(/Goudy Old Style/);
  });

  it("choosing Inter changes --font-interface (and only that area)", async () => {
    const { put } = setup();
    const before = prop("--font-reading");
    await userEvent.setup().selectOptions(screen.getByRole("combobox", { name: "Interface typeface" }), "Inter");
    expect(prop("--font-interface").startsWith("Inter, sans-serif, 'Noto Sans'")).toBe(true);
    expect(prop("--font-interface").endsWith(", sans-serif")).toBe(true);
    expect(prop("--font-reading")).toBe(before);
    expect(put).toHaveBeenCalledWith({ fonts: { interface: { family: "Inter", source: "system", generic: "sans-serif" } } });
  });

  it("offers the Atkinson Hyperlegible and OpenDyslexic presets for every area", () => {
    setup();
    for (const area of ["Interface", "Reading view", "Transcripts and translations", "Notes and memos"]) {
      const select = screen.getByRole("combobox", { name: `${area} typeface` });
      expect(within(select).getByRole("option", { name: /Atkinson Hyperlegible/ })).toBeTruthy();
      expect(within(select).getByRole("option", { name: /OpenDyslexic/ })).toBeTruthy();
    }
    expect(screen.getByRole("combobox", { name: "Monospace typeface" })).toBeTruthy();
  });

  it("any installed font can be typed in", async () => {
    setup();
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Installed font for Reading view" }), "Charter");
    await user.click(screen.getByRole("button", { name: "Use installed font for Reading view" }));
    expect(prop("--font-reading").startsWith("Charter, serif, 'Noto Serif'")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a typed monospace font keeps its generic family when the service's answer drops it (R109)", async () => {
    const { put, get } = setup(DEFAULT_APPEARANCE, { serviceDropsGeneric: true });
    await waitFor(() => expect(get).toHaveBeenCalled());
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "Installed font for Monospace" }), "Fira Code");
    await user.click(screen.getByRole("button", { name: "Use installed font for Monospace" }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const answer = await put.mock.results[0]!.value;
    expect(answer.fonts.mono.generic).toBeUndefined(); // the service really dropped it
    await settle(10);
    const stack = prop("--font-mono");
    expect(stack.startsWith("'Fira Code', monospace, ")).toBe(true);
    expect(stack.endsWith(", monospace")).toBe(true);
    expect(stack).not.toMatch(/Serif|Mincho|Songti|, serif/);
  });

  it("a typed font name that cannot be used shows a message and changes nothing", async () => {
    const { put } = setup();
    const user = userEvent.setup();
    const before = prop("--font-notes");
    await user.type(screen.getByRole("textbox", { name: "Installed font for Notes and memos" }), "Evil; color: red");
    await user.click(screen.getByRole("button", { name: "Use installed font for Notes and memos" }));
    expect(screen.getByRole("alert").textContent).toMatch(/can't be used as a font name/);
    expect(prop("--font-notes")).toBe(before);
    expect(put).not.toHaveBeenCalled();
  });

  it("a custom accent that fails contrast shows the warning and is not applied", async () => {
    const { put } = setup({ ...DEFAULT_APPEARANCE, theme: "light" });
    fireEvent.change(screen.getByLabelText("Accent color"), { target: { value: "#eeeeee" } });
    expect(screen.getByRole("alert").textContent).toContain("This accent color is too low-contrast for text");
    expect(prop("--accent")).toBe("");
    expect(put).not.toHaveBeenCalled();
  });

  it("a custom accent that passes is applied and saved; Reset goes back to the theme accent", async () => {
    const { put } = setup({ ...DEFAULT_APPEARANCE, theme: "light" });
    fireEvent.change(screen.getByLabelText("Accent color"), { target: { value: "#7a1f5c" } });
    expect(screen.queryByRole("alert")).toBeNull();
    await settle(ACCENT_DEBOUNCE_MS + 50);
    expect(prop("--accent")).toBe("#7A1F5C");
    expect(put).toHaveBeenCalledWith({ accent: "#7A1F5C" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Use the theme's accent" }));
    expect(prop("--accent")).toBe("");
    expect(put).toHaveBeenLastCalledWith({ accent: null });
  });

  it("the accent picker is debounced: a drag through many colours saves only the last, 300 ms after it stops", async () => {
    expect(ACCENT_DEBOUNCE_MS).toBe(300);
    const { put } = setup({ ...DEFAULT_APPEARANCE, theme: "light" });
    const input = screen.getByLabelText("Accent color");
    for (const v of ["#7a1f5c", "#6a1f5c", "#5a1f5c", "#4a1f5c"]) fireEvent.change(input, { target: { value: v } });
    await settle(150);
    expect(put).not.toHaveBeenCalled();
    expect(prop("--accent")).toBe("");
    await settle(ACCENT_DEBOUNCE_MS);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith({ accent: "#4A1F5C" });
    expect(prop("--accent")).toBe("#4A1F5C");
  });

  it("a pending accent is saved when the screen closes before the debounce ends (R109)", async () => {
    const { put, unmount } = setup({ ...DEFAULT_APPEARANCE, theme: "light" });
    fireEvent.change(screen.getByLabelText("Accent color"), { target: { value: "#7a1f5c" } });
    expect(put).not.toHaveBeenCalled();
    unmount();
    expect(put).toHaveBeenCalledWith({ accent: "#7A1F5C" });
    await settle(ACCENT_DEBOUNCE_MS + 50);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("headings are sized in rem only (the root font size already carries the text scale)", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "AppearanceSettings.css"), "utf8");
    expect(css).not.toMatch(/--text-scale/);
  });

  it("text size, line spacing, density and reduced motion are applied to <html>", async () => {
    setup();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Text size" }), "1.25");
    expect(prop("--text-scale")).toBe("1.25");
    await user.selectOptions(screen.getByRole("combobox", { name: "Line spacing" }), "1.8");
    expect(prop("--line-spacing")).toBe("1.8");
    await user.click(screen.getByRole("radio", { name: "Compact" }));
    expect(root().dataset.density).toBe("compact");
    await user.click(screen.getByRole("radio", { name: "Reduce motion" }));
    expect(root().dataset.motion).toBe("reduce");
  });

  it("every control has an accessible name and can be reached and operated with the keyboard", async () => {
    setup();
    const controls = [...document.querySelectorAll("input, select, button")] as HTMLElement[];
    expect(controls.length).toBeGreaterThan(10);
    for (const c of controls) {
      const name = c.getAttribute("aria-label") ?? (c.id ? document.querySelector(`label[for="${c.id}"]`)?.textContent : null) ?? c.closest("label")?.textContent ?? c.textContent;
      expect(name?.trim(), c.outerHTML).toBeTruthy();
      expect(c.tabIndex, c.outerHTML).toBeGreaterThanOrEqual(0);
    }
    // Keyboard: Tab to the theme radios, arrow to Dark.
    const user = userEvent.setup();
    screen.getByRole("radio", { name: "Follow system" }).focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(root().dataset.theme).toBe("dark");
  });

  it("sample text is rendered with dir=auto", () => {
    setup();
    const samples = screen.getAllByTestId("font-sample");
    expect(samples.length).toBe(5);
    for (const s of samples) expect(s.getAttribute("dir")).toBe("auto");
  });

  it("loads the saved settings when opened", async () => {
    const { get } = setup();
    await waitFor(() => expect(get).toHaveBeenCalled());
    await act(async () => {});
  });

  it("a failed load offers to load again, not to save again, and loading again clears it (FR-155)", async () => {
    let fail = true;
    const saved = { ...DEFAULT_APPEARANCE, theme: "dark" as const };
    const get = vi.fn(async () => {
      if (fail) throw new ApiClientError(503, { code: "UNAVAILABLE", message: "The library service is not answering." });
      return structuredClone(saved);
    });
    const put = vi.fn(async () => structuredClone(saved));
    const client = { appearance: { get, put } } as unknown as ApiClient;
    render(
      <AppearanceProvider client={client}>
        <AppearanceSettingsScreen />
      </AppearanceProvider>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load your appearance settings");
    expect(within(alert).queryByRole("button", { name: "Try saving again" })).toBeNull();
    fail = false;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try loading again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(get).toHaveBeenCalledTimes(2);
    expect(put).not.toHaveBeenCalled();
    expect(root().dataset.theme).toBe("dark");
  });

  // R468 (M6): focus is not lost to the page when "Try loading again" goes away with its alert.
  it("after loading again succeeds, focus is on the screen's heading; after it fails again, it stays on the button (FR-155, R468)", async () => {
    let fail = true;
    const get = vi.fn(async () => {
      if (fail) throw new ApiClientError(503, { code: "UNAVAILABLE", message: "The library service is not answering." });
      return structuredClone({ ...DEFAULT_APPEARANCE, theme: "dark" as const });
    });
    const client = { appearance: { get, put: vi.fn() } } as unknown as ApiClient;
    render(
      <AppearanceProvider client={client}>
        <AppearanceSettingsScreen />
      </AppearanceProvider>,
    );
    const user = userEvent.setup();
    const retry = within(await screen.findByRole("alert")).getByRole("button", { name: "Try loading again" });
    await user.click(retry);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(document.activeElement).toBe(retry);
    fail = false;
    await user.click(retry);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Appearance", level: 1 }));
  });
});

describe("a typeface from the researcher's own file (R100, Task 57)", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  const ID2 = "fedcba9876543210fedcba9876543210";
  const BRILL = { id: ID, name: "Brill", format: "woff2", size: 4, addedAt: "2026-11-11T10:00:00.000Z" };

  class FakeFontFace {
    static made: FakeFontFace[] = [];
    status = "unloaded";
    constructor(
      readonly family: string,
      readonly source: ArrayBuffer | string,
    ) {
      FakeFontFace.made.push(this);
    }
    async load() {
      if (typeof this.source === "string" || this.source.byteLength === 0) throw new Error("bad font");
      this.status = "loaded";
      return this;
    }
  }
  const faces = new Set<FakeFontFace>();
  beforeEach(() => {
    FakeFontFace.made = [];
    faces.clear();
    vi.stubGlobal("FontFace", FakeFontFace);
    Object.defineProperty(document, "fonts", { configurable: true, value: { add: (f: FakeFontFace) => faces.add(f), delete: (f: FakeFontFace) => faces.delete(f) } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (document as { fonts?: unknown }).fonts;
  });

  function setupFonts(initial: AppearanceSettings = DEFAULT_APPEARANCE, o: { fonts?: (typeof BRILL)[]; addFails?: string; badBytes?: boolean } = {}) {
    let cur = structuredClone(initial);
    let list = [...(o.fonts ?? [])];
    const put = vi.fn(async (patch: Partial<AppearanceSettings>) => {
      cur = { ...cur, ...patch, fonts: { ...cur.fonts, ...(patch.fonts ?? {}) } } as AppearanceSettings;
      return structuredClone(cur);
    });
    const get = vi.fn(async () => structuredClone(cur));
    const request = vi.fn(async (method: string, path: string, opts?: { body?: { path?: string; name?: string } }) => {
      if (method === "GET" && path === "/settings/fonts") return { fonts: list };
      if (method === "POST" && path === "/settings/fonts") {
        await new Promise((r) => setTimeout(r, 20));
        if (o.addFails) throw new ApiClientError(400, { code: "VALIDATION", message: o.addFails });
        const f = { ...BRILL, id: ID2, name: opts?.body?.name ?? "Junicode" };
        list = [...list.filter((x) => x.id !== f.id), f];
        return f;
      }
      if (method === "DELETE" && path.startsWith("/settings/fonts/")) {
        list = list.filter((x) => `/settings/fonts/${x.id}` !== path);
        return { removed: true };
      }
      throw new Error(`unexpected ${method} ${path}`);
    });
    const bytes = vi.fn(async (_path: string) => new Blob([o.badBytes ? new Uint8Array(0) : new Uint8Array([0x77, 0x4f, 0x46, 0x32])], { type: "font/woff2" }));
    const client = { appearance: { get, put }, request, bytes } as unknown as ApiClient;
    const utils = render(
      <AppearanceProvider client={client} initial={initial}>
        <AppearanceSettingsScreen />
      </AppearanceProvider>,
    );
    return { ...utils, put, get, request, bytes };
  }

  const withReading = (file: string, family = "Brill"): AppearanceSettings => ({ ...DEFAULT_APPEARANCE, fonts: { ...DEFAULT_APPEARANCE.fonts, reading: { family, source: "user-file", file, generic: "serif" } } });

  it("adds a font file through the service, offers it for each typeface, and loads it from the service's bytes", async () => {
    const { request, put, bytes } = setupFonts();
    const user = userEvent.setup();
    const region = await screen.findByRole("region", { name: "Your own font files" });
    await user.type(within(region).getByRole("textbox", { name: "Font file path" }), "/Users/me/Fonts/Junicode.woff2");
    await user.type(within(region).getByRole("textbox", { name: "Name to use (optional)" }), "Junicode");
    await user.dblClick(within(region).getByRole("button", { name: "Add font file" }));
    expect(await within(region).findByText("Junicode")).toBeTruthy();
    expect(request.mock.calls.filter((c) => c[0] === "POST")).toEqual([["POST", "/settings/fonts", { body: { path: "/Users/me/Fonts/Junicode.woff2", name: "Junicode" } }]]);
    expect((within(region).getByRole("textbox", { name: "Font file path" }) as HTMLInputElement).value).toBe("");

    await user.selectOptions(screen.getByRole("combobox", { name: "Reading view typeface" }), "From file: Junicode");
    expect(put).toHaveBeenLastCalledWith({ fonts: { reading: { family: "Junicode", source: "user-file", file: ID2, generic: "serif" } } });
    await waitFor(() => expect([...faces].map((f) => f.family)).toEqual(["Junicode"]));
    expect(bytes).toHaveBeenCalledWith(`/settings/fonts/${ID2}`, expect.objectContaining({ maxBytes: expect.any(Number) }));
    expect(typeof FakeFontFace.made[0]!.source).not.toBe("string"); // bytes, never an address
    expect((FakeFontFace.made[0]!.source as ArrayBuffer).byteLength).toBe(4);
    expect(prop("--font-reading").startsWith("'Junicode', serif")).toBe(true); // always quoted (M5)
  });

  it("a saved choice is loaded when the app starts, and released when another typeface is chosen", async () => {
    setupFonts(withReading(ID), { fonts: [BRILL] });
    await waitFor(() => expect([...faces].map((f) => f.family)).toEqual(["Brill"]));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Reading view typeface" }), "Sorts Mill Goudy (bundled)");
    await waitFor(() => expect(faces.size).toBe(0));
  });

  it("a font that cannot be loaded says so, and the fallback typefaces are used", async () => {
    setupFonts(withReading(ID), { fonts: [BRILL], badBytes: true });
    expect(await screen.findByText(/“Brill” could not be loaded/)).toBeTruthy();
    expect(faces.size).toBe(0);
  });

  it("refuses a relative path before sending it, and shows the service's refusal in plain words", async () => {
    const { request } = setupFonts(DEFAULT_APPEARANCE, { addFails: "That is not a font file this app can use." });
    const user = userEvent.setup();
    const region = await screen.findByRole("region", { name: "Your own font files" });
    await user.type(within(region).getByRole("textbox", { name: "Font file path" }), "fonts/x.ttf");
    await user.click(within(region).getByRole("button", { name: "Add font file" }));
    expect(within(region).getByRole("alert").textContent).toMatch(/full path/);
    expect(request.mock.calls.filter((c) => c[0] === "POST")).toEqual([]);
    await user.clear(within(region).getByRole("textbox", { name: "Font file path" }));
    await user.type(within(region).getByRole("textbox", { name: "Font file path" }), "/tmp/x.pdf");
    await user.click(within(region).getByRole("button", { name: "Add font file" }));
    expect((await within(region).findByRole("alert")).textContent).toMatch(/not a font file this app can use/);
  });

  it("removes a font file", async () => {
    const { request } = setupFonts(DEFAULT_APPEARANCE, { fonts: [BRILL] });
    const user = userEvent.setup();
    const region = await screen.findByRole("region", { name: "Your own font files" });
    await within(region).findByText("Brill");
    await user.click(within(region).getByRole("button", { name: "Remove Brill" }));
    await waitFor(() => expect(within(region).queryByText("Brill")).toBeNull());
    expect(request).toHaveBeenCalledWith("DELETE", `/settings/fonts/${ID}`);
    expect(screen.queryByRole("option", { name: "From file: Brill" })).toBeNull();
  });
});
