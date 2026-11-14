/**
 * The "Your library" screen (Find and acquire Task F18a; R324, R334, R301) against a mocked service shaped exactly like
 * F15's handlers and F18a's test route (apps/library-service/src/routes/your-library.ts; @ao/shared api/find.ts) and the
 * desktop shell's bridge (src/desktopShell.ts, F16) through its test double: the name, the pasted link (worked out and
 * never kept), the address now set and its removal, the catalogue's address, "Stay signed in", the draft and its save,
 * "Test" (the page's own ticket) and "Sign out of my library", in the desktop app and outside it.
 */
import { FIND_LIBRARY_TEXT, YOUR_LIBRARY_DERIVE_TEXT, YOUR_LIBRARY_TEXT, type LibraryAccess, type YourLibraryResponse } from "@ao/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { PATHS } from "../navigation";
import { fakeShell, type FakeShell } from "../test/desktopShell";
import { BASE, CURRENT_RW, LIBRARIES, TOKEN, libraryHandlers, server, testClient, url, useMockService } from "../test/service";
import { DEFAULT_APPEARANCE } from "../theme/appearance";
import { YOUR_LIBRARY_SCREEN_TEXT as T, YourLibrary } from "./YourLibrary";

const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
vi.mock("../desktopShell", () => ({ desktopShell: () => fake.shell, inDesktopShell: () => !!fake.shell }));

useMockService();

// Made up, recognisable: the library's host, a session's key in the pasted link.
const LIB_HOST = "ezproxy.zorblatt-univ.example.edu";
const SESSION = "SESSIONzorblatt77quux";
const LINK = `https://${LIB_HOST}/login?ticket=${SESSION}&url=https://www.jstor.org/stable/42`;
const EZ: LibraryAccess = { kind: "ezproxy-login", base: `https://${LIB_HOST}/login?url=` };
const EZ_SENTENCE = `Your library's address: ${LIB_HOST} (EZproxy)`;
const TEST_URL = `https://${LIB_HOST}/login?url=https://doi.org/10.1038/171737a0`;
const NOT_SET: YourLibraryResponse = { name: "", access: null, staySignedIn: false };
const SET: YourLibraryResponse = { name: "Zorblatt University", access: EZ, staySignedIn: false };

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
      svc.settings = { name: body.name.trim(), access: body.access, ...(body.catalogueSearch ? { catalogueSearch: body.catalogueSearch } : {}), staySignedIn: body.staySignedIn === true };
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

const liveText = () => screen.getByTestId("yl-live").textContent ?? "";
const nameField = () => screen.getByRole("textbox", { name: "Your institution's name" }) as HTMLInputElement;
const linkField = () => screen.getByRole("textbox", { name: "Paste any link that goes through your library" }) as HTMLInputElement;
const catField = () => screen.getByRole("textbox", { name: "Catalogue search address (optional)" }) as HTMLInputElement;
const stay = () => screen.getByRole("switch", { name: "Stay signed in to my library" }) as HTMLInputElement;
const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const described = (el: HTMLElement) => (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "");
const putBodies = (svc: Svc) => svc.sent.filter((s) => s.method === "PUT").map((s) => JSON.parse(s.body));

async function show(svc: Svc) {
  const view = render(<YourLibrary client={testClient()} />);
  await screen.findByRole("textbox", { name: "Your institution's name" });
  await waitFor(() => expect(svc.count("GET", "/settings/your-library")).toBe(1));
  return view;
}

let consoleCalls: unknown[][] = [];
beforeEach(() => {
  fake.shell = fakeShell();
  consoleCalls = [];
  for (const k of ["log", "info", "warn", "error", "debug", "trace"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void consoleCalls.push(a));
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  fake.shell = undefined;
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
    // The worked-out address is the draft's: said as what will be set, and saved with the rest.
    expect(screen.getByTestId("yl-address").textContent).toContain(EZ_SENTENCE);
    expect(linkField().value).toBe("");
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(putBodies(svc)).toEqual([{ name: "", access: EZ, catalogueSearch: null, staySignedIn: false }]);
  });

  it("Stay signed in is off at first", async () => {
    const svc = useSvc();
    await show(svc);
    expect(stay().checked).toBe(false);
    expect(stay().disabled).toBe(false);
    expect(fake.shell!.setStaySignedIn).not.toHaveBeenCalled();
  });
});

