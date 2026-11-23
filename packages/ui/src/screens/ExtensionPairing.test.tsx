import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, BROWSER_A, BROWSER_B, codeIdOf, makeApi, pairingService, server, url, useMsw } from "../test/msw-extension";
import { ExtensionPairing } from "./ExtensionPairing";

useMsw();

afterEach(() => {
  vi.useRealTimers();
  server.events.removeAllListeners();
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
    expect(code.textContent).toBe("482916"); // two spans with a gap in CSS: a copy is the six digits only
    expect(code.querySelectorAll("span")).toHaveLength(2);
    expect(svc.state.issued).toBe(1);
    // Instructions for the extension's side.
    expect(screen.getByText(/extension's popup/i)).toBeTruthy();
    expect(screen.getByText(/Valid for 5:00/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show a new code" })).toBeTruthy();
    // The code's id is not shown.
    expect(document.body.textContent).not.toContain(codeIdOf(0));
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

  it("says the code was used, by which browser, when the service says so; the digits leave the page; the list is read again", async () => {
    const svc = pairingService({ pairings: [BROWSER_A] });
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.pairWith(BROWSER_B);
    await tick(2500);
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/482\s?916/);
    const result = screen.getByRole("status", { name: "Pairing result" });
    expect(result.textContent).toMatch(/was used/i);
    expect(result.textContent).toContain(BROWSER_B.origin);
    expect(result.querySelector('[dir="auto"]')?.textContent).toBe(BROWSER_B.origin); // source text through UserText
    expect(screen.getByRole("button", { name: "Show a new code" })).toBeTruthy();
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Paired browsers" })).getAllByRole("listitem")).toHaveLength(2));
  });

  it("says plainly when the code stopped working after 5 wrong tries, and removes it", async () => {
    const svc = pairingService();
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.end(0, { state: "invalidated", codeId: codeIdOf(0), invalidatedAt: new Date().toISOString(), reason: "wrong-tries" });
    await tick(2500);
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/482\s?916/);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/5 wrong tries/);
    expect(alert.textContent).toMatch(/no longer works/i);
    expect(alert.textContent).not.toMatch(/invalidated|\{/);
    expect(screen.getByRole("button", { name: "Show a new code" })).toBeTruthy();
  });

  it("says plainly when a newer code was made elsewhere, and removes this one", async () => {
    const svc = pairingService();
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.end(0, { state: "replaced", codeId: codeIdOf(0), replacedAt: new Date().toISOString() });
    await tick(2500);
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/newer code was made/i);
  });

  it("says plainly when the service no longer knows the code (it was restarted)", async () => {
    const svc = pairingService();
    server.use(http.get(url("/extension/pair/status/:codeId"), () => HttpResponse.json({ state: "none" })), ...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    await tick(2500);
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/no longer works/i);
  });

  it("the service saying the code expired removes it, even before this page's countdown ends", async () => {
    const svc = pairingService();
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.end(0, { state: "expired", codeId: codeIdOf(0), expiredAt: new Date().toISOString() });
    await tick(2500);
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/expired/i);
  });

  it("a 401 from the service is shown plainly and the screen stays usable (review M6)", async () => {
    server.use(http.post(url("/extension/pair"), () => apiError(401, "UNAUTHORIZED", "A valid token is needed.")), ...pairingService().handlers.slice(1));
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    await show(user);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/valid token/i);
    expect(alert.textContent).not.toMatch(/UNAUTHORIZED|\{/);
    expect(screen.getByRole("button", { name: "Show a pairing code" })).toHaveProperty("disabled", false);
  });

  it("says plainly when the service cannot be reached, and when it is shutting down (review M6)", async () => {
    server.use(http.post(url("/extension/pair"), () => HttpResponse.error()), ...pairingService().handlers.slice(1));
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    await show(user);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be reached/i);
    server.use(http.post(url("/extension/pair"), () => apiError(503, "UNAVAILABLE", "The library service is shutting down.")));
    await user.click(screen.getByRole("button", { name: "Show a pairing code" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/shutting down/i));
  });

  it("drops an answer that arrives after the screen was left", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post(url("/extension/pair"), async () => {
        await gate;
        return HttpResponse.json({ code: "482916", codeId: codeIdOf(0), expiresAt: new Date(Date.now() + 300_000).toISOString(), validForMs: 300_000 });
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

const requestsTo = (method: string, path: RegExp) => {
  let n = 0;
  server.events.on("request:start", ({ request }) => {
    if (request.method === method && path.test(new URL(request.url).pathname)) n++;
  });
  return () => n;
};

describe("the code's status drives the screen (Task 46c)", () => {
  it("asks the service about its own code by id, never the list, while the code is shown", async () => {
    const svc = pairingService({ pairings: [BROWSER_A] });
    server.use(...svc.handlers);
    const lists = requestsTo("GET", /^\/extension\/pairings$/);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await screen.findByRole("button", { name: `Revoke ${BROWSER_A.origin}` });
    const listsAtStart = lists();
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    await tick(7000);
    expect(svc.state.statusReads.length).toBeGreaterThanOrEqual(3);
    expect(new Set(svc.state.statusReads)).toEqual(new Set([codeIdOf(0)]));
    expect(lists()).toBe(listsAtStart);
  });

  it("a new browser in the list never marks the code used: only the service's status does", async () => {
    const svc = pairingService({ pairings: [BROWSER_A] });
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.state.pairings.push({ ...BROWSER_B, pairedAt: new Date().toISOString() }); // paired by another code
    await tick(5000);
    expect(screen.getByRole("img", { name: /Pairing code/ })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Pairing result" })).toBeNull();
  });

  it("the page's clock does not matter: a service clock far behind still shows the full time (review N2)", async () => {
    const svc = pairingService();
    server.use(
      http.post(url("/extension/pair"), () => HttpResponse.json({ code: "482916", codeId: codeIdOf(0), expiresAt: new Date(Date.now() - 60 * 60_000).toISOString(), validForMs: 5 * 60_000 })),
      http.get(url("/extension/pair/status/:codeId"), ({ params }) => HttpResponse.json({ state: "active", codeId: String(params.codeId), expiresAt: new Date(Date.now() - 60 * 60_000).toISOString(), validForMs: 4 * 60_000 })),
      ...svc.handlers,
    );
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: codeName("482916") });
    expect(screen.getByText(/Valid for 5:00/)).toBeTruthy();
    await tick(2500);
    expect(screen.getByRole("img", { name: codeName("482916") })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a slow answer for a replaced code changes nothing on the new one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = pairingService({ codes: [{ code: "111111" }, { code: "222222" }] });
    server.use(
      http.get(url("/extension/pair/status/:codeId"), async ({ params }) => {
        if (params.codeId !== codeIdOf(0)) return undefined; // the fixture answers for code 2
        await gate;
        return HttpResponse.json({ state: "used", codeId: codeIdOf(0), usedAt: new Date().toISOString(), browser: { id: BROWSER_B.id, origin: BROWSER_B.origin } });
      }),
      ...svc.handlers,
    );
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: codeName("111111") });
    await tick(2100); // the status read for code 1 is now waiting
    await user.click(screen.getByRole("button", { name: "Show a new code" }));
    await screen.findByRole("img", { name: codeName("222222") });
    release();
    await tick(100);
    expect(screen.getByRole("img", { name: codeName("222222") })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Pairing result" })).toBeNull();
  });

  it("polling stops on expiry, on use, on replacement and on leaving the screen", async () => {
    const svc = pairingService({ codes: [{ code: "482916", ttlMs: 10_000 }, { code: "135790" }, { code: "246802" }, { code: "975311" }] });
    server.use(...svc.handlers);
    const count = () => svc.state.statusReads.length;
    const user = fakeClock();
    const { unmount } = render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    await tick(12_000); // expired
    expect(screen.getByRole("alert").textContent).toMatch(/expired/i);
    const afterExpiry = count();
    await tick(10_000);
    expect(count()).toBe(afterExpiry);
    await user.click(screen.getByRole("button", { name: "Show a new code" }));
    await screen.findByRole("img", { name: codeName("135790") });
    svc.pairWith(BROWSER_B);
    await tick(2500);
    expect(screen.getByRole("status", { name: "Pairing result" })).toBeTruthy(); // used
    const afterUse = count();
    await tick(10_000);
    expect(count()).toBe(afterUse);
    await user.click(screen.getByRole("button", { name: "Show a new code" }));
    await screen.findByRole("img", { name: codeName("246802") });
    svc.end(2, { state: "replaced", codeId: codeIdOf(2), replacedAt: new Date().toISOString() });
    await tick(2500);
    expect(screen.getByRole("alert").textContent).toMatch(/newer code/i);
    const afterReplace = count();
    await tick(10_000);
    expect(count()).toBe(afterReplace);
    await user.click(screen.getByRole("button", { name: "Show a new code" }));
    await screen.findByRole("img", { name: codeName("975311") });
    await tick(2500);
    unmount();
    const afterLeave = count();
    await tick(10_000);
    expect(count()).toBe(afterLeave);
  });

  it("never runs two status requests at once, however slow the service is", async () => {
    let active = 0;
    let most = 0;
    let seen = 0;
    server.use(
      http.get(url("/extension/pair/status/:codeId"), async ({ params }) => {
        seen++;
        active++;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 250));
        active--;
        return HttpResponse.json({ state: "active", codeId: String(params.codeId), expiresAt: new Date(Date.now() + 60_000).toISOString(), validForMs: 60_000 });
      }),
      ...pairingService().handlers,
    );
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} pollMs={50} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    await new Promise((r) => setTimeout(r, 900));
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(most).toBe(1);
  });

  it("a failed status read is silent and the next one tries again", async () => {
    const svc = pairingService();
    server.use(http.get(url("/extension/pair/status/:codeId"), () => HttpResponse.error(), { once: true }), ...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    await tick(2500);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("img", { name: /Pairing code/ })).toBeTruthy();
    svc.pairWith(BROWSER_B);
    await tick(2500);
    expect(screen.getByRole("status", { name: "Pairing result" })).toBeTruthy();
  });
});

describe("the button and the announcement (review M3, M4)", () => {
  it("while a code is being issued the button stays enabled and focused, says it is busy, and a second press asks for nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let posts = 0;
    server.use(
      http.post(url("/extension/pair"), async () => {
        posts++;
        await gate;
        return HttpResponse.json({ code: "482916", codeId: codeIdOf(0), expiresAt: new Date(Date.now() + 300_000).toISOString(), validForMs: 300_000 });
      }),
      ...pairingService().handlers.slice(1),
    );
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    const btn = screen.getByRole("button", { name: "Show a pairing code" });
    btn.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(btn.getAttribute("aria-busy")).toBe("true"));
    expect(btn).toHaveProperty("disabled", false);
    expect(document.activeElement).toBe(btn);
    await user.keyboard("{Enter}");
    expect(posts).toBe(1);
    release();
    await screen.findByRole("img", { name: /Pairing code/ });
    expect(btn.getAttribute("aria-busy")).toBeNull();
    expect(document.activeElement).toBe(btn);
    expect(posts).toBe(1);
  });

  it("the status region is there, empty, before any code, and announces the code once", async () => {
    const svc = pairingService();
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    const live = screen.getByRole("status", { name: "Pairing code time" });
    expect(live.textContent).toBe("");
    const seen: string[] = [];
    const mo = new MutationObserver(() => seen.push(live.textContent ?? ""));
    mo.observe(live, { childList: true, characterData: true, subtree: true });
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    await tick(30_000); // fifteen status reads and thirty clock ticks
    expect(screen.getByRole("status", { name: "Pairing code time" })).toBe(live); // the same node all along
    expect(seen.filter((t) => t !== "")).toEqual(["A pairing code is showing. It is valid for 5 minutes."]);
    mo.disconnect();
  });
});

