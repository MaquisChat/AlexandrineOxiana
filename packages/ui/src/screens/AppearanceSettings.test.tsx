import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import { DEFAULT_APPEARANCE, type AppearanceSettings } from "../theme/appearance";
import { AppearanceProvider } from "../theme/AppearanceProvider";
import { ACCENT_DEBOUNCE_MS, AppearanceSettingsScreen } from "./AppearanceSettings";

/** Lets real time pass (debounce, pending saves) inside act. */
const settle = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

const root = () => document.documentElement;
const prop = (name: string) => root().style.getPropertyValue(name);

function setup(initial: AppearanceSettings = DEFAULT_APPEARANCE) {
  let cur = structuredClone(initial);
  const put = vi.fn(async (patch: Partial<AppearanceSettings>) => {
    cur = { ...cur, ...patch, fonts: { ...cur.fonts, ...(patch.fonts ?? {}) } } as AppearanceSettings;
    if (patch.accent === null) delete cur.accent;
    return structuredClone(cur);
  });
  const get = vi.fn(async () => structuredClone(cur));
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
    expect(prop("--font-interface").startsWith("Inter, 'Noto Sans'")).toBe(true);
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
    expect(prop("--font-reading").startsWith("Charter, 'Noto Serif'")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
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
});
