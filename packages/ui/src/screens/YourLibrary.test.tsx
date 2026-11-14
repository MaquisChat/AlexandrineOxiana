/**
 * The "Your library" screen (Find and acquire Task F18a; R324, R334, R335, R336, R301) against a mocked service shaped
 * exactly like F15's handlers and F18a's test route (apps/library-service/src/routes/your-library.ts; @ao/shared
 * api/find.ts) and the desktop shell's bridge (src/desktopShell.ts, F16) through its test double: the name, the pasted
 * link (worked out and never kept), the address now set (in the service's own words) and its removal, the catalogue's
 * address, "Stay signed in" (at once, never in the draft), the draft and its save, the 60-second give-ups, "Test" (the
 * page's own ticket, the window's events) and "Sign out of my library", in the desktop app and outside it.
 */
import { FIND_LIBRARY_TEXT, YOUR_LIBRARY_CATALOGUE_MAX, YOUR_LIBRARY_DERIVE_TEXT, YOUR_LIBRARY_TEXT, type LibraryAccess, type YourLibraryResponse } from "@ao/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { PATHS } from "../navigation";
import { fakeShell, type FakeShell } from "../test/desktopShell";
import { BASE, CURRENT_RW, LIBRARIES, TOKEN, libraryHandlers, server, testClient, url, useMockService } from "../test/service";
import { DEFAULT_APPEARANCE } from "../theme/appearance";
import { YOUR_LIBRARY_SCREEN_TEXT as T, YourLibrary, onAMac } from "./YourLibrary";

const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
vi.mock("../desktopShell", () => ({ desktopShell: () => fake.shell, inDesktopShell: () => !!fake.shell }));

useMockService();

// Made up, recognisable: the library's host, a session's key in the pasted link.
const LIB_HOST = "ezproxy.zorblatt-univ.example.edu";
const SESSION = "SESSIONzorblatt77quux";
const LINK = `https://${LIB_HOST}/login?ticket=${SESSION}&url=https://www.jstor.org/stable/42`;
const EZ: LibraryAccess = { kind: "ezproxy-login", base: `https://${LIB_HOST}/login?url=` };
const EZ_SENTENCE = `Your library's address: ${LIB_HOST} (EZproxy)`;
const OU: LibraryAccess = { kind: "openurl", base: "https://resolver.example.edu/openurl" };
const OU_SENTENCE = "Your library's address: resolver.example.edu/openurl (link resolver)";
const TEST_URL = `https://${LIB_HOST}/login?url=https://doi.org/10.1038/171737a0`;
const NOT_SET: YourLibraryResponse = { name: "", access: null, staySignedIn: false };
const SET: YourLibraryResponse = { name: "Zorblatt University", access: EZ, staySignedIn: false, addressSentence: EZ_SENTENCE };
const MINUTE_AND_A_BIT = 61_000;

/** The service's sentence for an address it holds (R336 i), as the real handler words it. */
const named = (a: LibraryAccess | null): string | undefined => (!a ? undefined : a.base === EZ.base ? EZ_SENTENCE : a.base === OU.base ? OU_SENTENCE : `Your library's address: ${new URL(a.base).host} (EZproxy)`);

interface Sent {
  method: string;
  path: string;
  search: string;
  body: string;
}
interface Svc {
  sent: Sent[];
  settings: YourLibraryResponse;
  onGet?: () => Promise<Response | undefined>;
  onPut?: (body: any) => Promise<Response | undefined>;
  onDerive?: (body: any) => Promise<Response | undefined>;
  onTest?: () => Promise<Response | undefined>;
  count(method: string, path: string): number;
}

function useSvc(settings: YourLibraryResponse = NOT_SET): Svc {
  const svc: Svc = { sent: [], settings: structuredClone(settings), count: (m, p) => svc.sent.filter((s) => s.method === m && s.path === p).length };
  const rec = async (request: Request) => {
    const u = new URL(request.url);
    const s = { method: request.method, path: u.pathname, search: u.search, body: await request.clone().text() };
    svc.sent.push(s);
    return s;
  };
  server.use(
    http.get(url("/settings/your-library"), async ({ request }) => {
      await rec(request);
      return (await svc.onGet?.()) ?? HttpResponse.json(svc.settings);
    }),
    http.put(url("/settings/your-library"), async ({ request }) => {
      const s = await rec(request);
      const body = JSON.parse(s.body);
      const custom = await svc.onPut?.(body);
      if (custom) return custom;
      if (svc.settings.problem?.code === "newer") return HttpResponse.json({ error: { code: "CONFLICT", message: YOUR_LIBRARY_TEXT.newer } }, { status: 409 });
      const sentence = named(body.access);
      svc.settings = {
        name: body.name.trim(),
        access: body.access,
        ...(body.catalogueSearch ? { catalogueSearch: body.catalogueSearch } : {}),
        staySignedIn: body.staySignedIn === true,
        ...(sentence ? { addressSentence: sentence } : {}),
      };
      return HttpResponse.json(svc.settings);
    }),
    http.post(url("/settings/your-library/derive"), async ({ request }) => {
      const s = await rec(request);
      const body = JSON.parse(s.body);
      const custom = await svc.onDerive?.(body);
      if (custom) return custom;
      if (body.link === LINK) return HttpResponse.json({ access: EZ, sentence: EZ_SENTENCE });
      return HttpResponse.json({ access: null, sentence: YOUR_LIBRARY_DERIVE_TEXT["not-library"] });
    }),
    http.post(url("/settings/your-library/test"), async ({ request }) => {
      await rec(request);
      const custom = await svc.onTest?.();
      if (custom) return custom;
      if (!svc.settings.access) return HttpResponse.json({ error: { code: "CONFLICT", message: FIND_LIBRARY_TEXT.noLibrary, reason: "no-library" } }, { status: 409 });
      return HttpResponse.json({ url: TEST_URL });
    }),
  );
  return svc;
}

function held<V = void>() {
  let release!: (v: V) => void;
  const p = new Promise<V>((r) => (release = r));
  return { p, release };
}

/**
 * The shell's sign-in window as F16 built it (§2, §3): one ticket at a time — a second open while one is open is refused;
 * a hand-over ends the ticket; a sign-out closes the window.
 */
function realWindow(shell: FakeShell) {
  const w = { open: null as string | null };
  shell.openLibraryWindow.mockImplementation(async (ticket) => {
    if (w.open !== null) return false;
    w.open = ticket;
    shell.libraryWindow({ ticket, state: "opened" });
    return true;
  });
  shell.signOutOfLibrary.mockImplementation(async () => {
    const t = w.open;
    w.open = null;
    if (t) shell.libraryWindow({ ticket: t, state: "closed" });
    return true;
  });
  return {
    w,
    close(ticket: string | null = w.open) {
      w.open = null;
      act(() => shell.libraryWindow({ ticket, state: "closed" }));
    },
    handOver() {
      const t = w.open;
      w.open = null;
      act(() => shell.libraryWindow({ ticket: t, state: "handed-over" }));
    },
  };
}

/** Every text the polite region says, in order, observed over time: a sentence said twice is heard twice. */
function heard() {
  const said: string[] = [];
  const el = screen.getByTestId("yl-live");
  const mo = new MutationObserver(() => {
    const t = el.textContent ?? "";
    if (t) said.push(t);
  });
  mo.observe(el, { childList: true, subtree: true, characterData: true });
  return { said, stop: () => mo.disconnect() };
}