describe("a revoke is never undone by an older answer (review N1)", () => {
  it("a list read that started before a revoke does not bring the revoked browser back", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const svc = pairingService({ pairings: [BROWSER_A] });
    let reads = 0;
    server.use(
      http.get(url("/extension/pairings"), async () => {
        reads++;
        if (reads === 2) {
          // The read after the code was used: it saw both browsers, then is slow to answer.
          const snapshot = [BROWSER_A, BROWSER_B];
          await gate;
          return HttpResponse.json({ extensions: snapshot });
        }
        return HttpResponse.json({ extensions: svc.state.pairings });
      }),
      ...svc.handlers,
    );
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} pollMs={50} />);
    await screen.findByRole("button", { name: `Revoke ${BROWSER_A.origin}` });
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.pairWith(BROWSER_B);
    await screen.findByRole("status", { name: "Pairing result" });
    await waitFor(() => expect(reads).toBe(2)); // the slow read is under way
    await user.click(screen.getByRole("button", { name: `Revoke ${BROWSER_A.origin}` }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke pairing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(reads).toBe(3));
    const listed = () => within(screen.getByRole("region", { name: "Paired browsers" })).queryAllByRole("listitem").map((li) => li.textContent ?? "");
    await waitFor(() => expect(listed().some((t) => t.includes(BROWSER_B.origin))).toBe(true));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(listed()).toHaveLength(1);
    expect(listed()[0]).toContain(BROWSER_B.origin);
    expect(listed()[0]).not.toContain(BROWSER_A.origin);
  });
});

