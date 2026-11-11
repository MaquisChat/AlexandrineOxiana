import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

/** A new provider with these settings (the previous one unmounted). */
function fresh(initial: AppearanceSettings) {
  cleanup();
  return render(<AppearanceProvider initial={initial}>x</AppearanceProvider>);
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
    fresh(with_({ theme: "light" }));
    expect(root().dataset.theme).toBe("light");
    fresh(with_({ theme: "light", highContrast: true }));
    expect(root().dataset.theme).toBe("light-hc");
    fresh(with_({ theme: "system", highContrast: true }));
    expect(root().dataset.theme).toBe("dark-hc");
  });

  it("reduced motion 'system' follows prefers-reduced-motion, live; 'on' and 'off' override it", () => {
    setMedia({ reducedMotion: true });
    fresh(DEFAULT_APPEARANCE);
    expect(root().dataset.motion).toBe("reduce");
    act(() => setMedia({ reducedMotion: false }));
    expect(root().dataset.motion).toBe("full");
    fresh(with_({ reducedMotion: "on" }));
    expect(root().dataset.motion).toBe("reduce");
    act(() => setMedia({ reducedMotion: true }));
    fresh(with_({ reducedMotion: "off" }));
    expect(root().dataset.motion).toBe("full");
  });

  it("removes its media listeners on unmount", () => {
    const { unmount } = render(<AppearanceProvider initial={DEFAULT_APPEARANCE}>x</AppearanceProvider>);
    expect(mediaListenerCount()).toBeGreaterThan(0);
    unmount();
    expect(mediaListenerCount()).toBe(0);
  });

  it("applies a custom accent that passes contrast, and not one that fails", () => {
    fresh(with_({ theme: "light", accent: "#7A1F5C" }));
    expect(prop("--accent")).toBe("#7A1F5C");
    expect(prop("--accent-ink")).toBe("#7A1F5C");
    fresh(with_({ theme: "light", accent: "#E0E0E0" }));
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

  it("keeps at most one PUT in flight; changes made meanwhile are coalesced into one pending PUT, and all end up applied (R105 I1)", async () => {
    const { client, put } = fakeClient();
    const releases: (() => void)[] = [];
    const real = put.getMockImplementation()!;
    put.mockImplementation((patch) => new Promise((resolve) => releases.push(() => resolve(real(patch)))));
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
    const done: Promise<void>[] = [];
    act(() => {
      done.push(api!.update({ density: "compact" }));
    });
    act(() => {
      done.push(api!.update({ textScale: 1.25 }));
      done.push(api!.update({ lineSpacing: 1.8 }));
      done.push(api!.update({ textScale: 1.5 }));
    });
    expect(put).toHaveBeenCalledTimes(1); // the others wait
    expect(prop("--text-scale")).toBe("1.5"); // shown at once all the same
    await act(async () => {
      releases.shift()!();
      await Promise.resolve();
    });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1]![0]).toEqual({ textScale: 1.5, lineSpacing: 1.8 }); // one PUT for the three changes
    await act(async () => {
      releases.shift()!();
      await Promise.all(done);
    });
    expect(put).toHaveBeenCalledTimes(2);
    expect(root().dataset.density).toBe("compact");
    expect(prop("--text-scale")).toBe("1.5");
    expect(prop("--line-spacing")).toBe("1.8");
  });

  it("two quick changes from the screen both end up saved and applied", async () => {
    const { client, put } = fakeClient();
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
    await act(async () => {
      await Promise.all([api!.update({ theme: "dark" }), api!.update({ density: "compact" })]);
    });
    expect(root().dataset.theme).toBe("dark");
    expect(root().dataset.density).toBe("compact");
    const saved = await client.appearance.get();
    expect(saved.theme).toBe("dark");
    expect(saved.density).toBe("compact");
  });

  it("applies the initial prop once; a later prop value does not reset what the user chose", () => {
    let api: ReturnType<typeof useAppearance> | undefined;
    function Probe() {
      api = useAppearance();
      return null;
    }
    const { rerender } = render(
      <AppearanceProvider initial={with_({ theme: "light" })}>
        <Probe />
      </AppearanceProvider>,
    );
    act(() => void api!.update({ density: "compact" }));
    rerender(
      <AppearanceProvider initial={with_({ theme: "dark" })}>
        <Probe />
      </AppearanceProvider>,
    );
    expect(root().dataset.theme).toBe("light");
    expect(root().dataset.density).toBe("compact");
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

describe("<AppearanceProvider> failed saves (R109)", () => {
  it("a failed change stays on screen with its error; a later successful save neither undoes it nor hides the error; retry saves it", async () => {
    const { client, put, get } = fakeClient();
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
    expect(screen.getByText(/could not be reached/)).toBeTruthy();
    await act(() => api!.update({ theme: "dark" })); // succeeds; the server's answer has density comfortable
    expect(put).toHaveBeenLastCalledWith({ theme: "dark" });
    expect(root().dataset.theme).toBe("dark");
    expect(root().dataset.density).toBe("compact"); // not undone
    expect(screen.getByText(/could not be reached/)).toBeTruthy(); // still unsaved, still said
    await act(() => api!.retrySave());
    expect(put).toHaveBeenLastCalledWith({ density: "compact" });
    expect(screen.getByText("saved")).toBeTruthy();
    expect((await get()).density).toBe("compact");
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