const liveText = () => screen.getByTestId("yl-live").textContent ?? "";
const nameField = () => screen.getByRole("textbox", { name: "Your institution's name" }) as HTMLInputElement;
const linkField = () => screen.getByRole("textbox", { name: "Paste any link that goes through your library" }) as HTMLInputElement;
const catField = () => screen.getByRole("textbox", { name: "Catalogue search address (optional)" }) as HTMLInputElement;
const stay = () => screen.getByRole("switch", { name: "Stay signed in to my library" }) as HTMLInputElement;
const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const described = (el: HTMLElement) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "");
const putBodies = (svc: Svc) => svc.sent.filter((s) => s.method === "PUT").map((s) => JSON.parse(s.body));
const setPlatform = (p: string) => Object.defineProperty(navigator, "platform", { value: p, configurable: true });
const fakeTime = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
const pass = async (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function show(svc: Svc) {
  const view = render(<YourLibrary client={testClient()} />);
  await screen.findByRole("textbox", { name: "Your institution's name" });
  await waitFor(() => expect(svc.count("GET", "/settings/your-library")).toBe(1));
  return view;
}

let consoleCalls: unknown[][] = [];
beforeEach(() => {
  fake.shell = fakeShell();
  // The desktop app on a Mac, unless a test says otherwise (macOS's web view reports "MacIntel").
  setPlatform("MacIntel");
  consoleCalls = [];
  for (const k of ["log", "info", "warn", "error", "debug", "trace"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void consoleCalls.push(a));
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  fake.shell = undefined;
  delete (navigator as { platform?: string }).platform;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Your library: the plan's two tests", () => {
  it("a pasted EZproxy link shows the worked-out address", async () => {
    const svc = useSvc();
    await show(svc);
    expect(screen.getByRole("heading", { level: 1, name: "Your library" })).toBeTruthy();
    expect(screen.getByTestId("yl-address").textContent).toBe("No library is set.");
    const user = userEvent.setup();
    await user.click(linkField());
    await user.paste(LINK);
    await user.click(btn("Work out the address"));
    await waitFor(() => expect(screen.getByTestId("yl-derived").textContent).toBe(EZ_SENTENCE));
    // One request, with the link and nothing else.
    expect(svc.count("POST", "/settings/your-library/derive")).toBe(1);
    expect(JSON.parse(svc.sent.find((s) => s.path === "/settings/your-library/derive")!.body)).toEqual({ link: LINK });
    // The worked-out address is the draft's: named in the derive's words as what will be set, and saved with the rest.
    expect(screen.getByTestId("yl-address").textContent).toBe(`${EZ_SENTENCE} ${T.notSavedYet}`);
    expect(linkField().value).toBe("");
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(putBodies(svc)).toEqual([{ name: "", access: EZ, catalogueSearch: null, staySignedIn: false }]);
    expect(screen.getByTestId("yl-address").textContent).toBe(EZ_SENTENCE);
  });

  it("Stay signed in is off at first", async () => {
    const svc = useSvc();
    await show(svc);
    expect(stay().checked).toBe(false);
    expect(stay().getAttribute("aria-disabled")).toBeNull();
    expect(fake.shell!.setStaySignedIn).not.toHaveBeenCalled();
  });
});

describe("Your library: the pasted link is never kept", () => {
  it("after the answer (worked out or refused) the link is in no element, attribute, storage, address or later request; the field offers no history", async () => {
    const svc = useSvc(SET);
    await show(svc);
    realWindow(fake.shell!);
    expect(linkField().getAttribute("autocomplete")).toBe("off");
    expect(linkField().getAttribute("name")).toBeNull();
    expect(linkField().closest("form")).toBeNull();
    const user = userEvent.setup();
    // Refused first: the service's sentence, the field emptied, the stored address unchanged.
    const hostile = `https://my-library.edu/catalogue?q=${SESSION}`;
    await user.click(linkField());
    await user.paste(hostile);
    await user.click(btn("Work out the address"));
    await waitFor(() => expect(screen.getByTestId("yl-derived").textContent).toBe(YOUR_LIBRARY_DERIVE_TEXT["not-library"]));
    expect(linkField().value).toBe("");
    expect(screen.getByTestId("yl-address").textContent).toBe(EZ_SENTENCE);
    // Then worked out.
    await user.click(linkField());
    await user.paste(LINK);
    await user.click(btn("Work out the address"));
    await waitFor(() => expect(linkField().value).toBe(""));
    // Every later request: a save, a test.
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    await user.click(btn("Test"));
    await waitFor(() => expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1));
    const later = svc.sent.filter((s) => s.path !== "/settings/your-library/derive");
    for (const s of later) expect(`${s.path}${s.search}${s.body}`).not.toContain(SESSION);
    expect(svc.sent.filter((s) => s.path === "/settings/your-library/derive").map((s) => JSON.parse(s.body))).toEqual([{ link: hostile }, { link: LINK }]);
    const page = document.documentElement.outerHTML;
    for (const w of [SESSION, "jstor", "my-library.edu"]) expect(page).not.toContain(w);
    for (const st of [localStorage, sessionStorage]) for (let i = 0; i < st.length; i++) expect(`${st.key(i)}=${st.getItem(st.key(i)!)}`).not.toContain(SESSION);
    expect(window.location.href).not.toContain(SESSION);
    expect(JSON.stringify(consoleCalls)).not.toContain(SESSION);
    // The shell gets the ticket, the test's address and the kind of start (R347 a: the library's) only.
    expect(fake.shell!.openLibraryWindow.mock.calls[0]![1]).toBe(TEST_URL);
    expect(fake.shell!.openLibraryWindow.mock.calls[0]![2]).toBe("library");
  });

  it("a refusal of the derive route (400) shows the service's sentence and never the link; the field is emptied", async () => {
    const svc = useSvc();
    await show(svc);
    svc.onDerive = async () => HttpResponse.json({ error: { code: "VALIDATION", message: YOUR_LIBRARY_TEXT.link } }, { status: 400 });
    const user = userEvent.setup();
    await user.click(linkField());
    await user.paste(LINK);
    await user.click(btn("Work out the address"));
    await waitFor(() => expect(screen.getByTestId("yl-derived").textContent).toBe(YOUR_LIBRARY_TEXT.link));
    expect(linkField().value).toBe("");
    expect(document.documentElement.outerHTML).not.toContain(SESSION);
  });

  it("a double press of Work out the address sends one request; an empty field sends none", async () => {
    const svc = useSvc();
    await show(svc);
    const user = userEvent.setup();
    await user.click(btn("Work out the address"));
    expect(screen.getByTestId("yl-derived").textContent).toBe(T.pasteFirst);
    expect(svc.count("POST", "/settings/your-library/derive")).toBe(0);
    const gate = held();
    svc.onDerive = async () => {
      await gate.p;
      return undefined;
    };
    await user.click(linkField());
    await user.paste(LINK);
    await user.dblClick(btn("Work out the address"));
    await act(async () => gate.release());
    await waitFor(() => expect(screen.getByTestId("yl-derived").textContent).toBe(EZ_SENTENCE));
    expect(svc.count("POST", "/settings/your-library/derive")).toBe(1);
  });
});

describe("Your library: the 60-second give-ups (R336 a, c)", () => {
  it("PB: a derive with no answer — at 61 s the field is empty, it is said, Save works again; the late answer changes nothing", async () => {
    fakeTime();
    const svc = useSvc(SET);
    await show(svc);
    const gate = held();
    svc.onDerive = async () => {
      await gate.p;
      return undefined;
    };
    fireEvent.change(nameField(), { target: { value: "New name" } });
    linkField().value = LINK;
    await act(async () => btn("Work out the address").click());
    await waitFor(() => expect(svc.count("POST", "/settings/your-library/derive")).toBe(1));
    // While it is out, Save says why it waits — shown, said on a press, and nothing is sent.
    expect(btn("Save").getAttribute("aria-disabled")).toBe("true");
    expect(described(btn("Save"))).toContain(T.waitDerive);
    await act(async () => btn("Save").click());
    expect(liveText()).toBe(T.waitDerive);
    expect(svc.count("PUT", "/settings/your-library")).toBe(0);
    await pass(59_000);
    expect(linkField().value).toBe(LINK);
    await pass(2_000);
    await waitFor(() => expect(screen.getByTestId("yl-derived").textContent).toBe(T.deriveSilent));
    expect(liveText()).toBe(T.deriveSilent);
    expect(linkField().value).toBe("");
    expect(btn("Work out the address").getAttribute("aria-busy")).toBeNull();
    expect(btn("Save").getAttribute("aria-disabled")).toBeNull();
    // The late answer: nothing changes.
    await act(async () => {
      gate.release();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByTestId("yl-address").textContent).toBe(EZ_SENTENCE);
    expect(screen.getByTestId("yl-derived").textContent).toBe(T.deriveSilent);
    await act(async () => btn("Save").click());
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(putBodies(svc)).toEqual([{ name: "New name", access: EZ, catalogueSearch: null, staySignedIn: false }]);
  });

  it("PC: Discard changes while the address is worked out — the field is emptied and the late answer changes nothing", async () => {
    const svc = useSvc(NOT_SET);
    await show(svc);
    const gate = held();
    svc.onDerive = async () => {
      await gate.p;
      return undefined;
    };
    const user = userEvent.setup();
    await user.type(nameField(), "Zorblatt");
    await user.click(linkField());
    await user.paste(LINK);
    await user.click(btn("Work out the address"));
    await waitFor(() => expect(svc.count("POST", "/settings/your-library/derive")).toBe(1));
    await user.click(btn("Discard changes"));
    expect(linkField().value).toBe("");
    expect(btn("Save").getAttribute("aria-disabled")).toBeNull();
    await act(async () => {
      gate.release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByTestId("yl-address").textContent).toBe(T.noLibrary);
    expect(screen.queryByTestId("yl-derived")).toBeNull();
    expect(btn("Discard changes").disabled).toBe(true);
  });

  it("each call to the shell is given up at 60 s and said; its late answer is ignored (the switch, Test, Sign out)", async () => {
    fakeTime();
    const svc = useSvc(SET);
    await show(svc);
    const stayGate = held<boolean>();
    const openGate = held<boolean>();
    const outGate = held<boolean>();
    fake.shell!.setStaySignedIn.mockReturnValueOnce(stayGate.p);
    fake.shell!.openLibraryWindow.mockReturnValueOnce(openGate.p);
    fake.shell!.signOutOfLibrary.mockReturnValueOnce(outGate.p);
    // The switch: while out, Save says why it waits.
    await act(async () => stay().click());
    expect(stay().getAttribute("aria-busy")).toBe("true");
    expect(described(btn("Save"))).toContain(T.waitStay);
    await act(async () => btn("Save").click());
    expect(liveText()).toBe(T.waitStay);
    await act(async () => btn("Test").click());
    await act(async () => btn("Sign out of my library").click());
    await waitFor(() => expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1));
    await pass(MINUTE_AND_A_BIT);
    await waitFor(() => expect(screen.getByTestId("yl-stay-note").textContent).toBe(T.appSilent));
    expect(screen.getByTestId("yl-test-result").textContent).toBe(T.appSilent);
    expect(screen.getByTestId("yl-signout-result").textContent).toBe(T.appSilent);
    expect(stay().getAttribute("aria-busy")).toBeNull();
    expect(stay().checked).toBe(false);
    expect(btn("Test").getAttribute("aria-busy")).toBeNull();
    expect(btn("Sign out of my library").getAttribute("aria-busy")).toBeNull();
    expect(btn("Save").getAttribute("aria-disabled")).toBeNull();
    // The late answers: no save of the switch, no window remembered, nothing said.
    const live = liveText();
    await act(async () => {
      stayGate.release(true);
      openGate.release(true);
      outGate.release(true);
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(svc.count("PUT", "/settings/your-library")).toBe(0);
    expect(liveText()).toBe(live);
    expect(screen.getByTestId("yl-test-result").textContent).toBe(T.appSilent);
    // The window that opened late is this screen's own (R341 b): its closing is said.
    const t = fake.shell!.openLibraryWindow.mock.calls[0]![0];
    act(() => fake.shell!.libraryWindow({ ticket: t, state: "closed" }));
    expect(screen.getByTestId("yl-test-result").textContent).toBe(T.windowClosed);
  });
});

describe("Your library: what is set, and its removal", () => {
  it("the stored address in the service's sentence; Remove makes the draft's address none, saved with the rest", async () => {
    const svc = useSvc({ ...SET, catalogueSearch: "https://catalogue.example.edu/search?q={query}" });
    await show(svc);
    expect(screen.getByTestId("yl-address").textContent).toBe(EZ_SENTENCE);
    expect(nameField().value).toBe("Zorblatt University");
    expect(catField().value).toBe("https://catalogue.example.edu/search?q={query}");
    expect(described(catField()).join(" ")).toContain(T.catalogueHint);
    const user = userEvent.setup();
    await user.click(btn("Remove my library's address"));
    expect(screen.getByTestId("yl-address").textContent).toContain(T.noLibrary);
    expect(screen.getByTestId("yl-address").textContent).toContain(T.notSavedYet);
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(putBodies(svc)).toEqual([{ name: "Zorblatt University", access: null, catalogueSearch: "https://catalogue.example.edu/search?q={query}", staySignedIn: false }]);
    expect(screen.getByTestId("yl-address").textContent).toBe(T.noLibrary);
    expect(screen.queryByRole("button", { name: "Remove my library's address" })).toBeNull();
  });

  it("R336 i: the stored address is named by the service's own sentence, never one the screen makes (a resolver's too)", async () => {
    const odd = "Your library's address: <b>named</b> by the service (EZproxy)";
    const svc = useSvc({ ...SET, addressSentence: odd });
    const view = await show(svc);
    expect(screen.getByTestId("yl-address").textContent).toBe(odd);
    expect(document.querySelector("main b")).toBeNull();
    view.unmount();
    const svc2 = useSvc({ ...NOT_SET, access: OU, addressSentence: OU_SENTENCE });
    await show(svc2);
    expect(screen.getByTestId("yl-address").textContent).toBe(OU_SENTENCE);
  });

  it("markup in an institution's name stays text; the fields take at most the shared bounds", async () => {
    const svc = useSvc({ ...SET, name: "<b>Zorblatt</b> & <img src=x onerror=alert(1)>" });
    await show(svc);
    expect(nameField().value).toBe("<b>Zorblatt</b> & <img src=x onerror=alert(1)>");
    expect(document.querySelector("main b, main img")).toBeNull();
    expect(nameField().getAttribute("maxlength")).toBe("200");
    expect(catField().getAttribute("maxlength")).toBe(String(YOUR_LIBRARY_CATALOGUE_MAX));
  });
});

describe("Your library: Stay signed in, at once (R335 a, R336 e, l, m, n)", () => {
  it("the shell first; on true ONE save of the settings as last saved with the new value, Saved.; the draft and Discard never touch it", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    await user.type(nameField(), " DRAFT");
    fake.shell!.setStaySignedIn.mockResolvedValue(true);
    const h = heard();
    await user.click(stay());
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(fake.shell!.setStaySignedIn.mock.calls).toEqual([[true]]);
    expect(putBodies(svc)).toEqual([{ name: "Zorblatt University", access: EZ, catalogueSearch: null, staySignedIn: true }]);
    expect(stay().checked).toBe(true);
    expect(h.said).toEqual([T.saved]);
    h.stop();
    // The draft is still the draft; Discard leaves the switch as it is and asks the shell nothing.
    expect(nameField().value).toBe("Zorblatt University DRAFT");
    await user.click(btn("Discard changes"));
    expect(stay().checked).toBe(true);
    expect(fake.shell!.setStaySignedIn).toHaveBeenCalledTimes(1);
    // A save of the draft sends the saved value of the switch, never another.
    await user.type(nameField(), "!");
    await act(async () => new Promise((r) => setTimeout(r, 600)));
    await user.click(btn("Save"));
    await waitFor(() => expect(svc.count("PUT", "/settings/your-library")).toBe(2));
    expect(putBodies(svc)[1].staySignedIn).toBe(true);
  });

  it("R341 a (N1): pressed while a Save is out, the switch sends nothing and says why, by the switch and in the status region", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const gate = held<void>();
    svc.onPut = async () => {
      await gate.p;
      return undefined;
    };
    const user = userEvent.setup();
    await user.click(btn("Save"));
    await waitFor(() => expect(svc.count("PUT", "/settings/your-library")).toBe(1));
    await user.click(stay());
    expect(fake.shell!.setStaySignedIn).not.toHaveBeenCalled();
    expect(liveText()).toBe("Wait until your changes are saved.");
    expect(described(stay())).toContain("Wait until your changes are saved.");
    expect(svc.count("PUT", "/settings/your-library")).toBe(1);
    gate.release();
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(described(stay())).not.toContain("Wait until your changes are saved.");
  });

  it("on a Mac, a false or failing answer of the shell: “Stay signed in” could not be changed. Try again. — never Only on a Mac; nothing saved", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    await user.click(stay());
    await waitFor(() => expect(screen.getByTestId("yl-stay-note").textContent).toBe(T.stayNotChanged));
    expect(liveText()).toBe(T.stayNotChanged);
    expect(stay().checked).toBe(false);
    expect(document.body.textContent).not.toContain(T.onlyOnMac);
    fake.shell!.setStaySignedIn.mockRejectedValueOnce(new Error("no"));
    await user.click(stay());
    await waitFor(() => expect(fake.shell!.setStaySignedIn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(stay().getAttribute("aria-busy")).toBeNull());
    expect(screen.getByTestId("yl-stay-note").textContent).toBe(T.stayNotChanged);
    expect(svc.count("PUT", "/settings/your-library")).toBe(0);
  });

  it("in the desktop app off a Mac: unavailable from the start with Only on a Mac, still reachable by Tab; a press says why and asks nothing", async () => {
    setPlatform("Linux x86_64");
    expect(onAMac()).toBe(false);
    const svc = useSvc(SET);
    await show(svc);
    expect(stay().getAttribute("aria-disabled")).toBe("true");
    expect(stay().disabled).toBe(false);
    expect(described(stay())).toContain(T.onlyOnMac);
    expect(described(stay())).not.toContain(T.stayHint);
    const user = userEvent.setup();
    catField().focus();
    await user.tab();
    expect(document.activeElement).toBe(stay());
    await user.keyboard(" ");
    expect(liveText()).toBe(T.onlyOnMac);
    expect(stay().checked).toBe(false);
    expect(fake.shell!.setStaySignedIn).not.toHaveBeenCalled();
  });

  it("a Mac is told by the browser's own platform: userAgentData where there is one, else navigator.platform", () => {
    setPlatform("MacIntel");
    expect(onAMac()).toBe(true);
    setPlatform("Win32");
    expect(onAMac()).toBe(false);
    Object.defineProperty(navigator, "userAgentData", { value: { platform: "macOS" }, configurable: true });
    try {
      expect(onAMac()).toBe(true);
    } finally {
      delete (navigator as { userAgentData?: unknown }).userAgentData;
    }
  });

  it("outside the desktop app: the switch, Test and Sign out are unavailable, each with Only in the desktop app, reachable and saying why; the rest works", async () => {
    fake.shell = undefined;
    const svc = useSvc(SET);
    await show(svc);
    expect(stay().getAttribute("aria-disabled")).toBe("true");
    expect(stay().disabled).toBe(false);
    expect(described(stay())).toContain(T.onlyDesktop);
    for (const name of ["Test", "Sign out of my library"]) {
      expect(btn(name).getAttribute("aria-disabled")).toBe("true");
      expect(described(btn(name))).toContain(T.onlyDesktop);
    }
    const user = userEvent.setup();
    const h = heard();
    await user.click(stay());
    await user.click(btn("Test"));
    await user.click(btn("Sign out of my library"));
    expect(h.said).toEqual([T.onlyDesktop, T.onlyDesktop, T.onlyDesktop]);
    h.stop();
    expect(svc.count("POST", "/settings/your-library/test")).toBe(0);
    await user.click(linkField());
    await user.paste(LINK);
    await user.click(btn("Work out the address"));
    await waitFor(() => expect(screen.getByTestId("yl-derived").textContent).toBe(EZ_SENTENCE));
    await user.type(catField(), "https://catalogue.example.edu/?q={{query}");
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(putBodies(svc)[0].catalogueSearch).toBe("https://catalogue.example.edu/?q={query}");
  });

  it("the save of the switch refused: the shell is put back (and that checked), the switch shows what is true, the service's sentence is said", async () => {
    const svc = useSvc(SET);
    await show(svc);
    fake.shell!.setStaySignedIn.mockResolvedValue(true);
    svc.onPut = async () => HttpResponse.json({ error: { code: "INTERNAL", message: "The settings file could not be written." } }, { status: 500 });
    const user = userEvent.setup();
    await user.click(stay());
    await waitFor(() => expect(screen.getByTestId("yl-stay-note").textContent).toBe("The settings file could not be written."));
    expect(fake.shell!.setStaySignedIn.mock.calls).toEqual([[true], [false]]);
    expect(stay().checked).toBe(false);
    expect(liveText()).toBe("The settings file could not be written.");
  });

  it("the shell does not take the going back: it is said, with what to do", async () => {
    const svc = useSvc(SET);
    await show(svc);
    fake.shell!.setStaySignedIn.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    svc.onPut = async () => HttpResponse.json({ error: { code: "INTERNAL", message: "No." } }, { status: 500 });
    const user = userEvent.setup();
    await user.click(stay());
    await waitFor(() => expect(screen.getByTestId("yl-stay-note").textContent).toBe(T.stayNotPutBack));
    expect(liveText()).toBe(T.stayNotPutBack);
    expect(T.stayNotPutBack).toBe("“Stay signed in” could not be put back, so the sign-in window may keep your sign-in. Use “Sign out of my library” to remove it.");
  });

  it("PE: the screen left while the shell is asked — the sequence goes on: the setting is saved", async () => {
    const svc = useSvc(SET);
    const view = await show(svc);
    const gate = held<boolean>();
    fake.shell!.setStaySignedIn.mockReturnValueOnce(gate.p);
    await act(async () => stay().click());
    view.unmount();
    await act(async () => gate.release(true));
    await waitFor(() => expect(svc.count("PUT", "/settings/your-library")).toBe(1));
    expect(putBodies(svc)[0]).toEqual({ name: "Zorblatt University", access: EZ, catalogueSearch: null, staySignedIn: true });
    expect(svc.settings.staySignedIn).toBe(true);
  });

  it("PF: the screen left while the save is out and it fails — the shell is still put back", async () => {
    const svc = useSvc(SET);
    const view = await show(svc);
    fake.shell!.setStaySignedIn.mockResolvedValue(true);
    const gate = held();
    svc.onPut = async () => {
      await gate.p;
      return HttpResponse.json({ error: { code: "INTERNAL", message: "No." } }, { status: 500 });
    };
    await act(async () => stay().click());
    await waitFor(() => expect(svc.count("PUT", "/settings/your-library")).toBe(1));
    view.unmount();
    await act(async () => gate.release());
    await waitFor(() => expect(fake.shell!.setStaySignedIn.mock.calls).toEqual([[true], [false]]));
  });

  it("R336 n: a save that replaces an unreadable file first switches the shell's side off; if the shell refuses, nothing is saved and it is said", async () => {
    const svc = useSvc({ ...NOT_SET, problem: { code: "unreadable", text: YOUR_LIBRARY_TEXT.unreadable } });
    await show(svc);
    const user = userEvent.setup();
    await user.click(btn("Save"));
    await waitFor(() => expect(screen.getByTestId("yl-save-error").textContent).toBe(T.stayNotChanged));
    expect(fake.shell!.setStaySignedIn.mock.calls).toEqual([[false]]);
    expect(svc.count("PUT", "/settings/your-library")).toBe(0);
    fake.shell!.setStaySignedIn.mockResolvedValueOnce(true);
    await act(async () => new Promise((r) => setTimeout(r, 600)));
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(fake.shell!.setStaySignedIn.mock.calls).toEqual([[false], [false]]);
    expect(putBodies(svc)).toEqual([{ name: "", access: null, catalogueSearch: null, staySignedIn: false }]);
  });

  it("R336 n outside the desktop app: there is no shell to ask; the unreadable file is replaced", async () => {
    fake.shell = undefined;
    const svc = useSvc({ ...NOT_SET, problem: { code: "unreadable", text: YOUR_LIBRARY_TEXT.unreadable } });
    await show(svc);
    const user = userEvent.setup();
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(screen.queryByTestId("yl-problem")).toBeNull();
  });
});

describe("Your library: draft and save (as Search sources)", () => {
  it("the PUT is the whole draft, once for a double click; Saved. said once (heard over time); focus stays on Save", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    await user.clear(nameField());
    await user.type(nameField(), "  Université de Zorblatt ");
    const save = btn("Save");
    const h = heard();
    await user.dblClick(save);
    await waitFor(() => expect(liveText()).toBe(T.saved));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(h.said).toEqual([T.saved]);
    h.stop();
    expect(document.activeElement).toBe(save);
    expect(svc.count("PUT", "/settings/your-library")).toBe(1);
    expect(Object.keys(putBodies(svc)[0]).sort()).toEqual(["access", "catalogueSearch", "name", "staySignedIn"]);
    expect(putBodies(svc)[0].name).toBe("  Université de Zorblatt ");
    expect(nameField().value).toBe("Université de Zorblatt");
  });

  it("a refused field gets the service's sentence and the focus (the catalogue's address; the name)", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    svc.onPut = async () => HttpResponse.json({ error: { code: "VALIDATION", message: YOUR_LIBRARY_TEXT.catalogueSearch } }, { status: 400 });
    await user.type(catField(), "http://x.example.edu/?q={{query}");
    await user.click(btn("Save"));
    await waitFor(() => expect(document.activeElement).toBe(catField()));
    expect(described(catField())).toContain(YOUR_LIBRARY_TEXT.catalogueSearch);
    expect(catField().getAttribute("aria-invalid")).toBe("true");
    expect(catField().value).toBe("http://x.example.edu/?q={query}");
    svc.onPut = async () => HttpResponse.json({ error: { code: "VALIDATION", message: YOUR_LIBRARY_TEXT.name } }, { status: 400 });
    await act(async () => new Promise((r) => setTimeout(r, 600)));
    await user.click(btn("Save"));
    await waitFor(() => expect(document.activeElement).toBe(nameField()));
    expect(described(nameField())).toContain(YOUR_LIBRARY_TEXT.name);
    expect(liveText()).not.toBe(T.saved);
  });

  it("while a save is out the form is inert; given up at 60 s with the draft kept and said ONCE (by the alert); a late answer is dropped", async () => {
    fakeTime();
    const svc = useSvc(SET);
    await show(svc);
    const gate = held();
    svc.onPut = async () => {
      await gate.p;
      return HttpResponse.json({ ...SET, name: "late" });
    };
    const h = heard();
    await act(async () => {
      fireEvent.change(nameField(), { target: { value: "New name" } });
    });
    await act(async () => btn("Save").click());
    await waitFor(() => expect(svc.count("PUT", "/settings/your-library")).toBe(1));
    expect(nameField().disabled).toBe(true);
    expect(catField().disabled).toBe(true);
    expect(btn("Work out the address").disabled).toBe(true);
    expect(btn("Save").getAttribute("aria-disabled")).toBe("true");
    await pass(59_000);
    expect(screen.queryByTestId("yl-save-error")).toBeNull();
    await pass(2_000);
    await waitFor(() => expect(screen.getByTestId("yl-save-error").textContent).toBe(T.saveTimedOut));
    expect(screen.getByTestId("yl-save-error").getAttribute("role")).toBe("alert");
    expect(h.said).not.toContain(T.saveTimedOut);
    expect(screen.getAllByText(T.saveTimedOut)).toHaveLength(1);
    expect(nameField().disabled).toBe(false);
    expect(nameField().value).toBe("New name");
    await act(async () => {
      gate.release();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(nameField().value).toBe("New name");
    expect(h.said).not.toContain(T.saved);
    h.stop();
  });

  it("Discard changes puts back what the service holds", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    expect(btn("Discard changes").disabled).toBe(true);
    await user.type(nameField(), " extra");
    await user.click(btn("Remove my library's address"));
    await user.click(btn("Discard changes"));
    expect(nameField().value).toBe("Zorblatt University");
    expect(screen.getByTestId("yl-address").textContent).toBe(EZ_SENTENCE);
    expect(svc.count("PUT", "/settings/your-library")).toBe(0);
  });

  it("PA: a newer file meanwhile (409): the draft is dropped; the screen shows the file the service read, read-only", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    await user.type(nameField(), " DRAFTNAME");
    svc.settings = { ...NOT_SET, name: "FILE", problem: { code: "newer", text: YOUR_LIBRARY_TEXT.newer } };
    await user.click(btn("Save"));
    await waitFor(() => expect(screen.getByTestId("yl-problem").textContent).toBe(YOUR_LIBRARY_TEXT.newer));
    expect(svc.count("GET", "/settings/your-library")).toBe(2);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByTestId("yl-name").textContent).toBe("FILE");
    expect(document.body.textContent).not.toContain("DRAFTNAME");
    expect(screen.getByTestId("yl-address").textContent).toBe(T.noLibrary);
    expect(described(btn("Test"))).toContain(T.testNoLibrary);
    expect(described(btn("Test"))).not.toContain(T.saveFirst);
  });

  it("of a read and a save, the answer that came later wins: a read started before the switch's save answered is dropped", async () => {
    const svc = useSvc(SET);
    await show(svc);
    // A save refused as newer is followed by a read; that read is held while the switch's own save answers.
    let firstPut = true;
    svc.onPut = async () => {
      if (!firstPut) return undefined;
      firstPut = false;
      return HttpResponse.json({ error: { code: "CONFLICT", message: YOUR_LIBRARY_TEXT.newer } }, { status: 409 });
    };
    const gate = held();
    let holdRead = true;
    svc.onGet = async () => {
      if (!holdRead) return undefined;
      holdRead = false;
      const before = structuredClone(svc.settings);
      await gate.p;
      return HttpResponse.json({ ...before, name: "STALE READ" });
    };
    fake.shell!.setStaySignedIn.mockResolvedValue(true);
    const user = userEvent.setup();
    await user.type(nameField(), "!");
    await user.click(btn("Save"));
    await waitFor(() => expect(svc.count("GET", "/settings/your-library")).toBe(2));
    await user.click(stay());
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(stay().checked).toBe(true);
    await act(async () => {
      gate.release();
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(stay().checked).toBe(true);
    expect(nameField().value).toBe("Zorblatt University");
  });
});

describe("Your library: the settings file", () => {
  it("a newer file: the fields are shown as text, nothing that would be refused can be pressed, the service's sentence is shown", async () => {
    const svc = useSvc({ ...NOT_SET, name: "<i>Old</i>", problem: { code: "newer", text: YOUR_LIBRARY_TEXT.newer } });
    render(<YourLibrary client={testClient()} />);
    expect((await screen.findByTestId("yl-problem")).textContent).toBe(YOUR_LIBRARY_TEXT.newer);
    expect(svc.count("GET", "/settings/your-library")).toBe(1);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("switch")).toBeNull();
    for (const name of ["Save", "Discard changes", "Work out the address", "Remove my library's address"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(btn("Test").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("yl-name").textContent).toBe("<i>Old</i>");
    expect(document.querySelector("main i")).toBeNull();
    expect(screen.getByText(`${T.stayLabel}: ${T.off}`)).toBeTruthy();
  });

  it("an unreadable file: the service's sentence, and a save replaces it (the shell's side switched off first)", async () => {
    const svc = useSvc({ ...NOT_SET, problem: { code: "unreadable", text: YOUR_LIBRARY_TEXT.unreadable } });
    await show(svc);
    expect(screen.getByTestId("yl-problem").textContent).toBe(YOUR_LIBRARY_TEXT.unreadable);
    fake.shell!.setStaySignedIn.mockResolvedValue(true);
    const user = userEvent.setup();
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(fake.shell!.setStaySignedIn.mock.calls).toEqual([[false]]);
    expect(screen.queryByTestId("yl-problem")).toBeNull();
  });

  it("a read that fails: the service's sentence", async () => {
    useSvc();
    server.use(http.get(url("/settings/your-library"), () => HttpResponse.json({ error: { code: "INTERNAL", message: "The service could not read this." } }, { status: 500 })));
    render(<YourLibrary client={testClient()} />);
    expect((await screen.findByRole("alert")).textContent).toBe("The service could not read this.");
  });
});

describe("Your library: Test (R334 b, R336 d)", () => {
  it("asks the service for the address, then opens the window with a ticket of the page's own (32 lower-case hex, new each press, never shown) and the address only", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const win = realWindow(fake.shell!);
    expect(screen.getByText(T.testNote)).toBeTruthy();
    // The ticket is the browser's random source's bytes, in lower-case hex: the first press gets these bytes.
    const real = crypto.getRandomValues.bind(crypto);
    let first = true;
    const rng = vi.spyOn(crypto, "getRandomValues").mockImplementation(<A extends ArrayBufferView | null>(a: A): A => {
      if (first && a instanceof Uint8Array && a.length === 16) {
        first = false;
        a.set(Array.from({ length: 16 }, (_, i) => i * 17));
        return a;
      }
      return real(a as never) as A;
    });
    const user = userEvent.setup();
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    expect(svc.sent.filter((s) => s.path === "/settings/your-library/test").map((s) => [s.method, s.body])).toEqual([["POST", ""]]);
    win.close();
    await user.click(btn("Test"));
    await waitFor(() => expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(2));
    const calls = fake.shell!.openLibraryWindow.mock.calls;
    for (const c of calls) {
      expect(c).toHaveLength(3);
      expect(c[0]).toMatch(/^[0-9a-f]{32}$/);
      expect(c[1]).toBe(TEST_URL);
      expect(c[2]).toBe("library");
    }
    expect(calls[0]![0]).toBe("00112233445566778899aabbccddeeff");
    expect(calls[0]![0]).not.toBe(calls[1]![0]);
    expect(rng).toHaveBeenCalled();
    const page = document.documentElement.outerHTML;
    for (const c of calls) expect(page).not.toContain(c[0]);
    expect(page).not.toContain(TEST_URL);
    expect(page).not.toContain("171737a0");
  });

  it("the shell refused: its sentence; the service refused: its sentence; the window closed for ITS ticket only: said once (heard over time)", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowRefused));
    expect(screen.getByTestId("yl-test-result").textContent).toBe(T.windowRefused);
    svc.onTest = async () => HttpResponse.json({ error: { code: "CONFLICT", message: YOUR_LIBRARY_TEXT.unreadable } }, { status: 409 });
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(YOUR_LIBRARY_TEXT.unreadable));
    expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1);
    svc.onTest = undefined;
    const win = realWindow(fake.shell!);
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    const ticket = win.w.open!;
    const h = heard();
    // Another ticket's events, and states other than "closed" and "handed-over", say nothing.
    act(() => fake.shell!.libraryWindow({ ticket: "f".repeat(32), state: "closed" }));
    act(() => fake.shell!.libraryWindow({ ticket: "f".repeat(32), state: "handed-over" }));
    act(() => fake.shell!.libraryWindow({ ticket, state: "fetching" }));
    act(() => fake.shell!.libraryWindow({ ticket, state: "not-a-pdf" }));
    expect(h.said).toEqual([]);
    win.close(ticket);
    await waitFor(() => expect(liveText()).toBe(T.windowClosed));
    act(() => fake.shell!.libraryWindow({ ticket, state: "closed" }));
    act(() => fake.shell!.libraryWindow({ ticket: null, state: "closed" }));
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(h.said).toEqual([T.windowClosed]);
    h.stop();
    expect(screen.getByTestId("yl-test-result").textContent).toBe(T.windowClosed);
  });

  it("while its own window is open, a press says it is already open and opens nothing; reaching a PDF is said, and the window is still remembered until it closes", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const win = realWindow(fake.shell!);
    const user = userEvent.setup();
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    await user.click(btn("Test"));
    expect(liveText()).toBe(T.windowAlreadyOpen);
    expect(screen.getByTestId("yl-test-result").textContent).toBe(T.windowAlreadyOpen);
    expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1);
    expect(svc.count("POST", "/settings/your-library/test")).toBe(1);
    win.handOver();
    await waitFor(() => expect(liveText()).toBe(T.windowReachedPdf));
    expect(T.windowReachedPdf).toBe("Signing in works: the window reached a PDF. Nothing was added to your library.");
    // The ticket ended with the hand-over but the window is still there (R341 b): a press says so; after its closing a press opens again.
    await user.click(btn("Test"));
    expect(liveText()).toBe(T.windowAlreadyOpen);
    expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1);
    act(() => fake.shell!.libraryWindow({ ticket: null, state: "closed" }));
    await waitFor(() => expect(liveText()).toBe(T.windowClosed));
    await user.click(btn("Test"));
    await waitFor(() => expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(2));
    expect(liveText()).toBe(T.windowOpen);
  });

  it("closed with no ticket while its ticket is remembered is said; a failed Sign out does not forget the window; a good one is said by its own sentence only", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const win = realWindow(fake.shell!);
    const user = userEvent.setup();
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    win.close(null);
    await waitFor(() => expect(liveText()).toBe(T.windowClosed));
    // Open again; a sign-out that fails keeps the window in mind: its later close is said.
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    fake.shell!.signOutOfLibrary.mockResolvedValueOnce(false);
    await user.click(btn("Sign out of my library"));
    await waitFor(() => expect(liveText()).toBe(T.signOutFailed));
    await user.click(btn("Test"));
    expect(liveText()).toBe(T.windowAlreadyOpen);
    win.close();
    await waitFor(() => expect(liveText()).toBe(T.windowClosed));
    // A sign-out that works closes the window: said once, by the sign-out's sentence.
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    const h = heard();
    await user.click(btn("Sign out of my library"));
    await waitFor(() => expect(liveText()).toBe(T.signedOut));
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(h.said).toEqual([T.signedOut]);
    h.stop();
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
  });

  it("R341 b (N2): a Test given up, the shell opens the window late — the next Test says it is already open, opens nothing, and the closing is said once", async () => {
    fakeTime();
    const svc = useSvc(SET);
    await show(svc);
    const gate = held<void>();
    const win = realWindow(fake.shell!);
    const real = fake.shell!.openLibraryWindow.getMockImplementation()!;
    fake.shell!.openLibraryWindow.mockImplementationOnce(async (ticket, address, from) => {
      await gate.p;
      return real(ticket, address, from);
    });
    await act(async () => btn("Test").click());
    await waitFor(() => expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1));
    await pass(MINUTE_AND_A_BIT);
    await waitFor(() => expect(screen.getByTestId("yl-test-result").textContent).toBe(T.appSilent));
    // The shell opens the window after all.
    await act(async () => {
      gate.release();
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(win.w.open).not.toBeNull();
    const posts = svc.count("POST", "/settings/your-library/test");
    await act(async () => btn("Test").click());
    expect(liveText()).toBe(T.windowAlreadyOpen);
    expect(screen.getByTestId("yl-test-result").textContent).toBe(T.windowAlreadyOpen);
    expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1);
    expect(svc.count("POST", "/settings/your-library/test")).toBe(posts);
    const h = heard();
    win.close();
    await waitFor(() => expect(liveText()).toBe(T.windowClosed));
    act(() => fake.shell!.libraryWindow({ ticket: null, state: "closed" }));
    await pass(30);
    expect(h.said).toEqual([T.windowClosed]);
    h.stop();
    // After the closing a Test works again.
    await act(async () => btn("Test").click());
    await waitFor(() => expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
  });

  it("R341 b (N3): the window reached a PDF (its ticket ended), then closed with no ticket — said once; a second Test works after", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const win = realWindow(fake.shell!);
    const user = userEvent.setup();
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    win.handOver();
    await waitFor(() => expect(liveText()).toBe(T.windowReachedPdf));
    // The shell ended the ticket, but the window is still there: Test says so and opens nothing.
    await user.click(btn("Test"));
    expect(liveText()).toBe(T.windowAlreadyOpen);
    expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(1);
    const h = heard();
    act(() => fake.shell!.libraryWindow({ ticket: null, state: "closed" }));
    await waitFor(() => expect(liveText()).toBe(T.windowClosed));
    act(() => fake.shell!.libraryWindow({ ticket: null, state: "closed" }));
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(h.said).toEqual([T.windowClosed]);
    h.stop();
    expect(screen.getByTestId("yl-test-result").textContent).toBe(T.windowClosed);
    await user.click(btn("Test"));
    await waitFor(() => expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(2));
  });

  it("R341 b: a closed with no ticket while no test of this screen is open says nothing; nor does a closed for another ticket", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const win = realWindow(fake.shell!);
    const h = heard();
    act(() => fake.shell!.libraryWindow({ ticket: null, state: "closed" }));
    act(() => fake.shell!.libraryWindow({ ticket: "a".repeat(32), state: "closed" }));
    const user = userEvent.setup();
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    act(() => fake.shell!.libraryWindow({ ticket: "a".repeat(32), state: "closed" }));
    win.close();
    await waitFor(() => expect(liveText()).toBe(T.windowClosed));
    act(() => fake.shell!.libraryWindow({ ticket: null, state: "closed" }));
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(h.said).toEqual([T.windowOpen, T.windowClosed]);
    h.stop();
  });

  it("unavailable while a draft is unsaved (Save your changes first.) and when no library is set; a press says why", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    await user.type(nameField(), "!");
    expect(btn("Test").getAttribute("aria-disabled")).toBe("true");
    expect(described(btn("Test"))).toContain(T.saveFirst);
    await user.click(btn("Test"));
    expect(liveText()).toBe(T.saveFirst);
    expect(svc.count("POST", "/settings/your-library/test")).toBe(0);
    await user.click(btn("Remove my library's address"));
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(btn("Test").getAttribute("aria-disabled")).toBe("true");
    expect(described(btn("Test"))).toContain(T.testNoLibrary);
    await user.click(btn("Test"));
    expect(liveText()).toBe(T.testNoLibrary);
    expect(svc.count("POST", "/settings/your-library/test")).toBe(0);
    expect(fake.shell!.openLibraryWindow).not.toHaveBeenCalled();
  });

  it("the address arriving after leaving the screen opens no window", async () => {
    const svc = useSvc(SET);
    const view = await show(svc);
    const gate = held();
    svc.onTest = async () => {
      await gate.p;
      return undefined;
    };
    fake.shell!.openLibraryWindow.mockResolvedValue(true);
    const user = userEvent.setup();
    await user.click(btn("Test"));
    await waitFor(() => expect(svc.count("POST", "/settings/your-library/test")).toBe(1));
    view.unmount();
    await act(async () => {
      gate.release();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(fake.shell!.openLibraryWindow).not.toHaveBeenCalled();
  });

  it("the window's listener is removed on leaving — also when the screen is left before the listening began", async () => {
    const svc = useSvc(SET);
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    fake.shell!.onLibraryWindow.mockImplementation(async () => {
      const s = vi.fn();
      stops.push(s);
      return s;
    });
    const view = await show(svc);
    await waitFor(() => expect(stops).toHaveLength(1));
    view.unmount();
    expect(stops[0]).toHaveBeenCalledTimes(1);
    // Left at once: the stop arrives after the leaving, and is called then.
    const gate = held<() => void>();
    fake.shell!.onLibraryWindow.mockReturnValueOnce(gate.p);
    const quick = render(<YourLibrary client={testClient()} />);
    quick.unmount();
    const late = vi.fn();
    await act(async () => gate.release(late));
    expect(late).toHaveBeenCalledTimes(1);
  });
});

