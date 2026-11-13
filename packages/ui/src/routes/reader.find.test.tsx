/**
 * The reader's route when a search's words or an annotation id come with it (Task R12): the words are
 * taken once from the in-memory hand-over (never from the address); with several PDFs the file that
 * holds the first matching annotation is the one that opens (the source's annotations are asked for
 * once, matched file by file in the File choice's order, with R1's `matchAnnotations`); "Looking for
 * the words…" while that is asked; a failed question opens the first file and still passes the words;
 * choosing a file by hand drops the words; the reader ending drops them.
 *
 * The screen itself is tested in screens/Reader.find.test.tsx; here only what it is given.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeFor } from "../App";
import type { AnnotationRecord } from "../api/reader";
import { clearPendingFind, hasPendingFind, setPendingFind, takePendingFind } from "../reader/readerHandoff";
const DROPPED = "Your search was not carried over, so all annotations are shown.";
import { CURRENT_RW, LIBRARIES, PROJECTS, server, SOURCE_FILE, sse, testClient, url, useMockService } from "../test/service";

const seenProps = vi.hoisted(() => [] as number[]);
vi.mock("../screens/Reader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../screens/Reader")>()),
  ReaderScreen: (p: { assetId?: string; annotationId?: string; findWords?: string; onFindDone?: () => void; preloadedAnnotations?: unknown[] }) => (
    <div>
      {(seenProps.push(p.preloadedAnnotations ? p.preloadedAnnotations.length : 0), null)}
      <p data-testid="preloaded">{p.preloadedAnnotations ? String(p.preloadedAnnotations.length) : "-"}</p>
      <p data-testid="reader-screen">{`${p.assetId ?? "-"}|${p.annotationId ?? "-"}|${p.findWords ?? "-"}`}</p>
      <button type="button" onClick={() => p.onFindDone?.()}>
        hand back
      </button>
    </div>
  ),
}));

useMockService();

beforeEach(() => {
  seenProps.length = 0;
  clearPendingFind();
  window.history.replaceState(null, "", "/");
});
afterEach(async () => {
  cleanup();
  clearPendingFind();
  await new Promise((r) => setTimeout(r, 20));
  window.history.replaceState(null, "", "/");
});

import { useLocation } from "../navigation";
function Host() {
  return routeFor(useLocation(), testClient());
}

const pdf = (id: string, name: string) => ({ id, sourceId: "s1", role: "original", kind: "pdf", path: `Dissertation/Sources/s1/${name}`, encrypted: false, sha256: "0".repeat(64), bytes: 1024, mime: "application/pdf" });
const TWO = [pdf("a1", "chapter-1.pdf"), pdf("a2", "chapter-2.pdf")];

function rec(id: string, assetId: string, quote: string, page = 1): AnnotationRecord {
  return {
    id,
    sourceId: "s1",
    kind: "highlight",
    pdfAnchors: [{ id: `${id}-a`, assetId, page, rects: [{ x: 1, y: 1, w: 1, h: 1 }], sortIndex: "00001|000000|00000", sortIndexDerived: false }],
    otherAnchorKinds: [],
    quote,
    colorName: "yellow",
    imported: false,
    author: "me",
    createdAt: "2026-11-13T10:00:00Z",
  };
}

function serve(assets: unknown[], annotations: () => Response | Promise<Response>) {
  const asked: string[] = [];
  server.use(
    http.get(url("/events"), () => sse([])),
    http.get(url("/projects"), () => HttpResponse.json(PROJECTS)),
    http.get(url("/libraries"), () => HttpResponse.json({ ...LIBRARIES, current: CURRENT_RW })),
    http.get(url("/projects/:id/sources/:sid"), () => HttpResponse.json({ ...SOURCE_FILE, assets })),
    http.get(url("/projects/:id/sources/:sid/annotations"), ({ request }) => {
      asked.push(request.url);
      return annotations();
    }),
  );
  return asked;
}
const list = (items: AnnotationRecord[]) => () => HttpResponse.json({ annotations: items, count: items.length, textChars: 0 }) as unknown as Response;
const shownScreen = async () => (await screen.findByTestId("reader-screen")).textContent;
const storages = () => JSON.stringify([...Object.entries(localStorage), ...Object.entries(sessionStorage)]);

describe("the reader route with a search hit's words (Task R12)", () => {
  it("opens the file of the source that holds the first matching annotation, and gives the screen the words; the address stays ids only", async () => {
    const asked = serve(TWO, list([rec("n1", "a1", "unrelated text"), rec("n2", "a2", "the field and its habitus")]));
    setPendingFind("p1", "s1", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await shownScreen()).toBe("a2|-|habitus");
    // The source's annotations were asked for once, for the choice of file.
    expect(asked).toHaveLength(1);
    expect(window.location.search).toBe("?project=p1&source=s1");
    expect(window.location.href).not.toContain("habitus");
    expect(JSON.stringify(window.history.state)).not.toContain("habitus");
    expect(storages()).not.toContain("habitus");
    expect(takePendingFind("p1", "s1")).toBeUndefined();
    // The File choice shows the file that opened.
    expect((screen.getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);
  });

  it("takes the first file, in the File choice's order, when several hold matches", async () => {
    serve(TWO, list([rec("late", "a2", "habitus here"), rec("early", "a1", "habitus there")]));
    setPendingFind("p1", "s1", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await shownScreen()).toBe("a1|-|habitus");
  });

  it("says 'Looking for the words…' while the source's annotations are asked for, and opens nothing before", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    serve(TWO, async () => {
      await gate;
      return list([rec("n2", "a2", "habitus")])();
    });
    setPendingFind("p1", "s1", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await screen.findByText("Looking for the words…")).toBeTruthy();
    expect(screen.queryByTestId("reader-screen")).toBeNull();
    release();
    expect(await shownScreen()).toBe("a2|-|habitus");
    expect(screen.queryByText("Looking for the words…")).toBeNull();
  });

  it("with no match in any file opens the first file and still hands the words over (the screen says nothing matched)", async () => {
    serve(TWO, list([rec("n1", "a1", "alpha"), rec("n2", "a2", "beta")]));
    setPendingFind("p1", "s1", "gamma");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await shownScreen()).toBe("a1|-|gamma");
  });

  it("when the question fails, opens the first file with the words (the screen asks again for itself)", async () => {
    serve(TWO, () => HttpResponse.error() as unknown as Response);
    setPendingFind("p1", "s1", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await shownScreen()).toBe("a1|-|habitus");
  });

  it("one PDF: nothing is asked for here, the screen gets the words at once", async () => {
    const asked = serve([pdf("a1", "only.pdf")], list([]));
    setPendingFind("p1", "s1", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await shownScreen()).toBe("a1|-|habitus");
    expect(asked).toHaveLength(0);
  });

  it("an asset named in the address is the file that opens, whatever the words match elsewhere", async () => {
    const asked = serve(TWO, list([rec("n2", "a2", "habitus")]));
    setPendingFind("p1", "s1", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1&asset=a1");
    render(<Host />);
    expect(await shownScreen()).toBe("a1|-|habitus");
    expect(asked).toHaveLength(0);
  });

  it("words handed over for another source are not given to this one, and are gone", async () => {
    serve(TWO, list([]));
    setPendingFind("p1", "other-source", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await shownScreen()).toBe("a1|-|-");
    expect(takePendingFind("p1", "other-source")).toBeUndefined();
  });

  it("when the screen is done with the words, and when another file is chosen by hand, the words are not given again", async () => {
    const user = userEvent.setup();
    serve(TWO, list([rec("n1", "a1", "habitus")]));
    setPendingFind("p1", "s1", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await shownScreen()).toBe("a1|-|habitus");
    await user.click(screen.getAllByRole("radio")[1]!);
    await waitFor(() => expect(screen.getByTestId("reader-screen").textContent).toBe("a2|-|-"));
    expect(window.location.search).toBe("?project=p1&source=s1&asset=a2");
    await user.click(screen.getAllByRole("radio")[0]!);
    await waitFor(() => expect(screen.getByTestId("reader-screen").textContent).toBe("a1|-|-"));
  });

  it("the screen handing the words back drops them from the route", async () => {
    const user = userEvent.setup();
    serve([pdf("a1", "only.pdf")], list([]));
    setPendingFind("p1", "s1", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await shownScreen()).toBe("a1|-|habitus");
    await user.click(screen.getByRole("button", { name: "hand back" }));
    await waitFor(() => expect(screen.getByTestId("reader-screen").textContent).toBe("a1|-|-"));
  });
});

describe("what the route hands on (R12 fix round 1)", () => {
  it("hands the screen the list it asked for, so that the screen does not ask again", async () => {
    serve(TWO, list([rec("n1", "a1", "unrelated"), rec("n2", "a2", "habitus")]));
    setPendingFind("p1", "s1", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await shownScreen()).toBe("a2|-|habitus");
    expect(screen.getByTestId("preloaded").textContent).toBe("2");
  });

  it("hands nothing when the question failed (the screen asks for itself)", async () => {
    serve(TWO, () => HttpResponse.error() as unknown as Response);
    setPendingFind("p1", "s1", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    await shownScreen();
    expect(screen.getByTestId("preloaded").textContent).toBe("-");
  });

  it("tells the researcher once, politely, that words dropped on the way were not carried over", async () => {
    serve(TWO, list([]));
    setPendingFind("p1", "s1", "habitus");
    clearPendingFind();
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await shownScreen()).toBe("a1|-|-");
    expect(screen.getByText(DROPPED).getAttribute("role")).toBe("status");
    cleanup();
    render(<Host />);
    await shownScreen();
    expect(screen.queryByText(DROPPED)).toBeNull();
  });

  it("says nothing when the reader was opened in the ordinary way", async () => {
    serve(TWO, list([]));
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    await shownScreen();
    expect(screen.queryByText(DROPPED)).toBeNull();
  });

  it("a project locked while the route is still asking which file holds the words ends the reader: the screen is never given them", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    serve(TWO, async () => {
      await gate;
      return list([rec("n2", "a2", "habitus")])();
    });
    server.use(
      http.get(url("/events"), () => sse([{ type: "library.state", data: { open: true, ...CURRENT_RW } }])),
      http.get(url("/projects"), () => HttpResponse.json({ projects: PROJECTS.projects.map((p) => (p.id === "p1" ? { ...p, unlocked: false } : p)) })),
    );
    setPendingFind("p1", "s1", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await screen.findByText("This project is locked. Unlock it in the library to read its files.")).toBeTruthy();
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("reader-screen")).toBeNull();
  });
});

describe("R222: nothing of the list is kept by the route; no words are held without a file", () => {
  /** An event stream the test feeds, so that the mounted route can be made to render again. */
  function liveEvents() {
    const open: ReadableStreamDefaultController<Uint8Array>[] = [];
    const enc = new TextEncoder();
    server.use(
      http.get(url("/events"), () => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            open.push(c);
          },
        });
        return new HttpResponse(stream, { headers: { "content-type": "text/event-stream" } });
      }),
    );
    return (data: unknown) => open.forEach((c) => c.enqueue(enc.encode(`event: library.state\ndata: ${JSON.stringify(data)}\n\n`)));
  }

  it("the list is handed on with the first render of the screen and is not kept: the route's later renders, and the screen's own, pass none", async () => {
    serve(TWO, list([rec("n2", "a2", "zeppelin quote-secret")]));
    const push = liveEvents();
    setPendingFind("p1", "s1", "zeppelin");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await shownScreen()).toBe("a2|-|zeppelin");
    expect(seenProps[0]).toBe(1);
    // The library's mode changes: the mounted route renders again, its screen with it.
    push({ open: true, ...CURRENT_RW, mode: "read-only" });
    await waitFor(() => expect(seenProps.length).toBeGreaterThan(1));
    expect(seenProps.slice(1).every((n) => n === 0)).toBe(true);
  });

  it("a lock after the route chose the file: the locked view shows and nothing of the annotations is anywhere in it", async () => {
    serve(TWO, list([rec("n2", "a2", "zeppelin quote-secret")]));
    const push = liveEvents();
    setPendingFind("p1", "s1", "zeppelin");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    expect(await shownScreen()).toBe("a2|-|zeppelin");
    server.use(http.get(url("/projects"), () => HttpResponse.json({ projects: PROJECTS.projects.map((p) => (p.id === "p1" ? { ...p, unlocked: false } : p)) })));
    push({ open: true, ...CURRENT_RW });
    expect(await screen.findByText("This project is locked. Unlock it in the library to read its files.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("quote-secret");
    expect(screen.queryByTestId("reader-screen")).toBeNull();
  });

  it("the words are taken only when there is a file to open: while the source is read they wait; a source with no PDF drops them at once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    serve([{ ...pdf("x1", "scan.png"), mime: "image/png", kind: "image" }], list([]));
    server.use(
      http.get(url("/projects/:id/sources/:sid"), async () => {
        await gate;
        return HttpResponse.json({ ...SOURCE_FILE, assets: [{ ...pdf("x1", "scan.png"), mime: "image/png", kind: "image" }] });
      }),
    );
    setPendingFind("p1", "s1", "habitus");
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    render(<Host />);
    await screen.findByText("Opening the source…");
    expect(hasPendingFind()).toBe(true);
    release();
    expect(await screen.findByText("This source has no PDF that can be shown here.")).toBeTruthy();
    expect(hasPendingFind()).toBe(false);
    expect(screen.queryByTestId("reader-screen")).toBeNull();
  });
});

describe("the reader route with an annotation id (Task R12)", () => {
  it("opens the file that holds the annotation, and passes its id on", async () => {
    serve(TWO, list([rec("n1", "a1", "x"), rec("target", "a2", "y")]));
    window.history.replaceState(null, "", "/reader?project=p1&source=s1&annotation=target");
    render(<Host />);
    expect(await shownScreen()).toBe("a2|target|-");
  });

  it("an id that is nowhere opens the first file, and the screen says it is gone", async () => {
    serve(TWO, list([rec("n1", "a1", "x")]));
    window.history.replaceState(null, "", "/reader?project=p1&source=s1&annotation=vanished");
    render(<Host />);
    expect(await shownScreen()).toBe("a1|vanished|-");
  });

  it("with the asset named too, nothing is asked here", async () => {
    const asked = serve(TWO, list([rec("target", "a2", "y")]));
    window.history.replaceState(null, "", "/reader?project=p1&source=s1&asset=a1&annotation=target");
    render(<Host />);
    expect(await shownScreen()).toBe("a1|target|-");
    expect(asked).toHaveLength(0);
  });
});