describe("used only once written (review round 1: I1, M1, M2, M3)", () => {
  const usedBy = (n: number, b: typeof BROWSER_B) => ({ state: "used" as const, codeId: codeIdOf(n), usedAt: new Date().toISOString(), browser: { id: b.id, origin: b.origin } });

  it("while the pairing is being saved the code stays shown and the screen keeps asking; then it says used", async () => {
    const svc = pairingService();
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.end(0, { state: "confirming", codeId: codeIdOf(0) });
    await tick(6500);
    expect(screen.getByRole("img", { name: /Pairing code/ })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Pairing result" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    const reads = svc.state.statusReads.length;
    svc.pairWith(BROWSER_B);
    await tick(2500);
    expect(svc.state.statusReads.length).toBeGreaterThan(reads);
    expect(screen.getByRole("status", { name: "Pairing result" }).textContent).toContain(BROWSER_B.origin);
  });

  it("FR-335: while the pairing is being saved the countdown stops and the screen says so; it never calls the code expired", async () => {
    const svc = pairingService({ codes: [{ code: "482916", ttlMs: 30_000 }] });
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.end(0, { state: "confirming", codeId: codeIdOf(0) });
    await tick(2500);
    const saving = screen.getByRole("status", { name: "Pairing being saved" });
    expect(saving.textContent).toBe("The right code was typed. The pairing is being saved…");
    expect(screen.queryByText(/Valid for/)).toBeNull();
    // Well past the code's own expiry on this page's clock: still being saved, never "expired".
    await tick(40_000);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toMatch(/expired/i);
    expect(screen.queryByText(/Valid for/)).toBeNull();
    expect(screen.getByRole("status", { name: "Pairing being saved" }).textContent).toBe("The right code was typed. The pairing is being saved…");
  });

  it("FR-335: still being saved 60 seconds later, the screen says it is taking long and reads the list again once, then again when the status changes", async () => {
    const svc = pairingService();
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.end(0, { state: "confirming", codeId: codeIdOf(0) });
    await tick(2500); // the poll at 2 s sees "confirming"
    const before = svc.state.listReads;
    await tick(59_000); // 59.5 s after it was seen
    expect(screen.getByRole("status", { name: "Pairing being saved" }).textContent).toBe("The right code was typed. The pairing is being saved…");
    expect(svc.state.listReads).toBe(before);
    await tick(1000);
    expect(screen.getByRole("status", { name: "Pairing being saved" }).textContent).toBe(
      "The pairing is taking longer than it should to be saved. The browser is paired once it appears in the list of paired browsers.",
    );
    expect(svc.state.listReads).toBe(before + 1);
    await tick(20_000);
    expect(svc.state.listReads).toBe(before + 1); // once then, not on every poll
    expect(document.body.textContent).not.toMatch(/expired/i);
    svc.end(0, { state: "invalidated", codeId: codeIdOf(0), invalidatedAt: new Date().toISOString(), reason: "not-saved" });
    await tick(2500);
    expect(screen.getByRole("alert").textContent).toMatch(/did not complete/i);
    expect(svc.state.listReads).toBe(before + 2);
    expect(screen.getByRole("status", { name: "Pairing being saved" }).textContent).toBe("");
  });

  it("a pairing that could not be saved: the code is removed and the screen says the pairing did not complete", async () => {
    const svc = pairingService();
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.end(0, { state: "invalidated", codeId: codeIdOf(0), invalidatedAt: new Date().toISOString(), reason: "not-saved" });
    await tick(2500);
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toMatch(/did not complete/i);
    expect(alert).toMatch(/new code/i);
    expect(alert).not.toMatch(/wrong tries/);
    expect(screen.queryByRole("status", { name: "Pairing result" })).toBeNull();
  });

  it("after a use, the list is read again until the paired browser appears", async () => {
    const svc = pairingService();
    let hide = 2; // the first two reads after the use do not have it yet
    server.use(
      http.get(url("/extension/pairings"), () => {
        const used = svc.state.pairings.length > 0;
        if (used && hide > 0) {
          hide--;
          return HttpResponse.json({ extensions: [] });
        }
        return HttpResponse.json({ extensions: svc.state.pairings });
      }),
      ...svc.handlers,
    );
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.pairWith(BROWSER_B);
    await tick(2500);
    await tick(6500);
    const items = within(screen.getByRole("region", { name: "Paired browsers" })).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain(BROWSER_B.origin);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("if the paired browser never appears, the reading stops and the screen says so plainly", async () => {
    const svc = pairingService();
    const lists = requestsTo("GET", /^\/extension\/pairings$/);
    server.use(http.get(url("/extension/pairings"), () => HttpResponse.json({ extensions: [] })), ...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.pairWith(BROWSER_B);
    await tick(2500);
    await tick(30_000);
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toMatch(/not in the list/i);
    const n = lists();
    expect(n).toBeLessThanOrEqual(8);
    await tick(30_000);
    expect(lists()).toBe(n);
  });

  it("if the list cannot be read after a use, the screen says the list could not be read, not that the browser is missing, and does not suggest pairing again (FR-337)", async () => {
    const svc = pairingService();
    let reads = 0;
    server.use(
      http.get(url("/extension/pairings"), () => (++reads === 1 ? HttpResponse.json({ extensions: [] }) : apiError(500, "INTERNAL", "Something went wrong in the library service."))),
      ...svc.handlers,
    );
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.pairWith(BROWSER_B);
    await tick(2500);
    await tick(30_000);
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toBe("The code was used, but the list of paired browsers could not be read just now, so the browser just paired is not shown. Reload this page to read the list again.");
    expect(screen.getByRole("status", { name: "Pairing result" }).textContent).toContain(BROWSER_B.origin);
  });

  it("R466 M3 (FR-337): the 'could not be read' warning goes once a later read shows the paired browser", async () => {
    const svc = pairingService({ pairings: [BROWSER_A] });
    let reads = 0;
    let readable = false;
    let showB = true;
    server.use(
      http.get(url("/extension/pairings"), () =>
        ++reads === 1 || readable ? HttpResponse.json({ extensions: svc.state.pairings.filter((p) => showB || p.id !== BROWSER_B.id) }) : apiError(500, "INTERNAL", "Something went wrong in the library service."),
      ),
      ...svc.handlers,
    );
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.pairWith(BROWSER_B);
    await tick(2500);
    await tick(30_000);
    expect(screen.getByRole("alert").textContent).toMatch(/could not be read just now/);
    // A revoke of another browser reads the list, which now holds the browser just paired.
    readable = true;
    await user.click(screen.getByRole("button", { name: `Revoke ${BROWSER_A.origin}` }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke pairing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await tick(2500);
    expect(within(screen.getByRole("region", { name: "Paired browsers" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining(BROWSER_B.origin)]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("R466 M3 (FR-337): after 'could not be read', a later read that succeeds without the paired browser says it is not in the list", async () => {
    const svc = pairingService({ pairings: [BROWSER_A] });
    let reads = 0;
    let readable = false;
    server.use(
      http.get(url("/extension/pairings"), () =>
        ++reads === 1 || readable ? HttpResponse.json({ extensions: svc.state.pairings.filter((p) => p.id !== BROWSER_B.id) }) : apiError(500, "INTERNAL", "Something went wrong in the library service."),
      ),
      ...svc.handlers,
    );
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.pairWith(BROWSER_B);
    await tick(2500);
    await tick(30_000);
    expect(screen.getByRole("alert").textContent).toMatch(/could not be read just now/);
    readable = true;
    await user.click(screen.getByRole("button", { name: `Revoke ${BROWSER_A.origin}` }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke pairing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await tick(2500);
    expect(screen.getByRole("alert").textContent).toMatch(/not in the list yet/);
  });

  it("revoking another browser keeps the 'not in the list' warning while the paired browser is still missing (FR-338)", async () => {
    const svc = pairingService({ pairings: [BROWSER_A] });
    // The list never shows the browser the code paired (BROWSER_B), only BROWSER_A until it is revoked.
    server.use(http.get(url("/extension/pairings"), () => HttpResponse.json({ extensions: svc.state.pairings.filter((p) => p.id !== BROWSER_B.id) })), ...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.pairWith(BROWSER_B);
    await tick(2500);
    await tick(30_000);
    expect(screen.getByRole("alert").textContent).toMatch(/not in the list/i);
    await user.click(screen.getByRole("button", { name: `Revoke ${BROWSER_A.origin}` }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke pairing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await tick(2500);
    expect(screen.getByRole("status", { name: "Revoke result" }).textContent).toContain(BROWSER_A.origin);
    expect(screen.getByRole("alert").textContent).toMatch(/not in the list/i);
  });

  it("a refusal from the status route stops the asking and says plainly that the screen cannot tell (M1)", async () => {
    const svc = pairingService();
    let reads = 0;
    server.use(
      http.get(url("/extension/pair/status/:codeId"), () => {
        reads++;
        return apiError(403, "FORBIDDEN", "A pairing code's status is shown in the desktop app only.");
      }),
      ...svc.handlers,
    );
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    await tick(2500);
    expect(reads).toBe(1);
    expect(screen.getByRole("alert").textContent).toMatch(/cannot tell/i);
    await tick(10_000);
    expect(reads).toBe(1);
  });

  it("an answer in the wrong shape is ignored and the asking goes on (M2)", async () => {
    const svc = pairingService();
    server.use(http.get(url("/extension/pair/status/:codeId"), () => HttpResponse.json({ state: "used", codeId: codeIdOf(0) }), { once: true }), ...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={2000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    await tick(2500);
    expect(screen.getByRole("img", { name: /Pairing code/ })).toBeTruthy();
    svc.end(0, usedBy(0, BROWSER_B));
    svc.state.pairings.push({ ...BROWSER_B, pairedAt: new Date().toISOString() });
    await tick(2500);
    expect(screen.getByRole("status", { name: "Pairing result" }).textContent).toContain(BROWSER_B.origin);
  });

  it("revoking the browser the code paired removes the 'was paired' message (M3)", async () => {
    const svc = pairingService();
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} pollMs={50} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    svc.pairWith(BROWSER_B);
    await screen.findByRole("status", { name: "Pairing result" });
    await user.click(await screen.findByRole("button", { name: `Revoke ${BROWSER_B.origin}` }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke pairing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("status", { name: "Pairing result" })).toBeNull();
    expect(screen.getByRole("status", { name: "Revoke result" }).textContent).toContain(BROWSER_B.origin);
  });
});

describe("the expiry follows the service's time (item 4)", () => {
  it("a sleeping machine or background tab: on return the expired code is removed at once", async () => {
    const svc = pairingService({ codes: [{ code: "482916" }] });
    server.use(...svc.handlers);
    const user = fakeClock();
    render(<ExtensionPairing api={makeApi()} pollMs={1_000_000} />);
    await show(user);
    await screen.findByRole("img", { name: /Pairing code/ });
    vi.setSystemTime(Date.now() + 10 * 60_000); // the timers did not run while asleep
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.queryByRole("img", { name: /Pairing code/ })).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/expired/i);
  });
});

describe("the service's port (review I1) and the popup's words (review M8)", () => {
  it("shows the port beside the code, with a name, and the instructions match the popup's fields", async () => {
    server.use(...pairingService().handlers);
    render(<ExtensionPairing api={makeApi()} port={48123} />);
    const group = screen.getByRole("group", { name: "Port" });
    expect(group.textContent).toContain("48123");
    const steps = screen.getByRole("list", { name: "Steps" }).textContent ?? "";
    expect(steps).toMatch(/“Port”/);
    expect(steps).toMatch(/“Pairing code”/);
    expect(steps).toMatch(/“Pair”/);
    expect(steps).toMatch(/“Pair with the desktop app”/);
  });

  it("labels the port and the code with the popup's field names exactly, and quotes the popup's refusal", async () => {
    server.use(...pairingService().handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} port={48123} />);
    // The popup's fields are labelled "Port" and "Pairing code" (apps/browser-extension popup).
    expect(screen.getByRole("group", { name: "Port" }).querySelector(".ao-pairing-label")?.textContent).toBe("Port");
    await show(user);
    const box = (await screen.findByRole("img", { name: /Pairing code/ })).closest(".ao-pairing-code-box")!;
    expect(box.querySelector(".ao-pairing-label")?.textContent).toBe("Pairing code");
    expect(box.textContent).toContain("“That code is not valid”");
    // The popup asks for "a port number and a 6-digit code".
    expect(screen.getByRole("list", { name: "Steps" }).textContent).toMatch(/6-digit code/);
  });

  it("the app passes the port only: the screen shows it and nothing else of the connection", async () => {
    const { App } = await import("../App");
    const { PATHS } = await import("../navigation");
    const { DEFAULT_APPEARANCE } = await import("../theme/appearance");
    const token = "q".repeat(40) + "-secret";
    // Every request the app makes has a handler (review N3): the appearance and researcher settings too.
    const unhandled: string[] = [];
    server.events.on("request:unhandled", ({ request }) => void unhandled.push(`${request.method} ${new URL(request.url).pathname}`));
    server.use(
      http.get(url("/settings/appearance"), () => HttpResponse.json(DEFAULT_APPEARANCE)),
      http.get(url("/settings/researcher"), () => HttpResponse.json({ name: null })),
      ...pairingService().handlers,
    );
    window.history.pushState(null, "", PATHS.extension);
    render(<App service={{ baseUrl: "http://127.0.0.1:4318", token }} />);
    const group = await screen.findByRole("group", { name: "Port" });
    expect(group.textContent).toContain("4318");
    await screen.findByText("No browser is paired yet.");
    expect(document.body.innerHTML).not.toContain(token);
    expect(document.body.innerHTML).not.toContain("http://127.0.0.1");
    expect(unhandled).toEqual([]);
    window.history.pushState(null, "", "/");
  });
});

describe("the route", () => {
  it("has one owner at its path and shows the screen with a Back to library link", async () => {
    const { ROUTES, routeFor } = await import("../App");
    const { createClient } = await import("../api/client");
    const { PATHS } = await import("../navigation");
    expect(ROUTES.filter((r) => r.matches(PATHS.extension))).toHaveLength(1);
    server.use(...pairingService().handlers);
    render(routeFor({ pathname: PATHS.extension, search: "?project=p1" }, createClient("http://127.0.0.1:4318", "t".repeat(40) + "-task34e")));
    expect(screen.getByRole("link", { name: "Back to library" }).getAttribute("href")).toBe("/?project=p1");
    expect(await screen.findByRole("heading", { name: "Browser extension" })).toBeTruthy();
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

  it("a held or repeated Enter on Revoke opens the dialog on its heading and revokes nothing; Tab then Enter revokes once (R376 c)", async () => {
    const svc = pairingService({ pairings: [BROWSER_A, BROWSER_B] });
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    const btn = await screen.findByRole("button", { name: `Revoke ${BROWSER_A.origin}` });
    btn.focus();
    await user.keyboard("{Enter>4}{/Enter}{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Revoke this browser?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Revoke this browser?" }));
    expect(svc.state.deleted).toEqual([]);
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Revoke pairing" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(svc.state.deleted).toEqual([BROWSER_A.id]));
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

  it("a failed revoke keeps the entry and says why in the dialog (a library move in progress: review M6)", async () => {
    const svc = pairingService({ pairings: [BROWSER_A] });
    server.use(http.delete(url("/extension/pairings/:pid"), () => apiError(503, "MOVE_IN_PROGRESS", "The library is being moved. Try again when the move has finished.")), ...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    await user.click(await screen.findByRole("button", { name: `Revoke ${BROWSER_A.origin}` }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Revoke pairing" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/being moved/i);
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

describe("the app's port changed since a browser was paired (R171, defect D13)", () => {
  const NOW = 4318;
  const OLD = 51234;
  const NOTICE = "The app's port changed";
  const noticeText = () => screen.queryByRole("status", { name: NOTICE })?.textContent ?? "";

  it("says so in plain words when a paired browser holds an older port: what happened, the new port, what to do in the browser", async () => {
    const svc = pairingService({ port: NOW, pairings: [{ ...BROWSER_A, port: OLD }, { ...BROWSER_B, port: NOW }] });
    server.use(...svc.handlers);
    render(<ExtensionPairing api={makeApi()} port={NOW} />);
    await waitFor(() => expect(noticeText()).not.toBe(""));
    const notice = screen.getByRole("status", { name: NOTICE });
    const text = notice.textContent ?? "";
    expect(text).toMatch(/opened/i);
    // It does not assert a cause it cannot know (review M3): the usual one, as the usual one.
    expect(text).toMatch(/most often because another program/i);
    expect(text).toContain(String(NOW));
    expect(text).toMatch(/“Use a different port”/);
    expect(text).toMatch(/“Check and save”/);
    expect(text).toMatch(/no need to pair again/i);
    // The current port is easy to read and copy: on its own, in a selectable element.
    expect(notice.querySelector(".ao-pairing-port-value")?.textContent).toBe(String(NOW));
    // The browser that holds the old port is marked in the list; the other is not.
    const rowA = screen.getByText(BROWSER_A.origin).closest("li")!;
    const rowB = screen.getByText(BROWSER_B.origin).closest("li")!;
    expect(rowA.textContent).toContain(`Old port: ${OLD}`);
    expect(rowB.textContent).not.toMatch(/Old port/);
    // Its origin comes from outside: shown through UserText.
    expect(within(rowA).getByText(BROWSER_A.origin).getAttribute("dir")).toBe("auto");
  });

  it("says nothing when every paired browser holds the current port, or none is paired", async () => {
    server.use(...pairingService({ port: NOW, pairings: [{ ...BROWSER_A, port: NOW }] }).handlers);
    const { unmount } = render(<ExtensionPairing api={makeApi()} port={NOW} />);
    await screen.findByText(BROWSER_A.origin);
    expect(noticeText()).toBe("");
    expect(document.body.textContent).not.toMatch(/Old port/);
    unmount();
    server.use(...pairingService({ port: NOW }).handlers);
    render(<ExtensionPairing api={makeApi()} port={NOW} />);
    await screen.findByText("No browser is paired yet.");
    expect(noticeText()).toBe("");
  });

  it("a browser paired before ports were kept gets a hint on its row, not the notice", async () => {
    server.use(...pairingService({ port: NOW, pairings: [BROWSER_A] }).handlers);
    render(<ExtensionPairing api={makeApi()} port={NOW} />);
    await screen.findByText(BROWSER_A.origin);
    expect(noticeText()).toBe("");
    const row = screen.getByText(BROWSER_A.origin).closest("li")!;
    expect(row.textContent).toMatch(new RegExp(`give it port ${NOW}`));
  });

  it("the notice is announced once: a later read of the same list does not change it; it goes when the old-port browser is revoked", async () => {
    const svc = pairingService({ port: NOW, pairings: [{ ...BROWSER_A, port: OLD }, { ...BROWSER_B, port: NOW }] });
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} port={NOW} />);
    await waitFor(() => expect(noticeText()).not.toBe(""));
    const first = noticeText();
    const region = screen.getByRole("status", { name: NOTICE });
    // Revoking the other browser reads the list again: the notice's words do not change (no new announcement).
    await user.click(screen.getByRole("button", { name: `Revoke ${BROWSER_B.origin}` }));
    await user.click(screen.getByRole("button", { name: "Revoke pairing" }));
    await waitFor(() => expect(svc.state.deleted).toEqual([BROWSER_B.id]));
    await waitFor(() => expect(svc.state.listReads).toBeGreaterThanOrEqual(2));
    expect(noticeText()).toBe(first);
    // The same live region, not a new one (a new node would be announced again: review M7).
    expect(screen.getByRole("status", { name: NOTICE })).toBe(region);
    await user.click(screen.getByRole("button", { name: `Revoke ${BROWSER_A.origin}` }));
    await user.click(screen.getByRole("button", { name: "Revoke pairing" }));
    await waitFor(() => expect(noticeText()).toBe(""));
  });

  it("the notice goes by itself once the browser has reached the app on the current port, without the screen being reopened (fix round 1, I3)", async () => {
    const svc = pairingService({ port: NOW, pairings: [{ ...BROWSER_A, port: OLD }, { ...BROWSER_B, port: NOW }] });
    server.use(...svc.handlers);
    render(<ExtensionPairing api={makeApi()} port={NOW} listPollMs={30} />);
    await waitFor(() => expect(noticeText()).not.toBe(""));
    const region = screen.getByRole("status", { name: NOTICE });
    const first = noticeText();
    // Reads while nothing changed keep the words and the node: no announcement on each read.
    const reads = svc.state.listReads;
    await waitFor(() => expect(svc.state.listReads).toBeGreaterThanOrEqual(reads + 2));
    expect(noticeText()).toBe(first);
    expect(screen.getByRole("status", { name: NOTICE })).toBe(region);
    // The browser takes the new port in its popup; the service records it.
    svc.state.pairings[0] = { ...svc.state.pairings[0]!, port: NOW };
    await waitFor(() => expect(noticeText()).toBe(""));
    expect(screen.getByText(BROWSER_A.origin).closest("li")!.textContent).not.toMatch(/Old port/);
    // With no notice left, the reading stops.
    const after = svc.state.listReads;
    await new Promise((r) => setTimeout(r, 200));
    expect(svc.state.listReads).toBe(after);
  });

  it("the reading stops when the screen is left, and after a bounded number of reads", async () => {
    const svc = pairingService({ port: NOW, pairings: [{ ...BROWSER_A, port: OLD }] });
    server.use(...svc.handlers);
    const { unmount } = render(<ExtensionPairing api={makeApi()} port={NOW} listPollMs={20} listPollMax={3} />);
    await waitFor(() => expect(noticeText()).not.toBe(""));
    await waitFor(() => expect(svc.state.listReads).toBe(4)); // the first read, then 3 more
    await new Promise((r) => setTimeout(r, 200));
    expect(svc.state.listReads).toBe(4);
    expect(noticeText()).not.toBe("");
    unmount();

    const svc2 = pairingService({ port: NOW, pairings: [{ ...BROWSER_A, port: OLD }] });
    server.use(...svc2.handlers);
    const second = render(<ExtensionPairing api={makeApi()} port={NOW} listPollMs={20} />);
    await waitFor(() => expect(svc2.state.listReads).toBeGreaterThanOrEqual(2));
    second.unmount();
    const left = svc2.state.listReads;
    await new Promise((r) => setTimeout(r, 200));
    expect(svc2.state.listReads).toBeLessThanOrEqual(left + 1); // at most one already on its way
  });

  it("one read at a time, however slow the service; an answer older than a newer read is dropped", async () => {
    let inFlight = 0;
    let most = 0;
    let n = 0;
    server.use(
      http.get(url("/extension/pairings"), async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        const mine = ++n;
        // The second read is slow and says the old port; the later ones say the new one.
        await new Promise((r) => setTimeout(r, mine === 2 ? 300 : 10));
        inFlight--;
        return HttpResponse.json({ extensions: [{ ...BROWSER_A, port: mine <= 2 ? OLD : NOW }], port: NOW });
      }),
    );
    render(<ExtensionPairing api={makeApi()} port={NOW} listPollMs={20} />);
    await waitFor(() => expect(noticeText()).not.toBe(""));
    await waitFor(() => expect(noticeText()).toBe(""), { timeout: 3000 });
    expect(most).toBe(1);
  });

  it("takes the port from the service's answer, and ignores one that is not a port", async () => {
    // The page was given no port: the service's answer is enough.
    server.use(...pairingService({ port: NOW, pairings: [{ ...BROWSER_A, port: OLD }] }).handlers);
    const { unmount } = render(<ExtensionPairing api={makeApi()} />);
    await waitFor(() => expect(noticeText()).toContain(String(NOW)));
    unmount();
    server.use(http.get(url("/extension/pairings"), () => HttpResponse.json({ extensions: [{ ...BROWSER_A, port: OLD }], port: "4318" })));
    render(<ExtensionPairing api={makeApi()} />);
    await screen.findByText(BROWSER_A.origin);
    expect(noticeText()).toBe("");
  });
});

describe("the list of paired browsers cannot be read (Task 68, Task 66 M8)", () => {
  const RESET = "Reset the list of paired browsers…";

  it("says so in plain words and offers the reset; nothing is offered while the list can be read", async () => {
    const readable = pairingService({ pairings: [BROWSER_A] });
    server.use(...readable.handlers);
    const { unmount } = render(<ExtensionPairing api={makeApi()} />);
    await screen.findByText(BROWSER_A.origin);
    expect(screen.queryByRole("button", { name: RESET })).toBeNull();
    unmount();
    server.use(...pairingService({ unreadable: true }).handlers);
    render(<ExtensionPairing api={makeApi()} />);
    const btn = await screen.findByRole("button", { name: RESET });
    const alert = btn.closest('[role="alert"]')!;
    expect(alert.textContent).toMatch(/cannot read its list of paired browsers/i);
    expect(alert.textContent).toMatch(/paired again/i);
  });

  it("the reset asks first, in plain words with what is lost; focus goes into the dialog, stays there, and comes back to the button on cancel", async () => {
    const svc = pairingService({ unreadable: true });
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    const btn = await screen.findByRole("button", { name: RESET });
    await user.click(btn);
    const dialog = await screen.findByRole("dialog", { name: "Reset the list of paired browsers?" });
    expect(dialog.textContent).toMatch(/every browser .* paired again/i);
    expect(dialog.textContent).toMatch(/kept, renamed/i);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: RESET }));
    expect(svc.state.resets).toEqual([]);
  });

  it("confirmed: one request, then the list is read again and the notice goes; the screen says what to do next", async () => {
    const svc = pairingService({ unreadable: true });
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    await user.click(await screen.findByRole("button", { name: RESET }));
    const dialog = await screen.findByRole("dialog");
    await user.dblClick(within(dialog).getByRole("button", { name: "Reset the list" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(svc.state.resets).toEqual([{ file: "extension-pairings", confirm: true }]);
    await waitFor(() => expect(screen.queryByRole("button", { name: RESET })).toBeNull());
    expect(screen.getByRole("status", { name: "Reset result" }).textContent).toMatch(/reset.*pair each browser again/i);
    expect(screen.getByText("No browser is paired yet.")).toBeTruthy();
    // Focus does not fall to the page: it lands on the list's heading.
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Paired browsers" }));
  });

  it("a reset that fails says why inside the dialog and keeps it open", async () => {
    const svc = pairingService({ unreadable: true, resetFails: true });
    server.use(...svc.handlers);
    const user = userEvent.setup();
    render(<ExtensionPairing api={makeApi()} />);
    await user.click(await screen.findByRole("button", { name: RESET }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Reset the list" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toMatch(/could not be set aside/);
  });
});