describe("Your library: Sign out of my library", () => {
  it("true and false each say their sentence; one request per press; the button says it is working meanwhile", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const gate = held<boolean>();
    fake.shell!.signOutOfLibrary.mockReturnValueOnce(gate.p);
    const user = userEvent.setup();
    await user.click(btn("Sign out of my library"));
    expect(btn("Signing out…").getAttribute("aria-busy")).toBe("true");
    await user.click(btn("Signing out…"));
    await user.click(btn("Signing out…"));
    expect(fake.shell!.signOutOfLibrary).toHaveBeenCalledTimes(1);
    await act(async () => gate.release(true));
    await waitFor(() => expect(liveText()).toBe(T.signedOut));
    expect(screen.getByTestId("yl-signout-result").textContent).toBe(T.signedOut);
    fake.shell!.signOutOfLibrary.mockResolvedValueOnce(false);
    await user.click(btn("Sign out of my library"));
    await waitFor(() => expect(liveText()).toBe(T.signOutFailed));
    expect(fake.shell!.signOutOfLibrary).toHaveBeenCalledTimes(2);
    expect(svc.sent.filter((s) => s.method !== "GET")).toEqual([]);
  });
});

describe("Your library: sentences (R334 d) and keyboard", () => {
  it("no sentence of the screen says the app adds a file by itself; the new sentences are word for word", () => {
    // The sentences that name adding say that nothing is (or was) added; no other sentence speaks of adding at all.
    for (const t of Object.values(T)) expect(t.replace("Nothing is added to your library.", "").replace("Nothing was added to your library.", "")).not.toMatch(/\badd(s|ed|ing)?\b/i);
    expect(T.testNote).toBe("This opens your library's sign-in in a separate window, with one well-known article, so that you can see whether signing in works there. Nothing is added to your library.");
    expect([T.deriveSilent, T.appSilent, T.waitDerive, T.waitStay, T.windowAlreadyOpen, T.stayNotChanged]).toEqual([
      "The service did not answer, so the link was not used. Paste it again.",
      "The app did not answer. Try again.",
      "Wait until the address is worked out.",
      "Wait until “Stay signed in” is changed.",
      "The sign-in window is already open.",
      "“Stay signed in” could not be changed. Try again.",
    ]);
  });

  it("the whole screen by keyboard: every control reached by Tab in order, and worked with Enter and Space", async () => {
    const svc = useSvc(SET);
    await show(svc);
    fake.shell!.setStaySignedIn.mockResolvedValue(true);
    realWindow(fake.shell!);
    const user = userEvent.setup();
    const order = [nameField(), linkField(), btn("Work out the address"), btn("Remove my library's address"), catField(), stay(), btn("Save"), btn("Discard changes"), btn("Test"), btn("Sign out of my library")];
    // Discard is disabled with nothing to discard: it is skipped.
    const reachable = order.filter((el) => !(el as HTMLButtonElement).disabled);
    (document.activeElement as HTMLElement | null)?.blur();
    const seen: Element[] = [];
    for (let i = 0; i < reachable.length; i++) {
      await user.tab();
      seen.push(document.activeElement!);
    }
    expect(seen).toEqual(reachable);
    // Work them.
    linkField().focus();
    await user.paste(LINK);
    await user.tab();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("yl-derived").textContent).toBe(EZ_SENTENCE));
    btn("Save").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(liveText()).toBe(T.saved));
    stay().focus();
    await user.keyboard(" ");
    await waitFor(() => expect(stay().checked).toBe(true));
    await waitFor(() => expect(svc.count("PUT", "/settings/your-library")).toBe(2));
    btn("Test").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    btn("Sign out of my library").focus();
    await user.keyboard(" ");
    await waitFor(() => expect(liveText()).toBe(T.signedOut));
  });
});

