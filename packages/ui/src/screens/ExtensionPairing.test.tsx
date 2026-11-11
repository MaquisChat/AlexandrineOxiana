import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, BROWSER_A, BROWSER_B, makeApi, pairingService, server, url, useMsw } from "../test/msw-extension";
import { ExtensionPairing } from "./ExtensionPairing";

useMsw();

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const codeName = (digits: string) => `Pairing code: ${digits.split("").join(" ")}`;
const show = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Show a pairing code" }));

function fakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], shouldAdvanceTime: true });
  return userEvent.setup({ advanceTimers: (ms) => void vi.advanceTimersByTime(ms) });
}
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("Pair a browser", () => {
  it("asks the service for a code and shows it large, grouped, with an accessible name that reads digits", async () => {
    const svc = pairingService({ codes: [{ code: "482916" }] });
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    await show(user);
    const code = await screen.findByRole("img", { name: codeName("482916") });
    expect(code.textContent).toBe("482 916");
    expect(svc.state.issued).toBe(1);
    // Instructions for the extension's side.
    expect(screen.getByText(/extension's popup/i)).toBeTruthy();
    expect(screen.getByText(/Valid for 5:00/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show a new code" })).toBeTruthy();
  });

  it("a double click issues one code", async () => {
    const svc = pairingService();
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    await user.dblClick(screen.getByRole("button", { name: "Show a pairing code" }));
    await screen.findByRole("img", { name: /Pairing code/ });
    expect(svc.state.issued).toBe(1);
  });

  it("the countdown reaches zero, says the code expired, removes the digits and offers a new code", async () => {
    const svc = pairingService({ codes: [{ code: "482916", ttlMs: 3 * 60_000 }, { code: "135790" }] });
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={1_000_000} />);
    await show(user);
    await screen.findByRole("img", { name: codeName("482916") });
    await tick(60_000);
    expect(screen.getByText(/Valid for 2:00/)).toBeTruthy();
    await tick(2 * 60_000 + 1000);
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/482\s?916/);
    expect(screen.getByRole("alert").textContent).toMatch(/expired/i);
    await user.click(screen.getByRole("button", { name: "Show a new code" }));
    await screen.findByRole("img", { name: codeName("135790") });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("announces at sensible moments only, not every second", async () => {
    const svc = pairingService({ codes: [{ code: "482916", ttlMs: 90_000 }] });
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={1_000_000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    const live = screen.getByRole("status", { name: "Pairing code time" });
    const seen: string[] = [];
    const mo = new MutationObserver(() => seen.push(live.textContent ?? ""));
    mo.observe(live, { childList: true, characterData: true, subtree: true });
    await tick(20_000);
    expect(seen).toEqual([]); // the visible countdown changed, the announcement did not
    await tick(15_000); // 55 s left
    expect(seen.some((t) => /1 minute left/.test(t))).toBe(true);
    const n = seen.length;
    await tick(10_000);
    expect(seen.length).toBe(n);
    mo.disconnect();
  });

  it("a new code replaces the old one, and the old digits leave the page", async () => {
    const svc = pairingService({ codes: [{ code: "482916" }, { code: "770011" }] });
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    await show(user);
    await screen.findByRole("img", { name: codeName("482916") });
    await user.click(screen.getByRole("button", { name: "Show a new code" }));
    await screen.findByRole("img", { name: codeName("770011") });
    expect(screen.queryByRole("img", { name: codeName("482916") })).toBeNull();
    expect(document.body.textContent).not.toMatch(/482\s?916/);
  });

  it("says the code was used when a new browser shows up in the list, and offers a new code", async () => {
    const svc = pairingService({ pairings: [BROWSER_A] });
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.state.pairings.push(BROWSER_B);
    await tick(2500);
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/482\s?916/);
    expect(screen.getByRole("status", { name: "Pairing result" }).textContent).toMatch(/was used/i);
    expect(screen.getByRole("button", { name: "Show a new code" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Paired browsers" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows a rate-limit refusal plainly and keeps the screen usable", async () => {
    server.use(http.post(url("/extension/pair"), () => apiError(429, "RATE_LIMITED", "Too many attempts. Wait a minute, then try again.")), ...pairingService().handlers.slice(1));
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    await show(user);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/wait/i);
    expect(alert.textContent).not.toMatch(/RATE_LIMITED|\{/);
    expect(screen.getByRole("button", { name: "Show a pairing code" })).toHaveProperty("disabled", false);
  });

  it("says plainly when the service cannot be reached, and when the library is read-only", async () => {
    server.use(http.post(url("/extension/pair"), () => HttpResponse.error()), ...pairingService().handlers.slice(1));
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    await show(user);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be reached/i);
    server.use(http.post(url("/extension/pair"), () => apiError(403, "READ_ONLY", "The library is read-only.")));
    await user.click(screen.getByRole("button", { name: "Show a pairing code" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/read-only/i));
  });

  it("drops an answer that arrives after the screen was left", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post(url("/extension/pair"), async () => {
        await gate;
        return HttpResponse.json({ code: "482916", expiresAt: new Date(Date.now() + 300_000).toISOString() });
      }),
      ...pairingService().handlers.slice(1),
    );
    const user = userEvent.setup();
    const { unmount } = render(<ExtensionPairing api={makeApi()} />);
    await show(user);
    unmount();
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(document.body.textContent).not.toMatch(/482\s?916/);
  });

  it("never puts the code in the address or in storage, and never logs it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = pairingService({ codes: [{ code: "482916" }] });
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    expect(window.location.href).not.toMatch(/482916/);
    for (const store of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < store.length; i++) expect(`${store.key(i)}=${store.getItem(store.key(i)!)}`).not.toMatch(/482916/);
    }
    for (const spy of [log, err]) expect(JSON.stringify(spy.mock.calls)).not.toMatch(/482916/);
    log.mockRestore();
    err.mockRestore();
  });
});

describe("Paired browsers", () => {
  it("lists each browser by origin with when it was paired", async () => {
    server.use(...pairingService({ pairings: [BROWSER_A, BROWSER_B] }).handlers);
    render(<ExtensionPairing api={makeApi()} />);
    const region = await screen.findByRole("region", { name: "Paired browsers" });
    const items = await within(region).findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain(BROWSER_A.origin);
    expect(items[0]!.textContent).toMatch(/2 Nov 2026|Nov 2, 2026|2026/);
    expect(items[0]!.querySelector('[dir="auto"]')).toBeTruthy();
    expect(within(items[1]!).getByRole("button", { name: `Revoke ${BROWSER_B.origin}` })).toBeTruthy();
  });

  it("says so in plain words when no browser is paired", async () => {
    server.use(...pairingService().handlers);
    render(<ExtensionPairing api={makeApi()} />);
    expect(await screen.findByText("No browser is paired yet.")).toBeTruthy();
  });

  it("says plainly when the list cannot be read", async () => {
    server.use(...pairingService().handlers.slice(0, 1), http.get(url("/extension/pairings"), () => HttpResponse.error()));
    render(<ExtensionPairing api={makeApi()} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be reached/i);
  });

  it("revoke asks first, says capture stops until paired again, then removes the entry and updates the list", async () => {
    const svc = pairingService({ pairings: [BROWSER_A, BROWSER_B] });
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    await user.click(await screen.findByRole("button", { name: `Revoke ${BROWSER_A.origin}` }));
    const dialog = await screen.findByRole("dialog", { name: /Revoke/ });
    expect(dialog.textContent).toMatch(/stop being able to capture until it is paired again/i);
    expect(svc.state.deleted).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Revoke pairing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(svc.state.deleted).toEqual([BROWSER_A.id]);
    const region = screen.getByRole("region", { name: "Paired browsers" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);
    expect(within(region).getAllByRole("listitem")[0]!.textContent).not.toContain(BROWSER_A.origin);
    expect(screen.getByRole("status", { name: "Revoke result" }).textContent).toMatch(/revoked/i);
  });

  it("Cancel and Escape change nothing and return focus to the Revoke button", async () => {
    const svc = pairingService({ pairings: [BROWSER_A] });
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    const btn = await screen.findByRole("button", { name: `Revoke ${BROWSER_A.origin}` });
    await user.click(btn);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(btn);
    await user.click(btn);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(btn);
    expect(svc.state.deleted).toEqual([]);
  });

  it("a failed revoke keeps the entry and says why in the dialog", async () => {
    const svc = pairingService({ pairings: [BROWSER_A] });
    server.use(http.delete(url("/extension/pairings/:pid"), () => apiError(403, "READ_ONLY", "The library is read-only.")), ...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    await user.click(await screen.findByRole("button", { name: `Revoke ${BROWSER_A.origin}` }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke pairing" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/read-only/i);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(within(screen.getByRole("region", { name: "Paired browsers" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("is fully keyboard operable: pair, revoke, and focus lands on the list heading afterwards", async () => {
    const svc = pairingService({ pairings: [BROWSER_A] });
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    const revoke = await screen.findByRole("button", { name: `Revoke ${BROWSER_A.origin}` });
    const showBtn = screen.getByRole("button", { name: "Show a pairing code" });
    showBtn.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("img", { name: /Pairing code/ });
    revoke.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Tab stays inside the dialog.
    await user.tab();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    (within(dialog).getByRole("button", { name: "Revoke pairing" })).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Paired browsers" })));
  });
});
