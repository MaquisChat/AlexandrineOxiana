import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { act, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIBRARIES, server, serviceError, testApi, url, useMockService } from "../test/service";
import { LibraryChooser, roomSentence } from "./LibraryChooser";

useMockService();

describe("LibraryChooser", () => {
  it("lists the registered libraries with where they were last seen", async () => {
    server.use(http.get(url("/libraries"), () => HttpResponse.json(LIBRARIES)));
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Libraries" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Thesis library");
    expect(items[0]!.textContent).toContain("/Volumes/Fieldwork SSD/Thesis library");
    expect(within(items[1]!).getByRole("button", { name: "Open Grant 2025" })).toBeTruthy();
  });

  it("each library's name heading takes its direction from the text itself (as D7)", async () => {
    server.use(http.get(url("/libraries"), () => HttpResponse.json({ libraries: [{ libraryId: "lib-ar", name: "مكتبة الأطروحة", lastKnownPaths: ["/home/r/ar"] }] })));
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    const heading = await screen.findByRole("heading", { level: 2, name: "مكتبة الأطروحة" });
    expect(heading.getAttribute("dir")).toBe("auto");
  });

  it("opens a library at its last known path", async () => {
    let body: unknown;
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json(LIBRARIES)),
      http.post(url("/libraries/open"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ libraryId: "lib-2", name: "Grant 2025", mode: "read-write" });
      }),
    );
    const onOpened = vi.fn();
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={onOpened} onNotFound={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Open Grant 2025" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith({ libraryId: "lib-2", name: "Grant 2025", mode: "read-write" }));
    expect(body).toEqual({ path: "/home/r/Grant 2025" });
  });

  it("a library that is not where it was goes to the not-found screen", async () => {
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json(LIBRARIES)),
      http.post(url("/libraries/open"), () => serviceError(404, "NOT_FOUND", "That folder is not a library.")),
    );
    const onNotFound = vi.fn();
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={onNotFound} />);
    await user.click(await screen.findByRole("button", { name: "Open Thesis library" }));
    await waitFor(() => expect(onNotFound).toHaveBeenCalledWith(LIBRARIES.libraries[0]));
  });

  it("opens a library at a typed path", async () => {
    let body: unknown;
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })),
      http.post(url("/libraries/open"), async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ libraryId: "lib-3", name: "Other", mode: "read-write" });
      }),
    );
    const onOpened = vi.fn();
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={onOpened} onNotFound={vi.fn()} />);
    expect(await screen.findByText(/No libraries yet/)).toBeTruthy();
    await user.type(screen.getByLabelText("Library folder"), "/home/r/Other");
    await user.click(screen.getByRole("button", { name: "Open library" }));
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    expect(body).toEqual({ path: "/home/r/Other" });
  });

  // ---- R447 (Task FR-A23): a suggested folder, and the free room on the disk under the folder in the box ----

  const SUGGESTED = "/Users/r/Documents/Alexandrine Oxiana";
  const folderBox = () => screen.getByLabelText("Library folder") as HTMLInputElement;
  const roomLine = () => screen.queryByText(/Free space on that disk/);

  it("R447: the suggestion is offered under the box, which stays empty; “Use this folder” fills it and creates nothing", async () => {
    const posts: string[] = [];
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })),
      http.get(url("/libraries/suggested-folder"), () => HttpResponse.json({ folder: SUGGESTED })),
      http.post(url("/libraries/folder-room"), () => HttpResponse.json({ freeBytes: 212e9 })),
      http.post(/.*/, ({ request }) => {
        posts.push(new URL(request.url).pathname);
        return HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    // R448: the button is named by its visible words; the suggested folder is its description.
    const use = await screen.findByRole("button", { name: "Use this folder", description: `Suggested: ${SUGGESTED}` });
    expect(use.textContent).toBe("Use this folder");
    expect(use.hasAttribute("aria-label")).toBe(false);
    expect(screen.getAllByRole("button", { name: "Use this folder" })).toHaveLength(1);
    const offer = use.closest("p") as HTMLElement;
    expect(offer.textContent).toBe(`Suggested: ${SUGGESTED} Use this folder`);
    const shown = within(offer).getByText(SUGGESTED);
    expect(shown.getAttribute("dir")).toBe("auto");
    // An offer, never a choice made for the researcher: the box is empty, and no room is asked for.
    expect(folderBox().value).toBe("");
    expect(roomLine()).toBeNull();
    // A typed path's problem line clears when the button fills the box, as if typed.
    await user.click(screen.getByRole("button", { name: "Create a new library in that folder" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/full path/);
    await user.click(use);
    expect(folderBox().value).toBe(SUGGESTED);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(use);
    expect((await screen.findByText("Free space on that disk: 212 GB.")).closest("[role=status]")).toBeTruthy();
    expect(posts).toEqual([]);
  });

  it("R447: no suggestion from the service (none, or an error): nothing is offered, and the rest of the screen works", async () => {
    for (const answer of [() => HttpResponse.json({}), () => serviceError(500, "INTERNAL", "Something failed.")]) {
      server.use(
        http.get(url("/libraries"), () => HttpResponse.json(LIBRARIES)),
        http.get(url("/libraries/suggested-folder"), answer),
      );
      const { unmount } = render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
      await screen.findByRole("button", { name: "Open Grant 2025" });
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByRole("button", { name: "Use this folder" })).toBeNull();
      expect(screen.queryByText(/Suggested:/)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      unmount();
    }
  });

  it("R447: a suggestion that never comes does not hold up the list of libraries", async () => {
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json(LIBRARIES)),
      http.get(url("/libraries/suggested-folder"), () => new Promise<never>(() => {})),
    );
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Open Grant 2025" })).toBeTruthy();
  });

  it("R447: the room is said for a typed full path in a polite status, after a pause, and follows the path", async () => {
    const asked: unknown[] = [];
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })),
      http.post(url("/libraries/folder-room"), async ({ request }) => {
        const body = (await request.json()) as { path: string };
        asked.push(body);
        return HttpResponse.json({ freeBytes: body.path.startsWith("/Volumes/Small") ? 9e9 : 11e9 });
      }),
    );
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await screen.findByText(/No libraries yet/);
    // Not a full path: nothing is asked.
    await user.type(folderBox(), "Research");
    await new Promise((r) => setTimeout(r, 450));
    expect(asked).toEqual([]);
    expect(roomLine()).toBeNull();
    await user.clear(folderBox());
    await user.type(folderBox(), "/Volumes/Big/Research library");
    const line = await screen.findByText("Free space on that disk: 11 GB.");
    const status = line.closest("[role=status]") as HTMLElement;
    expect(status.getAttribute("aria-live") ?? "polite").toBe("polite");
    expect(status.textContent).toBe("Free space on that disk: 11 GB.");
    // One request for the whole typed path, the path in the body.
    expect(asked).toEqual([{ path: "/Volumes/Big/Research library" }]);
    // A changed path: the old figure goes at once, the new one comes; under 10 GB the second sentence.
    await user.clear(folderBox());
    expect(roomLine()).toBeNull();
    await user.type(folderBox(), "/Volumes/Small/Research library");
    expect(await screen.findByText("Free space on that disk: 9 GB. That is little room: an import copies its files into the library.")).toBeTruthy();
  });

  it("R447: an answer for a path the box no longer holds is dropped", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((r) => (releaseFirst = r));
    let firstArrived!: () => void;
    const arrived = new Promise<void>((r) => (firstArrived = r));
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })),
      http.post(url("/libraries/folder-room"), async ({ request }) => {
        const { path } = (await request.json()) as { path: string };
        if (path === "/first") {
          firstArrived();
          await firstHeld;
          return HttpResponse.json({ freeBytes: 500e9 });
        }
        return HttpResponse.json({ freeBytes: 20e9 });
      }),
    );
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await screen.findByText(/No libraries yet/);
    await user.type(folderBox(), "/first");
    await arrived;
    await user.clear(folderBox());
    await user.type(folderBox(), "/second");
    expect(await screen.findByText("Free space on that disk: 20 GB.")).toBeTruthy();
    releaseFirst();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByText(/500 GB/)).toBeNull();
    expect(screen.getByText("Free space on that disk: 20 GB.")).toBeTruthy();
  });

  it("R447: nothing is said when the room cannot be told (an error, or no number)", async () => {
    let n = 0;
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })),
      http.post(url("/libraries/folder-room"), () => {
        n++;
        return n === 1 ? serviceError(400, "VALIDATION", '"path" must be an absolute path.') : HttpResponse.json({});
      }),
    );
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await screen.findByText(/No libraries yet/);
    await user.type(folderBox(), "/Volumes/Share/lib");
    await waitFor(() => expect(n).toBe(1));
    await user.type(folderBox(), "2");
    await waitFor(() => expect(n).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(roomLine()).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("R447: by keyboard, in order — the box, Open library, “Use this folder” (Enter fills the box), the new library's name", async () => {
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })),
      http.get(url("/libraries/suggested-folder"), () => HttpResponse.json({ folder: SUGGESTED })),
      http.post(url("/libraries/folder-room"), () => HttpResponse.json({ freeBytes: 212e9 })),
    );
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await screen.findByRole("button", { name: "Use this folder" });
    folderBox().focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open library" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Use this folder" }));
    await user.keyboard("{Enter}");
    expect(folderBox().value).toBe(SUGGESTED);
    expect(await screen.findByText("Free space on that disk: 212 GB.")).toBeTruthy();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("New library name"));
  });

  it("R449 d (M4): the room is never written larger than it is, and the figure and the little-room sentence agree", () => {
    const LITTLE = " That is little room: an import copies its files into the library.";
    const rows: Array<[number, string]> = [
      [9_999_999_999, "9.9 GB." + LITTLE],
      [9.96e9, "9.9 GB." + LITTLE],
      [0, "less than 1 MB." + LITTLE],
      [999.6e6, "999 MB." + LITTLE],
      [3.6e12, "3.6 TB."],
      [10e9, "10 GB."],
      [11e9, "11 GB."],
      [212.9e9, "212 GB."],
      [999.99e9, "999 GB."],
      [1e12, "1 TB."],
      [1.5e9, "1.5 GB." + LITTLE],
    ];
    for (const [bytes, rest] of rows) expect([bytes, roomSentence(bytes)]).toEqual([bytes, `Free space on that disk: ${rest}`]);
  });

  // ---- R449 e (M5): the line keeps its words until a newer answer; asked 600 ms after the last change ----

  const statusLine = () => document.querySelector(".ao-library-room") as HTMLElement;

  it("R449 e: the line is always in the page, with its line reserved, even before any path", async () => {
    server.use(http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })));
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await screen.findByText(/No libraries yet/);
    expect(statusLine()).toBeTruthy();
    expect(statusLine().getAttribute("role")).toBe("status");
    expect(statusLine().textContent).toBe("");
  });

  it("R449 e: a second path keeps the first figure until its own answer comes; then it is replaced", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let secondAsked = false;
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })),
      http.post(url("/libraries/folder-room"), async ({ request }) => {
        const { path } = (await request.json()) as { path: string };
        if (path === "/Volumes/A") return HttpResponse.json({ freeBytes: 11e9 });
        secondAsked = true;
        await held;
        return HttpResponse.json({ freeBytes: 300e9 });
      }),
    );
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await screen.findByText(/No libraries yet/);
    await user.type(folderBox(), "/Volumes/A");
    await waitFor(() => expect(statusLine().textContent).toBe("Free space on that disk: 11 GB."));
    await user.type(folderBox(), "B");
    expect(statusLine().textContent).toBe("Free space on that disk: 11 GB.");
    await waitFor(() => expect(secondAsked).toBe(true));
    expect(statusLine().textContent).toBe("Free space on that disk: 11 GB.");
    release();
    await waitFor(() => expect(statusLine().textContent).toBe("Free space on that disk: 300 GB."));
  });

  it("R449 e: a newer answer with no number empties the line; a box that no longer holds a full path empties it at once", async () => {
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })),
      http.post(url("/libraries/folder-room"), async ({ request }) => {
        const { path } = (await request.json()) as { path: string };
        return HttpResponse.json(path === "/x" ? { freeBytes: 11e9 } : {});
      }),
    );
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await screen.findByText(/No libraries yet/);
    await user.type(folderBox(), "/x");
    await waitFor(() => expect(statusLine().textContent).toBe("Free space on that disk: 11 GB."));
    await user.type(folderBox(), "y");
    await waitFor(() => expect(statusLine().textContent).toBe(""));
    await user.clear(folderBox());
    await user.type(folderBox(), "/x");
    await waitFor(() => expect(statusLine().textContent).toBe("Free space on that disk: 11 GB."));
    await user.type(folderBox(), "{Home}r");
    expect(folderBox().value).toBe("r/x");
    expect(statusLine().textContent).toBe("");
  });

  it("R449 e: the same words again do not touch the line (a screen reader is not told twice)", async () => {
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })),
      http.post(url("/libraries/folder-room"), () => HttpResponse.json({ freeBytes: 11e9 })),
    );
    let asks = 0;
    server.events.on("request:start", ({ request }) => {
      if (request.url.endsWith("/libraries/folder-room")) asks++;
    });
    const user = userEvent.setup();
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await screen.findByText(/No libraries yet/);
    await user.type(folderBox(), "/x");
    await waitFor(() => expect(statusLine().textContent).toBe("Free space on that disk: 11 GB."));
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((m) => changes.push(...m));
    observer.observe(statusLine(), { childList: true, characterData: true, subtree: true });
    const before = asks;
    await user.type(folderBox(), "y");
    await waitFor(() => expect(asks).toBe(before + 1));
    await new Promise((r) => setTimeout(r, 100));
    observer.disconnect();
    server.events.removeAllListeners();
    expect(statusLine().textContent).toBe("Free space on that disk: 11 GB.");
    expect(changes).toEqual([]);
  });

  it("R449 e (U3): a path typed at 350 ms a key is asked about far fewer than twelve times (at most two)", async () => {
    const asked: string[] = [];
    server.use(
      http.get(url("/libraries"), () => HttpResponse.json({ libraries: [] })),
      http.post(url("/libraries/folder-room"), async ({ request }) => {
        asked.push(((await request.json()) as { path: string }).path);
        return HttpResponse.json({ freeBytes: 50e9 });
      }),
    );
    const user = userEvent.setup({ delay: 350 });
    render(<LibraryChooser api={testApi()} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    await screen.findByText(/No libraries yet/);
    await user.type(folderBox(), "/Volumes/abc");
    await waitFor(() => expect(statusLine().textContent).toBe("Free space on that disk: 50 GB."));
    expect(asked.length).toBeLessThanOrEqual(2);
    expect(asked[asked.length - 1]).toBe("/Volumes/abc");
  }, 20_000);
});