describe("Your library: the contract (each request exactly as the handler takes it)", () => {
  it("GET no body; PUT the four fields; derive { link } only; test no body; the switch's own save", async () => {
    const svc = useSvc(SET);
    await show(svc);
    realWindow(fake.shell!);
    fake.shell!.setStaySignedIn.mockResolvedValue(true);
    const user = userEvent.setup();
    await user.click(linkField());
    await user.paste(LINK);
    await user.click(btn("Work out the address"));
    await waitFor(() => expect(screen.getByTestId("yl-derived").textContent).toBe(EZ_SENTENCE));
    await user.type(catField(), "https://catalogue.example.edu/?q={{query}");
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    await user.click(stay());
    await waitFor(() => expect(svc.count("PUT", "/settings/your-library")).toBe(2));
    expect(svc.sent.map((s) => [s.method, s.path, s.search, s.body === "" ? "" : JSON.parse(s.body)])).toEqual([
      ["GET", "/settings/your-library", "", ""],
      ["POST", "/settings/your-library/derive", "", { link: LINK }],
      ["PUT", "/settings/your-library", "", { name: "Zorblatt University", access: EZ, catalogueSearch: "https://catalogue.example.edu/?q={query}", staySignedIn: false }],
      ["POST", "/settings/your-library/test", "", ""],
      ["PUT", "/settings/your-library", "", { name: "Zorblatt University", access: EZ, catalogueSearch: "https://catalogue.example.edu/?q={query}", staySignedIn: true }],
    ]);
  });
});

