/**
 * Every screen can be reached by clicking (D10, R170). The desktop app has no address bar, so a
 * route that no link leads to cannot be opened at all. This test walks the app as a person would:
 * it starts at the library chooser, opens a library, and then follows every in-app link on every
 * screen it reaches, rendering each screen against a mocked service. It fails when a path in the
 * route table is never reached.
 *
 * Routes that are only ever opened from another screen with an id (a source's transcript, an
 * import's review queue) are in OPENED_WITH_AN_ID below: for each, the screen that holds the id is
 * rendered with that id and must show the link.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportApi, ImportReport } from "./api/import";
import { App, ROUTES } from "./App";
import { normalisePath, PATHS } from "./navigation";
import { StepReport } from "./screens/import/StepReport";
import { SourceDetail } from "./screens/SourceDetail";
import { CURRENT_RW, LIBRARIES, libraryHandlers, server, SOURCE_FILE, testApi, TOKEN, BASE, url, useMockService } from "./test/service";
import { sourceHandlers, TRANSCRIPT_SOURCE } from "./test/verification";
import { DEFAULT_APPEARANCE } from "./theme/appearance";

useMockService();
afterEach(() => window.history.replaceState(null, "", "/"));

const ALL_PATHS: string[] = [...new Set(Object.values(PATHS))];

/**
 * Paths reached only from a screen that holds an id; each entry renders that screen with an id and
 * returns the in-app links it shows. Keep this list short: anything else must be linked from a
 * screen a person can reach without an id.
 */
const OPENED_WITH_AN_ID: Record<string, { from: string; links: () => Promise<string[]> }> = {
  // A source's transcript: the link in the source's details (TranscriptLink, mounted by Task 34d).
  [PATHS.transcript]: {
    from: "the details of a source that has a recording or a transcript (library → a source)",
    links: async () => {
      server.use(...sourceHandlers(TRANSCRIPT_SOURCE));
      render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
      await screen.findByRole("link", { name: "Open the transcript" });
      return inAppHrefs();
    },
  },
  // A source's PDF in the reader: the link in the source's details (ReaderLink, Task R7).
  [PATHS.reader]: {
    from: "the details of a source that has a PDF (library → a source)",
    links: async () => {
      server.use(...sourceHandlers(TRANSCRIPT_SOURCE));
      server.use(http.get(url("/projects/:id/sources/:sid"), () => HttpResponse.json(SOURCE_FILE)));
      render(<SourceDetail api={testApi()} projectId="p1" sourceId="s1" readOnly={false} onClose={vi.fn()} />);
      await screen.findByRole("link", { name: "Read the PDF" });
      return inAppHrefs();
    },
  },
  // An import's review queue: the link in that import's report (and in the library's "needs review" outcomes).
  [PATHS.reviewQueue]: {
    from: "the report of an import with items waiting for review (Import → … → Report and undo)",
    links: async () => {
      const report: ImportReport = {
        batchId: "b1",
        number: 1,
        kind: "folder",
        state: "finished",
        startedAt: "2026-11-10T09:00:00.000Z",
        counts: { created: 1, needsReview: 1, merged: 0, updated: 0, duplicates: 0, unchanged: 0, deletedHere: 0, failed: 0 },
        failures: [],
        fileNotes: [],
        pendingReview: [{ reviewId: "r1", reasons: ["low confidence"] }],
        keptFields: [],
        governance: [],
        notes: [],
      } as unknown as ImportReport;
      const api = { report: async () => report } as unknown as ImportApi;
      render(<StepReport api={api} projectId="p1" batchId="b1" />);
      await screen.findByRole("link", { name: /Open the review queue/ });
      return inAppHrefs();
    },
  },
};

