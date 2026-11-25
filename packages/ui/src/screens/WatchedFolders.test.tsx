/**
 * The "Watched folders" screen (Task W8) against a mocked service shaped exactly like W7's handlers
 * (apps/library-service/src/routes/watched-folders.ts): the chooser, the folder states, the acts and
 * their answers, the files list, the dialogs (R145) and the one live region.
 */
import type { WatchedFolderFilesResponse, WatchedFolderSummary } from "@ao/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, type JsonBodyType } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchedFoldersApi, watchedFoldersHref } from "../api/watchedFolders";
import { fakeShell, type FakeShell } from "../test/desktopShell";
import { CURRENT_RW, hang, libraryHandlers, PROJECTS, server, serviceError, SOURCE_FILE, sseAttempts, STYLES, testApi, testClient, url, useMockService } from "../test/service";
import { routeFor } from "../App";
import { Library } from "./Library";
import { WatchedFoldersRoute } from "./WatchedFolders";

const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
vi.mock("../desktopShell", () => ({ desktopShell: () => fake.shell, inDesktopShell: () => !!fake.shell }));

useMockService();

const G1 = "a".repeat(32);
const G2 = "b".repeat(32);
const ZERO = { cameIn: 0, alreadyInLibrary: 0, notDownloaded: 0, notDownloadedBytes: 0, waiting: 0, didNotComeIn: 0, changed: 0, gone: 0 };

/** The service's order of readings (R241): every summary and list built here draws the next number unless the test names one. */
let seqN = 0;
const nextSeq = () => ++seqN;

function folder(o: Partial<Omit<WatchedFolderSummary, "counts">> & { counts?: Partial<WatchedFolderSummary["counts"]> } = {}): WatchedFolderSummary {
  const { counts, ...rest } = o;
  return {
    seq: nextSeq(),
    id: "w1",
    label: "Fieldwork scans",
    recursive: false,
    place: { provider: "google-drive", providerName: "Google Drive", display: "Google Drive/My Drive/Fieldwork" },
    state: "watching",
    scanning: false,
    choices: { paused: false, notDownloaded: "leave" },
    ...rest,
    counts: { ...ZERO, ...counts },
  };
}

/** A text/event-stream the test writes into while the screen listens. */
function eventStream() {
  const enc = new TextEncoder();
  let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
  return {
    handler: http.get(url("/events"), () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
        },
      });
      return new HttpResponse(body, { headers: { "content-type": "text/event-stream" } });
    }),
    open: () => ctl !== undefined,
    push(type: string, data: unknown) {
      ctl!.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    },
  };
}

let events: ReturnType<typeof eventStream>;

/** The service as the screen reads it at load; `folders` is what the list answers. */
function useService(folders: WatchedFolderSummary[] | (() => JsonBodyType), opts: { mode?: "read-write" | "read-only" } = {}) {
  events = eventStream();
  server.use(
    events.handler,
    http.get(url("/libraries"), () => HttpResponse.json({ libraries: [], current: { libraryId: "lib-1", name: "Thesis library", mode: opts.mode ?? "read-write" } })),
    http.get(url("/projects"), () => HttpResponse.json(PROJECTS)),
    http.get(url("/projects/p1/collections"), () => HttpResponse.json({ collections: [{ id: "c1", projectId: "p1", name: "Interviews" }] })),
    http.get(url("/projects/p1/watched-folders"), () => HttpResponse.json(typeof folders === "function" ? { seq: nextSeq(), ...(folders() as object) } : { seq: nextSeq(), folders })),
  );
}

function show() {
  return render(<WatchedFoldersRoute client={testClient()} loc={{ pathname: "/settings/watched-folders", search: "?project=p1" }} />);
}

const status = () => screen.getByTestId("watch-live");
const card = (name = "Fieldwork scans") => screen.getByRole("region", { name });

/** A promise the test resolves. */
function held<T>() {
  let release!: (v: T) => void;
  const p = new Promise<T>((r) => (release = r));
  return { p, release };
}

beforeEach(() => {
  fake.shell = fakeShell();
  seqN = 0;
});