describe("Your library: reachable", () => {
  it("the library's settings links name it, and the app shows it at its address", async () => {
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ ...LIBRARIES, current: CURRENT_RW })),
      http.get(url("/settings/appearance"), () => HttpResponse.json(DEFAULT_APPEARANCE)),
      http.get(url("/settings/researcher"), () => HttpResponse.json({ name: null })),
      ...libraryHandlers(),
      http.all(url("/*"), () => HttpResponse.json({ error: { code: "NOT_FOUND", message: "Not in this test's service." } }, { status: 404 })),
    );
    const app = render(<App service={{ baseUrl: BASE, token: TOKEN }} />);
    const link = await screen.findByRole("link", { name: "Your library" });
    expect(link.getAttribute("href")).toBe(PATHS.yourLibrary);
    expect(PATHS.yourLibrary).toBe("/settings/your-library");
    app.unmount();
    server.resetHandlers();
    server.use(
      http.get(url("/settings/appearance"), () => HttpResponse.json(DEFAULT_APPEARANCE)),
      http.all(url("/*"), () => HttpResponse.json({ error: { code: "NOT_FOUND", message: "Not in this test's service." } }, { status: 404 })),
    );
    // Handlers added later take precedence: the screen's own routes over the catch-all.
    useSvc(SET);
    window.history.pushState(null, "", PATHS.yourLibrary);
    try {
      render(<App service={{ baseUrl: BASE, token: TOKEN }} />);
      expect(await screen.findByRole("heading", { level: 1, name: "Your library" })).toBeTruthy();
      expect(within(screen.getByRole("main", { name: "Your library" })).getByTestId("yl-address").textContent).toBe(EZ_SENTENCE);
    } finally {
      window.history.pushState(null, "", "/");
    }
  });
});