describe("Your library: the pasted link is never kept", () => {
  it("after the answer (worked out or refused) the link is in no element, attribute, storage, address or later request; the field offers no history", async () => {
    const svc = useSvc(SET);
    await show(svc);
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
    fake.shell!.openLibraryWindow.mockResolvedValue(true);
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
    // The shell gets the ticket and the test's address only.
    expect(fake.shell!.openLibraryWindow.mock.calls[0]![1]).toBe(TEST_URL);
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

  it("a link resolver's sentence names its host and path (as the service's derive does)", async () => {
    const svc = useSvc({ ...NOT_SET, access: { kind: "openurl", base: "https://resolver.example.edu/openurl" } });
    await show(svc);
    expect(screen.getByTestId("yl-address").textContent).toBe("Your library's address: resolver.example.edu/openurl (link resolver)");
  });

  it("markup in an institution's name stays text", async () => {
    const svc = useSvc({ ...SET, name: "<b>Zorblatt</b> & <img src=x onerror=alert(1)>" });
    await show(svc);
    expect(nameField().value).toBe("<b>Zorblatt</b> & <img src=x onerror=alert(1)>");
    expect(document.querySelector("main b, main img")).toBeNull();
    expect(nameField().getAttribute("maxlength")).toBe("200");
  });
});

describe("Your library: Stay signed in (R334 c)", () => {
  it("the shell is asked first: true — the draft changes and Save sends it; false for on — Only on a Mac, the switch stays off", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    fake.shell!.setStaySignedIn.mockResolvedValueOnce(false);
    await user.click(stay());
    await waitFor(() => expect(described(stay())).toContain(T.onlyOnMac));
    expect(fake.shell!.setStaySignedIn).toHaveBeenCalledWith(true);
    expect(stay().checked).toBe(false);
    expect(liveText()).toBe(T.onlyOnMac);
    expect(btn("Discard changes").disabled).toBe(true);
    fake.shell!.setStaySignedIn.mockResolvedValueOnce(true);
    await user.click(stay());
    await waitFor(() => expect(stay().checked).toBe(true));
    expect(described(stay())).not.toContain(T.onlyOnMac);
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(putBodies(svc)).toEqual([{ name: "Zorblatt University", access: EZ, catalogueSearch: null, staySignedIn: true }]);
  });

  it("Discard changes puts the shell's setting back as the service holds it", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    fake.shell!.setStaySignedIn.mockResolvedValue(true);
    await user.click(stay());
    await waitFor(() => expect(stay().checked).toBe(true));
    await user.click(btn("Discard changes"));
    expect(stay().checked).toBe(false);
    await waitFor(() => expect(fake.shell!.setStaySignedIn).toHaveBeenLastCalledWith(false));
    expect(svc.count("PUT", "/settings/your-library")).toBe(0);
  });

  it("outside the desktop app: the switch, Test and Sign out are unavailable, each with Only in the desktop app; the rest works", async () => {
    fake.shell = undefined;
    const svc = useSvc(SET);
    await show(svc);
    expect(stay().disabled).toBe(true);
    expect(described(stay())).toContain(T.onlyDesktop);
    for (const name of ["Test", "Sign out of my library"]) {
      expect(btn(name).getAttribute("aria-disabled")).toBe("true");
      expect(described(btn(name))).toContain(T.onlyDesktop);
    }
    const user = userEvent.setup();
    await user.click(btn("Test"));
    await user.click(btn("Sign out of my library"));
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
});

describe("Your library: draft and save (as Search sources)", () => {
  it("the PUT is the whole draft, once for a double click; Saved. said once; focus stays on Save", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    await user.clear(nameField());
    await user.type(nameField(), "  Université de Zorblatt ");
    const save = btn("Save");
    await user.dblClick(save);
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(document.activeElement).toBe(save);
    expect(svc.count("PUT", "/settings/your-library")).toBe(1);
    expect(Object.keys(putBodies(svc)[0]).sort()).toEqual(["access", "catalogueSearch", "name", "staySignedIn"]);
    expect(putBodies(svc)[0].name).toBe("  Université de Zorblatt ");
    expect(nameField().value).toBe("Université de Zorblatt");
    expect(screen.getByTestId("yl-live").querySelectorAll("span")).toHaveLength(1);
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

  it("while a save is out the form is inert; a save with no answer in 60 seconds is given up with the draft kept and a sentence; a late answer is dropped", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    const svc = useSvc(SET);
    await show(svc);
    const gate = held();
    svc.onPut = async () => {
      await gate.p;
      return HttpResponse.json({ ...SET, name: "late" });
    };
    await act(async () => {
      fireEvent.change(nameField(), { target: { value: "New name" } });
    });
    await act(async () => btn("Save").click());
    await waitFor(() => expect(svc.count("PUT", "/settings/your-library")).toBe(1));
    expect(nameField().disabled).toBe(true);
    expect(catField().disabled).toBe(true);
    expect(btn("Work out the address").disabled).toBe(true);
    expect(btn("Save").getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(screen.queryByTestId("yl-save-error")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(screen.getByTestId("yl-save-error").textContent).toBe(T.saveTimedOut));
    expect(nameField().disabled).toBe(false);
    expect(nameField().value).toBe("New name");
    await act(async () => {
      gate.release();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(nameField().value).toBe("New name");
    expect(liveText()).not.toBe(T.saved);
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

  it("a newer file meanwhile (409): its sentence; what the service holds now is read and shown, read-only", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    await user.type(nameField(), " x");
    svc.settings = { ...NOT_SET, problem: { code: "newer", text: YOUR_LIBRARY_TEXT.newer } };
    await user.click(btn("Save"));
    await waitFor(() => expect(screen.getByTestId("yl-problem").textContent).toBe(YOUR_LIBRARY_TEXT.newer));
    expect(svc.count("GET", "/settings/your-library")).toBe(2);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("an answer after leaving the screen is dropped", async () => {
    const svc = useSvc(SET);
    const view = await show(svc);
    const gate = held();
    svc.onDerive = async () => {
      await gate.p;
      return undefined;
    };
    const user = userEvent.setup();
    await user.click(linkField());
    await user.paste(LINK);
    await user.click(btn("Work out the address"));
    await waitFor(() => expect(svc.count("POST", "/settings/your-library/derive")).toBe(1));
    view.unmount();
    await act(async () => {
      gate.release();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(consoleCalls.filter((c) => String(c[0]).includes("unmounted"))).toEqual([]);
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

  it("an unreadable file: the service's sentence, and a save replaces it", async () => {
    const svc = useSvc({ ...NOT_SET, problem: { code: "unreadable", text: YOUR_LIBRARY_TEXT.unreadable } });
    await show(svc);
    expect(screen.getByTestId("yl-problem").textContent).toBe(YOUR_LIBRARY_TEXT.unreadable);
    const user = userEvent.setup();
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(screen.queryByTestId("yl-problem")).toBeNull();
  });

  it("a read that fails: the service's sentence", async () => {
    useSvc();
    server.use(http.get(url("/settings/your-library"), () => HttpResponse.json({ error: { code: "INTERNAL", message: "The service could not read this." } }, { status: 500 })));
    render(<YourLibrary client={testClient()} />);
    expect((await screen.findByRole("alert")).textContent).toBe("The service could not read this.");
  });
});

describe("Your library: Test (R334 b)", () => {
  it("asks the service for the address, then opens the window with a ticket of the page's own (32 lower-case hex, new each press, never shown) and the address only", async () => {
    const svc = useSvc(SET);
    await show(svc);
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
    fake.shell!.openLibraryWindow.mockResolvedValue(true);
    const user = userEvent.setup();
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    expect(svc.sent.filter((s) => s.path === "/settings/your-library/test").map((s) => [s.method, s.body])).toEqual([["POST", ""]]);
    await user.click(btn("Test"));
    await waitFor(() => expect(fake.shell!.openLibraryWindow).toHaveBeenCalledTimes(2));
    const calls = fake.shell!.openLibraryWindow.mock.calls;
    for (const c of calls) {
      expect(c).toHaveLength(2);
      expect(c[0]).toMatch(/^[0-9a-f]{32}$/);
      expect(c[1]).toBe(TEST_URL);
    }
    expect(calls[0]![0]).toBe("00112233445566778899aabbccddeeff");
    expect(calls[0]![0]).not.toBe(calls[1]![0]);
    expect(rng).toHaveBeenCalled();
    const page = document.documentElement.outerHTML;
    for (const c of calls) expect(page).not.toContain(c[0]);
    expect(page).not.toContain(TEST_URL);
    expect(page).not.toContain("171737a0");
  });

  it("the shell refused: its sentence; the service refused: its sentence; the window closed for ITS ticket only: said once", async () => {
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
    fake.shell!.openLibraryWindow.mockResolvedValue(true);
    await user.click(btn("Test"));
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    const ticket = fake.shell!.openLibraryWindow.mock.calls.at(-1)![0];
    // Another ticket's events, and any state but "closed", say nothing.
    act(() => fake.shell!.libraryWindow({ ticket: "f".repeat(32), state: "closed" }));
    act(() => fake.shell!.libraryWindow({ ticket, state: "fetching" }));
    act(() => fake.shell!.libraryWindow({ ticket, state: "handed-over" }));
    expect(liveText()).toBe(T.windowOpen);
    act(() => fake.shell!.libraryWindow({ ticket, state: "closed" }));
    await waitFor(() => expect(liveText()).toBe(T.windowClosed));
    expect(screen.getByTestId("yl-live").querySelectorAll("span")).toHaveLength(1);
    act(() => fake.shell!.libraryWindow({ ticket, state: "closed" }));
    expect(screen.getByTestId("yl-test-result").textContent).toBe(T.windowClosed);
  });

  it("unavailable while a draft is unsaved (Save your changes first.) and when no library is set", async () => {
    const svc = useSvc(SET);
    await show(svc);
    const user = userEvent.setup();
    await user.type(nameField(), "!");
    expect(btn("Test").getAttribute("aria-disabled")).toBe("true");
    expect(described(btn("Test"))).toContain(T.saveFirst);
    await user.click(btn("Test"));
    expect(svc.count("POST", "/settings/your-library/test")).toBe(0);
    await user.click(btn("Remove my library's address"));
    await user.click(btn("Save"));
    await waitFor(() => expect(liveText()).toBe(T.saved));
    expect(btn("Test").getAttribute("aria-disabled")).toBe("true");
    expect(described(btn("Test"))).toContain(T.testNoLibrary);
    await user.click(btn("Test"));
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
  it("no sentence of the screen says the app adds a file by itself", () => {
    // The one sentence that names adding says that nothing is added; no other sentence speaks of adding at all.
    for (const t of Object.values(T)) expect(t.replace("Nothing is added to your library.", "")).not.toMatch(/\badd(s|ed|ing)?\b/i);
    expect(T.testNote).toBe("This opens your library's sign-in in a separate window, with one well-known article, so that you can see whether signing in works there. Nothing is added to your library.");
  });

  it("the whole screen by keyboard: every control reached by Tab in order, and worked with Enter and Space", async () => {
    const svc = useSvc(SET);
    await show(svc);
    fake.shell!.setStaySignedIn.mockResolvedValue(true);
    fake.shell!.openLibraryWindow.mockResolvedValue(true);
    fake.shell!.signOutOfLibrary.mockResolvedValue(true);
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
    stay().focus();
    await user.keyboard(" ");
    await waitFor(() => expect(stay().checked).toBe(true));
    btn("Save").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(liveText()).toBe(T.saved));
    btn("Test").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(liveText()).toBe(T.windowOpen));
    btn("Sign out of my library").focus();
    await user.keyboard(" ");
    await waitFor(() => expect(liveText()).toBe(T.signedOut));
  });
});

describe("Your library: the contract (each request exactly as the handler takes it)", () => {
  it("GET no body; PUT the four fields; derive { link } only; test no body", async () => {
    const svc = useSvc(SET);
    await show(svc);
    fake.shell!.openLibraryWindow.mockResolvedValue(true);
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
    expect(svc.sent.map((s) => [s.method, s.path, s.search, s.body === "" ? "" : JSON.parse(s.body)])).toEqual([
      ["GET", "/settings/your-library", "", ""],
      ["POST", "/settings/your-library/derive", "", { link: LINK }],
      ["PUT", "/settings/your-library", "", { name: "Zorblatt University", access: EZ, catalogueSearch: "https://catalogue.example.edu/?q={query}", staySignedIn: false }],
      ["POST", "/settings/your-library/test", "", ""],
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