/** Every text the live region (or a dialog's) was given, in order: a repeat counts again (M2). */
function heard(testId = "watch-live") {
  const said: string[] = [];
  const watch = (el: Element) => {
    const mo = new MutationObserver(() => {
      const t = el.textContent ?? "";
      if (t) said.push(t);
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return mo;
  };
  let mo: MutationObserver | undefined;
  return {
    said,
    async start() {
      mo = watch(await screen.findByTestId(testId));
    },
    stop: () => mo?.disconnect(),
  };
}
afterEach(() => {
  fake.shell = undefined;
});

describe("WatchedFolders", () => {
  it("outside the shell the screen says the desktop app is needed", async () => {
    fake.shell = undefined;
    useService([folder()]);
    show();
    expect(await screen.findByRole("heading", { level: 1, name: "Watched folders" })).toBeTruthy();
    expect(screen.getByText("Files put in these folders are copied into this project by themselves while the app is open. The app only reads them: it never changes, moves or deletes anything in a folder.")).toBeTruthy();
    expect(screen.getByText("Adding a folder needs the desktop app.")).toBeTruthy();
    await screen.findByRole("region", { name: "Fieldwork scans" });
    expect(screen.queryByRole("button", { name: "Add a folder…" })).toBeNull();
  });

  it("add a folder: picker, collection, start watching", async () => {
    useService([]);
    const user = userEvent.setup();
    fake.shell!.pickWatchFolder.mockResolvedValue({ grantId: G1, name: "Fieldwork <b>scans</b>" });
    const bodies: unknown[] = [];
    server.use(
      http.post(url("/projects/p1/watched-folders"), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(folder({ label: "Scans", collectionId: "c1", collectionName: "Interviews", recursive: true }), { status: 201 });
      }),
    );
    show();
    const add = await screen.findByRole("button", { name: "Add a folder…" });
    await user.click(add);
    const dialog = await screen.findByRole("dialog", { name: "Add a watched folder" });
    expect(fake.shell!.pickWatchFolder).toHaveBeenCalledTimes(1);
    // The chooser's name, as text (never markup).
    const name = within(dialog).getByText("Fieldwork <b>scans</b>");
    expect(name.getAttribute("dir")).toBe("auto");
    expect(dialog.querySelector("b")).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText("Collection"), "c1");
    expect(within(dialog).getByRole("option", { name: "No collection" })).toBeTruthy();
    await user.click(within(dialog).getByRole("checkbox", { name: "Also watch the folders inside it" }));
    await user.type(within(dialog).getByLabelText("Name shown here (optional)"), "Scans");
    await user.click(within(dialog).getByRole("button", { name: "Start watching" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodies).toEqual([{ grantId: G1, label: "Scans", recursive: true, collectionId: "c1" }]);
    expect(await screen.findByRole("region", { name: "Scans" })).toBeTruthy();
    expect(within(card("Scans")).getByText("Interviews")).toBeTruthy();
    expect(document.activeElement).toBe(add);
    await waitFor(() => expect(status().textContent).toBe("Added. “Scans”: Watching."));
  });

  it("a double press sends one request: the chooser once, the grant once, the agreement once, the removal once", async () => {
    useService([folder({ counts: { notDownloaded: 2, notDownloadedBytes: 5000 } })]);
    const chooser = held<{ grantId: string; name: string } | null>();
    fake.shell!.pickWatchFolder.mockReturnValueOnce(chooser.p);
    const answer = held<void>();
    const calls = { post: 0, patch: 0, del: 0 };
    server.use(
      http.post(url("/projects/p1/watched-folders"), async () => {
        calls.post++;
        await answer.p;
        return HttpResponse.json(folder({ id: "w2", label: "Two" }), { status: 201 });
      }),
      http.patch(url("/projects/p1/watched-folders/w1"), async () => {
        calls.patch++;
        await answer.p;
        return HttpResponse.json(folder({ counts: { notDownloaded: 2, notDownloadedBytes: 5000 }, choices: { paused: false, notDownloaded: "download" } }));
      }),
      http.delete(url("/projects/p1/watched-folders/w1"), async () => {
        calls.del++;
        return HttpResponse.json({ removed: true });
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    const add = screen.getByRole("button", { name: "Add a folder…" });
    act(() => {
      add.click();
      add.click();
    });
    chooser.release({ grantId: G1, name: "Two" });
    const dialog = await screen.findByRole("dialog", { name: "Add a watched folder" });
    expect(fake.shell!.pickWatchFolder).toHaveBeenCalledTimes(1);
    const start = within(dialog).getByRole("button", { name: "Start watching" });
    act(() => {
      start.click();
      start.click();
    });
    answer.release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.post).toBe(1);

    act(() => within(c).getByRole("radio", { name: "Download and import them" }).click());
    const go = within(await screen.findByRole("dialog")).getByRole("button", { name: "Download and import" });
    act(() => {
      go.click();
      go.click();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.patch).toBe(1);

    act(() => within(c).getByRole("button", { name: "Remove “Fieldwork scans”…" }).click());
    const stop = within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop watching" });
    act(() => {
      stop.click();
      stop.click();
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Fieldwork scans" })).toBeNull());
    expect(calls.del).toBe(1);
  });

  it("a cancelled chooser adds nothing", async () => {
    useService([]);
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Add a folder…" }));
    await waitFor(() => expect(fake.shell!.pickWatchFolder).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a refused add offers the chooser again and never resends the grant", async () => {
    useService([]);
    const user = userEvent.setup();
    fake.shell!.pickWatchFolder.mockResolvedValueOnce({ grantId: G1, name: "Scans" }).mockResolvedValueOnce({ grantId: G2, name: "Scans 2" });
    const bodies: Array<{ grantId: string }> = [];
    server.use(
      http.post(url("/projects/p1/watched-folders"), async ({ request }) => {
        bodies.push((await request.json()) as { grantId: string });
        if (bodies.length === 1) return serviceError(409, "CONFLICT", "This folder is not answering (Google Drive may be offline or signed out). Watching goes on when it does.");
        return HttpResponse.json(folder({ label: undefined }), { status: 201 });
      }),
    );
    show();
    await user.click(await screen.findByRole("button", { name: "Add a folder…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a watched folder" });
    const start = within(dialog).getByRole("button", { name: "Start watching" });
    await user.click(start);
    expect((await within(dialog).findByRole("alert")).textContent).toBe("This folder is not answering (Google Drive may be offline or signed out). Watching goes on when it does.");
    // M11: the next useful act has focus.
    const again = within(dialog).getByRole("button", { name: "Choose the folder again…" });
    await waitFor(() => expect(document.activeElement).toBe(again));
    // The grant is spent: pressing again sends nothing.
    expect(start.hasAttribute("disabled") || start.getAttribute("aria-disabled") === "true").toBe(true);
    await user.click(start);
    expect(bodies).toHaveLength(1);
    await user.click(again);
    await within(dialog).findByText("Scans 2");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Start watching" }));
    await user.click(within(dialog).getByRole("button", { name: "Start watching" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodies.map((b) => b.grantId)).toEqual([G1, G2]);
    // No label: the place names it.
    expect(await screen.findByRole("region", { name: "Google Drive/My Drive/Fieldwork" })).toBeTruthy();
  });

  it("a not-downloaded count with its size; counts only when not zero; one file in the singular", async () => {
    useService([folder({ counts: { cameIn: 12, notDownloaded: 3, notDownloadedBytes: 2_500_000 } }), folder({ id: "w2", label: "Other", counts: { notDownloaded: 1, notDownloadedBytes: 1500, didNotComeIn: 1234, waiting: 1, changed: 2, gone: 1 } })]);
    show();
    const one = await screen.findByRole("region", { name: "Fieldwork scans" });
    expect(within(one).getByText("12 files came in")).toBeTruthy();
    expect(within(one).getByText("3 files here are not downloaded to this Mac (3 MB)")).toBeTruthy();
    expect(within(one).queryByText(/^[\d,]+ files? did not come in$/)).toBeNull();
    expect(within(one).queryByText(/waiting to come in/)).toBeNull();
    const two = card("Other");
    expect(within(two).getByText("1 file here is not downloaded to this Mac (2 kB)")).toBeTruthy();
    expect(within(two).getByText("1,234 files did not come in")).toBeTruthy();
    expect(within(two).getByText("1 file is waiting to come in")).toBeTruthy();
    expect(within(two).getByText("2 files in the library have changed in the folder")).toBeTruthy();
    expect(within(two).getByText("1 file is no longer in the folder")).toBeTruthy();
    expect(within(two).queryByText(/came in/)).toBeNull();
  });

  it("FR-476: files whose content was already in the library (a same-content conflict copy) have their line", async () => {
    useService([folder({ counts: { cameIn: 2, alreadyInLibrary: 1 } }), folder({ id: "w2", label: "Other", counts: { alreadyInLibrary: 3 } }), folder({ id: "w3", label: "None", counts: { cameIn: 1 } })]);
    show();
    const one = await screen.findByRole("region", { name: "Fieldwork scans" });
    expect(within(one).getByText("1 file was already in the library, so it was not brought in again")).toBeTruthy();
    expect(within(card("Other")).getByText("3 files were already in the library, so they were not brought in again")).toBeTruthy();
    expect(within(card("None")).queryByText(/already in the library/)).toBeNull();
  });

  it("every state word, and stopped as Not watched with its reason", async () => {
    useService([
      folder({ id: "a", label: "A" }),
      folder({ id: "b", label: "B", state: "paused", reason: "Paused. Files put in the folder meanwhile come in when you resume.", choices: { paused: true, notDownloaded: "leave" } }),
      folder({ id: "c", label: "C", state: "unreachable", reason: "The folder cannot be found." }),
      folder({ id: "d", label: "D", state: "locked" }),
      folder({ id: "e", label: "E", state: "not-set-up", place: null }),
      folder({ id: "f", label: "F", state: "stopped", reason: "This library is open read-only, so no folder is watched." }),
    ]);
    show();
    await screen.findByRole("region", { name: "A" });
    expect(within(card("A")).getByText("Watching")).toBeTruthy();
    expect(within(card("B")).getByText("Paused")).toBeTruthy();
    expect(within(card("B")).getByRole("button", { name: "Resume watching “B”" })).toBeTruthy();
    expect(within(card("C")).getByText("Cannot be reached")).toBeTruthy();
    expect(within(card("C")).getByText("The folder cannot be found.")).toBeTruthy();
    expect(within(card("D")).getByText("Waiting for the project to be unlocked")).toBeTruthy();
    expect(within(card("E")).getByText("Not set up on this Mac")).toBeTruthy();
    expect(within(card("F")).getByText("Not watched")).toBeTruthy();
    expect(within(card("F")).getByText("This library is open read-only, so no folder is watched.")).toBeTruthy();
    // "Try again" only when it cannot be reached; the chooser only when it is not set up.
    expect(within(card("A")).queryByRole("button", { name: /Try again/ })).toBeNull();
    expect(within(card("C")).getByRole("button", { name: "Try again for “C”" })).toBeTruthy();
    expect(within(card("A")).queryByRole("button", { name: /Choose the folder/ })).toBeNull();
  });

  it("scanning is said beside the state word", async () => {
    useService([folder({ scanning: true })]);
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    expect(within(c).getByText("Watching — looking through the folder…")).toBeTruthy();
  });

  it("download asks with the size first and sends it", async () => {
    useService([folder({ counts: { notDownloaded: 3, notDownloadedBytes: 2_500_000 } })]);
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.patch(url("/projects/p1/watched-folders/w1"), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(folder({ counts: { notDownloaded: 3, notDownloadedBytes: 2_500_000 }, choices: { paused: false, notDownloaded: "download" } }));
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    const group = within(c).getByRole("group", { name: "Files not downloaded to this Mac" });
    const leave = within(group).getByRole("radio", { name: "Leave them until I download them" }) as HTMLInputElement;
    const download = within(group).getByRole("radio", { name: "Download and import them" }) as HTMLInputElement;
    expect(leave.checked).toBe(true);
    await user.click(download);
    const dialog = await screen.findByRole("dialog", { name: "Download 3 files (3 MB) to this Mac and import them? They stay downloaded afterwards." });
    expect(bodies).toEqual([]);
    // Not yet agreed: the radio still shows what the service reports.
    expect(leave.checked).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Download and import" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodies).toEqual([{ notDownloaded: "download", confirmBytes: 2_500_000 }]);
    await waitFor(() => expect(download.checked).toBe(true));
    expect(document.activeElement).toBe(download);
  });

  it("a changed size answers 409 and asks again", async () => {
    let listed = folder({ counts: { notDownloaded: 3, notDownloadedBytes: 2_500_000 } });
    useService(() => ({ folders: [listed] }));
    const user = userEvent.setup();
    const bodies: Array<{ confirmBytes?: number }> = [];
    server.use(
      http.patch(url("/projects/p1/watched-folders/w1"), async ({ request }) => {
        bodies.push((await request.json()) as { confirmBytes?: number });
        if (bodies.length === 1) {
          listed = folder({ counts: { notDownloaded: 4, notDownloadedBytes: 4_000_000 } });
          return serviceError(409, "CONFLICT", "The number of files not downloaded has changed. Look at the new size and choose again.");
        }
        return HttpResponse.json(folder({ counts: { notDownloaded: 4, notDownloadedBytes: 4_000_000 }, choices: { paused: false, notDownloaded: "download" } }));
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    await user.click(within(c).getByRole("radio", { name: "Download and import them" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Download and import" });
    await user.click(confirm);
    expect((await within(dialog).findByRole("alert")).textContent).toBe("The number of files not downloaded has changed. Look at the new size and choose again. The folder now reports 4 files (4 MB) not downloaded.");
    // Asked again with the new size; nothing resent by itself.
    await within(dialog).findByRole("heading", { name: "Download 4 files (4 MB) to this Mac and import them? They stay downloaded afterwards." });
    expect(bodies).toHaveLength(1);
    expect(document.activeElement).toBe(confirm);
    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(bodies.map((b) => b.confirmBytes)).toEqual([2_500_000, 4_000_000]);
  });

  it("leave needs no dialog", async () => {
    useService([folder({ counts: { notDownloaded: 1, notDownloadedBytes: 10 }, choices: { paused: false, notDownloaded: "download" } })]);
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.patch(url("/projects/p1/watched-folders/w1"), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(folder({ counts: { notDownloaded: 1, notDownloadedBytes: 10 } }));
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    const leave = within(c).getByRole("radio", { name: "Leave them until I download them" }) as HTMLInputElement;
    expect(leave.checked).toBe(false);
    await user.click(leave);
    await waitFor(() => expect(leave.checked).toBe(true));
    expect(bodies).toEqual([{ notDownloaded: "leave" }]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("downloads held: Continue downloading sends the size shown", async () => {
    const reason = "Downloading has stopped at the size you agreed to. 2 files (3 MB) are waiting for your word.";
    useService([folder({ reason, counts: { notDownloaded: 2, notDownloadedBytes: 3_000_000 }, choices: { paused: false, notDownloaded: "download" }, downloadHeld: { files: 2, bytes: 3_000_000 } })]);
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.patch(url("/projects/p1/watched-folders/w1"), async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(folder({ counts: { notDownloaded: 2, notDownloadedBytes: 3_000_000 }, choices: { paused: false, notDownloaded: "download" } }));
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    expect(within(c).getByText(reason)).toBeTruthy();
    await user.click(within(c).getByRole("button", { name: "Continue downloading (3 MB) for “Fieldwork scans”" }));
    await waitFor(() => expect(bodies).toEqual([{ notDownloaded: "download", confirmBytes: 3_000_000 }]));
    await waitFor(() => expect(within(c).queryByRole("button", { name: /Continue downloading/ })).toBeNull());
    expect(document.activeElement).toBe(within(c).getByRole("heading", { level: 3, name: "Fieldwork scans" }));
  });

  it("M4: Continue downloading answered 409 reads the list again and offers the new size", async () => {
    let listed = folder({ reason: "held", counts: { notDownloaded: 2, notDownloadedBytes: 3_000_000 }, choices: { paused: false, notDownloaded: "download" }, downloadHeld: { files: 2, bytes: 3_000_000 } });
    useService(() => ({ folders: [listed] }));
    const user = userEvent.setup();
    let gets = 0;
    server.use(
      http.get(url("/projects/p1/watched-folders"), () => {
        gets++;
        return HttpResponse.json({ seq: nextSeq(), folders: [listed] });
      }),
      http.patch(url("/projects/p1/watched-folders/w1"), () => {
        listed = folder({ reason: "held", counts: { notDownloaded: 3, notDownloadedBytes: 5_000_000 }, choices: { paused: false, notDownloaded: "download" }, downloadHeld: { files: 3, bytes: 5_000_000 } });
        return serviceError(409, "CONFLICT", "The number of files not downloaded has changed. Look at the new size and choose again.");
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    await user.click(within(c).getByRole("button", { name: "Continue downloading (3 MB) for “Fieldwork scans”" }));
    expect((await within(c).findByRole("alert")).textContent).toBe("The number of files not downloaded has changed. Look at the new size and choose again.");
    await within(c).findByRole("button", { name: "Continue downloading (5 MB) for “Fieldwork scans”" });
    expect(gets).toBe(2);
  });

  it("pause and resume show the service's answer", async () => {
    useService([folder()]);
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.patch(url("/projects/p1/watched-folders/w1"), async ({ request }) => {
        const b = (await request.json()) as { paused: boolean };
        bodies.push(b);
        return HttpResponse.json(b.paused ? folder({ state: "paused", reason: "Paused. Files put in the folder meanwhile come in when you resume.", choices: { paused: true, notDownloaded: "leave" } }) : folder());
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    const pauseButton = within(c).getByRole("button", { name: "Pause watching “Fieldwork scans”" });
    await user.click(pauseButton);
    const resume = await within(c).findByRole("button", { name: "Resume watching “Fieldwork scans”" });
    expect(within(c).getByText("Paused")).toBeTruthy();
    // The same button, relabelled: focus stays on it.
    expect(document.activeElement).toBe(resume);
    await waitFor(() => expect(status().textContent).toBe("“Fieldwork scans”: Paused."));
    await user.click(resume);
    await within(c).findByRole("button", { name: "Pause watching “Fieldwork scans”" });
    expect(bodies).toEqual([{ paused: true }, { paused: false }]);
  });

  it("a refusal shows the service's sentence on that folder and changes nothing; focus stays", async () => {
    useService([folder()]);
    const user = userEvent.setup();
    server.use(http.patch(url("/projects/p1/watched-folders/w1"), () => serviceError(409, "CONFLICT", "This folder is not answering (Google Drive may be offline or signed out). Watching goes on when it does.")));
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    const pause = within(c).getByRole("button", { name: "Pause watching “Fieldwork scans”" });
    await user.click(pause);
    expect((await within(c).findByRole("alert")).textContent).toBe("This folder is not answering (Google Drive may be offline or signed out). Watching goes on when it does.");
    expect(within(c).getByText("Watching")).toBeTruthy();
    expect(document.activeElement).toBe(pause);
  });

  it("Try again restarts the folder and says the result; it shows it is working and cannot be pressed twice", async () => {
    useService([folder({ state: "unreachable", reason: "The folder cannot be found." }), folder({ id: "w2", label: "Other" })]);
    const user = userEvent.setup();
    const answer = held<void>();
    let calls = 0;
    server.use(
      http.post(url("/projects/p1/watched-folders/w1/retry"), async () => {
        calls++;
        await answer.p;
        return HttpResponse.json(folder({ scanning: true }));
      }),
      http.patch(url("/projects/p1/watched-folders/w2"), () => HttpResponse.json(folder({ id: "w2", label: "Other", state: "paused", choices: { paused: true, notDownloaded: "leave" } }))),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    const retry = within(c).getByRole("button", { name: "Try again for “Fieldwork scans”" });
    await user.click(retry);
    await waitFor(() => expect(retry.textContent).toBe("Trying again…"));
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(retry);
    await user.click(retry);
    // The rest of the screen stays usable meanwhile.
    await user.click(within(card("Other")).getByRole("button", { name: "Pause watching “Other”" }));
    await within(card("Other")).findByText("Paused");
    expect(calls).toBe(1);
    answer.release();
    await within(c).findByText("Watching — looking through the folder…");
    await waitFor(() => expect(status().textContent).toBe("Tried again. “Fieldwork scans”: Watching — looking through the folder…"));
    expect(calls).toBe(1);
    // Focus was moved to the other folder meanwhile, and stays there.
    expect(document.activeElement).toBe(within(card("Other")).getByRole("button", { name: "Resume watching “Other”" }));
  });

  it("I2: after a successful Try again focus is on the folder's heading, and the result is said", async () => {
    useService([folder({ state: "unreachable", reason: "The folder cannot be found." })]);
    const user = userEvent.setup();
    server.use(http.post(url("/projects/p1/watched-folders/w1/retry"), () => HttpResponse.json(folder())));
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    await user.click(within(c).getByRole("button", { name: "Try again for “Fieldwork scans”" }));
    await within(c).findByText("Watching");
    expect(document.activeElement).toBe(within(c).getByRole("heading", { level: 3, name: "Fieldwork scans" }));
    await waitFor(() => expect(status().textContent).toBe("Tried again. “Fieldwork scans”: Watching."));
  });

  it("a folder not where it was chosen offers the chooser; a refused choice offers it again", async () => {
    const reason = "This folder is not where it was when you chose it. Choose it again.";
    useService([folder({ state: "not-set-up", place: null, reason })]);
    const user = userEvent.setup();
    fake.shell!.pickWatchFolder.mockResolvedValueOnce({ grantId: G1, name: "Fieldwork" }).mockResolvedValueOnce({ grantId: G2, name: "Fieldwork" });
    const bodies: unknown[] = [];
    server.use(
      http.put(url("/projects/p1/watched-folders/w1/folder"), async ({ request }) => {
        bodies.push(await request.json());
        if (bodies.length === 1) return serviceError(400, "VALIDATION", "That folder could not be found. Choose the folder again.");
        return HttpResponse.json(folder());
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    expect(within(c).getByText("Not set up on this Mac")).toBeTruthy();
    expect(within(c).getByText(reason)).toBeTruthy();
    await user.click(within(c).getByRole("button", { name: "Choose the folder on this Mac… for “Fieldwork scans”" }));
    expect((await within(c).findByRole("alert")).textContent).toBe("That folder could not be found. Choose the folder again.");
    const again = within(c).getByRole("button", { name: "Choose the folder again… for “Fieldwork scans”" });
    expect(document.activeElement).toBe(again);
    await user.click(again);
    await within(c).findByText("Watching");
    expect(bodies).toEqual([{ grantId: G1 }, { grantId: G2 }]);
    expect(document.activeElement).toBe(within(c).getByRole("heading", { level: 3, name: "Fieldwork scans" }));
    await waitFor(() => expect(status().textContent).toBe("Folder chosen. “Fieldwork scans”: Watching."));
  });

  it("remove says nothing is removed from the library", async () => {
    useService([folder(), folder({ id: "w2", label: "Other" })]);
    const user = userEvent.setup();
    let deleted = 0;
    server.use(
      http.delete(url("/projects/p1/watched-folders/w1"), () => {
        deleted++;
        return HttpResponse.json({ removed: true });
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    await user.click(within(c).getByRole("button", { name: "Remove “Fieldwork scans”…" }));
    const dialog = await screen.findByRole("dialog", { name: "Stop watching “Fieldwork scans”?" });
    expect(within(dialog).getByText("Nothing already in the library is removed, and nothing in the folder is touched.")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Stop watching" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Fieldwork scans" })).toBeNull());
    expect(deleted).toBe(1);
    await waitFor(() => expect(status().textContent).toBe("Stopped watching “Fieldwork scans”."));
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Folders" }));
    // A late event for the removed folder does not bring it back.
    await waitFor(() => expect(events.open()).toBe(true));
    await act(async () => events.push("watch.status", { projectId: "p1", folder: folder() }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("region", { name: "Fieldwork scans" })).toBeNull();
  });

  it("file names go through UserText; the list is fetched when asked for", async () => {
    useService([folder({ counts: { didNotComeIn: 1, changed: 1 } })]);
    const user = userEvent.setup();
    const asked: string[] = [];
    server.use(
      http.get(url("/projects/p1/watched-folders/w1/files"), ({ request }) => {
        asked.push(new URL(request.url).search);
        return HttpResponse.json({
          total: 3,
          items: [
            { file: "<b>bold</b>.pdf", kind: "not-supported", reason: "This kind of file cannot be attached." },
            { file: "big.pdf", kind: "not-downloaded", reason: "The size of this file is not known until it is downloaded, so it is left for you to download yourself." },
            { file: "notes/طلب.pdf", kind: "changed", reason: "The file in the folder has changed since it was brought in. The library's copy is unchanged.", bytes: 2000, sourceId: "s1" },
          ],
        } satisfies WatchedFolderFilesResponse);
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    expect(asked).toEqual([]);
    const toggle = within(c).getByRole("button", { name: "Show files that did not come in for “Fieldwork scans”" });
    await user.click(toggle);
    const list = await within(c).findByRole("list", { name: "Files of “Fieldwork scans”" });
    const bold = within(list).getByText("<b>bold</b>.pdf");
    expect(bold.getAttribute("dir")).toBe("auto");
    expect(list.querySelector("b")).toBeNull();
    expect(within(list).getByText("notes/طلب.pdf").getAttribute("dir")).toBe("auto");
    // No size for a file whose size is not known; the size for one that has it.
    const big = within(list).getByText("big.pdf").closest("li")!;
    expect(big.textContent).not.toMatch(/\(\d/);
    expect(within(list).getByText("notes/طلب.pdf").closest("li")!.textContent).toContain("(2 kB)");
    expect(within(list).getAllByRole("button", { name: /Open the source/ })).toHaveLength(1);
    expect(asked).toEqual(["?offset=0&limit=200"]);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("the files list says the first 5,000 and shows more 200 at a time", async () => {
    useService([folder({ counts: { notDownloaded: 7000, notDownloadedBytes: 7_000_000_000 } })]);
    const user = userEvent.setup();
    const asked: string[] = [];
    server.use(
      http.get(url("/projects/p1/watched-folders/w1/files"), ({ request }) => {
        const q = new URL(request.url).searchParams;
        asked.push(new URL(request.url).search);
        const offset = Number(q.get("offset"));
        const items = Array.from({ length: 200 }, (_, i) => ({ file: `f${offset + i}.pdf`, kind: "not-downloaded" as const, reason: "Not downloaded to this Mac. It comes in once it is downloaded.", bytes: 1_000_000 }));
        return HttpResponse.json({ total: 5000, items });
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    await user.click(within(c).getByRole("button", { name: "Show files that did not come in for “Fieldwork scans”" }));
    const list = await within(c).findByRole("list", { name: "Files of “Fieldwork scans”" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(200);
    expect(within(c).getByText(/the first 5,000/)).toBeTruthy();
    expect(within(c).getByText("Showing 200 of 5,000.")).toBeTruthy();
    await user.click(within(c).getByRole("button", { name: "Show more files of “Fieldwork scans”" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(400));
    expect(asked).toEqual(["?offset=0&limit=200", "?offset=200&limit=200"]);
  });

  it("Open the source shows the source here", async () => {
    useService([folder({ counts: { gone: 1 } })]);
    const user = userEvent.setup();
    server.use(
      http.get(url("/projects/p1/watched-folders/w1/files"), () =>
        HttpResponse.json({ total: 1, items: [{ file: "gone.pdf", kind: "gone", reason: "The file is no longer in the watched folder. The library's copy is unchanged.", sourceId: "s1" }] }),
      ),
      http.get(url("/projects/p1/sources/s1"), () => HttpResponse.json(SOURCE_FILE)),
      http.get(url("/styles"), () => HttpResponse.json(STYLES)),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    await user.click(within(c).getByRole("button", { name: "Show files that did not come in for “Fieldwork scans”" }));
    await user.click(await within(c).findByRole("button", { name: "Open the source of “gone.pdf”" }));
    const source = await screen.findByRole("region", { name: "Source" });
    expect(document.activeElement).toBe(source);
    await within(source).findByText("Ethnography at Work");
  });

  it("M10: closing the source after its list was hidden puts focus on the folder's heading", async () => {
    useService([folder({ counts: { gone: 1 } })]);
    const user = userEvent.setup();
    server.use(
      http.get(url("/projects/p1/watched-folders/w1/files"), () =>
        HttpResponse.json({ total: 1, items: [{ file: "gone.pdf", kind: "gone", reason: "The file is no longer in the watched folder. The library's copy is unchanged.", sourceId: "s1" }] }),
      ),
      http.get(url("/projects/p1/sources/s1"), () => HttpResponse.json(SOURCE_FILE)),
      http.get(url("/styles"), () => HttpResponse.json(STYLES)),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    const toggle = within(c).getByRole("button", { name: "Show files that did not come in for “Fieldwork scans”" });
    await user.click(toggle);
    await user.click(await within(c).findByRole("button", { name: "Open the source of “gone.pdf”" }));
    const source = await screen.findByRole("region", { name: "Source" });
    await within(source).findByText("Ethnography at Work");
    await user.click(toggle);
    await user.click(within(source).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Source" })).toBeNull());
    expect(document.activeElement).toBe(within(c).getByRole("heading", { level: 3, name: "Fieldwork scans" }));
  });

  it("M6: a double press on Show files, Show more and Choose the folder again… sends one request", async () => {
    useService([folder({ counts: { notDownloaded: 400, notDownloadedBytes: 1000 } })]);
    const user = userEvent.setup();
    const asked: string[] = [];
    server.use(
      http.get(url("/projects/p1/watched-folders/w1/files"), ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        asked.push(String(offset));
        return HttpResponse.json({ total: 400, items: Array.from({ length: 200 }, (_, i) => ({ file: `f${offset + i}.pdf`, kind: "not-downloaded", reason: "Not downloaded.", bytes: 1 })) });
      }),
      http.post(url("/projects/p1/watched-folders"), () => serviceError(400, "VALIDATION", "That folder choice has expired. Choose the folder again.")),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    const toggle = within(c).getByRole("button", { name: "Show files that did not come in for “Fieldwork scans”" });
    // A toggle pressed twice opens and closes: one request at most, none left to answer.
    act(() => {
      toggle.click();
      toggle.click();
    });
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(asked).toHaveLength(1);
    expect(within(c).queryByRole("list", { name: "Files of “Fieldwork scans”" })).toBeNull();
    await user.click(toggle);
    await within(c).findByText("Showing 200 of 400.");
    const more = within(c).getByRole("button", { name: "Show more files of “Fieldwork scans”" });
    act(() => {
      more.click();
      more.click();
    });
    await within(c).findByText("Showing 400 of 400.");
    expect(asked).toEqual(["0", "0", "200"]);

    // Choose the folder again…, twice at once: one chooser.
    const chooser = held<{ grantId: string; name: string } | null>();
    fake.shell!.pickWatchFolder.mockResolvedValueOnce({ grantId: G1, name: "Scans" }).mockReturnValueOnce(chooser.p);
    await user.click(screen.getByRole("button", { name: "Add a folder…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a watched folder" });
    await user.click(within(dialog).getByRole("button", { name: "Start watching" }));
    const again = await within(dialog).findByRole("button", { name: "Choose the folder again…" });
    act(() => {
      again.click();
      again.click();
    });
    chooser.release(null);
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(fake.shell!.pickWatchFolder).toHaveBeenCalledTimes(2);
  });

  it("M9: a list that changes between pages shows no entry twice and says so", async () => {
    useService([folder({ counts: { notDownloaded: 300, notDownloadedBytes: 1000 } })]);
    const user = userEvent.setup();
    server.use(
      http.get(url("/projects/p1/watched-folders/w1/files"), ({ request }) => {
        const offset = Number(new URL(request.url).searchParams.get("offset"));
        // A file came in between the pages: everything after it moved by one.
        const start = offset === 0 ? 0 : offset - 1;
        const total = offset === 0 ? 300 : 301;
        const n = Math.min(200, total - offset);
        return HttpResponse.json({ total, items: Array.from({ length: n }, (_, i) => ({ file: `f${String(start + i).padStart(3, "0")}.pdf`, kind: "not-downloaded", reason: "Not downloaded.", bytes: 1 })) });
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    await user.click(within(c).getByRole("button", { name: "Show files that did not come in for “Fieldwork scans”" }));
    await within(c).findByText("Showing 200 of 300.");
    await user.click(within(c).getByRole("button", { name: "Show more files of “Fieldwork scans”" }));
    await within(c).findByText(/The list changed while it was being read/);
    expect(within(c).getAllByText("f199.pdf")).toHaveLength(1);
  });

  it("each dialog keeps focus on open, Tab, Shift+Tab and close", async () => {
    useService([folder({ counts: { notDownloaded: 2, notDownloadedBytes: 5000 } })]);
    const user = userEvent.setup();
    fake.shell!.pickWatchFolder.mockResolvedValue({ grantId: G1, name: "Scans" });
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });

    // Add.
    const add = screen.getByRole("button", { name: "Add a folder…" });
    await user.click(add);
    let dialog = await screen.findByRole("dialog", { name: "Add a watched folder" });
    const select = within(dialog).getByLabelText("Collection");
    expect(document.activeElement).toBe(select);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.tab();
    expect(document.activeElement).toBe(select);
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole("checkbox"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(add);

    // Download.
    const download = within(c).getByRole("radio", { name: "Download and import them" });
    await user.click(download);
    dialog = await screen.findByRole("dialog");
    const go = within(dialog).getByRole("button", { name: "Download and import" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { level: 2 })); // R376 c: the heading, not the confirming button
    await user.tab();
    expect(document.activeElement).toBe(go);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(go);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);
    await user.click(cancel);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(download);
    expect((download as HTMLInputElement).checked).toBe(false);

    // Remove.
    const remove = within(c).getByRole("button", { name: "Remove “Fieldwork scans”…" });
    await user.click(remove);
    dialog = await screen.findByRole("dialog");
    const stop = within(dialog).getByRole("button", { name: "Stop watching" });
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { level: 2 })); // R376 c: the heading, not the confirming button
    await user.tab();
    expect(document.activeElement).toBe(stop);
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.tab();
    expect(document.activeElement).toBe(stop);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(remove);
  });

  describe("a held or repeated key on the opener confirms nothing (R376 c)", () => {
    const DL_TITLE = /^Download 2 files \(.+\) to this Mac and import them\?/;
    const bodiesOf = () => {
      const patches: unknown[] = [];
      const deletes: number[] = [];
      server.use(
        http.patch(url("/projects/p1/watched-folders/w1"), async ({ request }) => {
          patches.push(await request.json());
          return HttpResponse.json(folder({ counts: { notDownloaded: 2, notDownloadedBytes: 5000 }, choices: { paused: false, notDownloaded: "download" } }));
        }),
        http.delete(url("/projects/p1/watched-folders/w1"), () => {
          deletes.push(1);
          return HttpResponse.json({ removed: true });
        }),
      );
      return { patches, deletes };
    };

    it("Stop watching: held Enter then Enter again leaves it open on the heading; Tab then Enter stops once; Shift+Tab reaches Cancel; Escape returns to the opener", async () => {
      useService([folder()]);
      const user = userEvent.setup();
      const { deletes } = bodiesOf();
      show();
      const c = await screen.findByRole("region", { name: "Fieldwork scans" });
      const opener = within(c).getByRole("button", { name: "Remove “Fieldwork scans”…" });
      opener.focus();
      await user.keyboard("{Enter>4}{/Enter}{Enter}");
      const dialog = await screen.findByRole("dialog", { name: "Stop watching “Fieldwork scans”?" });
      expect(deletes).toHaveLength(0);
      expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Stop watching “Fieldwork scans”?" }));
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
      await user.tab(); // wraps to the first control
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Stop watching" }));
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(opener);
      expect(deletes).toHaveLength(0);
      opener.focus();
      await user.keyboard("{Enter}");
      await screen.findByRole("dialog", { name: "Stop watching “Fieldwork scans”?" });
      await user.tab();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByRole("region", { name: "Fieldwork scans" })).toBeNull());
      expect(deletes).toHaveLength(1);
    });

    it("Download and import: a held or doubled key after it opens leaves it open on the heading; Tab then Enter agrees once; Shift+Tab reaches Cancel; Escape returns to the opener", async () => {
      useService([folder({ counts: { notDownloaded: 2, notDownloadedBytes: 5000 } })]);
      const user = userEvent.setup();
      const { patches } = bodiesOf();
      show();
      const c = await screen.findByRole("region", { name: "Fieldwork scans" });
      const opener = within(c).getByRole("radio", { name: "Download and import them" });
      opener.focus();
      await user.keyboard("[Space]");
      const dialog = await screen.findByRole("dialog", { name: DL_TITLE });
      await user.keyboard("{Enter>4}{/Enter}{Enter}");
      expect(screen.getByRole("dialog", { name: DL_TITLE })).toBe(dialog);
      expect(patches).toHaveLength(0);
      expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: DL_TITLE }));
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(opener);
      expect(patches).toHaveLength(0);
      await user.click(opener);
      await screen.findByRole("dialog", { name: DL_TITLE });
      await user.tab();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Download and import" }));
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(patches).toHaveLength(1);
    });
  });

  it("the live region speaks only a state change", async () => {
    useService([folder()]);
    show();
    await screen.findByRole("region", { name: "Fieldwork scans" });
    expect(status().getAttribute("aria-live")).toBe("polite");
    expect(screen.getAllByTestId("watch-live")).toHaveLength(1);
    await waitFor(() => expect(events.open()).toBe(true));
    await act(async () => events.push("watch.status", { projectId: "p1", folder: folder({ counts: { cameIn: 3 } }) }));
    await within(card()).findByText("3 files came in");
    expect(status().textContent).toBe("");
    // Another project's event changes nothing here.
    await act(async () => events.push("watch.status", { projectId: "p2", folder: folder({ state: "unreachable" }) }));
    await act(async () => events.push("watch.status", { projectId: "p1", folder: folder({ state: "unreachable", reason: "The folder cannot be found.", counts: { cameIn: 3 } }) }));
    await within(card()).findByText("Cannot be reached");
    await waitFor(() => expect(status().textContent).toBe("“Fieldwork scans”: Cannot be reached."));
    await act(async () => events.push("watch.status", { projectId: "p1", folder: folder({ state: "unreachable", reason: "The folder cannot be found.", counts: { cameIn: 4 } }) }));
    await within(card()).findByText("4 files came in");
    expect(status().textContent).toBe("“Fieldwork scans”: Cannot be reached.");
  });

  it("R241: a list in flight does not replace a newer answer (folder B's radio)", async () => {
    const A = (o: Parameters<typeof folder>[0] = {}) => folder({ id: "w1", label: "A", ...o });
    const B = (o: Parameters<typeof folder>[0] = {}) => folder({ id: "w2", label: "B", ...o });
    const held1 = { downloadHeld: { files: 2, bytes: 3_000_000 }, counts: { notDownloaded: 2, notDownloadedBytes: 3_000_000 }, choices: { paused: false, notDownloaded: "download" as const } };
    const dl = { counts: { notDownloaded: 1, notDownloadedBytes: 10 }, choices: { paused: false, notDownloaded: "download" as const } };
    useService([]);
    const user = userEvent.setup();
    const later = held<void>();
    let gets = 0;
    server.use(
      http.get(url("/projects/p1/watched-folders"), async () => {
        gets++;
        // Read now (before B's change below), answered later.
        const body = { seq: nextSeq(), folders: [A(held1), B(dl)] };
        if (gets > 1) await later.p;
        return HttpResponse.json(body);
      }),
      http.patch(url("/projects/p1/watched-folders/w1"), () => serviceError(409, "CONFLICT", "The number of files not downloaded has changed. Look at the new size and choose again.")),
      http.patch(url("/projects/p1/watched-folders/w2"), () => HttpResponse.json(B({ counts: { notDownloaded: 1, notDownloadedBytes: 10 } }))),
    );
    show();
    const a = await screen.findByRole("region", { name: "A" });
    const b = card("B");
    // A 409 on A reads the list again (M4): that list is held.
    await user.click(within(a).getByRole("button", { name: "Continue downloading (3 MB) for “A”" }));
    await waitFor(() => expect(gets).toBe(2));
    const leave = within(b).getByRole("radio", { name: "Leave them until I download them" }) as HTMLInputElement;
    await user.click(leave);
    await waitFor(() => expect(leave.checked).toBe(true));
    later.release();
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(leave.checked).toBe(true);
  });

  it("R241: an older event arriving during an act or after its answer never overrides the answer; the result is said from the answer", async () => {
    useService([folder()]);
    const user = userEvent.setup();
    const answer = held<void>();
    let gets = 0;
    server.use(
      http.get(url("/projects/p1/watched-folders"), () => {
        gets++;
        return HttpResponse.json({ seq: 2, folders: [folder({ seq: 1, counts: { cameIn: 1 } })] });
      }),
      http.patch(url("/projects/p1/watched-folders/w1"), async () => {
        await answer.p;
        return HttpResponse.json(folder({ seq: 20, state: "paused", choices: { paused: true, notDownloaded: "leave" }, counts: { cameIn: 4 } }));
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    await within(c).findByText("1 file came in");
    await waitFor(() => expect(events.open()).toBe(true));
    const ear = heard();
    await ear.start();
    await user.click(within(c).getByRole("button", { name: "Pause watching “Fieldwork scans”" }));
    // Read before the pause, arriving while it is out.
    await act(async () => events.push("watch.status", { projectId: "p1", folder: folder({ seq: 10, counts: { cameIn: 5 } }) }));
    await within(c).findByText("5 files came in");
    answer.release();
    await within(c).findByText("4 files came in");
    expect(within(c).getByText("Paused")).toBeTruthy();
    // Read before the pause, arriving after its answer.
    await act(async () => events.push("watch.status", { projectId: "p1", folder: folder({ seq: 15, counts: { cameIn: 6 } }) }));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(within(c).getByText("4 files came in")).toBeTruthy();
    expect(within(c).getByText("Paused")).toBeTruthy();
    // A later reading is taken.
    await act(async () => events.push("watch.status", { projectId: "p1", folder: folder({ seq: 25, state: "paused", choices: { paused: true, notDownloaded: "leave" }, counts: { cameIn: 7 } }) }));
    await within(c).findByText("7 files came in");
    expect(ear.said).toEqual(["“Fieldwork scans”: Paused."]);
    // No re-reading of the list was needed.
    expect(gets).toBe(1);
  });

  it("R241: a folder removed while a list is in flight does not come back; a list drops only folders it read later", async () => {
    useService([]);
    const user = userEvent.setup();
    const later = held<void>();
    let gets = 0;
    const heldB = { downloadHeld: { files: 2, bytes: 3_000_000 }, counts: { notDownloaded: 2, notDownloadedBytes: 3_000_000 }, choices: { paused: false, notDownloaded: "download" as const } };
    server.use(
      http.get(url("/projects/p1/watched-folders"), async () => {
        gets++;
        if (gets === 1) return HttpResponse.json({ seq: 4, folders: [folder({ seq: 1, id: "w1", label: "A" }), folder({ seq: 2, id: "w2", label: "B", ...heldB }), folder({ seq: 3, id: "w4", label: "D" })] });
        await later.p;
        // Read at 1000: A and B still there; D gone; C (added at 2000) not yet.
        return HttpResponse.json({ seq: 1000, folders: [folder({ seq: 1000, id: "w1", label: "A" }), folder({ seq: 1000, id: "w2", label: "B", ...heldB })] });
      }),
      http.patch(url("/projects/p1/watched-folders/w2"), () => serviceError(409, "CONFLICT", "The number of files not downloaded has changed. Look at the new size and choose again.")),
      http.delete(url("/projects/p1/watched-folders/w1"), () => HttpResponse.json({ removed: true })),
    );
    show();
    const a = await screen.findByRole("region", { name: "A" });
    await waitFor(() => expect(events.open()).toBe(true));
    await user.click(within(card("B")).getByRole("button", { name: "Continue downloading (3 MB) for “B”" }));
    await waitFor(() => expect(gets).toBe(2));
    await user.click(within(a).getByRole("button", { name: "Remove “A”…" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop watching" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "A" })).toBeNull());
    await act(async () => events.push("watch.status", { projectId: "p1", folder: folder({ seq: 2000, id: "w3", label: "C" }) }));
    await screen.findByRole("region", { name: "C" });
    later.release();
    await waitFor(() => expect(screen.queryByRole("region", { name: "D" })).toBeNull());
    expect(screen.queryByRole("region", { name: "A" })).toBeNull();
    expect(screen.getByRole("region", { name: "C" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "B" })).toBeTruthy();
  });

  it("N3: when the library closes the screen drops its folders and numbers; when one opens it reads the list again", async () => {
    let gets = 0;
    useService(() => {
      gets++;
      return gets === 1 ? { folders: [folder({ seq: 500 })] } : gets === 2 ? { folders: [folder({ seq: 1, label: "Reopened" })] } : { folders: [folder({ seq: 2, id: "w9", label: "Other library" })] };
    });
    show();
    await screen.findByRole("region", { name: "Fieldwork scans" });
    await waitFor(() => expect(events.open()).toBe(true));
    await act(async () => events.push("library.state", { open: false }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Fieldwork scans" })).toBeNull());
    expect(screen.getByText("No library is open. Open one from the library to see its watched folders.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a folder…" })).toBeNull();
    // Opened again (its numbers start below what was shown): read afresh, and shown.
    await act(async () => events.push("library.state", { open: true, libraryId: "lib-1", name: "Thesis library", mode: "read-write" }));
    expect(await screen.findByRole("region", { name: "Reopened" })).toBeTruthy();
    expect(gets).toBe(2);
    // Another library opened in its place: the same.
    await act(async () => events.push("library.state", { open: true, libraryId: "lib-2", name: "Grant 2025", mode: "read-write" }));
    expect(await screen.findByRole("region", { name: "Other library" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Reopened" })).toBeNull();
    // A state of the same open library reads nothing again.
    await act(async () => events.push("library.state", { open: true, libraryId: "lib-2", name: "Grant 2025", mode: "read-write" }));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(gets).toBe(3);
  });

  it("R241 (b): an event that takes away the busy Try again moves focus to the folder's heading, not the page", async () => {
    useService([folder({ state: "unreachable", reason: "The folder cannot be found." })]);
    const user = userEvent.setup();
    const answer = held<void>();
    server.use(
      http.post(url("/projects/p1/watched-folders/w1/retry"), async () => {
        await answer.p;
        return HttpResponse.json(folder());
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    await waitFor(() => expect(events.open()).toBe(true));
    await user.click(within(c).getByRole("button", { name: "Try again for “Fieldwork scans”" }));
    await act(async () => events.push("watch.status", { projectId: "p1", folder: folder() }));
    await waitFor(() => expect(within(c).queryByRole("button", { name: /Try/ })).toBeNull());
    expect(document.activeElement).toBe(within(c).getByRole("heading", { level: 3 }));
    answer.release();
    await waitFor(() => expect(status().textContent).toBe("Tried again. “Fieldwork scans”: Watching."));
    expect(document.activeElement).toBe(within(c).getByRole("heading", { level: 3 }));
  });

  it("M2: the same result twice is said twice", async () => {
    useService([folder({ state: "unreachable", reason: "The folder cannot be found." })]);
    const user = userEvent.setup();
    server.use(http.post(url("/projects/p1/watched-folders/w1/retry"), () => HttpResponse.json(folder({ state: "unreachable", reason: "The folder cannot be found." }))));
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    const ear = heard();
    await ear.start();
    const retry = within(c).getByRole("button", { name: "Try again for “Fieldwork scans”" });
    await user.click(retry);
    await waitFor(() => expect(ear.said).toHaveLength(1));
    await waitFor(() => expect(retry.getAttribute("aria-disabled")).toBeNull());
    await user.click(retry);
    await waitFor(() => expect(ear.said).toEqual(["Tried again. “Fieldwork scans”: Cannot be reached.", "Tried again. “Fieldwork scans”: Cannot be reached."]));
  });

  it("M3: what is said while a dialog is open is said in the dialog, never inside the inert page; the act's result after it closes", async () => {
    useService([folder()]);
    const user = userEvent.setup();
    fake.shell!.pickWatchFolder.mockResolvedValue({ grantId: G1, name: "Two" });
    server.use(http.post(url("/projects/p1/watched-folders"), () => HttpResponse.json(folder({ id: "w2", label: "Two" }), { status: 201 })));
    show();
    await screen.findByRole("region", { name: "Fieldwork scans" });
    await waitFor(() => expect(events.open()).toBe(true));
    await user.click(screen.getByRole("button", { name: "Add a folder…" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a watched folder" });
    await act(async () => events.push("watch.status", { projectId: "p1", folder: folder({ state: "unreachable" }) }));
    const inDialog = await within(dialog).findByTestId("watch-dialog-live");
    await waitFor(() => expect(inDialog.textContent).toBe("“Fieldwork scans”: Cannot be reached."));
    expect(inDialog.closest("[inert]")).toBeNull();
    expect(inDialog.getAttribute("aria-live")).toBe("polite");
    await user.click(within(dialog).getByRole("button", { name: "Start watching" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(status().textContent).toBe("Added. “Two”: Watching."));
    expect(status().closest("[inert]")).toBeNull();
  });

  it("a burst of status events leaves an open dialog and its focus alone", async () => {
    useService([folder({ counts: { notDownloaded: 3, notDownloadedBytes: 2_500_000 } })]);
    const user = userEvent.setup();
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    await waitFor(() => expect(events.open()).toBe(true));
    await user.click(within(c).getByRole("radio", { name: "Download and import them" }));
    const bodies: unknown[] = [];
    server.use(
      http.patch(url("/projects/p1/watched-folders/w1"), async ({ request }) => {
        bodies.push(await request.json());
        return serviceError(409, "CONFLICT", "The number of files not downloaded has changed. Look at the new size and choose again.");
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Download 3 files (3 MB) to this Mac and import them? They stay downloaded afterwards." });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    await user.tab(); // the heading has focus on open (R376 c): the first Tab reaches the confirming button
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    for (let i = 1; i <= 5; i++) {
      await act(async () => events.push("watch.status", { projectId: "p1", folder: folder({ state: i % 2 ? "unreachable" : "watching", counts: { notDownloaded: 3 + i, notDownloadedBytes: 2_500_000 + i * 1_000_000 } }) }));
    }
    await within(c).findByText("8 files here are not downloaded to this Mac (8 MB)");
    expect(screen.getByRole("dialog", { name: "Download 3 files (3 MB) to this Mac and import them? They stay downloaded afterwards." })).toBe(dialog);
    expect(document.activeElement).toBe(cancel);
    // The change is said, not slipped in.
    const notice = within(dialog).getByText("Since this opened, the folder's count has changed: 8 files (8 MB) are not downloaded now. “Download and import” agrees only to the size above; cancel and choose again for the new size.");
    expect(notice.closest("[aria-live='polite']")).toBeTruthy();
    // I3: what is agreed is the size the dialog shows, whatever arrived meanwhile.
    await user.click(within(dialog).getByRole("button", { name: "Download and import" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ notDownloaded: "download", confirmBytes: 2_500_000 });
  });

  it("I3: Cancel and Escape send nothing", async () => {
    useService([folder({ counts: { notDownloaded: 3, notDownloadedBytes: 2_500_000 } })]);
    const user = userEvent.setup();
    let patches = 0;
    server.use(
      http.patch(url("/projects/p1/watched-folders/w1"), () => {
        patches++;
        return HttpResponse.json(folder());
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    const download = within(c).getByRole("radio", { name: "Download and import them" });
    await user.click(download);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(download);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(patches).toBe(0);
  });

  it("M5: no agreement is offered when there is no size to agree to", async () => {
    useService([folder({ counts: { notDownloaded: 2, notDownloadedBytes: 0 } }), folder({ id: "w2", label: "Other" })]);
    const user = userEvent.setup();
    let patches = 0;
    server.use(
      http.patch(url("/projects/p1/watched-folders/:wid"), () => {
        patches++;
        return HttpResponse.json(folder());
      }),
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    const download = within(c).getByRole("radio", { name: "Download and import them" });
    await user.click(download);
    expect((await within(c).findByRole("alert")).textContent).toBe("The size of these files is not known until they are downloaded, so they are left for you to download yourself.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(download);
    const other = card("Other");
    await user.click(within(other).getByRole("radio", { name: "Download and import them" }));
    expect((await within(other).findByRole("alert")).textContent).toBe("There is nothing to download in this folder at the moment.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(patches).toBe(0);
  });

  it("read-only disables every changing control with the reason", async () => {
    useService(
      [
        folder({ state: "unreachable", counts: { notDownloaded: 1, notDownloadedBytes: 10 } }),
        folder({ id: "w2", label: "Other", state: "not-set-up", place: null }),
        folder({ id: "w3", label: "Third", state: "stopped", reason: "This library is open read-only, so no folder is watched." }),
      ],
      { mode: "read-only" },
    );
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    expect(await screen.findByText("This library is open read-only, so watched folders cannot be added, changed or removed here.")).toBeTruthy();
    expect(screen.getAllByText("This library is open read-only, so watched folders cannot be added, changed or removed here.")).toHaveLength(1);
    // M7: the reason is visible once, not again on each folder.
    expect(screen.getAllByText(/read-only/)).toHaveLength(1);
    expect(within(card("Third")).getByText("Not watched")).toBeTruthy();
    const disabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;
    expect(disabled(screen.getByRole("button", { name: "Add a folder…" }))).toBe(true);
    expect(disabled(within(c).getByRole("button", { name: "Pause watching “Fieldwork scans”" }))).toBe(true);
    expect(disabled(within(c).getByRole("button", { name: "Try again for “Fieldwork scans”" }))).toBe(true);
    expect(disabled(within(c).getByRole("button", { name: "Remove “Fieldwork scans”…" }))).toBe(true);
    for (const r of within(c).getAllByRole("radio")) expect(disabled(r)).toBe(true);
    expect(disabled(within(card("Other")).getByRole("button", { name: "Choose the folder on this Mac… for “Other”" }))).toBe(true);
    // Reading is not changing.
    expect(disabled(within(c).getByRole("button", { name: "Show files that did not come in for “Fieldwork scans”" }))).toBe(false);
  });

  it("a 423 shows the project as locked", async () => {
    useService([]);
    server.use(http.get(url("/projects/p1/watched-folders"), () => serviceError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.")));
    show();
    expect(await screen.findByRole("heading", { name: "Dissertation is locked" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a folder…" })).toBeNull();
  });

  it("a 423 answering an act shows the project as locked", async () => {
    useService([folder()]);
    const user = userEvent.setup();
    server.use(http.patch(url("/projects/p1/watched-folders/w1"), () => serviceError(423, "PROJECT_LOCKED", "This project is locked. Its passphrase is needed.")));
    show();
    const c = await screen.findByRole("region", { name: "Fieldwork scans" });
    await user.click(within(c).getByRole("button", { name: "Pause watching “Fieldwork scans”" }));
    expect(await screen.findByRole("heading", { name: "Dissertation is locked" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Fieldwork scans" })).toBeNull();
  });

  it("long and right-to-left names are shown as text, laid out by direction", async () => {
    const long = "ف".repeat(300);
    useService([folder({ label: long, place: { provider: null, providerName: null, display: `/Users/ana/${"x".repeat(300)}` } })]);
    show();
    const c = await screen.findByRole("region", { name: long });
    for (const el of within(c).getAllByText(long)) expect(el.getAttribute("dir")).toBe("auto");
    expect(within(c).getByRole("button", { name: `Pause watching “${long}”` })).toBeTruthy();
  });
});

describe("watchedFoldersApi: each request as the handler takes it", () => {
  const seen: Array<{ method: string; path: string; search: string; body: unknown }> = [];
  const record = async ({ request }: { request: Request }) => {
    const u = new URL(request.url);
    const text = await request.text();
    seen.push({ method: request.method, path: u.pathname, search: u.search, body: text ? JSON.parse(text) : undefined });
  };
  beforeEach(() => {
    seen.length = 0;
  });
  const api = () => watchedFoldersApi(testClient());

  it("list: GET /projects/:id/watched-folders", async () => {
    server.use(http.get(url("/projects/p%201/watched-folders"), async (i) => (await record(i), HttpResponse.json({ folders: [] }))));
    expect(await api().list("p 1")).toEqual({ folders: [] });
    expect(seen).toEqual([{ method: "GET", path: "/projects/p%201/watched-folders", search: "", body: undefined }]);
  });

  it("add: POST /projects/:id/watched-folders with the grant and options only", async () => {
    server.use(http.post(url("/projects/p1/watched-folders"), async (i) => (await record(i), HttpResponse.json(folder(), { status: 201 }))));
    await api().add("p1", { grantId: G1, recursive: false });
    expect(seen).toEqual([{ method: "POST", path: "/projects/p1/watched-folders", search: "", body: { grantId: G1, recursive: false } }]);
  });

  it("setFolder: PUT /projects/:id/watched-folders/:wid/folder with { grantId }", async () => {
    server.use(http.put(url("/projects/p1/watched-folders/w1/folder"), async (i) => (await record(i), HttpResponse.json(folder()))));
    await api().setFolder("p1", "w1", G1);
    expect(seen).toEqual([{ method: "PUT", path: "/projects/p1/watched-folders/w1/folder", search: "", body: { grantId: G1 } }]);
  });

  it("patch: PATCH /projects/:id/watched-folders/:wid with the patch", async () => {
    server.use(http.patch(url("/projects/p1/watched-folders/w1"), async (i) => (await record(i), HttpResponse.json(folder()))));
    await api().patch("p1", "w1", { notDownloaded: "download", confirmBytes: 5 });
    expect(seen).toEqual([{ method: "PATCH", path: "/projects/p1/watched-folders/w1", search: "", body: { notDownloaded: "download", confirmBytes: 5 } }]);
  });

  it("retry: POST /projects/:id/watched-folders/:wid/retry with no body", async () => {
    server.use(http.post(url("/projects/p1/watched-folders/w1/retry"), async (i) => (await record(i), HttpResponse.json(folder()))));
    await api().retry("p1", "w1");
    expect(seen).toEqual([{ method: "POST", path: "/projects/p1/watched-folders/w1/retry", search: "", body: undefined }]);
  });

  it("remove: DELETE /projects/:id/watched-folders/:wid", async () => {
    server.use(http.delete(url("/projects/p1/watched-folders/w1"), async (i) => (await record(i), HttpResponse.json({ removed: true }))));
    expect(await api().remove("p1", "w1")).toEqual({ removed: true });
    expect(seen).toEqual([{ method: "DELETE", path: "/projects/p1/watched-folders/w1", search: "", body: undefined }]);
  });

  it("files: GET …/files with offset and limit (and kind when given)", async () => {
    server.use(http.get(url("/projects/p1/watched-folders/w1/files"), async (i) => (await record(i), HttpResponse.json({ total: 0, items: [] }))));
    await api().files("p1", "w1", { offset: 0, limit: 200 });
    await api().files("p1", "w1", { kind: "gone", offset: 200, limit: 200 });
    expect(seen).toEqual([
      { method: "GET", path: "/projects/p1/watched-folders/w1/files", search: "?offset=0&limit=200", body: undefined },
      { method: "GET", path: "/projects/p1/watched-folders/w1/files", search: "?kind=gone&offset=200&limit=200", body: undefined },
    ]);
  });

  it("origin: GET /projects/:id/sources/:sid/watch-origin", async () => {
    server.use(http.get(url("/projects/p1/sources/s1/watch-origin"), async (i) => (await record(i), HttpResponse.json({ origins: [] }))));
    expect(await api().origin("p1", "s1")).toEqual({ origins: [] });
    expect(seen).toEqual([{ method: "GET", path: "/projects/p1/sources/s1/watch-origin", search: "", body: undefined }]);
  });

  it("act: POST /projects/:id/sources/:sid/watch-origin/action with { watchId, action }", async () => {
    server.use(http.post(url("/projects/p1/sources/s1/watch-origin/action"), async (i) => (await record(i), HttpResponse.json({ done: "settled", sourceId: "s1" }))));
    expect(await api().act("p1", "s1", { watchId: "w1", action: "keep-as-it-is" })).toEqual({ done: "settled", sourceId: "s1" });
    expect(seen).toEqual([{ method: "POST", path: "/projects/p1/sources/s1/watch-origin/action", search: "", body: { watchId: "w1", action: "keep-as-it-is" } }]);
  });

  it("watchedFoldersHref names the project", () => {
    expect(watchedFoldersHref("p 1")).toBe("/settings/watched-folders?project=p%201");
  });
});

describe("the way in", () => {
  it("the route shows the screen for the project in the address", async () => {
    useService([folder()]);
    render(routeFor({ pathname: "/settings/watched-folders", search: "?project=p1" }, testClient()));
    expect(await screen.findByRole("region", { name: "Fieldwork scans" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to library" }).getAttribute("href")).toBe("/?project=p1");
  });

  it("without a project the route says to open one", () => {
    render(routeFor({ pathname: "/settings/watched-folders", search: "" }, testClient()));
    expect(screen.getByText("Open a project in the library first, then choose “Watched folders”.")).toBeTruthy();
  });

  it("the library links to the screen, with its project", async () => {
    server.use(...libraryHandlers());
    render(<Library api={testApi()} current={CURRENT_RW as never} />);
    const link = await screen.findByRole("link", { name: "Watched folders" });
    expect(link.getAttribute("href")).toBe("/settings/watched-folders?project=p1");
  });
});

describe("Watched folders: first reads that never settle (FR-750, R579)", () => {
  const UNREACHABLE = "The library service could not be reached.";
  /** R586 M5: said where a read was given up at the time limit (it neither answered nor failed). */
  const NO_ANSWER = "The library service did not answer in time.";
  const listReads = () => calls.filter((c) => c === "GET /projects/p1/watched-folders").length;
  let calls: string[];
  const onReq = ({ request }: { request: Request }) => {
    const u = new URL(request.url);
    if (u.pathname !== "/events") calls.push(`${request.method} ${u.pathname}`);
  };
  beforeEach(() => {
    calls = [];
    server.events.on("request:start", onReq);
  });
  afterEach(() => {
    server.events.removeListener("request:start", onReq);
  });
  const tryAgain = () => screen.queryByRole("button", { name: "Try again" });
  const showWithin = (ms: number) => render(<WatchedFoldersRoute client={testClient()} loc={{ pathname: "/settings/watched-folders", search: "?project=p1" }} firstReadMs={ms} />);

  it("a list that hangs is given up after the limit: the usual alert with “Try again”; pressing it reads again, and focus is not lost", async () => {
    useService([]);
    let answer = false;
    const gate = hang();
    server.use(
      http.get(url("/projects/p1/watched-folders"), async () => {
        if (!answer) await gate;
        return HttpResponse.json({ seq: nextSeq(), folders: [folder()] });
      }),
    );
    showWithin(300);
    expect(screen.getByText("Reading the watched folders…")).toBeTruthy();
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual([NO_ANSWER]);
    expect(screen.queryByText("Reading the watched folders…")).toBeNull();
    expect(document.activeElement).toBe(document.body);
    answer = true;
    await userEvent.setup().click(tryAgain()!);
    await screen.findByRole("region", { name: "Fieldwork scans" });
    expect(tryAgain()).toBeNull();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(listReads()).toBe(2);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Folders" }));
  });

  it("when the event stream opens anew, a list still out from before is read again, without a press and without an event", async () => {
    useService([]);
    const ev = sseAttempts((n) => (n === 1 ? "fail" : []));
    const gate = hang();
    let n = 0;
    server.use(
      ev.handler,
      http.get(url("/projects/p1/watched-folders"), async () => {
        if (++n === 1) await gate;
        return HttpResponse.json({ seq: nextSeq(), folders: [folder()] });
      }),
    );
    show();
    await screen.findByRole("region", { name: "Fieldwork scans" }, { timeout: 10_000 });
    expect(ev.attempts()).toBe(2);
    expect(listReads()).toBe(2);
    expect(tryAgain()).toBeNull();
  });

  it("FR-756 C (R597): a stream that never opens is cancelled at the limit and opened afresh after the screen's pause; at that opening a list still out is read again", async () => {
    useService([]);
    const ev = sseAttempts((n) => (n === 1 ? "hang" : []));
    const gate = hang();
    let n = 0;
    server.use(
      ev.handler,
      http.get(url("/projects/p1/watched-folders"), async () => {
        if (++n === 1) await gate;
        return HttpResponse.json({ seq: nextSeq(), folders: [folder()] });
      }),
    );
    render(<WatchedFoldersRoute client={testClient()} loc={{ pathname: "/settings/watched-folders", search: "?project=p1" }} streamOpenMs={300} />);
    await screen.findByRole("region", { name: "Fieldwork scans" }, { timeout: 10_000 });
    expect(ev.attempts()).toBe(2);
    expect(listReads()).toBe(2);
    expect(tryAgain()).toBeNull();
  });

  it("FR-756 C (R597): a stream that has opened is never dropped by the limit, however long it stays quiet", async () => {
    useService([]);
    const ev = sseAttempts(() => []);
    server.use(ev.handler);
    render(<WatchedFoldersRoute client={testClient()} loc={{ pathname: "/settings/watched-folders", search: "?project=p1" }} streamOpenMs={200} />);
    await waitFor(() => expect(ev.attempts()).toBe(1));
    await new Promise((r) => setTimeout(r, 3_000));
    expect(ev.attempts()).toBe(1);
    // R602 M2: the page has not cancelled it (a drop after the answer began would not end a mocked body).
    expect(ev.signals()[0]!.aborted).toBe(false);
  });

  it("a service that stays unreachable is asked again once per opening of the stream, never in a loop", async () => {
    useService([]);
    const ev = sseAttempts((n) => (n === 1 ? "fail" : []));
    server.use(ev.handler, http.get(url("/projects/p1/watched-folders"), () => HttpResponse.error()));
    show();
    await screen.findByRole("button", { name: "Try again" });
    await waitFor(() => expect(listReads()).toBe(2), { timeout: 10_000 });
    await screen.findByRole("button", { name: "Try again" });
    ev.drop();
    await waitFor(() => expect(ev.attempts()).toBe(3), { timeout: 10_000 });
    await waitFor(() => expect(listReads()).toBe(3));
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual([UNREACHABLE]);
    expect(listReads()).toBe(3);
  });

  it("a list refused with an answer shows its sentence as today, with no “Try again”", async () => {
    useService([]);
    server.use(http.get(url("/projects/p1/watched-folders"), () => serviceError(500, "INTERNAL", "The watched folders could not be listed.")));
    show();
    await screen.findByText("The watched folders could not be listed.");
    expect(tryAgain()).toBeNull();
  });
});

// FR-756's remainder (R609 N4): the screen's silent side reads — the projects (its name), the libraries (the mode), the
// collections — are given up at the limit silently (cancelled; nothing new is shown), and cancelled when it is left.
describe("Watched folders: the side reads are given up silently at the limit (FR-756 remainder)", () => {
  function heldSide() {
    const gate = hang();
    const seen = new Map<string, AbortSignal>();
    const held = (name: string, body: unknown) => async ({ request }: { request: Request }) => {
      seen.set(name, request.signal);
      await gate;
      return HttpResponse.json(body as never);
    };
    server.use(
      http.get(url("/projects"), held("projects", PROJECTS)),
      http.get(url("/libraries"), held("libraries", { libraries: [], current: CURRENT_RW })),
      http.get(url("/projects/p1/collections"), held("collections", { collections: [] })),
    );
    return seen;
  }

  it("held, they are cancelled at the limit with no alert, and the folders are shown", async () => {
    useService([folder()]);
    const seen = heldSide();
    render(<WatchedFoldersRoute client={testClient()} loc={{ pathname: "/settings/watched-folders", search: "?project=p1" }} firstReadMs={300} />);
    await screen.findByRole("region", { name: "Fieldwork scans" });
    await waitFor(() => expect([...seen.keys()].sort()).toEqual(["collections", "libraries", "projects"]));
    await waitFor(() => expect([...seen.values()].every((s) => s.aborted)).toBe(true), { timeout: 3000 });
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("held, they are cancelled when the screen is left", async () => {
    useService([folder()]);
    const seen = heldSide();
    const view = render(<WatchedFoldersRoute client={testClient()} loc={{ pathname: "/settings/watched-folders", search: "?project=p1" }} firstReadMs={60_000} />);
    await screen.findByRole("region", { name: "Fieldwork scans" });
    await waitFor(() => expect([...seen.keys()].sort()).toEqual(["collections", "libraries", "projects"]));
    expect([...seen.values()].some((s) => s.aborted)).toBe(false);
    view.unmount();
    await waitFor(() => expect([...seen.values()].every((s) => s.aborted)).toBe(true), { timeout: 1000 });
  });
});
