import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import { UserText } from "../components/UserText";
import { mediaListenerCount, setMedia } from "../test/media";
import { DEFAULT_APPEARANCE, type AppearanceSettings } from "./appearance";
import { AppearanceProvider, useAppearance } from "./AppearanceProvider";
import { GOUDY_STACK, fontStack } from "./fonts";

const root = () => document.documentElement;
const prop = (name: string) => root().style.getPropertyValue(name);

function with_(patch: Partial<AppearanceSettings>): AppearanceSettings {
  return { ...structuredClone(DEFAULT_APPEARANCE), ...patch };
}

function fakeClient(initial: AppearanceSettings = DEFAULT_APPEARANCE) {
  let cur = structuredClone(initial);
  const get = vi.fn(async () => structuredClone(cur));
  const put = vi.fn(async (patch: Partial<AppearanceSettings>) => {
    cur = { ...cur, ...patch } as AppearanceSettings;
    return structuredClone(cur);
  });
  return { client: { appearance: { get, put } } as unknown as ApiClient, get, put };
}

describe("<AppearanceProvider>", () => {
  it("applies the defaults to <html>: theme, Goudy stacks for every area, text scale, line spacing, density", () => {
    render(<AppearanceProvider initial={DEFAULT_APPEARANCE}>x</AppearanceProvider>);
    expect(root().dataset.theme).toBe("light");
    for (const slot of ["interface", "reading", "transcript", "notes"]) {
      expect(prop(`--font-${slot}`)).toBe(fontStack({ family: GOUDY_STACK, source: "bundled" }));
      expect(prop(`--font-${slot}`).startsWith("'Goudy Old Style', 'Sorts Mill Goudy'")).toBe(true);
    }
    expect(prop("--font-mono").startsWith("ui-monospace, SFMono-Regular, Menlo, Consolas")).toBe(true);
    expect(prop("--text-scale")).toBe("1");
    expect(prop("--line-spacing")).toBe("1.5");
    expect(root().dataset.density).toBe("comfortable");
    expect(root().dataset.motion).toBe("full");
  });

  it("theme 'system' follows prefers-color-scheme, live", () => {
    setMedia({ dark: true });
    render(<AppearanceProvider initial={DEFAULT_APPEARANCE}>x</AppearanceProvider>);
    expect(root().dataset.theme).toBe("dark");
    act(() => setMedia({ dark: false }));
    expect(root().dataset.theme).toBe("light");
  });

  it("an explicit theme ignores the system, and high contrast selects the -hc variant", () => {
    setMedia({ dark: true });
    const { rerender } = render(<AppearanceProvider initial={with_({ theme: "light" })}>x</AppearanceProvider>);
    expect(root().dataset.theme).toBe("light");
    rerender(<AppearanceProvider initial={with_({ theme: "light", highContrast: true })}>x</AppearanceProvider>);
    expect(root().dataset.theme).toBe("light-hc");
    rerender(<AppearanceProvider initial={with_({ theme: "system", highContrast: true })}>x</AppearanceProvider>);
    expect(root().dataset.theme).toBe("dark-hc");
  });

  it("reduced motion 'system' follows prefers-reduced-motion, live; 'on' and 'off' override it", () => {
    setMedia({ reducedMotion: true });
    const { rerender } = render(<AppearanceProvider initial={DEFAULT_APPEARANCE}>x</AppearanceProvider>);
    expect(root().dataset.motion).toBe("reduce");
    act(() => setMedia({ reducedMotion: false }));
    expect(root().dataset.motion).toBe("full");
    rerender(<AppearanceProvider initial={with_({ reducedMotion: "on" })}>x</AppearanceProvider>);
    expect(root().dataset.motion).toBe("reduce");
    act(() => setMedia({ reducedMotion: true }));
    rerender(<AppearanceProvider initial={with_({ reducedMotion: "off" })}>x</AppearanceProvider>);
    expect(root().dataset.motion).toBe("full");
  });

  it("removes its media listeners on unmount", () => {
    const { unmount } = render(<AppearanceProvider initial={DEFAULT_APPEARANCE}>x</AppearanceProvider>);
    expect(mediaListenerCount()).toBeGreaterThan(0);
    unmount();
    expect(mediaListenerCount()).toBe(0);
  });

  it("applies a custom accent that passes contrast, and not one that fails", () => {
    const { rerender } = render(<AppearanceProvider initial={with_({ theme: "light", accent: "#7A1F5C" })}>x</AppearanceProvider>);
    expect(prop("--accent")).toBe("#7A1F5C");
    expect(prop("--accent-ink")).toBe("#7A1F5C");
    rerender(<AppearanceProvider initial={with_({ theme: "light", accent: "#E0E0E0" })}>x</AppearanceProvider>);
    expect(prop("--accent")).toBe("");
    expect(prop("--accent-ink")).toBe("");
  });

  it("loads the saved settings from the service and saves changes with PUT /settings/appearance", async () => {
    const { client, get, put } = fakeClient(with_({ theme: "dark", density: "compact" }));
    let api: ReturnType<typeof useAppearance> | undefined;
    function Probe() {
      api = useAppearance();
      return null;
    }
    render(
      <AppearanceProvider client={client}>
        <Probe />
      </AppearanceProvider>,
    );
    await waitFor(() => expect(root().dataset.theme).toBe("dark"));
    expect(get).toHaveBeenCalledTimes(1);
    expect(root().dataset.density).toBe("compact");
    await act(() => api!.update({ textScale: 1.25 }));
    expect(put).toHaveBeenCalledWith({ textScale: 1.25 });
    expect(prop("--text-scale")).toBe("1.25");
  });

  it("a slow answer to an earlier save never undoes a later change", async () => {
    const { client, put } = fakeClient();
    let releaseFirst!: (s: AppearanceSettings) => void;
    put.mockImplementationOnce(() => new Promise<AppearanceSettings>((r) => (releaseFirst = r)));
    let api: ReturnType<typeof useAppearance> | undefined;
    function Probe() {
      api = useAppearance();
      return null;
    }
    render(
      <AppearanceProvider client={client} initial={DEFAULT_APPEARANCE}>
        <Probe />
      </AppearanceProvider>,
    );
    let first!: Promise<void>;
    act(() => {
      first = api!.update({ density: "compact" });
    });
    await act(() => api!.update({ textScale: 1.5 }));
    await act(async () => {
      releaseFirst(with_({ density: "compact" })); // the server's answer to the first save, without the second change
      await first;
    });
    expect(prop("--text-scale")).toBe("1.5");
  });

  it("a stored family name that cannot be used falls back to the default stack instead of breaking the page", () => {
    render(<AppearanceProvider initial={with_({ fonts: { ...DEFAULT_APPEARANCE.fonts, reading: { family: "a\\b", source: "system" } } })}>x</AppearanceProvider>);
    expect(prop("--font-reading").startsWith("'Goudy Old Style'")).toBe(true);
  });

  it("shows a plain message when saving fails, keeping the change on screen", async () => {
    const { client, put } = fakeClient();
    put.mockRejectedValueOnce(Object.assign(new Error("The library service could not be reached."), { code: "UNAVAILABLE" }));
    let api: ReturnType<typeof useAppearance> | undefined;
    function Probe() {
      api = useAppearance();
      return <p>{api.saveError ?? "saved"}</p>;
    }
    render(
      <AppearanceProvider client={client}>
        <Probe />
      </AppearanceProvider>,
    );
    await waitFor(() => expect(screen.getByText("saved")).toBeTruthy());
    await act(() => api!.update({ density: "compact" }));
    expect(root().dataset.density).toBe("compact");
    expect(screen.getByText(/could not be reached/)).toBeTruthy();
  });
});

describe("<UserText>", () => {
  it("renders user-entered and source text with dir=auto (right-to-left text lays out correctly)", () => {
    render(
      <>
        <UserText>مرحبا بالعالم</UserText>
        <UserText as="p" lang="he">
          שלום
        </UserText>
      </>,
    );
    const ar = screen.getByText("مرحبا بالعالم");
    expect(ar.getAttribute("dir")).toBe("auto");
    expect(ar.tagName).toBe("SPAN");
    const he = screen.getByText("שלום");
    expect(he.getAttribute("dir")).toBe("auto");
    expect(he.tagName).toBe("P");
    expect(he.getAttribute("lang")).toBe("he");
  });
});