function inAppHrefs(): string[] {
  return [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")!).filter((h) => h.startsWith("/") && !h.startsWith("//"));
}
const pathOf = (href: string) => normalisePath(new URL(href, "http://app.invalid").pathname);

/** Requests the mocked service has not answered yet. */
let inflight = 0;
server.events.on("request:start", () => {
  inflight++;
});
server.events.on("response:mocked", () => {
  inflight = Math.max(0, inflight - 1);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits until the screen has asked for everything it shows and every answer has arrived. */
async function settle(): Promise<void> {
  for (let quiet = 0; quiet < 3; ) {
    await act(async () => {
      await sleep(30);
    });
    quiet = inflight === 0 ? quiet + 1 : 0;
  }
}

/** The service: one library (open once the person opens it), the library's fixtures, and a plain "not found" for anything else. */
function serviceFor(state: { opened: boolean }) {
  return [
    http.get(url("/libraries"), () => HttpResponse.json(state.opened ? { ...LIBRARIES, current: CURRENT_RW } : LIBRARIES)),
    http.post(url("/libraries/open"), () => {
      state.opened = true;
      return HttpResponse.json(CURRENT_RW);
    }),
    http.get(url("/settings/appearance"), () => HttpResponse.json(DEFAULT_APPEARANCE)),
    http.get(url("/settings/researcher"), () => HttpResponse.json({ name: null })),
    // Its own answer for GET /libraries comes first, so the fixture's is never used.
    ...libraryHandlers(),
    http.all(url("/*"), () => HttpResponse.json({ error: { code: "NOT_FOUND", message: "Not in this test's service." } }, { status: 404 })),
  ];
}

describe("every screen can be reached by clicking (D10)", () => {
  it("the route table has a path for each route, and one route for each path", () => {
    for (const p of ALL_PATHS) expect(ROUTES.filter((r) => r.matches(p)), p).toHaveLength(1);
    for (const r of ROUTES) expect(ALL_PATHS.some((p) => r.matches(p)), String(r.matches)).toBe(true);
  });

  it("the project's whole review queue, and one source's entries in it, are reached by clicking from the library (Task 67)", async () => {
    const state = { opened: true };
    server.use(...serviceFor(state));
    render(<App service={{ baseUrl: BASE, token: TOKEN }} />);
    await screen.findByRole("navigation", { name: "Projects" });
    await screen.findByRole("link", { name: /^Review queue/ });
    await settle();
    const hrefs = inAppHrefs();
    // The header link (with the count) and a row's "Needs review" badge (that source's entries).
    expect(hrefs).toContain("/import/review?project=p1");
    expect(hrefs).toContain("/import/review?project=p1&source=s2");
  });

  it("starting at the library chooser, following links reaches every path in the route table", async () => {
    const state = { opened: false };
    server.use(...serviceFor(state));
    const service = { baseUrl: BASE, token: TOKEN };

    // The chooser: its links, then the person opens a library.
    const found = new Map<string, string>(); // path → the first href seen for it
    const from = new Map<string, string>(); // path → the screen where it was found
    const note = (hrefs: string[], where: string) => {
      for (const h of hrefs) {
        const p = pathOf(h);
        if (!found.has(p)) {
          found.set(p, h);
          from.set(p, where);
        }
      }
    };
    const chooser = render(<App service={service} />);
    await screen.findByRole("heading", { name: "Choose a library" });
    await settle();
    note(inAppHrefs(), "the library chooser");
    await userEvent.setup().click(screen.getByRole("button", { name: "Open Thesis library" }));
    await screen.findByRole("navigation", { name: "Projects" });
    await settle();
    note(inAppHrefs(), "the library");
    chooser.unmount();

    // Every screen found: rendered at its address, its links noted.
    const visited = new Set<string>([PATHS.library]);
    for (let next = [...found.keys()].find((p) => !visited.has(p)); next; next = [...found.keys()].find((p) => !visited.has(p))) {
      visited.add(next);
      if (!ROUTES.some((r) => r.matches(next!))) continue; // not a screen of the app (reported below)
      window.history.replaceState(null, "", found.get(next)!);
      const view = render(<App service={service} />);
      await settle();
      note(inAppHrefs(), found.get(next)!);
      view.unmount();
    }

    // Paths opened with an id: the screen holding the id shows the link.
    for (const [path, entry] of Object.entries(OPENED_WITH_AN_ID)) {
      const hrefs = await entry.links();
      expect(hrefs.map(pathOf), `${path} from ${entry.from}`).toContain(path);
      note(hrefs, entry.from);
      cleanup();
    }

    const unreached = ALL_PATHS.filter((p) => !found.has(normalisePath(p)) && normalisePath(p) !== PATHS.library);
    // "/library" is the same screen as "/", which is where the app starts.
    expect(unreached.filter((p) => p !== PATHS.libraryAlias), "paths no link leads to").toEqual([]);
    // Every link leads to a screen of the app.
    expect([...found.keys()].filter((p) => !ROUTES.some((r) => r.matches(p))), "links to no screen").toEqual([]);
    await waitFor(() => expect(inflight).toBe(0));
  });
});