// R450 (round 4): the room's line over time. A fake service answers `folderRoom`; the clock is faked, nothing is sent.
describe("LibraryChooser: the room's line over time (R450)", () => {
  afterEach(() => vi.useRealTimers());
  type Answer = { freeBytes?: number } | "fail" | "never";
  const setup = (answerFor: (path: string, n: number) => Answer) => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const base = testApi();
    const folderRoom = vi.fn((path: string) => {
      asked.push(path);
      const a = answerFor(path, asked.filter((x) => x === path).length);
      if (a === "never") return new Promise<{ freeBytes?: number }>(() => {});
      if (a === "fail") return Promise.reject(new Error("failed"));
      return Promise.resolve(a);
    });
    const api = {
      libraries: {
        ...base.libraries,
        list: () => Promise.resolve({ libraries: [] }),
        suggestedFolder: () => Promise.resolve({}),
        folderRoom,
      },
    } as unknown as ReturnType<typeof testApi>;
    render(<LibraryChooser api={api} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    return { asked };
  };
  const type = (v: string) => fireEvent.change(screen.getByLabelText("Library folder"), { target: { value: v } });
  const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const line = () => (document.querySelector(".ao-library-room") as HTMLElement).textContent;

  it("S1: a newer answer that has not come four seconds after it was asked empties the line (not before)", async () => {
    setup((p) => (p === "/A" ? { freeBytes: 11e9 } : "never"));
    type("/A");
    await wait(600);
    expect(line()).toBe("Free space on that disk: 11 GB.");
    type("/B");
    await wait(600);
    expect(line()).toBe("Free space on that disk: 11 GB.");
    await wait(3999);
    expect(line()).toBe("Free space on that disk: 11 GB.");
    await wait(1);
    expect(line()).toBe("");
  });

  it("S1: a late answer for the path the box still holds is shown", async () => {
    let release!: (r: { freeBytes: number }) => void;
    vi.useFakeTimers();
    const base = testApi();
    const api = {
      libraries: { ...base.libraries, list: () => Promise.resolve({ libraries: [] }), suggestedFolder: () => Promise.resolve({}), folderRoom: () => new Promise<{ freeBytes: number }>((r) => (release = r)) },
    } as unknown as ReturnType<typeof testApi>;
    render(<LibraryChooser api={api} onOpened={vi.fn()} onNotFound={vi.fn()} />);
    type("/A");
    await wait(600 + 4000);
    expect(line()).toBe("");
    await act(async () => release({ freeBytes: 20e9 }));
    expect(line()).toBe("Free space on that disk: 20 GB.");
  });

  it("S2: an answer with no number is asked again after 2,000 ms, and a number then shows", async () => {
    const { asked } = setup((_p, n) => (n === 1 ? {} : { freeBytes: 11e9 }));
    type("/A");
    await wait(600);
    expect(asked).toEqual(["/A"]);
    await wait(1999);
    expect(asked).toHaveLength(1);
    await wait(1);
    expect(asked).toHaveLength(2);
    expect(line()).toBe("Free space on that disk: 11 GB.");
    await wait(60_000);
    expect(asked).toHaveLength(2);
  });

  it("S2: four answers with no number (and failures) make exactly four requests, none after", async () => {
    const { asked } = setup((_p, n) => (n % 2 ? {} : "fail"));
    type("/A");
    await wait(600);
    await wait(2000);
    await wait(4000);
    await wait(8000);
    expect(asked).toEqual(["/A", "/A", "/A", "/A"]);
    await wait(120_000);
    expect(asked).toHaveLength(4);
  });

  it("S2: a box changed during a wait makes no further request for the old path", async () => {
    const { asked } = setup(() => ({}));
    type("/A");
    await wait(600);
    expect(asked).toEqual(["/A"]);
    await wait(1000);
    type("not a path");
    await wait(60_000);
    expect(asked).toEqual(["/A"]);
  });

  it("an error for a new path after a figure empties the line", async () => {
    setup((p) => (p === "/A" ? { freeBytes: 11e9 } : "fail"));
    type("/A");
    await wait(600);
    expect(line()).toBe("Free space on that disk: 11 GB.");
    type("/B");
    await wait(600);
    expect(line()).toBe("");
  });
});
