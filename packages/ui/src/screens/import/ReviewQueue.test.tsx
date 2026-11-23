import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportApi, ReviewItem, SourceFile } from "../../api/import";
import { http, HttpResponse } from "msw";
import { BASE as SERVICE, mockService, PSEUDONYMISING_GOVERNANCE, server, type ServiceSetup, B1, P1 } from "../../test/importService";
import { renderToStaticMarkup } from "react-dom/server";
import { HELD_FILE_LOOKS_RIGHT_TEXT, HELD_FILE_WHY_TEXT } from "@ao/shared";
import { FilePreview } from "./FilePreview";
import { DECIDE_SETTLE_MS, HELD_DECISION_TIMEOUT_MS, HELD_NO_ANSWER_TEXT, ReviewQueue } from "./ReviewQueue";
import { SCROLL_SETTLE_MS } from "./pressGuard";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

/**
 * R362 d: the panel's deciding controls take a mouse press only where the pointer really moved over them (their client
 * coordinates changed), and none in the panel's quiet after the list changed. user-event's own click moves to the
 * element without new coordinates, so a press here travels: from a point on the page to a new point on the control, then
 * the button goes down and up there (`clicks` times). `settle` lets the panel's quiet pass first (after a decision).
 */
let travel = 0;
const settle = () => new Promise((r) => setTimeout(r, DECIDE_SETTLE_MS + 20));
const pressPanel = async (user: ReturnType<typeof userEvent.setup>, el: Element, clicks = 1) => {
  travel += 10;
  await user.pointer([
    { target: document.body, coords: { clientX: travel, clientY: travel } },
    { target: el, coords: { clientX: travel + 3, clientY: travel + 2 } },
    ...Array.from({ length: clicks }, () => ({ keys: "[MouseLeft]", target: el })),
  ]);
};

const item = (n: number, extra: Partial<ReviewItem> = {}): ReviewItem => ({
  id: `r${n}`,
  projectId: P1,
  sourceId: `s${n}`,
  kind: "import",
  status: "pending",
  createdAt: "2026-11-11T10:00:00.000Z",
  fields: {},
  reasons: ["Low confidence"],
  confidence: 0.5,
  method: "embedded",
  batchId: B1,
  ...extra,
});

const source = (n: number, title: string, extra: { evidence?: unknown[]; collectionIds?: string[]; tagIds?: string[] } = {}) => ({
  source: {
    id: `s${n}`,
    type: "article-journal",
    title: { variants: [{ lang: "en", kind: "original", value: title }] },
    creators: [{ family: "Smith", given: "Ann" }],
    issued: "2020",
    collectionIds: extra.collectionIds ?? [],
    tagIds: extra.tagIds ?? [],
    provenance: { identification: { method: "embedded", confidence: 0.5 }, importBatchId: B1 },
  },
  assets: [{ id: "a1", fileName: `paper-${n}.pdf`, mediaType: "application/pdf", role: "original" }],
  fieldEvidence: extra.evidence ?? [],
});

/** A UUIDv7 id minted at `iso` (its first 48 bits are the time in ms). */
const idAt = (iso: string, n: number) => {
  const h = Date.parse(iso).toString(16).padStart(12, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7000-8000-${n.toString(16).padStart(12, "0")}`;
};

const BATCH = {
  batchId: B1,
  number: 4,
  kind: "folder",
  state: "finished",
  startedAt: "2026-11-11T10:00:00.000Z",
  finishedAt: "2026-11-11T10:20:00.000Z",
  counts: { created: 3, merged: 0, skipped: 0, failed: 0, needsReview: 3 },
  // The collection and tag the R64 tests' batch made (idAt 10:05 n=1, 10:06 n=3).
  created: { collectionIds: [idAt("2026-11-11T10:05:00.000Z", 1)], tagIds: [idAt("2026-11-11T10:06:00.000Z", 3)] },
};

const BASE: ServiceSetup = {
  review: [
    item(1, {
      candidates: [
        { title: "Kinship in Herat", creators: [{ family: "Smith", given: "Ann" }], issued: "2020", type: "article-journal", provider: "crossref", identifiers: { doi: "10.1/kin" } },
        { title: "Kinship and Herat", creators: [], type: "book", provider: "openlibrary" },
      ],
    }),
    item(2),
    item(3),
  ],
  sources: { s1: source(1, "kinship herat draft"), s2: source(2, "Second paper"), s3: source(3, "Third paper") },
  collections: [{ id: "c1", name: "Chapter 2" }],
  tags: [{ id: "t1", name: "fieldwork", color: "#1F5E63" }, { id: "t2", name: "theory" }],
};

function setup(o: ServiceSetup = BASE) {
  const m = mockService(o);
  const user = userEvent.setup();
  render(<ReviewQueue client={m.client} projectId={P1} batchId={B1} />);
  return { m, user };
}

const everyBodyHasProject = (m: ReturnType<typeof mockService>) => {
  const review = m.calls.filter((c) => c.path.startsWith("/review/"));
  expect(review.length).toBeGreaterThan(0);
  for (const c of review) expect((c.body as { projectId?: string }).projectId).toBe(P1);
};

describe("Review queue", () => {
  it("shows the selected item side by side with its candidates", async () => {
    setup();
    const preview = await screen.findByRole("region", { name: "Imported record" });
    expect(await within(preview).findByText("kinship herat draft")).toBeTruthy();
    expect(within(preview).getByText("paper-1.pdf")).toBeTruthy();
    const candidates = screen.getByRole("region", { name: "Candidate matches" });
    expect(within(candidates).getByText("Kinship in Herat")).toBeTruthy();
    expect(within(candidates).getByText("Kinship and Herat")).toBeTruthy();
    expect(within(candidates).getByText(/10\.1\/kin/)).toBeTruthy();
  });

  it("selecting 3 items and Set type → Report posts one bulk edit", async () => {
    const { m, user } = setup();
    await screen.findByRole("checkbox", { name: "Select Second paper" });
    await user.click(screen.getByRole("checkbox", { name: "Select kinship herat draft" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Second paper" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Third paper" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Set type" }), "report");
    await user.click(screen.getByRole("button", { name: "Apply type to 3 items" }));
    await waitFor(() => expect(m.bodies("POST /review/bulk-edit")).toHaveLength(1));
    expect(m.bodies("POST /review/bulk-edit")).toEqual([{ projectId: P1, itemIds: ["r1", "r2", "r3"], patch: { type: "report" } }]);
  });

  it("bulk Add tag and Move to collection post their patches", async () => {
    const { m, user } = setup();
    await screen.findByRole("checkbox", { name: "Select Second paper" });
    await user.click(screen.getByRole("checkbox", { name: "Select all" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Add tag" }), "t1");
    await user.click(screen.getByRole("button", { name: "Add tag to 3 items" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Move to collection" }), "c1");
    await user.click(screen.getByRole("button", { name: "Move 3 items" }));
    await waitFor(() => expect(m.bodies("POST /review/bulk-edit")).toHaveLength(2));
    expect(m.bodies("POST /review/bulk-edit")).toEqual([
      { projectId: P1, itemIds: ["r1", "r2", "r3"], patch: { tagIds: ["t1"] } },
      { projectId: P1, itemIds: ["r1", "r2", "r3"], patch: { collectionId: "c1" } },
    ]);
  });

  it("shows tags with their swatch", async () => {
    setup({ ...BASE, sources: { ...BASE.sources, s1: source(1, "kinship herat draft", { tagIds: ["t1"] }) } });
    const preview = await screen.findByRole("region", { name: "Imported record" });
    await within(preview).findByText("fieldwork");
    expect(within(preview).getAllByTestId("code-swatch").length).toBeGreaterThan(0);
  });

  it("per-item Accept, Skip and Keep both decide with the project in the body", async () => {
    const { m, user } = setup();
    await screen.findByRole("region", { name: "Imported record" });
    await pressPanel(user, screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(m.bodies("POST /review/r1/decide")).toEqual([{ projectId: P1, decision: { action: "accept" } }]));
    // r1 is gone; r2 is now shown.
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Select kinship herat draft" })).toBeNull());
    await within(screen.getByRole("region", { name: "Imported record" })).findByText("Second paper");
    await settle();
    await pressPanel(user, screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(m.bodies("POST /review/r2/decide")).toEqual([{ projectId: P1, decision: { action: "skip" } }]));
    await within(screen.getByRole("region", { name: "Imported record" })).findByText("Third paper");
    await settle();
    await pressPanel(user, screen.getByRole("button", { name: "Keep both" }));
    await waitFor(() => expect(m.bodies("POST /review/r3/decide")).toEqual([{ projectId: P1, decision: { action: "keep-both" } }]));
    expect(await screen.findByText(/Nothing is waiting for review/)).toBeTruthy();
    everyBodyHasProject(m);
  });

  it("accepting a candidate sends its index", async () => {
    const { m, user } = setup();
    const candidates = await screen.findByRole("region", { name: "Candidate matches" });
    await pressPanel(user, within(candidates).getAllByRole("button", { name: /Use this match/ })[1]!);
    await waitFor(() => expect(m.bodies("POST /review/r1/decide")).toEqual([{ projectId: P1, decision: { action: "accept-candidate", index: 1 } }]));
  });

  it("Edit accepts with the corrected title and type", async () => {
    const { m, user } = setup();
    await within(await screen.findByRole("region", { name: "Imported record" })).findByText("kinship herat draft");
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Kinship in Herat");
    await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "book");
    await pressPanel(user, screen.getByRole("button", { name: "Save and accept" }));
    await waitFor(() =>
      expect(m.bodies("POST /review/r1/decide")).toEqual([
        { projectId: P1, decision: { action: "accept", draft: { type: "book", title: { variants: [{ lang: "en", kind: "original", value: "Kinship in Herat" }] } } } },
      ]),
    );
  });

  it("Merge searches the library and merges into the chosen source", async () => {
    const { m, user } = setup();
    await screen.findByRole("region", { name: "Imported record" });
    await user.click(screen.getByRole("button", { name: "Merge" }));
    await user.type(screen.getByRole("searchbox", { name: "Find the source to merge into" }), "older");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await pressPanel(user, await screen.findByRole("button", { name: "Merge into An older edition" }));
    await waitFor(() => expect(m.bodies("POST /review/r1/decide")).toEqual([{ projectId: P1, decision: { action: "merge", sourceId: "s-old" } }]));
  });

  it("offers the likely duplicate as the merge target", async () => {
    const { m, user } = setup({ ...BASE, review: [item(1, { duplicateOf: { sourceId: "s9", reason: "Same DOI" } })] });
    await screen.findByText(/Same DOI/);
    await pressPanel(user, screen.getByRole("button", { name: "Merge into the likely duplicate" }));
    await waitFor(() => expect(m.bodies("POST /review/r1/decide")).toEqual([{ projectId: P1, decision: { action: "merge", sourceId: "s9" } }]));
  });

  describe("pseudonymised projects (R64)", () => {
    const HEDGED_COLLECTIONS =
      "The app has no record of which collections this import made, so these collection names may come from folder names, which can carry participants' names. Check them, and rename the collection or move the item if one names someone.";
    const HEDGED_TAGS =
      "The app has no record of which tags this import made, so these tag names may come from folder names, which can carry participants' names. Check them, and rename or remove a tag that names someone.";
    const made = idAt("2026-11-11T10:05:00.000Z", 1); // created by the batch
    const older = idAt("2026-10-01T09:00:00.000Z", 2); // existed before it
    const madeTag = idAt("2026-11-11T10:06:00.000Z", 3);
    const flagged: ServiceSetup = {
      ...BASE,
      governance: PSEUDONYMISING_GOVERNANCE,
      batches: [BATCH],
      collections: [{ id: made, name: "Amina Rahimi" }, { id: older, name: "Chapter 2" }],
      tags: [{ id: madeTag, name: "rahimi-family" }],
      review: [item(1, { method: "filename" })],
      sources: {
        s1: source(1, "Interview Amina Rahimi 2024", {
          evidence: [{ field: "/title", value: "Interview Amina Rahimi 2024", source: { kind: "filename" } }],
          collectionIds: [made],
          tagIds: [madeTag],
        }),
      },
    };

    it("flags titles from file names, and collections and tags the batch made from folder names", async () => {
      setup(flagged);
      const preview = await screen.findByRole("region", { name: "Imported record" });
      expect(await within(preview).findByText(/title was taken from the file name/i)).toBeTruthy();
      expect(await within(preview).findByText(/collection names come from folder names/i)).toBeTruthy();
      expect(within(preview).getByText(/tag names come from folder names/i)).toBeTruthy();
      expect(within(preview).getAllByText(/participants' names/i).length).toBeGreaterThan(0);
    });

    it("flags by the ids the batch reports it created, not by when an id was minted (R118)", async () => {
      // Made during the batch's run but not by it (another window), and made by it but with an id outside its run.
      const sameTime = idAt("2026-11-11T10:07:00.000Z", 4);
      const ours = idAt("2026-09-01T09:00:00.000Z", 5);
      setup({
        ...flagged,
        batches: [{ ...BATCH, created: { collectionIds: [ours], tagIds: [] } }],
        collections: [{ id: sameTime, name: "Someone else's" }, { id: ours, name: "Amina Rahimi" }],
        tags: [],
        sources: { s1: source(1, "Interview 3", { collectionIds: [sameTime] }) },
      });
      const preview = await screen.findByRole("region", { name: "Imported record" });
      await within(preview).findByText("Someone else's");
      expect(within(preview).queryByText(/collection names come from folder names/i)).toBeNull();
    });

    it("flags a collection whose id the batch reports as created", async () => {
      const ours = idAt("2026-09-01T09:00:00.000Z", 5);
      setup({
        ...flagged,
        batches: [{ ...BATCH, created: { collectionIds: [ours], tagIds: [] } }],
        collections: [{ id: ours, name: "Amina Rahimi" }],
        tags: [],
        sources: { s1: source(1, "Interview 3", { collectionIds: [ours] }) },
      });
      const preview = await screen.findByRole("region", { name: "Imported record" });
      expect(await within(preview).findByText(/collection names come from folder names/i)).toBeTruthy();
    });

    it("does not flag collections and tags that existed before the batch", async () => {
      setup({ ...flagged, sources: { s1: source(1, "Interview 3", { collectionIds: [older], tagIds: [] }) } });
      const preview = await screen.findByRole("region", { name: "Imported record" });
      await within(preview).findByText("Chapter 2");
      expect(within(preview).queryByText(/collection names come from folder names/i)).toBeNull();
      expect(within(preview).queryByText(/tag names come from folder names/i)).toBeNull();
    });

    it("does not flag collections of a Zotero import (they are Zotero's own)", async () => {
      setup({ ...flagged, batches: [{ ...BATCH, kind: "zotero-local" }] });
      const preview = await screen.findByRole("region", { name: "Imported record" });
      await within(preview).findByText("Amina Rahimi");
      expect(within(preview).queryByText(/collection names come from folder names/i)).toBeNull();
    });

    it("FR-157: a folder batch from an older service that reports nothing it created flags its collections and tags (fails closed)", async () => {
      const { created: _c, ...olderBatch } = BATCH;
      setup({ ...flagged, batches: [olderBatch], sources: { s1: source(1, "Interview 3", { collectionIds: [older], tagIds: [madeTag] }) } });
      const preview = await screen.findByRole("region", { name: "Imported record" });
      await within(preview).findByText("Chapter 2");
      // R465 a: no record of what it made, so the sentence is hedged, never that the names DO come from folder names.
      expect(await within(preview).findByText(HEDGED_COLLECTIONS)).toBeTruthy();
      expect(within(preview).getByText(HEDGED_TAGS)).toBeTruthy();
      expect(within(preview).queryByText(/^These (collection|tag) names come from folder names/)).toBeNull();
    });

    it("FR-157: a batch the screen does not know (not in the list of imports it read) flags them too", async () => {
      setup({ ...flagged, batches: [], sources: { s1: source(1, "Interview 3", { collectionIds: [older], tagIds: [] }) } });
      const preview = await screen.findByRole("region", { name: "Imported record" });
      await within(preview).findByText("Chapter 2");
      expect(await within(preview).findByText(HEDGED_COLLECTIONS)).toBeTruthy();
      expect(within(preview).queryByText(/^These collection names come from folder names/)).toBeNull();
    });

    it("R465 a: an import that reports what it created keeps the asserting sentence, for exactly those", async () => {
      setup({ ...flagged, sources: { s1: source(1, "Interview 3", { collectionIds: [made, older], tagIds: [madeTag] }) } });
      const preview = await screen.findByRole("region", { name: "Imported record" });
      expect(
        await within(preview).findByText("These collection names come from folder names, which can carry participants' names. Check them, and rename the collection or move the item if one names someone."),
      ).toBeTruthy();
      expect(within(preview).getByText("These tag names come from folder names, which can carry participants' names. Check them, and rename or remove a tag that names someone.")).toBeTruthy();
      expect(within(preview).queryByText(HEDGED_COLLECTIONS)).toBeNull();
      expect(within(preview).queryByText(HEDGED_TAGS)).toBeNull();
    });

    it("FR-157 (R463 M1): the list of imports could not be read (a read-only library): no folder-name warning on any entry", async () => {
      let answered!: () => void;
      const refused = new Promise<void>((r) => (answered = r));
      setup({ ...flagged, batchesRefused: true, onBatchesAnswered: () => answered(), sources: { s1: source(1, "Interview 3", { collectionIds: [made, older], tagIds: [madeTag] }) } });
      const preview = await screen.findByRole("region", { name: "Imported record" });
      await within(preview).findByText("Chapter 2");
      await refused;
      // The refusal has been handled (its promise settles before the next task).
      await act(async () => {});
      expect(within(preview).queryByText(/collection names come from folder names/i)).toBeNull();
      expect(within(preview).queryByText(/tag names come from folder names/i)).toBeNull();
    });

    it("FR-157 (R463 M1): no folder-name warning before the list of imports is known; once known, the batch's own are flagged", async () => {
      let release!: () => void;
      const batchesHeld = new Promise<void>((r) => (release = r));
      setup({ ...flagged, batchesHeld, sources: { s1: source(1, "Interview 3", { collectionIds: [made, older], tagIds: [] }) } });
      const preview = await screen.findByRole("region", { name: "Imported record" });
      await within(preview).findByText("Chapter 2");
      expect(within(preview).queryByText(/collection names come from folder names/i)).toBeNull();
      release();
      expect(await within(preview).findByText(/collection names come from folder names/i)).toBeTruthy();
    });

    it("does not flag them when names are not pseudonymised", async () => {
      setup({ ...flagged, governance: undefined });
      const preview = await screen.findByRole("region", { name: "Imported record" });
      await within(preview).findByText("Interview Amina Rahimi 2024");
      expect(within(preview).queryByText(/title was taken from the file name/i)).toBeNull();
    });
  });

  it("shows the titles the service sends at once; only the shown item's record is fetched (R118)", async () => {
    const n = 300;
    const review = Array.from({ length: n }, (_, i) => item(i + 1, { title: `Listed paper ${i + 1}` }));
    const sources = Object.fromEntries(review.map((r, i) => [r.sourceId!, source(i + 1, `Listed paper ${i + 1}`)]));
    const { m } = setup({ review, sources });
    expect(await screen.findByRole("checkbox", { name: "Select Listed paper 300" })).toBeTruthy();
    await within(screen.getByRole("region", { name: "Imported record" })).findByText("Listed paper 1");
    await new Promise((r) => setTimeout(r, 200));
    const fetched = m.calls.filter((c) => c.method === "GET" && /\/sources\/s\d+$/.test(c.path)).map((c) => c.path);
    expect(fetched).toEqual([expect.stringMatching(/\/sources\/s1$/)]);
  });

  it("loads titles six at a time (items sent without a title), the current item first, and it can be acted on early", async () => {
    const n = 2000;
    const review = Array.from({ length: n }, (_, i) => item(i + 1));
    const sources = Object.fromEntries(review.map((r, i) => [r.sourceId!, source(i + 1, `Paper ${i + 1}`)]));
    const { m, user } = setup({ review, sources, sourceDelayMs: 1 });
    // Found inside its group: a query by role and name over the whole page computes the name of every
    // one of the list's 4,000 controls, again on each change of the DOM while titles arrive.
    const accept = within(await screen.findByRole("group", { name: "Decide this item" })).getByRole("button", { name: "Accept" });
    await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false));
    const sourceCalls = () => m.calls.filter((c) => c.method === "GET" && /\/sources\/s\d+$/.test(c.path));
    expect(sourceCalls()[0]!.path).toMatch(/\/sources\/s1$/);
    expect(sourceCalls().length).toBeLessThan(n); // not waiting for the whole queue
    await pressPanel(user, accept);
    await waitFor(() => expect(m.bodies("POST /review/r1/decide")).toHaveLength(1));
    // Polled (not waitFor, which re-runs on every DOM change of a 2,000-row list).
    for (const end = Date.now() + 30000; sourceCalls().length < n && Date.now() < end; ) await new Promise((r) => setTimeout(r, 100));
    expect(sourceCalls().length).toBe(n);
    expect(m.peakSourceRequests()).toBeLessThanOrEqual(6);
    expect(m.peakSourceRequests()).toBeGreaterThan(1);
  }, 40000);

  it("a title that failed to load can be retried", async () => {
    const { user } = setup({ ...BASE, failSourcesOnce: ["s2"] });
    const retry = await screen.findByRole("button", { name: "Retry loading item 2" });
    await user.click(retry);
    expect(await screen.findByRole("checkbox", { name: "Select Second paper" })).toBeTruthy();
  });

  it("a bulk edit updates the items in place without fetching them all again", async () => {
    const { m, user } = setup();
    await screen.findByRole("checkbox", { name: "Select Third paper" });
    const before = m.calls.filter((c) => c.path.includes("/sources/")).length;
    await user.click(screen.getByRole("checkbox", { name: "Select kinship herat draft" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Set type" }), "report");
    await user.click(screen.getByRole("button", { name: "Apply type to 1 item" }));
    await within(screen.getByRole("region", { name: "Imported record" })).findByText("Report");
    expect(m.calls.filter((c) => c.path.includes("/sources/")).length).toBe(before);
  });

  it("after a decision, focus moves to the next item's heading (R362 d: never to a control that decides)", async () => {
    const { user } = setup();
    await within(await screen.findByRole("region", { name: "Imported record" })).findByText("kinship herat draft");
    screen.getByRole("button", { name: "Accept" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Second paper" })));
  });

  it("shows hints as user text", async () => {
    setup({ ...BASE, review: [item(1, { hints: ["doi:10.1/x"] })] });
    const hint = await screen.findByText("doi:10.1/x");
    expect(hint.getAttribute("dir")).toBe("auto");
  });

  it("offers workspace tags too", async () => {
    setup({ ...BASE, workspaceTags: [{ id: "w1", name: "to-read" }] });
    await screen.findByRole("checkbox", { name: "Select Second paper" });
    expect(await screen.findByRole("option", { name: "to-read" })).toBeTruthy();
  });

  it("merge search shows the latest answer, not a slower earlier one", async () => {
    const { user } = setup({
      ...BASE,
      extra: [
        http.get(`${SERVICE}/projects/:id/sources`, async ({ request }) => {
          const text = new URL(request.url).searchParams.get("text");
          if (text === "slow") {
            await new Promise((r) => setTimeout(r, 200));
            return HttpResponse.json({ total: 1, items: [{ id: "s-slow", title: "Slow answer", type: "book" }] });
          }
          return HttpResponse.json({ total: 1, items: [{ id: "s-fast", title: "Fast answer", type: "book" }] });
        }),
      ],
    });
    await screen.findByRole("region", { name: "Imported record" });
    await user.click(screen.getByRole("button", { name: "Merge" }));
    const box = screen.getByRole("searchbox", { name: "Find the source to merge into" });
    await user.type(box, "slow");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.clear(box);
    await user.type(box, "fast");
    await user.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("button", { name: "Merge into Fast answer" });
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole("button", { name: "Merge into Slow answer" })).toBeNull();
  });

  it("is reachable by keyboard: items are a list of buttons that select the preview", async () => {
    const { user } = setup();
    await screen.findByRole("checkbox", { name: "Select Second paper" });
    screen.getByRole("button", { name: "Show Second paper" }).focus();
    await user.keyboard("{Enter}");
    await within(screen.getByRole("region", { name: "Imported record" })).findByText("Second paper");
  });
});

describe("R362 d (D28): the panel's deciding controls are guarded as the found files' are", () => {
  const ENTRY = {
    moved: "Not taken. Look at the entry, then move the pointer and press again.",
    quiet: "Not taken: the list had just changed. Look at the entry, then press again.",
  };
  beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => void vi.useRealTimers());
  const passGuard = () => vi.setSystemTime(Date.now() + DECIDE_SETTLE_MS + 1);
  const decided = (m: ReturnType<typeof mockService>) => m.calls.filter((c) => /^\/review\/r\d+\/decide$/u.test(c.path)).map((c) => c.path);
  const accept = () => within(screen.getByRole("group", { name: "Decide this item" })).getByRole("button", { name: "Accept" });
  /** The panel beside the list (its line of a press not taken; the polite region says the same words). */
  const panel = () => document.querySelector<HTMLElement>(".ao-review__panel")!;
  const pointer = { x: 1, y: 1 };
  /** The pointer really moves onto the control (from where it was to a new point). */
  const moveOver = (el: Element) => {
    fireEvent.pointerMove(document.body, { pointerType: "mouse", pointerId: 1, clientX: pointer.x, clientY: pointer.y });
    pointer.x += 3;
    pointer.y += 2;
    fireEvent.pointerMove(el, { pointerType: "mouse", pointerId: 1, clientX: pointer.x, clientY: pointer.y });
  };
  /** A mouse press where the pointer rests (no movement before it). */
  const pressBy = (el: Element) => {
    fireEvent.pointerDown(el, { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(el, { pointerType: "mouse", button: 0 });
    fireEvent.click(el);
  };
  const shownTitle = (t: string) => waitFor(() => within(screen.getByRole("region", { name: "Imported record" })).getByText(t));
  const listenSaid = () => {
    const said: string[] = [];
    const region = screen.getAllByRole("status").find((x) => x.classList.contains("ao-visually-hidden"))!;
    const mo = new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) if (n.textContent) said.push(n.textContent);
    });
    mo.observe(region, { childList: true, subtree: true });
    return { said, stop: () => mo.disconnect() };
  };
  const ready = async () => {
    await shownTitle("kinship herat draft");
    await waitFor(() => expect((accept() as HTMLButtonElement).disabled).toBe(false));
    passGuard();
  };

  it("two presses at one spot in one moment decide ONE entry: the second falls on the next entry's Accept, which the pointer never moved over", async () => {
    const { m } = setup();
    await ready();
    const first = accept();
    moveOver(first);
    pressBy(first);
    await shownTitle("Second paper");
    await waitFor(() => expect((accept() as HTMLButtonElement).disabled).toBe(false));
    pressBy(accept());
    await new Promise((r) => setTimeout(r, 50));
    expect(decided(m)).toEqual(["/review/r1/decide"]);
  });

  it("a second press after the next entry slid in is not taken, and says why (on the panel and in the polite region); after a movement over it, it is taken", async () => {
    const { m } = setup();
    await ready();
    moveOver(accept());
    pressBy(accept());
    await shownTitle("Second paper");
    await waitFor(() => expect((accept() as HTMLButtonElement).disabled).toBe(false));
    passGuard();
    const h = listenSaid();
    pressBy(accept());
    await waitFor(() => expect(h.said).toContain(ENTRY.moved));
    const note = within(panel()).getByText(ENTRY.moved);
    expect(accept().getAttribute("aria-describedby")).toBe(note.id);
    expect(decided(m)).toEqual(["/review/r1/decide"]);
    moveOver(accept());
    pressBy(accept());
    await waitFor(() => expect(decided(m)).toEqual(["/review/r1/decide", "/review/r2/decide"]));
    h.stop();
  });

  it("a key press inside the quiet after the list changed is not taken and says so; after the quiet it is taken", async () => {
    const { m } = setup();
    await ready();
    moveOver(accept());
    pressBy(accept());
    await shownTitle("Second paper");
    await waitFor(() => expect((accept() as HTMLButtonElement).disabled).toBe(false));
    const a = accept();
    a.focus();
    fireEvent.keyDown(a, { key: "Enter", code: "Enter" });
    fireEvent.click(a);
    fireEvent.keyUp(a, { key: "Enter", code: "Enter" });
    expect(await within(panel()).findByText(ENTRY.quiet)).toBeTruthy();
    expect(decided(m)).toEqual(["/review/r1/decide"]);
    passGuard();
    fireEvent.keyDown(a, { key: "Enter", code: "Enter" });
    fireEvent.click(a);
    fireEvent.keyUp(a, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(decided(m)).toEqual(["/review/r1/decide", "/review/r2/decide"]));
  });

  it("Enter held down on Accept decides ONE entry (the repeated keydowns and the clicks a browser makes of them)", async () => {
    const { m } = setup();
    await ready();
    const a = accept();
    a.focus();
    fireEvent.keyDown(a, { key: "Enter", code: "Enter" });
    fireEvent.click(a);
    await shownTitle("Second paper");
    await waitFor(() => expect((accept() as HTMLButtonElement).disabled).toBe(false));
    passGuard();
    // The key is still down: its repeats reach whatever holds focus, here the next entry's Accept at the same place.
    const b = accept();
    for (let i = 0; i < 5; i++) {
      fireEvent.keyDown(b, { key: "Enter", code: "Enter", repeat: true });
      fireEvent.click(b);
    }
    fireEvent.keyUp(b, { key: "Enter", code: "Enter" });
    await new Promise((r) => setTimeout(r, 50));
    expect(decided(m)).toEqual(["/review/r1/decide"]);
  });

  // ---- R371 d (M1): guards no test held before, each shown by taking it out (see the report) ----
  const enterOn = (el: HTMLElement) => {
    el.focus();
    fireEvent.keyDown(el, { key: "Enter", code: "Enter" });
    fireEvent.click(el);
    fireEvent.keyUp(el, { key: "Enter", code: "Enter" });
  };

  it("R371 d, R318 b: a press swallowed by the panel's quiet starts it again — a key press at 500 ms, then one at 700 ms is still not taken; 600 ms after it, one is", async () => {
    const { m } = setup();
    await ready();
    moveOver(accept());
    pressBy(accept());
    await shownTitle("Second paper");
    await waitFor(() => expect((accept() as HTMLButtonElement).disabled).toBe(false));
    // The quiet started when the first entry left (the clock stands still until moved).
    const t0 = Date.now();
    const a = accept();
    vi.setSystemTime(t0 + 500);
    enterOn(a);
    expect(await within(panel()).findByText(ENTRY.quiet)).toBeTruthy();
    vi.setSystemTime(t0 + 700);
    enterOn(a);
    await new Promise((r) => setTimeout(r, 50));
    expect(decided(m)).toEqual(["/review/r1/decide"]);
    vi.setSystemTime(t0 + 700 + DECIDE_SETTLE_MS + 1);
    enterOn(a);
    await waitFor(() => expect(decided(m)).toEqual(["/review/r1/decide", "/review/r2/decide"]));
  });

  it("R371 d, R323 a: a scroll forgets the panel's places seen — a real move, a scroll, more than 250 ms, a press without a new move: not taken; after a move it is", async () => {
    const { m } = setup();
    await ready();
    moveOver(accept());
    fireEvent.scroll(window);
    vi.setSystemTime(Date.now() + SCROLL_SETTLE_MS + 1);
    pressBy(accept());
    expect(await within(panel()).findByText(ENTRY.moved)).toBeTruthy();
    expect(decided(m)).toEqual([]);
    moveOver(accept());
    pressBy(accept());
    await waitFor(() => expect(decided(m)).toEqual(["/review/r1/decide"]));
  });

  it("R371 d: a click on a panel control that says it came from a mouse, with no pointer-down before it, is not taken (\"moved\")", async () => {
    const { m } = setup();
    await ready();
    moveOver(accept());
    const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(e, "pointerType", { value: "mouse" });
    fireEvent(accept(), e);
    expect(await within(panel()).findByText(ENTRY.moved)).toBeTruthy();
    expect(decided(m)).toEqual([]);
    moveOver(accept());
    pressBy(accept());
    await waitFor(() => expect(decided(m)).toEqual(["/review/r1/decide"]));
  });

  it("R371 d: a key press on a panel control clears a stale pointer-down (the mouse went down there and was let go elsewhere): Enter is taken", async () => {
    const { m } = setup();
    await ready();
    fireEvent.pointerDown(accept(), { pointerType: "mouse", button: 0 });
    fireEvent.pointerUp(document.body, { pointerType: "mouse", button: 0 });
    enterOn(accept());
    await waitFor(() => expect(decided(m)).toEqual(["/review/r1/decide"]));
  });

  it("after a decision focus goes to the next entry's heading, never to a deciding control; after the last, to the message that nothing waits", async () => {
    const { m } = setup();
    await ready();
    const a = accept();
    a.focus();
    fireEvent.keyDown(a, { key: "Enter", code: "Enter" });
    fireEvent.click(a);
    fireEvent.keyUp(a, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Second paper" })));
    // One Tab at a time leads on to the controls; the heading itself decides nothing.
    fireEvent.keyDown(document.activeElement!, { key: "Enter", code: "Enter" });
    fireEvent.click(document.activeElement!);
    expect(decided(m)).toEqual(["/review/r1/decide"]);
    for (const [title, id] of [["Third paper", "r2"]] as const) {
      passGuard();
      const b = accept();
      b.focus();
      fireEvent.keyDown(b, { key: "Enter", code: "Enter" });
      fireEvent.click(b);
      fireEvent.keyUp(b, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(decided(m)).toContain(`/review/${id}/decide`));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: title })));
    }
    passGuard();
    const c = accept();
    c.focus();
    fireEvent.keyDown(c, { key: "Enter", code: "Enter" });
    fireEvent.click(c);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText(/Nothing is waiting for review/)));
  });
});

describe("Review queue: the file under review (Task 57, R135)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pictureSource = (n: number, title: string, assets: unknown[]) => ({ ...source(n, title), assets });
  let made: string[];
  let revoked: string[];
  beforeEach(() => {
    made = [];
    revoked = [];
    let k = 0;
    URL.createObjectURL = vi.fn((b: Blob) => {
      expect(b.type).toBe("image/png");
      const u = `blob:http://localhost/p${++k}`;
      made.push(u);
      return u;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u)) as typeof URL.revokeObjectURL;
  });
  afterEach(() => vi.restoreAllMocks());

  const withPictures = (o: Partial<ServiceSetup> = {}): ServiceSetup => ({
    ...BASE,
    sources: {
      s1: pictureSource(1, "Market photo", [{ id: "a1", role: "original", kind: "image", mime: "image/png", path: "Sources/s1/photo-1.png", bytes: 8 }]),
      s2: pictureSource(2, "Second paper", [{ id: "a2", role: "original", kind: "pdf", mime: "application/pdf", path: "Sources/s2/paper-2.pdf", bytes: 900 }]),
      s3: pictureSource(3, "Third photo", [
        { id: "a3", role: "original", kind: "image", mime: "image/heic", path: "Sources/s3/IMG_3.heic", bytes: 900 },
        { id: "a3p", role: "derived", kind: "proxy", mime: "image/png", path: "Sources/s3/IMG_3.proxy.png", bytes: 8 },
      ]),
    },
    pictures: { a1: { type: "image/png", bytes: PNG }, a3p: { type: "image/png", bytes: PNG } },
    ...o,
  });

  it("shows a picture through a blob: address, fetched with the token in the header", async () => {
    const { m } = setup(withPictures());
    const preview = await screen.findByRole("region", { name: "File preview" });
    const img = (await within(preview).findByRole("img", { name: "Preview of photo-1.png" })) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe(made[0]);
    expect(img.getAttribute("src")!.startsWith("blob:")).toBe(true);
    expect(m.calls.filter((c) => c.path.endsWith("/content")).map((c) => c.path)).toEqual([`/projects/${P1}/sources/s1/assets/a1/content`]);
  });

  it("a picture that cannot be shown as it is uses its viewing copy; a PDF says plainly there is no preview", async () => {
    const { m, user } = setup(withPictures());
    await within(await screen.findByRole("region", { name: "File preview" })).findByRole("img");
    await user.click(screen.getByRole("button", { name: "Show Second paper" }));
    const preview = await screen.findByRole("region", { name: "File preview" });
    expect(await within(preview).findByText(/No preview of this file can be shown here/)).toBeTruthy();
    expect(within(preview).queryByRole("img")).toBeNull();
    expect(revoked).toEqual([made[0]]); // the earlier picture's address is released
    await user.click(screen.getByRole("button", { name: "Show Third photo" }));
    expect(await within(screen.getByRole("region", { name: "File preview" })).findByRole("img", { name: "Preview of IMG_3.proxy.png" })).toBeTruthy();
    expect(m.calls.filter((c) => c.path.endsWith("/content")).map((c) => c.path.split("/")[6])).toEqual(["a1", "a3p"]);
  });

  it("an answer that arrives after another item was chosen is dropped, and nothing outlives the screen", async () => {
    // The first picture answers only once the test lets it, after another item was chosen.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const { user } = setup(
      withPictures({
        extra: [
          http.get(`${SERVICE}/projects/:id/sources/:sid/assets/:aid/content`, async () => {
            if (first) {
              first = false;
              await gate;
            }
            return new HttpResponse(PNG, { headers: { "Content-Type": "image/png" } });
          }),
        ],
      }),
    );
    await screen.findByRole("region", { name: "File preview" });
    await waitFor(() => expect(first).toBe(false));
    await user.click(screen.getByRole("button", { name: "Show Second paper" }));
    await within(screen.getByRole("region", { name: "File preview" })).findByText(/No preview of this file can be shown here/);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("img", { name: /Preview of/ })).toBeNull();
    expect(made).toEqual([]); // the late answer never became an address
    await user.click(screen.getByRole("button", { name: "Show Market photo" }));
    await screen.findByRole("img", { name: "Preview of photo-1.png" });
    cleanup();
    expect(revoked).toEqual(made);
  });

  it("the first render of an item with a picture says it is loading, never \"No preview\" (M9)", () => {
    // Rendered once, with no effect run: what the browser paints first.
    const api = { picture: () => new Promise<Blob>(() => {}) } as unknown as ImportApi;
    const photo = pictureSource(1, "Market photo", [{ id: "a1", role: "original", kind: "image", mime: "image/png", path: "Sources/s1/photo-1.png", bytes: 8 }]) as unknown as SourceFile;
    const first = renderToStaticMarkup(<FilePreview api={api} projectId={P1} source={photo} />);
    expect(first).toContain("Loading the picture");
    expect(first).not.toContain("No preview");
    const paper = pictureSource(2, "Second paper", [{ id: "a2", role: "original", kind: "pdf", mime: "application/pdf", path: "Sources/s2/paper-2.pdf", bytes: 900 }]) as unknown as SourceFile;
    expect(renderToStaticMarkup(<FilePreview api={api} projectId={P1} source={paper} />)).toContain("No preview of this file can be shown here");
  });

  it("a picture that cannot be read says so in plain words", async () => {
    setup(withPictures({ pictures: {} }));
    const preview = await screen.findByRole("region", { name: "File preview" });
    expect(await within(preview).findByText(/The picture could not be shown/)).toBeTruthy();
  });
});

describe("files found for records (F11; R277 d, R296 b, R303)", () => {
  const RECORD = "Rivers and Memory in Upland Villages";
  const DOUBTED = "A file was found for this record, but it did not clearly match.";
  /** Words that doubt a file, and words that approve of one: neither may be said of the other kind. */
  const DOUBT = /did not clearly match|not match|mismatch|doubt|another DOI|does not show|accepted it after/iu;
  const APPROVAL = /looks? (like )?(the )?right|right file|matches its record/iu;
  const heldItem = (n: number, extra: Partial<ReviewItem> = {}): ReviewItem =>
    ({
      ...item(n, { kind: "verification", batchId: undefined, method: undefined, confidence: undefined, group: "found-file", cause: { kind: "acquired-file-mismatch", findEntryId: `e${n}` }, reasons: [DOUBTED], title: RECORD }),
      heldFile: { why: "other-doi", kind: "pdf", bytes: 2_400_000, fileDoi: "10.5555/ao.f11.other", embeddedTitle: "<b>A Different Paper</b> ‮Entirely", textStart: "A Different Paper Entirely. Abstract. <img src=x onerror=alert(1)>" },
      ...extra,
    }) as ReviewItem;
  /** A file the check matched (R296 b): the service's own sentence and advice. */
  const rightItem = (n: number, title: string): ReviewItem =>
    heldItem(n, { sourceId: `s${n}`, title, reasons: [HELD_FILE_LOOKS_RIGHT_TEXT], heldFile: { why: "looks-right", kind: "pdf", bytes: 900_000, embeddedTitle: title, textStart: `${title}. Ann Smith.` } } as Partial<ReviewItem>);
  const project = (handlers: ServiceSetup["extra"] = []): ServiceSetup => ({
    projectReview: { [P1]: [heldItem(7), heldItem(8, { sourceId: "s8", title: "A Second Record" })] },
    sources: { s7: source(7, RECORD), s8: source(8, "A Second Record") },
    extra: [
      http.post(`${SERVICE}/review/:itemId/held-file`, async ({ request, params }) => {
        (heldCalls as Array<{ id: string; body: unknown }>).push({ id: params.itemId as string, body: await request.json() });
        return HttpResponse.json({ decided: true });
      }),
      ...handlers,
    ],
  });
  /** Two files that look right and two that the check doubts, listed by the service in this order: 7 (doubted), 8 (right), 9 (doubted), 10 (right). */
  const mixed = (handlers: ServiceSetup["extra"] = []): ServiceSetup => ({
    ...project(handlers),
    projectReview: { [P1]: [heldItem(7), rightItem(8, "Right One"), heldItem(9, { sourceId: "s9", title: "Doubted Two" }), rightItem(10, "Right Two")] },
    sources: { s7: source(7, RECORD), s8: source(8, "Right One"), s9: source(9, "Doubted Two"), s10: source(10, "Right Two") },
  });
  let heldCalls: Array<{ id: string; body: unknown }> = [];
  // The clock stands still (R313 c's guard is timed by it): a test moves it past the guard with `passGuard`.
  beforeEach(() => {
    heldCalls = [];
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  /** R313 c: the time after a file leaves in which no deciding control acts, passed. */
  const passGuard = () => vi.setSystemTime(Date.now() + DECIDE_SETTLE_MS + 1);
  const open = (o: ServiceSetup) => {
    const m = mockService(o);
    const user = userEvent.setup();
    render(<ReviewQueue client={m.client} projectId={P1} />);
    return { m, user };
  };
  const group = (name: RegExp) => screen.getByRole("list", { name });
  const card = (title: string) => {
    const li = screen.getAllByRole("listitem").find((x) => x.querySelector("h4")?.textContent === title);
    if (!li) throw new Error(`no card for ${title}`);
    return li;
  };
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  /** A control's name: "<act> for <title>", then the record's first family name and year once its record is read (R313 g). */
  const named = (act: string, title: string) => new RegExp(`^${esc(act)} for ${esc(title)}( \\(.*\\))?$`, "u");
  const use = (title: string) => screen.getByRole("button", { name: named("Use this file", title) });
  const not = (title: string) => screen.getByRole("button", { name: named("Not this file", title) });
  const noUse = (title: string) => screen.queryByRole("button", { name: named("Use this file", title) });
  /** The card's heading (the record's title), where focus goes after a decision (R313 a). */
  const head = (title: string) => card(title).querySelector("h4")!;
  /**
   * R323 a: a press by mouse is taken only after the pointer really moved over the control (its client coordinates
   * changed). user-event's own click moves to the element without new coordinates, so a press here travels: from a point
   * on the page to a new point on the control, then the button goes down and up there.
   */
  let travel = 0;
  const point = async (user: ReturnType<typeof userEvent.setup>, el: Element) => {
    travel += 10;
    await user.pointer([
      { target: document.body, coords: { clientX: travel, clientY: travel } },
      { target: el, coords: { clientX: travel + 3, clientY: travel + 2 } },
      { keys: "[MouseLeft]", target: el },
    ]);
  };
  /** R319 d: the quiet holds at the screen's opening; a test that presses waits for the card, then lets the quiet pass. */
  const ready = async (title: string) => {
    const c = await waitFor(() => card(title));
    passGuard();
    return c;
  };
  /** The clock is faked afresh (these timers and Date) without going back in time: a quiet that has passed stays passed. */
  const refake = (toFake: NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"]) => {
    const t = Date.now();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake });
    vi.setSystemTime(t);
  };

  it("has its own group, and shows the record (title, creators, year), the entry's sentence and what the check found, as text only", async () => {
    open(project());
    expect(await screen.findByRole("heading", { name: "Files found for records" })).toBeTruthy();
    const c = await ready(RECORD);
    expect(within(c).getByText(DOUBTED)).toBeTruthy();
    expect(within(c).getByText(HELD_FILE_WHY_TEXT["other-doi"])).toBeTruthy();
    expect(within(c).getByText("10.5555/ao.f11.other")).toBeTruthy();
    // The record it was found for, from its source (labelled in words).
    await waitFor(() => expect(within(c).getByText("Ann Smith")).toBeTruthy());
    expect(within(c).getByText("2020")).toBeTruthy();
    for (const label of ["Creators", "Year", "What the app's check says", "DOI the file names", "Title in the file", "Start of the file's text", "File"]) expect(within(c).getByText(label)).toBeTruthy();
    // Outside text, never markup: shown as typed, with bidi isolation (UserText).
    expect(within(c).getByText(/<b>A Different Paper<\/b>/u)).toBeTruthy();
    expect(within(c).getByText(/<img src=x onerror=alert\(1\)>/u)).toBeTruthy();
    expect(within(c).getByText(/<b>A Different Paper<\/b>/u).closest("[dir=auto]")).toBeTruthy();
    expect(c.querySelector("b, img")).toBeNull();
    expect(within(c).getByText(/PDF, 2\.3 MB/u)).toBeTruthy();
    // R313 g: named with the record's title, its first creator's family name and its year.
    expect(within(c).getByRole("button", { name: `Use this file for ${RECORD} (Smith, 2020)` })).toBeTruthy();
    expect(within(c).getByRole("button", { name: `Not this file for ${RECORD} (Smith, 2020)` })).toBeTruthy();
  });

  it("a file that looks right is shown with the service's sentence and advice, never with words of doubt", async () => {
    const o = project();
    o.projectReview = { [P1]: [rightItem(8, "Right One")] };
    o.sources = { s8: source(8, "Right One") };
    open(o);
    const c = await ready("Right One");
    expect(within(c).getByText(HELD_FILE_LOOKS_RIGHT_TEXT)).toBeTruthy();
    expect(within(c).getByText(HELD_FILE_WHY_TEXT["looks-right"])).toBeTruthy();
    await waitFor(() => expect(within(c).getByText("Ann Smith")).toBeTruthy());
    expect(c.textContent).not.toMatch(DOUBT);
    // Nor anywhere else in the section.
    expect(screen.getByRole("region", { name: "Files found for records" }).textContent).not.toMatch(DOUBT);
  });

  it("a doubted file is shown with its reason, never with words of approval", async () => {
    const o = project();
    o.projectReview = { [P1]: [heldItem(7), heldItem(9, { sourceId: "s9", title: "Doubted Two", heldFile: { why: "no-text", kind: "epub", bytes: 4096 } } as Partial<ReviewItem>)] };
    o.sources = { s7: source(7, RECORD), s9: source(9, "Doubted Two") };
    open(o);
    const c = await ready("Doubted Two");
    expect(within(c).getByText(DOUBTED)).toBeTruthy();
    expect(within(c).getByText(HELD_FILE_WHY_TEXT["no-text"])).toBeTruthy();
    expect(within(c).getByText(/EPUB, 4 KB/u)).toBeTruthy();
    for (const t of [RECORD, "Doubted Two"]) expect(card(t).textContent).not.toMatch(APPROVAL);
    expect(screen.getByRole("region", { name: "Files found for records" }).textContent).not.toMatch(APPROVAL);
  });

  it("the files that look right are gathered first, each group with its number, an empty group not shown", async () => {
    open(mixed());
    const right = await waitFor(() => group(/^Files that look right/u));
    const other = group(/^Other files found/u);
    expect(screen.getByRole("heading", { name: "Files that look right (2)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Other files found (2)" })).toBeTruthy();
    expect(within(right).getAllByRole("listitem").map((li) => li.querySelector("h4")?.textContent)).toEqual(["Right One", "Right Two"]);
    expect(within(other).getAllByRole("listitem").map((li) => li.querySelector("h4")?.textContent)).toEqual([RECORD, "Doubted Two"]);
    // First: the group of files that look right comes before the other.
    expect(right.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
    // Only doubted files: no heading for files that look right.
    open(project());
    await ready(RECORD);
    expect(screen.queryByRole("heading", { name: /^Files that look right/u })).toBeNull();
    expect(screen.getByRole("heading", { name: "Other files found (2)" })).toBeTruthy();
  });

  it("every file has its own two controls, named with its record; nothing decides several at once", async () => {
    const { user } = open(mixed());
    await ready("Right Two");
    const section = screen.getByRole("region", { name: "Files found for records" });
    for (const t of ["Right One", "Right Two", RECORD, "Doubted Two"]) {
      await waitFor(() => expect(within(card(t)).getByRole("button", { name: `Use this file for ${t} (Smith, 2020)` })).toBeTruthy());
      const buttons = within(card(t)).getAllByRole("button");
      expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([`Use this file for ${t} (Smith, 2020)`, `Not this file for ${t} (Smith, 2020)`]);
    }
    // No control in the section is about more than one file.
    for (const el of within(section).queryAllByRole("button")) expect(el.getAttribute("aria-label") ?? el.textContent).not.toMatch(/\ball\b|every|selected/iu);
    expect(within(section).queryAllByRole("checkbox")).toHaveLength(0);
    // One file per request: two files decided one after the other make two requests, each for its own file.
    await point(user, use("Right One"));
    await waitFor(() => expect(noUse("Right One")).toBeNull());
    passGuard();
    await point(user, not("Doubted Two"));
    await waitFor(() => expect(screen.queryByRole("button", { name: named("Not this file", "Doubted Two") })).toBeNull());
    expect(heldCalls).toEqual([
      { id: "r8", body: { projectId: P1, decision: "attach" } },
      { id: "r9", body: { projectId: P1, decision: "discard" } },
    ]);
    expect(use("Right Two")).toBeTruthy();
    expect(use(RECORD)).toBeTruthy();
  });

  it("a double press on one file while its decision is out sends one request (R313 i: the press guard)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const o = mixed([]);
    o.extra = [
      http.post(`${SERVICE}/review/:itemId/held-file`, async ({ request, params }) => {
        heldCalls.push({ id: params.itemId as string, body: await request.json() });
        await gate;
        return HttpResponse.json({ decided: true });
      }),
    ];
    const { user } = open(o);
    await ready("Right Two");
    // The answer is held back, so both presses fall on the same file while its decision is out.
    // R323 a: a double press after a real movement onto the control (user-event's dblClick does not move the pointer).
    const first = use("Right One");
    await point(user, first);
    await user.pointer({ keys: "[MouseLeft]", target: first });
    await point(user, not("Right One"));
    await waitFor(() => expect(heldCalls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    release();
    await waitFor(() => expect(noUse("Right One")).toBeNull());
    expect(heldCalls).toEqual([{ id: "r8", body: { projectId: P1, decision: "attach" } }]);
  });

  // R313 a (it corrects R303 b): after a decision focus goes to the next file's CARD — its heading, the record's title —
  // never to a control that decides; one Tab from there reaches that file's "Use this file".
  it("after Use this file focus goes to the next waiting file's heading (R313 a); after the last, to the heading or the empty message", async () => {
    const { user } = open(mixed());
    await ready("Right Two");
    // The next in the same group: its heading, focusable, never its "Use this file".
    await point(user, use("Right One"));
    await waitFor(() => expect(document.activeElement).toBe(head("Right Two")));
    expect(head("Right Two").getAttribute("tabindex")).toBe("-1");
    expect(screen.getByRole("status").textContent).toBe("File added to its record: Right One");
    // One Tab reaches that file's "Use this file".
    await user.tab();
    expect(document.activeElement).toBe(use("Right Two"));
    // The last of its group: the first file of the other group.
    passGuard();
    await point(user, use("Right Two"));
    await waitFor(() => expect(document.activeElement).toBe(head(RECORD)));
    // R319 a: the group whose files are all decided stays in its place, counting none.
    expect(screen.getByRole("heading", { name: "Files that look right (0)" })).toBeTruthy();
    // Not this file moves on the same way.
    passGuard();
    await point(user, not(RECORD));
    await waitFor(() => expect(document.activeElement).toBe(head("Doubted Two")));
    expect(screen.getByRole("status").textContent).toBe(`File removed; the record keeps no file: ${RECORD}`);
    // The last file of all: the message that says nothing is waiting.
    passGuard();
    await point(user, use("Doubted Two"));
    const empty = await screen.findByText("Nothing is waiting for review in this project.");
    await waitFor(() => expect(document.activeElement).toBe(empty));
    expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10", "r7", "r9"]);
  });

  // R319 a, R319 d: the decided card stays (the section does not go), and focus goes to the section's heading (it was the
  // queue's heading, with the section gone).
  it("after the last found file, with other entries still waiting, focus goes to the section's heading; the card stays, decided", async () => {
    const o = project();
    o.projectReview = { [P1]: [item(1, { batchId: undefined, title: "Dropped file" }), rightItem(8, "Right One")] };
    o.sources = { s1: source(1, "Dropped file"), s8: source(8, "Right One") };
    const { user } = open(o);
    await ready("Right One");
    await point(user, use("Right One"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Files found for records" })));
    expect(within(card("Right One")).getByText("Decided")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Files that look right (0)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show Dropped file/u })).toBeTruthy();
  });

  it("R313 d: Enter on Use this file, then Enter again at once, decides exactly one file", async () => {
    const { user } = open(mixed());
    await ready("Right Two");
    use("Right One").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(noUse("Right One")).toBeNull());
    await user.keyboard("{Enter}");
    await new Promise((r) => setTimeout(r, 50));
    expect(heldCalls).toEqual([{ id: "r8", body: { projectId: P1, decision: "attach" } }]);
  });

  it("R313 d: Not this file, then Enter, decides exactly one file", async () => {
    const { user } = open(mixed());
    await ready("Right Two");
    not("Right One").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(noUse("Right One")).toBeNull());
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    await new Promise((r) => setTimeout(r, 50));
    expect(heldCalls).toEqual([{ id: "r8", body: { projectId: P1, decision: "discard" } }]);
  });

  it("R313 d: Enter held down over five files decides exactly one (repeated keydowns and the clicks a browser makes of them)", async () => {
    const o = project();
    o.projectReview = { [P1]: [1, 2, 3, 4, 5].map((k) => rightItem(k + 10, `Right ${k}`)) };
    o.sources = Object.fromEntries([1, 2, 3, 4, 5].map((k) => [`s${k + 10}`, source(k + 10, `Right ${k}`)]));
    open(o);
    await ready("Right 5");
    use("Right 1").focus();
    // The first keydown, and the click it makes.
    fireEvent.keyDown(document.activeElement!, { key: "Enter", code: "Enter" });
    fireEvent.click(document.activeElement!);
    // Held: the repeats fall on whatever has focus, each with its click, while the answers come in between.
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 15));
      const el = document.activeElement!;
      fireEvent.keyDown(el, { key: "Enter", code: "Enter", repeat: true });
      fireEvent.click(el);
    }
    fireEvent.keyUp(document.activeElement!, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(noUse("Right 1")).toBeNull());
    expect(heldCalls.map((c) => c.id)).toEqual(["r11"]);
    for (const k of [2, 3, 4, 5]) expect(use(`Right ${k}`)).toBeTruthy();
  });

  it("R313 b: a repeated keydown on a deciding control does nothing, for Enter and for Space, even with focus kept there", async () => {
    const GONE = "The record this file was found for is no longer in the library. Nothing was changed.";
    const o = project();
    o.extra = [
      http.post(`${SERVICE}/review/:itemId/held-file`, async ({ request, params }) => {
        heldCalls.push({ id: params.itemId as string, body: await request.json() });
        return HttpResponse.json({ error: { code: "CONFLICT", message: GONE, reason: "source-gone" } }, { status: 409 });
      }),
    ];
    open(o);
    await ready(RECORD);
    // A refusal keeps the file and focus on the control pressed: the held key's repeats fall on it.
    const u = use(RECORD);
    u.focus();
    fireEvent.keyDown(u, { key: "Enter", code: "Enter" });
    fireEvent.click(u);
    await within(card(RECORD)).findByRole("alert");
    expect(heldCalls).toHaveLength(1);
    for (const key of ["Enter", " "]) {
      for (let i = 0; i < 3; i++) {
        fireEvent.keyDown(u, { key, code: key === " " ? "Space" : "Enter", repeat: true });
        fireEvent.click(u);
      }
      fireEvent.keyUp(u, { key, code: key === " " ? "Space" : "Enter" });
    }
    const n = not(RECORD);
    fireEvent.keyDown(n, { key: "Enter", code: "Enter", repeat: true });
    fireEvent.click(n);
    await new Promise((r) => setTimeout(r, 50));
    expect(heldCalls).toHaveLength(1);
    // A deliberate press after the key was let go acts.
    fireEvent.keyDown(u, { key: "Enter", code: "Enter" });
    fireEvent.click(u);
    await waitFor(() => expect(heldCalls).toHaveLength(2));
  });

  // R319 changes what this asserts: no control takes the decided file's place any more (its card stays there, without
  // controls), so the second press at that place meets none; the next file is reached by a movement — here Tab and
  // Enter from its card's heading — and needs no wait.
  it("R313 c, d; R319 a: a second pointer press at once at the first's place meets no control; a deliberate Tab and Enter from the next card's heading decides the next file", async () => {
    const { user } = open(mixed());
    await ready("Right Two");
    const first = card("Right One");
    await point(user, use("Right One"));
    await waitFor(() => expect(noUse("Right One")).toBeNull());
    // At the first one's place: the same card, with no control a person can reach; a press on what is there does nothing.
    expect(document.querySelector(".ao-review__found .ao-review__file")).toBe(first);
    expect(within(first).queryAllByRole("button")).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(head("Right Two")));
    const there = first.querySelector("button");
    if (there) fireEvent.click(there);
    await new Promise((r) => setTimeout(r, 50));
    expect(heldCalls.map((c) => c.id)).toEqual(["r8"]);
    expect(use("Right Two").getAttribute("aria-busy")).toBeNull();
    // From the next card's heading (where focus went), Tab and Enter decide that file.
    expect(document.activeElement).toBe(head("Right Two"));
    await user.tab();
    expect(document.activeElement).toBe(use("Right Two"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10"]));
    await waitFor(() => expect(document.activeElement).toBe(head(RECORD)));
  });

  it("R313 c: after the list is read again, no deciding control acts for the guard's time", async () => {
    const o = project();
    o.extra = [http.post(`${SERVICE}/review/:itemId/held-file`, () => new Promise<Response>(() => {}))];
    const { m } = open(o);
    await ready("A Second Record");
    const reads = () => m.calls.filter((c) => c.method === "GET" && c.path.startsWith(`/projects/${P1}/review`)).length;
    const readsBefore = reads();
    // From the time the clock shows (the opening's quiet passed, R319 d).
    refake(["setTimeout", "clearTimeout", "Date"]);
    try {
      // A decision with no answer is given up, and the queue read again (R313 e).
      fireEvent.click(use(RECORD));
      await vi.advanceTimersByTimeAsync(HELD_DECISION_TIMEOUT_MS + 100);
    } finally {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date"] });
    }
    await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(within(card(RECORD)).getByText("The service did not answer. Look at the queue again before deciding.")).toBeTruthy());
    await waitFor(() => expect(within(card("A Second Record")).getByRole("button", { name: named("Use this file", "A Second Record") })).toBeTruthy());
    const before = heldCalls.length;
    fireEvent.click(use("A Second Record"));
    await new Promise((r) => setTimeout(r, 50));
    expect(use("A Second Record").getAttribute("aria-busy")).toBeNull();
    expect(heldCalls.length).toBe(before);
  });

  it("R313 e: a decision with no answer in 60 seconds is given up: the card is usable again and says so, the queue is read again, and the late answer changes nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const o = project();
    o.extra = [
      http.post(`${SERVICE}/review/:itemId/held-file`, async ({ request, params }) => {
        heldCalls.push({ id: params.itemId as string, body: await request.json() });
        await gate;
        return HttpResponse.json({ decided: true });
      }),
    ];
    const { m } = open(o);
    await ready(RECORD);
    const reads = () => m.calls.filter((c) => c.method === "GET" && c.path.startsWith(`/projects/${P1}/review`)).length;
    const readsBefore = reads();
    // From the time the clock shows (the opening's quiet passed, R319 d).
    refake(["setTimeout", "clearTimeout", "Date"]);
    try {
      // While it is out the button says "Using this file…" (R318 a): held by its element.
      const u = use(RECORD);
      fireEvent.click(u);
      await vi.advanceTimersByTimeAsync(10);
      expect(u.getAttribute("aria-busy")).toBe("true");
      await vi.advanceTimersByTimeAsync(HELD_DECISION_TIMEOUT_MS - 1_000);
      expect(u.getAttribute("aria-busy")).toBe("true");
      await vi.advanceTimersByTimeAsync(1_500);
    } finally {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date"] });
    }
    await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(within(card(RECORD)).getByText("The service did not answer. Look at the queue again before deciding.")).toBeTruthy());
    expect(use(RECORD).getAttribute("aria-busy")).toBeNull();
    expect(use(RECORD).getAttribute("aria-disabled")).toBeNull();
    // The late answer: nothing changes.
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(use(RECORD)).toBeTruthy();
    expect(within(card(RECORD)).getByText("The service did not answer. Look at the queue again before deciding.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).not.toMatch(/File added/u);
    // Usable again: after the guard a press decides it.
    passGuard();
    fireEvent.click(use(RECORD));
    await waitFor(() => expect(heldCalls).toHaveLength(2));
  });

  it("FR-529: a decision given up at 60 seconds that the service records later shows as soon as the service answers, without waiting for the next read", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const o = project();
    let list = o.projectReview![P1]!;
    let listReads = 0;
    o.extra = [
      http.get(`${SERVICE}/projects/:id/review`, () => {
        listReads++;
        return HttpResponse.json({ items: list, total: list.length, offset: 0, limit: 500 });
      }),
      http.post(`${SERVICE}/review/:itemId/held-file`, async ({ request, params }) => {
        heldCalls.push({ id: params.itemId as string, body: await request.json() });
        await gate;
        // The service records the decision late: the file no longer waits.
        list = list.filter((x) => x.id !== params.itemId);
        return HttpResponse.json({ decided: true });
      }),
    ];
    open(o);
    await ready(RECORD);
    const reads = () => listReads;
    refake(["setTimeout", "clearTimeout", "Date"]);
    try {
      fireEvent.click(use(RECORD));
      await vi.advanceTimersByTimeAsync(HELD_DECISION_TIMEOUT_MS + 100);
    } finally {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date"] });
    }
    await waitFor(() => expect(within(card(RECORD)).getByText("The service did not answer. Look at the queue again before deciding.")).toBeTruthy());
    const readsAfterGiveUp = reads();
    expect(use(RECORD)).toBeTruthy();
    // The late answer: the queue is read again by itself, and the card says what the service now holds.
    release();
    await waitFor(() => expect(within(card(RECORD)).getByText("No longer waiting.")).toBeTruthy());
    expect(reads()).toBe(readsAfterGiveUp + 1);
    expect(noUse(RECORD)).toBeNull();
    expect(heldCalls).toHaveLength(1);
  });

  /** R478: the held-file decisions' requests, each open until it answers or its signal aborts. */
  const openDecisions = () => {
    const st = { open: 0, most: 0, aborted: 0, gates: [] as Array<() => void> };
    const handler = http.post(`${SERVICE}/review/:itemId/held-file`, async ({ request, params }) => {
      heldCalls.push({ id: params.itemId as string, body: await request.json() });
      st.open++;
      st.most = Math.max(st.most, st.open);
      request.signal.addEventListener(
        "abort",
        () => {
          st.open--;
          st.aborted++;
        },
        { once: true },
      );
      await new Promise<void>((r) => st.gates.push(r));
      return HttpResponse.json({ decided: true });
    });
    return { st, handler };
  };
  const giveUp = async (title: string) => {
    refake(["setTimeout", "clearTimeout", "Date"]);
    try {
      fireEvent.click(use(title));
      await vi.advanceTimersByTimeAsync(HELD_DECISION_TIMEOUT_MS + 100);
    } finally {
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date"] });
    }
    await waitFor(() => expect(within(card(title)).getByText(HELD_NO_ANSWER_TEXT)).toBeTruthy());
  };

  it("R478: a card holds at most one given-up decision: a new press on it cancels the earlier request first, whose late answer then changes nothing", async () => {
    const o = project();
    let listReads = 0;
    const list = o.projectReview![P1]!;
    const { st, handler } = openDecisions();
    o.extra = [
      http.get(`${SERVICE}/projects/:id/review`, () => {
        listReads++;
        return HttpResponse.json({ items: list, total: list.length, offset: 0, limit: 500 });
      }),
      handler,
    ];
    open(o);
    await ready(RECORD);
    await giveUp(RECORD);
    // FR-529: the given-up request stays open.
    expect(st.open).toBe(1);
    await waitFor(() => expect(listReads).toBeGreaterThan(1));
    const readsAfterGiveUp = listReads;
    passGuard();
    fireEvent.click(use(RECORD));
    await waitFor(() => expect(heldCalls).toHaveLength(2));
    // The first request was cancelled before the second was sent: never two open for the card.
    await waitFor(() => expect(st.aborted).toBe(1));
    expect(st.open).toBe(1);
    expect(st.most).toBe(1);
    // The first's late answer (the service lets it go) changes nothing: no read, no alert, the card still waits.
    st.gates[0]!();
    await new Promise((r) => setTimeout(r, 100));
    expect(listReads).toBe(readsAfterGiveUp);
    expect(screen.queryAllByRole("alert")).toEqual([]);
    // The card still waits for its second decision (its control busy).
    expect(card(RECORD).querySelector('button[aria-busy="true"]')).not.toBeNull();
  });

  it("R478: leaving the review queue cancels every given-up decision's request", async () => {
    const o = project();
    const { st, handler } = openDecisions();
    o.extra = [handler];
    const { unmount } = render(<ReviewQueue client={mockService(o).client} projectId={P1} />);
    await ready(RECORD);
    await giveUp(RECORD);
    expect(st.open).toBe(1);
    unmount();
    expect(st.aborted).toBe(1);
    expect(st.open).toBe(0);
  });

  for (const how of ["unmounted", "shown another project"] as const) {
    it(`R486 e: a decision still inside its 60 seconds is cancelled when the review queue is ${how}, and no give-up timer is left`, async () => {
      const P2 = "0190a000-0000-7000-8000-0000000000f2";
      const o = project();
      o.projectReview = { ...o.projectReview, [P2]: [] };
      const { st, handler } = openDecisions();
      o.extra = [handler];
      const client = mockService(o).client;
      const view = render(<ReviewQueue client={client} projectId={P1} />);
      await ready(RECORD);
      const rejected: unknown[] = [];
      const onRejection = (r: unknown) => rejected.push(r);
      process.on("unhandledRejection", onRejection);
      refake(["setTimeout", "clearTimeout", "Date"]);
      try {
        fireEvent.click(use(RECORD));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(st.open).toBe(1);
        if (how === "unmounted") view.unmount();
        else view.rerender(<ReviewQueue client={client} projectId={P2} />);
        await vi.advanceTimersByTimeAsync(0);
        expect(st.aborted).toBe(1);
        expect(st.open).toBe(0);
        // No give-up timer is left: past the 60 seconds nothing more happens.
        if (how === "unmounted") expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(HELD_DECISION_TIMEOUT_MS * 11);
        expect(st.open).toBe(0);
        expect(st.aborted).toBe(1);
        if (how === "unmounted") expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ["Date"] });
      }
      await new Promise((r) => setTimeout(r, 50));
      process.off("unhandledRejection", onRejection);
      expect(rejected).toEqual([]);
      if (how === "shown another project") expect(screen.queryByText(HELD_NO_ANSWER_TEXT)).toBeNull();
    });
  }

  it("R313 f: a why of __proto__, toString or constructor shows no advice and breaks nothing", async () => {
    const o = project();
    o.projectReview = {
      [P1]: ["__proto__", "toString", "constructor"].map((why, k) => heldItem(20 + k, { sourceId: `s${20 + k}`, title: `Odd ${k}`, heldFile: { why, kind: "pdf", bytes: 1024 } } as unknown as Partial<ReviewItem>)),
    };
    o.sources = Object.fromEntries([0, 1, 2].map((k) => [`s${20 + k}`, source(20 + k, `Odd ${k}`)]));
    open(o);
    for (const k of [0, 1, 2]) {
      const c = await ready(`Odd ${k}`);
      expect(within(c).queryByText("What the app's check says")).toBeNull();
      expect(within(c).getByText(DOUBTED)).toBeTruthy();
    }
  });

  it("R313 i: a why this build does not know shows no sentence of the screen's own", async () => {
    const o = project();
    o.projectReview = { [P1]: [heldItem(7, { heldFile: { why: "from-a-later-build", kind: "pdf", bytes: 1024 } } as unknown as Partial<ReviewItem>)] };
    open(o);
    const c = await ready(RECORD);
    expect(within(c).queryByText("What the app's check says")).toBeNull();
    // Only the service's sentence and the file's facts.
    const dds = [...c.querySelectorAll("dd")].map((d) => d.textContent);
    expect(dds).toEqual(expect.arrayContaining(["PDF, 1 KB"]));
    expect(c.textContent).not.toMatch(/did not clearly match its record|later build/u);
  });

  it("R313 g: two records of one title and author get controls with different names; two equal results in a row are both announced", async () => {
    const o = project();
    o.projectReview = { [P1]: [heldItem(31, { sourceId: "s31", title: "Same Title" }), heldItem(32, { sourceId: "s32", title: "Same Title" })] };
    o.sources = { s31: source(31, "Same Title"), s32: source(32, "Same Title") };
    const { user } = open(o);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Use this file for Same Title \(Smith, 2020, file \d of 2\)$/u })).toHaveLength(2));
    passGuard(); // R319 d: the opening's quiet
    const names = screen.getAllByRole("button", { name: /^Use this file for / }).map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["Use this file for Same Title (Smith, 2020, file 1 of 2)", "Use this file for Same Title (Smith, 2020, file 2 of 2)"]);
    // Each result is said, even when its words are the last one's.
    const said: string[] = [];
    const region = screen.getAllByRole("status").find((s) => !s.textContent?.includes("Loading"))!;
    const mo = new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) if (n.textContent) said.push(n.textContent);
    });
    mo.observe(region, { childList: true, subtree: true, characterData: true });
    await point(user, screen.getByRole("button", { name: "Use this file for Same Title (Smith, 2020, file 1 of 2)" }));
    await waitFor(() => expect(said).toHaveLength(1));
    passGuard();
    await point(user, screen.getByRole("button", { name: /^Use this file for Same Title/u }));
    await waitFor(() => expect(said).toEqual(["File added to its record: Same Title", "File added to its record: Same Title"]));
    mo.disconnect();
  });

  it("R313 i: a researcher already at another file keeps their place when a decision ends", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const o = mixed([]);
    o.extra = [
      http.post(`${SERVICE}/review/:itemId/held-file`, async ({ request, params }) => {
        heldCalls.push({ id: params.itemId as string, body: await request.json() });
        await gate;
        return HttpResponse.json({ decided: true });
      }),
    ];
    const { user } = open(o);
    await ready("Right Two");
    await point(user, use("Right One"));
    await waitFor(() => expect(heldCalls).toHaveLength(1));
    // Meanwhile the researcher goes to another file.
    head(RECORD).focus();
    release();
    await waitFor(() => expect(noUse("Right One")).toBeNull());
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(document.activeElement).toBe(head(RECORD));
  });

  it("one file's decision under way leaves the others usable", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const o = mixed([]);
    o.extra = [
      http.post(`${SERVICE}/review/:itemId/held-file`, async ({ request, params }) => {
        heldCalls.push({ id: params.itemId as string, body: await request.json() });
        if (params.itemId === "r8") await gate;
        return HttpResponse.json({ decided: true });
      }),
    ];
    const { user } = open(o);
    await ready("Right Two");
    await point(user, use("Right One"));
    await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
    // Its two buttons are busy and cannot be pressed again; focus stays on the one pressed (its words say it is
    // working, R318 a: held by its element).
    const [u, n] = within(card("Right One")).getAllByRole("button") as [HTMLElement, HTMLElement];
    expect(u.getAttribute("aria-disabled")).toBe("true");
    expect(u.getAttribute("aria-busy")).toBe("true");
    expect(n.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(u);
    await point(user, u);
    await point(user, n);
    // Another file is decided meanwhile — deliberately, after the quiet those two presses started again (R318 b).
    passGuard();
    expect(use("Right Two").getAttribute("aria-disabled")).toBeNull();
    await point(user, use("Right Two"));
    await waitFor(() => expect(noUse("Right Two")).toBeNull());
    expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10"]);
    release();
    await waitFor(() => expect(noUse("Right One")).toBeNull());
    expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10"]);
  });

  it("a refusal keeps the entry, shows the service's sentence and keeps focus on the control", async () => {
    const GONE = "The record this file was found for is no longer in the library, so the file cannot be added to it. Choose “Not this file” to remove it. Nothing was changed.";
    const o = project();
    o.extra = [http.post(`${SERVICE}/review/:itemId/held-file`, () => HttpResponse.json({ error: { code: "CONFLICT", message: GONE, reason: "source-gone" } }, { status: 409 }))];
    const { user } = open(o);
    await ready(RECORD);
    await point(user, use(RECORD));
    const alert = await within(card(RECORD)).findByRole("alert");
    expect(alert.textContent).toContain(GONE);
    expect(use(RECORD)).toBeTruthy();
    expect(use(RECORD).getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(use(RECORD));
    // Only the file decided shows it.
    expect(within(card("A Second Record")).queryByRole("alert")).toBeNull();
  });

  it("R282 d: a 409 because Find and acquire is paused is NOT 'already decided': its sentence is shown and the entry stays", async () => {
    const PAUSED = "Find and acquire is paused for this project. Try again in a moment. Nothing was changed.";
    const o = project();
    o.extra = [http.post(`${SERVICE}/review/:itemId/held-file`, () => HttpResponse.json({ error: { code: "CONFLICT", message: PAUSED, reason: "paused" } }, { status: 409 }))];
    const { user } = open(o);
    await ready(RECORD);
    await point(user, use(RECORD));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(PAUSED);
    expect(use(RECORD)).toBeTruthy();
    expect(screen.queryByText(/had already been decided/u)).toBeNull();
  });

  const NOT_TAKEN = "Not taken: the list had just changed. Look at the file, then press again.";
  /** The service answers each decision after `ms` (a fake timer: it moves with the clock). */
  const slow = (ms: number) => [
    http.post(`${SERVICE}/review/:itemId/held-file`, async ({ request, params }) => {
      heldCalls.push({ id: params.itemId as string, body: await request.json() });
      await new Promise((r) => setTimeout(r, ms));
      return HttpResponse.json({ decided: true });
    }),
  ];
  /** The four files of `mixed`, the service's own handler replaced by a slow one. */
  const mixedSlow = (ms: number) => ({ ...mixed(), extra: slow(ms) });
  const section = () => screen.getByRole("region", { name: "Files found for records" });
  /** The clock moves from here on: timers and Date together (from the time it shows now: R319 d's opening quiet passed stays passed). */
  const moving = () => refake(["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"]);
  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  /** Each text put in the polite region from now on. */
  const listen = () => {
    const said: string[] = [];
    const region = screen.getAllByRole("status").find((s) => !s.textContent?.includes("Loading"))!;
    const mo = new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) if (n.textContent) said.push(n.textContent);
    });
    mo.observe(region, { childList: true, subtree: true, characterData: true });
    return { said, stop: () => mo.disconnect() };
  };

  // R318: on a clock that MOVES. The service answers a decision in one second; the presses come as a pointer at one
  // spot (or a quick keyboard) would make them.
  describe("R318: a press that is not taken renews the quiet (a moving clock)", () => {
    /**
     * The control at one spot of the section: the first card's first (or second) button. Since R319 the first card stays
     * there; once it is decided, what stands at that spot is the hidden stand-in of its control, which does nothing.
     */
    const atSpot = (k: 0 | 1) => section().querySelectorAll<HTMLButtonElement>(".ao-review__file button")[k]!;
    /** A press at that spot (nothing there once the section is empty). */
    const pressAt = (k: 0 | 1) => {
      const b = document.querySelectorAll<HTMLButtonElement>(".ao-review__found .ao-review__file button")[k];
      if (b) fireEvent.click(b);
    };

    it("R318 d: a press at one spot every 250 ms for ten seconds, against an answer that takes a second, decides ONE file; after a pause one deliberate press decides the next", async () => {
      open(mixedSlow(1_000));
      await ready("Right Two");
      await waitFor(() => expect(within(card("Right Two")).getByRole("button", { name: "Use this file for Right Two (Smith, 2020)" })).toBeTruthy());
      moving();
      const h = listen();
      for (let t = 0; t < 10_000; t += 250) {
        pressAt(0);
        await tick(250);
      }
      await tick(1_000);
      expect(heldCalls).toEqual([{ id: "r8", body: { projectId: P1, decision: "attach" } }]);
      // R319 changes what this asserts: the presses while the file is out fall on its working card (not taken, not
      // said), and after the answer they meet no control at that spot (R319 a), so there is no press to refuse or to say.
      expect(h.said.filter((s) => s === NOT_TAKEN)).toHaveLength(0);
      expect(atSpot(0).closest(".ao-review__file")).toBe(card("Right One"));
      h.stop();
      // A pause, then one deliberate press on the next file, at its own place (R319: reaching it takes a movement).
      await tick(DECIDE_SETTLE_MS + 100);
      expect(atSpot(0)).not.toBe(use("Right Two"));
      fireEvent.click(use("Right Two"));
      await tick(1_100);
      expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10"]);
    });

    it("R318 d: the same with Not this file", async () => {
      open(mixedSlow(1_000));
      await ready("Right Two");
      moving();
      for (let t = 0; t < 10_000; t += 250) {
        pressAt(1);
        await tick(250);
      }
      await tick(1_000);
      expect(heldCalls).toEqual([{ id: "r8", body: { projectId: P1, decision: "discard" } }]);
      await tick(DECIDE_SETTLE_MS + 100);
      // R319 changes what this asserts: at that spot is the decided card, without a control; the next file is pressed at its own place.
      fireEvent.click(atSpot(1));
      await tick(1_100);
      expect(heldCalls).toHaveLength(1);
      fireEvent.click(not("Right Two"));
      await tick(1_100);
      expect(heldCalls).toEqual([
        { id: "r8", body: { projectId: P1, decision: "discard" } },
        { id: "r10", body: { projectId: P1, decision: "discard" } },
      ]);
    });

    it("R318 b: one file's wait does not block a deliberate decision on another — B is decided more than 600 ms after A's press, A still out; a press within 600 ms of a press not taken is not", async () => {
      open(mixedSlow(5_000));
      await ready("Right Two");
      moving();
      const a = use("Right One");
      fireEvent.click(a);
      await tick(DECIDE_SETTLE_MS + 100);
      // A is still out; B, pressed deliberately, is decided.
      expect(a.getAttribute("aria-busy")).toBe("true");
      fireEvent.click(use("Right Two"));
      await tick(10);
      expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10"]);
      // A press on A while it is out is not taken, and starts the quiet again from that press: a press on another
      // file within 600 ms of it is not taken either; one after 600 ms without a press is.
      fireEvent.click(a);
      await tick(300);
      fireEvent.click(use(RECORD));
      await tick(10);
      expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10"]);
      await tick(DECIDE_SETTLE_MS + 100);
      fireEvent.click(use(RECORD));
      await tick(10);
      expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10", "r7"]);
    });

    // R319 changes the moment of this quiet: a decision no longer starts one (nothing moves), so the quiet here is the one
    // a press on a working card starts again (R318 b).
    it("R318 c: a quick Tab and Enter inside the quiet is not taken and is said once; the same press again after the quiet is taken", async () => {
      open(mixedSlow(1_000));
      await ready("Right Two");
      moving();
      /** Enter on the focused control: its keydown and the click it makes (user-event's waits hang on a moving fake clock). */
      const enter = () => {
        const el = document.activeElement!;
        fireEvent.keyDown(el, { key: "Enter", code: "Enter" });
        fireEvent.click(el);
        fireEvent.keyUp(el, { key: "Enter", code: "Enter" });
      };
      const a = use("Right One");
      fireEvent.click(a);
      await tick(100);
      // A second press on the working card: not taken; the quiet starts from it.
      fireEvent.click(a);
      const h = listen();
      // 150 ms later: Tab (one step on, to the next card's "Use this file"), then Enter, twice.
      await tick(150);
      use("Right Two").focus();
      enter();
      await tick(100);
      enter();
      await tick(10);
      expect(heldCalls.map((c) => c.id)).toEqual(["r8"]);
      expect(h.said).toEqual([NOT_TAKEN]);
      // Nothing changed on the card: it was not taken.
      expect(use("Right Two").getAttribute("aria-busy")).toBeNull();
      await tick(DECIDE_SETTLE_MS + 100);
      enter();
      await tick(10);
      expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10"]);
      h.stop();
    });

    it("R318 a: while a decision is out its button says it is working and the other looks unavailable; both back to normal after a refusal and after a give-up", async () => {
      let refuse = true;
      const o = mixed([
        http.post(`${SERVICE}/review/:itemId/held-file`, async ({ request, params }) => {
          heldCalls.push({ id: params.itemId as string, body: await request.json() });
          if (refuse) {
            await new Promise((r) => setTimeout(r, 1_000));
            return HttpResponse.json({ error: { code: "CONFLICT", message: "Paused.", reason: "paused" } }, { status: 409 });
          }
          return new Promise<Response>(() => {});
        }),
      ]);
      o.extra = o.extra!.slice(-1);
      open(o);
      await ready("Right Two");
      await waitFor(() => expect(within(card("Right One")).getByRole("button", { name: "Use this file for Right One (Smith, 2020)" })).toBeTruthy());
      moving();
      const [u, n] = within(card("Right One")).getAllByRole("button") as [HTMLButtonElement, HTMLButtonElement];
      const idle = () => {
        expect(u.textContent).toBe("Use this file");
        expect(n.textContent).toBe("Not this file");
        expect(u.getAttribute("aria-label")).toBe("Use this file for Right One (Smith, 2020)");
        expect(n.getAttribute("aria-label")).toBe("Not this file for Right One (Smith, 2020)");
        for (const b of [u, n]) {
          expect(b.getAttribute("aria-busy")).toBeNull();
          expect(b.getAttribute("aria-disabled")).toBeNull();
        }
      };
      idle();
      fireEvent.click(u);
      await tick(10);
      // The pressed button says it is working, in words, and still names its file; the other looks unavailable.
      expect(u.textContent).toBe("Using this file…");
      expect(u.getAttribute("aria-label")).toBe("Using this file… for Right One (Smith, 2020)");
      expect(u.getAttribute("aria-busy")).toBe("true");
      expect(u.getAttribute("aria-disabled")).toBe("true");
      expect(n.textContent).toBe("Not this file");
      expect(n.getAttribute("aria-disabled")).toBe("true");
      expect(n.getAttribute("aria-busy")).toBeNull();
      // Both stay focusable (never disabled).
      expect(u.disabled || n.disabled).toBe(false);
      await tick(1_000);
      expect(within(card("Right One")).getByRole("alert").textContent).toContain("Paused.");
      idle();
      // Not this file, given up after 60 seconds.
      refuse = false;
      await tick(DECIDE_SETTLE_MS + 100);
      fireEvent.click(n);
      await tick(10);
      expect(n.textContent).toBe("Removing this file…");
      expect(n.getAttribute("aria-label")).toBe("Removing this file… for Right One (Smith, 2020)");
      expect(n.getAttribute("aria-busy")).toBe("true");
      expect(u.textContent).toBe("Use this file");
      expect(u.getAttribute("aria-disabled")).toBe("true");
      await tick(HELD_DECISION_TIMEOUT_MS + 100);
      expect(within(card("Right One")).getByText("The service did not answer. Look at the queue again before deciding.")).toBeTruthy();
      const [u2, n2] = within(card("Right One")).getAllByRole("button");
      expect(u2!.textContent).toBe("Use this file");
      expect(n2!.textContent).toBe("Not this file");
      for (const b of [u2!, n2!]) {
        expect(b.getAttribute("aria-busy")).toBeNull();
        expect(b.getAttribute("aria-disabled")).toBeNull();
      }
    });
  });

  // R319: the cause is removed instead of timed — a decided file's card stays in its place, and the cards of the section
  // move only when the researcher asks ("Show them").
  describe("R319: nothing moves under the pointer", () => {
    /** The section's cards, in document order. */
    const cards = () => [...section().querySelectorAll<HTMLElement>(".ao-review__file")];
    const titles = () => cards().map((c) => c.querySelector("h4")?.textContent);
    /** A card's controls as a person reaches them (by role: a hidden, inert stand-in is none). */
    const controls = (el: HTMLElement) => within(el).queryAllByRole("button");

    it("R319 a: after Use this file the card stays in its place with the result in words and no deciding control; the next card has not moved", async () => {
      const { user } = open(mixed());
      await ready("Right Two");
      await waitFor(() => expect(within(card("Right One")).getByText("Ann Smith")).toBeTruthy());
      const before = cards();
      expect(before.map((c) => c.querySelector("h4")?.textContent)).toEqual(["Right One", "Right Two", RECORD, "Doubted Two"]);
      await point(user, use("Right One"));
      await waitFor(() => expect(within(card("Right One")).getByText("File added to its record.")).toBeTruthy());
      // The same cards, the same elements, in the same order: the element at the decided card's place is the decided card.
      expect(cards()).toEqual(before);
      expect(cards()[0]).toBe(card("Right One"));
      // Marked decided in words; no control that decides.
      const c = card("Right One");
      expect(within(c).getByText("Decided")).toBeTruthy();
      expect(controls(c)).toHaveLength(0);
      expect(noUse("Right One")).toBeNull();
      // Everything it showed, it still shows.
      for (const t of ["Ann Smith", "2020", HELD_FILE_LOOKS_RIGHT_TEXT, HELD_FILE_WHY_TEXT["looks-right"], "PDF, 879 KB"]) expect(within(c).getByText(t)).toBeTruthy();
      // The next card is where it was, still waiting, its controls its own.
      expect(cards()[1]).toBe(before[1]);
      expect(controls(cards()[1]!).map((b) => b.getAttribute("aria-label"))).toEqual(["Use this file for Right Two (Smith, 2020)", "Not this file for Right Two (Smith, 2020)"]);
      // The polite region says it as before.
      expect(screen.getByRole("status").textContent).toBe("File added to its record: Right One");
    });

    it("R319 a: after Not this file likewise", async () => {
      const { user } = open(mixed());
      await ready("Doubted Two");
      const before = cards();
      await point(user, not(RECORD));
      await waitFor(() => expect(within(card(RECORD)).getByText("File removed; the record keeps no file.")).toBeTruthy());
      expect(cards()).toEqual(before);
      const c = card(RECORD);
      expect(within(c).getByText("Decided")).toBeTruthy();
      expect(controls(c)).toHaveLength(0);
      for (const t of [DOUBTED, HELD_FILE_WHY_TEXT["other-doi"], "10.5555/ao.f11.other", "PDF, 2.3 MB"]) expect(within(c).getByText(t)).toBeTruthy();
      expect(controls(card("Doubted Two"))).toHaveLength(2);
      expect(screen.getByRole("status").textContent).toBe(`File removed; the record keeps no file: ${RECORD}`);
    });

    it("R319 a: the group's number counts the waiting files only; a group all decided stays", async () => {
      const { user } = open(mixed());
      await ready("Right Two");
      const before = cards();
      await point(user, use("Right One"));
      await waitFor(() => expect(screen.getByRole("heading", { name: "Files that look right (1)" })).toBeTruthy());
      await point(user, use("Right Two"));
      await waitFor(() => expect(screen.getByRole("heading", { name: "Files that look right (0)" })).toBeTruthy());
      // The group stays, with both its cards; the other group's cards have not moved.
      expect(within(group(/^Files that look right/u)).getAllByRole("listitem").map((li) => li.querySelector("h4")?.textContent)).toEqual(["Right One", "Right Two"]);
      expect(screen.getByRole("heading", { name: "Other files found (2)" })).toBeTruthy();
      expect(cards()).toEqual(before);
    });

    it("R319 d, R319 a: focus after a decision goes to the next waiting card's heading, skipping decided cards; with nothing waiting, to the message that says so", async () => {
      const { user } = open(mixed());
      await ready("Right Two");
      // The last of its group: the one before it.
      await point(user, use("Right Two"));
      await waitFor(() => expect(document.activeElement).toBe(head("Right One")));
      await point(user, not(RECORD));
      await waitFor(() => expect(document.activeElement).toBe(head("Doubted Two")));
      // Nothing waits in its group: the other group's first WAITING card (RECORD, decided, is skipped).
      await point(user, use("Right One"));
      await waitFor(() => expect(document.activeElement).toBe(head("Doubted Two")));
      await point(user, use("Doubted Two"));
      const empty = await screen.findByText("Nothing is waiting for review in this project.");
      await waitFor(() => expect(document.activeElement).toBe(empty));
      // Every card is still there, decided.
      expect(cards().map((c) => within(c).queryByText("Decided") !== null)).toEqual([true, true, true, true]);
      expect(heldCalls.map((c) => c.id)).toEqual(["r10", "r7", "r8", "r9"]);
    });

    describe("a re-read during the visit (after a decision given up)", () => {
      const ARRIVED = "2 more files have arrived since this list was opened.";
      /**
       * The four files of `mixed`. Right One is answered at once; RECORD's decision is never answered, so after 60 seconds
       * it is given up and the queue read again. The service then lists: RECORD and Doubted Two still waiting, Right Two
       * no longer (decided elsewhere), and two files that arrived meanwhile — "Right Three" (looks right) and "Doubted
       * Three" (doubted).
       */
      const visit = async () => {
        let list = mixed().projectReview![P1]!;
        const o = mixed();
        o.sources = { ...o.sources, s11: source(11, "Right Three"), s12: source(12, "Doubted Three") };
        o.extra = [
          http.get(`${SERVICE}/projects/:id/review`, () => HttpResponse.json({ items: list, total: list.length, offset: 0, limit: 500 })),
          http.post(`${SERVICE}/review/:itemId/held-file`, async ({ request, params }) => {
            heldCalls.push({ id: params.itemId as string, body: await request.json() });
            if (params.itemId === "r7") return new Promise<Response>(() => {});
            return HttpResponse.json({ decided: true });
          }),
        ];
        open(o);
        await ready("Doubted Two");
        await waitFor(() => expect(within(card("Right Two")).getByText("Ann Smith")).toBeTruthy());
        moving();
        fireEvent.click(use("Right One"));
        await tick(100);
        expect(within(card("Right One")).getByText("File added to its record.")).toBeTruthy();
        // The section is gone while the queue is read again and shown again after it: its cards are made anew, so they
        // are compared by what they show, in order.
        const before = titles();
        fireEvent.click(use(RECORD));
        const [r7, , r9] = mixed().projectReview![P1]!;
        list = [r7!, r9!, rightItem(11, "Right Three"), heldItem(12, { sourceId: "s12", title: "Doubted Three" })];
        await tick(HELD_DECISION_TIMEOUT_MS + 100);
        await tick(100);
        expect(within(card(RECORD)).getByText(HELD_NO_ANSWER_TEXT)).toBeTruthy();
        return { before };
      };
      const HELD_NO_ANSWER_TEXT = "The service did not answer. Look at the queue again before deciding.";

      it("R319 b: a file the service no longer lists keeps its card, saying it no longer waits", async () => {
        const { before } = await visit();
        expect(titles()).toEqual(before);
        const gone = card("Right Two");
        expect(within(gone).getByText("No longer waiting.")).toBeTruthy();
        expect(controls(gone)).toHaveLength(0);
        // Still showing what it showed.
        expect(within(gone).getByText("Ann Smith")).toBeTruthy();
        expect(within(gone).getByText(HELD_FILE_LOOKS_RIGHT_TEXT)).toBeTruthy();
        // The decided card stays decided; the files still listed still wait, with their controls.
        expect(within(card("Right One")).getByText("Decided")).toBeTruthy();
        expect(controls(card(RECORD))).toHaveLength(2);
        expect(controls(card("Doubted Two"))).toHaveLength(2);
        expect(screen.getByRole("heading", { name: "Files that look right (0)" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Other files found (2)" })).toBeTruthy();
      });

      it("R319 c: files that arrive are not slid in: a line says how many, and Show them lays the list out again with focus on the heading", async () => {
        const { before } = await visit();
        // The cards on screen have not changed; the new files are not among them.
        expect(titles()).toEqual(before);
        expect(screen.queryByRole("heading", { name: "Right Three" })).toBeNull();
        expect(cards().map((c) => c.querySelector("h4")?.textContent)).not.toContain("Doubted Three");
        expect(screen.getByText(ARRIVED)).toBeTruthy();
        // The line is in the section, above its cards, in the place kept for it: a stand-in of the line, never seen and
        // never reached (hidden, inert), is always laid out there, so that the line's appearing moves nothing (CSS).
        const line = screen.getByText(ARRIVED);
        expect(line.closest(".ao-review__arrivals")?.querySelector(":scope > .ao-review__ghost[aria-hidden='true'][inert]")).toBeTruthy();
        expect(section().contains(line)).toBe(true);
        expect(line.compareDocumentPosition(cards()[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        const h = listen();
        fireEvent.click(screen.getByRole("button", { name: "Show them" }));
        await tick(10);
        // Laid out afresh: decided and departed cards gone, the new files in, each in its group (in the service's order).
        expect(within(group(/^Files that look right/u)).getAllByRole("listitem").map((li) => li.querySelector("h4")?.textContent)).toEqual(["Right Three"]);
        expect(within(group(/^Other files found/u)).getAllByRole("listitem").map((li) => li.querySelector("h4")?.textContent)).toEqual([RECORD, "Doubted Two", "Doubted Three"]);
        expect(screen.getByRole("heading", { name: "Files that look right (1)" })).toBeTruthy();
        expect(screen.getByRole("heading", { name: "Other files found (3)" })).toBeTruthy();
        expect(screen.queryByText(ARRIVED)).toBeNull();
        expect(screen.queryByRole("button", { name: "Show them" })).toBeNull();
        // Focus on the section's heading; said once.
        expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Files found for records" }));
        expect(h.said).toEqual(["The list was laid out again."]);
        // The layout changed: the quiet holds — a press at once is not taken; one after the quiet is.
        fireEvent.click(use("Right Three"));
        await tick(10);
        expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r7"]);
        expect(h.said).toEqual(["The list was laid out again.", NOT_TAKEN]);
        await tick(DECIDE_SETTLE_MS + 100);
        fireEvent.click(use("Right Three"));
        await tick(10);
        expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r7", "r11"]);
        h.stop();
      });
    });

    // The place of the first card's "Use this file": the control that stands first among the section's controls when the
    // first press is made — the first card's first control. A later press at that place acts on whatever control
    // stands at that same position (the first card of the section, its first control), which must now be none.
    it.each([200, 1_000, 3_000])(
      "R319 g: a press at the place of the first card's Use this file, at every rhythm — every 100, 250, 550, 650, 1,000 and 2,000 ms for fifteen seconds — against an answer of %i ms, decides ONE file",
      async (answer) => {
        for (const every of [100, 250, 550, 650, 1_000, 2_000]) {
          heldCalls = [];
          open(mixedSlow(answer));
          await ready("Right Two");
          await waitFor(() => expect(within(card("Right Two")).getByText("Ann Smith")).toBeTruthy());
          moving();
          const atPlace = () => document.querySelector(".ao-review__found .ao-review__file")?.querySelector("button") ?? null;
          expect(atPlace()).toBe(use("Right One"));
          for (let t = 0; t < 15_000; t += every) {
            const b = atPlace();
            if (b) fireEvent.click(b);
            await tick(every);
          }
          await tick(answer + 100);
          expect({ every, decided: heldCalls.map((c) => c.id) }).toEqual({ every, decided: ["r8"] });
          // At that place: the decided card, without a control that decides.
          expect(cards()[0]).toBe(card("Right One"));
          expect(controls(cards()[0]!)).toHaveLength(0);
          cleanup();
          vi.useRealTimers();
          vi.useFakeTimers({ toFake: ["Date"] });
        }
      },
      60_000,
    );

    it("R319 e (m1): a result and a press not taken in the same moment — the result is said, then the notice", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const o = mixed();
      o.extra = [
        http.post(`${SERVICE}/review/:itemId/held-file`, async ({ request, params }) => {
          heldCalls.push({ id: params.itemId as string, body: await request.json() });
          if (params.itemId === "r8") await gate;
          return HttpResponse.json({ decided: true });
        }),
      ];
      open(o);
      await ready("Right Two");
      const u = use("Right One");
      fireEvent.click(u);
      await waitFor(() => expect(heldCalls).toHaveLength(1));
      const h = listen();
      // One moment (one render): a press on the busy card (not taken: it starts the quiet again), the answer, and a press
      // on another file inside that quiet (not taken: its notice).
      await act(async () => {
        fireEvent.click(u);
        release();
        await new Promise((r) => setTimeout(r, 50));
        fireEvent.click(use("Right Two"));
      });
      await waitFor(() => expect(within(card("Right One")).getByText("File added to its record.")).toBeTruthy());
      expect(h.said).toEqual(["File added to its record: Right One", NOT_TAKEN]);
      expect(heldCalls.map((c) => c.id)).toEqual(["r8"]);
      h.stop();
    });

    it("R319 f (m2): a press that is taken starts no quiet — file A pressed, and 100 ms later a deliberate press on file B at rest is taken", async () => {
      open(mixedSlow(1_000));
      await ready("Right Two");
      moving();
      fireEvent.click(use("Right One"));
      await tick(100);
      fireEvent.click(use("Right Two"));
      await tick(10);
      expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10"]);
    });
  });

  // R322: a deciding control takes a press by mouse only where the researcher pointed at it; by touch or pen only after
  // it has stood still for the quiet's time; by keyboard as built.
  //
  // The page's geometry is modelled (jsdom gives every element a zero rectangle): `getBoundingClientRect` is mocked so
  // that the section starts at 500 px, 300 px lower while the list of other entries (`.ao-review__layout`) is shown above
  // it, plus `geo.extra` (another part above that may go away); each card is 300 px tall, its "Use this file" at x 0 and
  // its "Not this file" at x 150 of the card's top line (100 × 30); the panel's "Accept" stands at y 500. A pointer
  // resting at a point presses whatever control's rectangle holds that point (a hidden stand-in is not hit).
  describe("R322: a press is taken only where the researcher pointed", () => {
    const MOVED = "Not taken. Look at the file, then move the pointer and press again.";
    const MOVED_TOUCH = "Not taken: the page had just moved. Look at the file, then tap again.";
    const geo = { extra: 0 };
    const rectFor = (el: Element): DOMRect => {
      const top = 500 + (document.querySelector(".ao-review__layout") ? 300 : 0) + geo.extra;
      if (el instanceof HTMLButtonElement && el.closest(".ao-review__layout") && el.textContent === "Accept") return new DOMRect(0, 500, 100, 30);
      const li = el instanceof HTMLButtonElement ? el.closest(".ao-review__file") : null;
      if (li) {
        const k = [...document.querySelectorAll(".ao-review__found .ao-review__file")].indexOf(li);
        const ghost = !!el.closest("[aria-hidden='true']");
        const col = [...li.querySelectorAll("button")].filter((b) => !!b.closest("[aria-hidden='true']") === ghost).indexOf(el as HTMLButtonElement);
        return new DOMRect(col * 150, top + k * 300, 100, 30);
      }
      return new DOMRect(0, 0, 0, 0);
    };
    beforeEach(() => {
      geo.extra = 0;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        return rectFor(this);
      });
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });
    /** The control a pointer resting at (x, y) would press now (none where nothing reachable stands). */
    const controlAt = (x: number, y: number) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => {
        if (b.closest("[aria-hidden='true']")) return false;
        const r = rectFor(b);
        return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
      });
    /** Where the pointer is (client coordinates): R323 a — a movement is a change of these. */
    const pointer = { x: 1, y: 1 };
    /** The pointer really moves over a control (to a new point). */
    const moveOver = (el: Element, pointerType = "mouse") => {
      // From where it was (seen by the screen) to a new point on the control.
      fireEvent.pointerMove(document.body, { pointerType, pointerId: 1, clientX: pointer.x, clientY: pointer.y });
      pointer.x += 3;
      pointer.y += 2;
      fireEvent.pointerMove(el, { pointerType, pointerId: 1, clientX: pointer.x, clientY: pointer.y });
    };
    /** A pointermove that reports no movement (WebKit sends these after a scroll, to update what is hovered). */
    const stillMove = (el: Element) => fireEvent.pointerMove(el, { pointerType: "mouse", pointerId: 1, clientX: pointer.x, clientY: pointer.y });
    /** A press by a pointer (no movement before it): down, up, and the click it makes. */
    const pressBy = (el: Element | undefined, pointerType = "mouse") => {
      if (!el) return;
      fireEvent.pointerDown(el, { pointerType, button: 0 });
      fireEvent.pointerUp(el, { pointerType, button: 0 });
      fireEvent.click(el);
    };
    /** A press at a resting point. */
    const pressAt = (x: number, y: number, pointerType = "mouse") => pressBy(controlAt(x, y), pointerType);

    it("R323 a: a pointermove that reports no movement does not arm the control: after the control moved, a press is not taken; after a real movement it is", async () => {
      open(mixed());
      await ready("Right Two");
      const h = listen();
      const u = use("Right Two");
      moveOver(u);
      // The page scrolls (by the wheel, say) under the resting pointer: the control moved; the engine sends a pointermove
      // at the same point.
      geo.extra = -300;
      stillMove(u);
      pressBy(u);
      await new Promise((r) => setTimeout(r, 50));
      expect(heldCalls).toHaveLength(0);
      expect(h.said).toEqual([MOVED]);
      passGuard();
      moveOver(u);
      pressBy(u);
      await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r10"]));
      h.stop();
    });

    it("R323 a: a scroll — of the window, or of any scrolling ancestor of the section — forgets where the controls stood; after a real movement a press is taken", async () => {
      open(mixed());
      await ready("Right Two");
      const u = use("Right One");
      moveOver(u);
      fireEvent.scroll(window);
      pressBy(u);
      await new Promise((r) => setTimeout(r, 50));
      expect(heldCalls).toHaveLength(0);
      // An inner scroller (an ancestor of the section).
      passGuard();
      moveOver(u);
      fireEvent.scroll(section().parentElement!);
      pressBy(u);
      await new Promise((r) => setTimeout(r, 50));
      expect(heldCalls).toHaveLength(0);
      passGuard();
      moveOver(u);
      pressBy(u);
      await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
    });

    // ---- R371 d (M1): guards no test held before, each shown by taking it out (see the report) ----
    /** A key press on the focused control (keydown, the click a browser makes of it, keyup). */
    const enterOn = (el: HTMLElement) => {
      el.focus();
      fireEvent.keyDown(el, { key: "Enter", code: "Enter" });
      fireEvent.click(el);
      fireEvent.keyUp(el, { key: "Enter", code: "Enter" });
    };
    /** A click whose own event says it came from a mouse, with no pointer-down before it. */
    const mouseClickOnly = (el: Element) => {
      const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      Object.defineProperty(e, "pointerType", { value: "mouse" });
      fireEvent(el, e);
    };

    it("R371 d, R318 b: a press swallowed by the quiet starts it again — a key press at 500 ms, then one at 700 ms (past the first 600 ms) is still not taken; 600 ms after it, one is", async () => {
      open(mixed());
      await waitFor(() => card("Right Two"));
      // The opening's quiet starts now (the clock stands still until moved).
      const t0 = Date.now();
      const u = use("Right One");
      vi.setSystemTime(t0 + 500);
      enterOn(u);
      await waitFor(() => expect(note("Right One")?.textContent).toBe(QUIET_SHOWN));
      vi.setSystemTime(t0 + 700);
      enterOn(u);
      await new Promise((r) => setTimeout(r, 50));
      expect(heldCalls).toHaveLength(0);
      vi.setSystemTime(t0 + 700 + DECIDE_SETTLE_MS + 1);
      enterOn(u);
      await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
    });

    it("R371 d, R323 a: a scroll forgets the places seen — a real move, a scroll, more than 250 ms, a press without a new move: not taken; after a move it is", async () => {
      open(mixed());
      await ready("Right Two");
      const h = listen();
      const u = use("Right One");
      moveOver(u);
      fireEvent.scroll(window);
      vi.setSystemTime(Date.now() + SCROLL_SETTLE_MS + 1);
      pressBy(u);
      await new Promise((r) => setTimeout(r, 50));
      expect(heldCalls).toHaveLength(0);
      expect(h.said).toEqual([MOVED]);
      moveOver(u);
      pressBy(u);
      await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
      h.stop();
    });

    it("R371 d: a click that says it came from a mouse, with no pointer-down before it, is not taken (check answers \"moved\"); a press with its pointer-down, after a movement, is", async () => {
      open(mixed());
      await ready("Right Two");
      const h = listen();
      const u = use("Right One");
      moveOver(u);
      mouseClickOnly(u);
      await new Promise((r) => setTimeout(r, 50));
      expect(heldCalls).toHaveLength(0);
      expect(h.said).toEqual([MOVED]);
      moveOver(u);
      pressBy(u);
      await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
      h.stop();
    });

    it("R371 d: a key press clears a stale pointer-down — the mouse went down on the control and was let go elsewhere; then Enter on it is taken as a key's press", async () => {
      open(mixed());
      await ready("Right Two");
      const u = use("Right One");
      fireEvent.pointerDown(u, { pointerType: "mouse", button: 0 });
      fireEvent.pointerUp(document.body, { pointerType: "mouse", button: 0 });
      enterOn(u);
      await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
    });

    it("R371 d (panel): the panel forgets the places seen when the list is read again while the same entry stays shown — a press under the resting pointer is not taken; after a move it is", async () => {
      const o = project();
      o.projectReview = { [P1]: [item(1, { batchId: undefined, title: "Dropped file" }), rightItem(8, "Right One")] };
      o.sources = { s1: source(1, "Dropped file"), s8: source(8, "Right One") };
      o.extra = [http.post(`${SERVICE}/review/:itemId/held-file`, () => new Promise<Response>(() => {}))];
      const { m } = open(o);
      await ready("Right One");
      const accept = await screen.findByRole("button", { name: "Accept" });
      await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false));
      moveOver(accept);
      const reads = () => m.calls.filter((c) => c.method === "GET" && c.path.startsWith(`/projects/${P1}/review`)).length;
      const readsBefore = reads();
      refake(["setTimeout", "clearTimeout", "Date"]);
      try {
        // A found file's decision with no answer is given up, and the queue is read again (R313 e).
        enterOn(use("Right One"));
        await vi.advanceTimersByTimeAsync(HELD_DECISION_TIMEOUT_MS + 100);
      } finally {
        vi.useRealTimers();
        vi.useFakeTimers({ toFake: ["Date"] });
      }
      await waitFor(() => expect(reads()).toBeGreaterThan(readsBefore));
      // The same entry is shown, its Accept where it stood.
      await waitFor(() => expect(within(screen.getByRole("region", { name: "Imported record" })).getByText("Dropped file")).toBeTruthy());
      const again = screen.getByRole("button", { name: "Accept" });
      await waitFor(() => expect((again as HTMLButtonElement).disabled).toBe(false));
      passGuard();
      const h = listen();
      pressBy(again);
      await new Promise((r) => setTimeout(r, 50));
      expect(m.calls.filter((c) => c.path === "/review/r1/decide")).toHaveLength(0);
      expect(h.said).toEqual(["Not taken. Look at the entry, then move the pointer and press again."]);
      moveOver(again);
      pressBy(again);
      await waitFor(() => expect(m.calls.filter((c) => c.path === "/review/r1/decide")).toHaveLength(1));
      h.stop();
    });

    const MOVED_SHOWN = MOVED;
    const QUIET_SHOWN = "Not taken: the list had just changed. Look at the file, then press again.";
    /** The line under a card's two controls (R323 c). */
    const note = (title: string) => card(title).querySelector<HTMLElement>(".ao-review__file-note");

    it("R323 b: a press not taken is shown on its card, under its controls, tied to the control, until the pointer moves over the card", async () => {
      open(mixed());
      await ready("Right Two");
      const u = use("Right One");
      pressBy(u);
      await waitFor(() => expect(note("Right One")?.textContent).toBe(MOVED_SHOWN));
      const shown = within(note("Right One")!).getByText(MOVED_SHOWN);
      expect(shown.closest("[role='alert']")).toBeNull();
      expect(u.getAttribute("aria-describedby")).toBe(shown.id);
      expect(shown.id).not.toBe("");
      // Only that card shows it.
      expect(note("Right Two")?.textContent).toBe("");
      // The pointer moves over the card: it goes.
      moveOver(card("Right One"));
      await waitFor(() => expect(note("Right One")?.textContent).toBe(""));
      expect(u.getAttribute("aria-describedby")).toBeNull();
    });

    it("R323 b: a press swallowed by the quiet is shown on its card; it goes when a press there is taken", async () => {
      open(mixed());
      await waitFor(() => card("Right Two"));
      // Inside the opening's quiet: by key.
      const u = use("Right One");
      u.focus();
      const enter = () => {
        fireEvent.keyDown(u, { key: "Enter", code: "Enter" });
        fireEvent.click(u);
        fireEvent.keyUp(u, { key: "Enter", code: "Enter" });
      };
      enter();
      await waitFor(() => expect(note("Right One")?.textContent).toBe(QUIET_SHOWN));
      expect(heldCalls).toHaveLength(0);
      passGuard();
      enter();
      await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
      await waitFor(() => expect(note("Right One")?.textContent).toBe(""));
    });

    it("R323 c: the line under the controls is there from the first showing, empty; a sentence comes into it, and nothing is put above or between the controls", async () => {
      const GONE = "The record this file was found for is no longer in the library. Nothing was changed.";
      const o = project();
      o.extra = [http.post(`${SERVICE}/review/:itemId/held-file`, () => HttpResponse.json({ error: { code: "CONFLICT", message: GONE, reason: "source-gone" } }, { status: 409 }))];
      open(o);
      const c = await waitFor(() => card(RECORD));
      const slot = c.querySelector(".ao-review__file-note")!;
      expect(slot).toBeTruthy();
      expect(slot.textContent).toBe("");
      for (const b of within(c).getAllByRole("button")) expect(b.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const children = [...c.children];
      const actions = within(c).getAllByRole("button")[0]!.parentElement!;
      const inActions = [...actions.children];
      passGuard();
      moveOver(use(RECORD));
      pressBy(use(RECORD));
      const alert = await within(c).findByRole("alert");
      expect(slot.contains(alert)).toBe(true);
      expect(alert.textContent).toContain(GONE);
      expect([...c.children]).toEqual(children);
      expect([...actions.children]).toEqual(inActions);
    });

    it("R322 a: a mouse press on a control the pointer moved over, where it stands, is taken", async () => {
      open(mixed());
      await ready("Right Two");
      moveOver(use("Right One"));
      pressBy(use("Right One"));
      await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
    });

    it("R322 a: after the control moved without a pointer movement (the section jumped), a mouse press is not taken and is said once; after a movement over it, it is taken", async () => {
      open(mixed());
      await ready("Right Two");
      const h = listen();
      const u = use("Right Two");
      moveOver(u);
      // The part above the section goes away: the control is 300 px higher; the pointer has not moved.
      geo.extra = -300;
      pressBy(u);
      pressBy(u);
      await new Promise((r) => setTimeout(r, 50));
      expect(heldCalls).toHaveLength(0);
      expect(u.getAttribute("aria-busy")).toBeNull();
      expect(h.said).toEqual([MOVED]);
      // The pointer moves over it where it now stands; a press (after the quiet those presses renewed) is taken.
      passGuard();
      moveOver(u);
      pressBy(u);
      await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r10"]));
      h.stop();
    });

    it("R322 a: a control the pointer never moved over, pressed by mouse, is not taken", async () => {
      open(mixed());
      await ready("Right Two");
      const h = listen();
      pressBy(use("Right One"));
      await new Promise((r) => setTimeout(r, 50));
      expect(heldCalls).toHaveLength(0);
      expect(h.said).toEqual([MOVED]);
      h.stop();
    });

    it("R322 a, b: a double press on the last Accept above, the second falling on a found file's Use this file, does not decide the found file", async () => {
      const o = project();
      o.projectReview = { [P1]: [item(1, { batchId: undefined, title: "Dropped file" }), rightItem(8, "Right One")] };
      o.sources = { s1: source(1, "Dropped file"), s8: source(8, "Right One") };
      const { m } = open(o);
      await ready("Right One");
      const accept = await screen.findByRole("button", { name: "Accept" });
      await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false));
      // The pointer rests on Accept (it moved there), and presses twice.
      const P = { x: 10, y: 510 };
      expect(controlAt(P.x, P.y)).toBe(accept);
      moveOver(accept);
      pressAt(P.x, P.y);
      // The import entry is decided: the list above goes, and the section moves up 300 px — its first card's Use this
      // file now stands under the resting pointer.
      await waitFor(() => expect(document.querySelector(".ao-review__layout")).toBeNull());
      expect(controlAt(P.x, P.y)).toBe(use("Right One"));
      pressAt(P.x, P.y);
      await new Promise((r) => setTimeout(r, 50));
      expect(m.calls.filter((c) => c.path === "/review/r1/decide")).toHaveLength(1);
      expect(heldCalls).toHaveLength(0);
      expect(use("Right One").getAttribute("aria-busy")).toBeNull();
    });

    it("R322 b: a decision on an entry of another kind above starts the quiet for the found files' controls (by key too)", async () => {
      const o = project();
      o.projectReview = { [P1]: [item(1, { batchId: undefined, title: "Dropped file" }), rightItem(8, "Right One")] };
      o.sources = { s1: source(1, "Dropped file"), s8: source(8, "Right One") };
      const { user } = open(o);
      await ready("Right One");
      const accept = await screen.findByRole("button", { name: "Accept" });
      await waitFor(() => expect((accept as HTMLButtonElement).disabled).toBe(false));
      await point(user, accept);
      await waitFor(() => expect(document.querySelector(".ao-review__layout")).toBeNull());
      const u = use("Right One");
      u.focus();
      fireEvent.keyDown(u, { key: "Enter", code: "Enter" });
      fireEvent.click(u);
      fireEvent.keyUp(u, { key: "Enter", code: "Enter" });
      await new Promise((r) => setTimeout(r, 50));
      expect(heldCalls).toHaveLength(0);
      passGuard();
      fireEvent.keyDown(u, { key: "Enter", code: "Enter" });
      fireEvent.click(u);
      fireEvent.keyUp(u, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
    });

    it("R322 a: a touch press on a control that moved within the last 600 ms is not taken; after 600 ms of stillness it is", async () => {
      open(mixedSlow(200));
      await ready("Right Two");
      moving();
      await tick(DECIDE_SETTLE_MS + 100);
      const h = listen();
      // Something above went away: the control moved.
      geo.extra = -300;
      pressBy(use("Right One"), "touch");
      await tick(10);
      expect(heldCalls).toHaveLength(0);
      expect(h.said).toEqual([MOVED_TOUCH]);
      await tick(300);
      pressBy(use("Right One"), "touch");
      await tick(10);
      expect(heldCalls).toHaveLength(0);
      // 600 ms after the last press, the control having stood still since it moved: taken. A pen likewise.
      await tick(DECIDE_SETTLE_MS + 100);
      pressBy(use("Right One"), "touch");
      await tick(10);
      expect(heldCalls.map((c) => c.id)).toEqual(["r8"]);
      pressBy(use("Right Two"), "pen");
      await tick(10);
      expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10"]);
      h.stop();
    });

    it("R322 a: a keyboard press (Enter, Space) on the focused control is not affected: never moved over, its rectangle changed", async () => {
      open(mixed());
      await ready("Right Two");
      geo.extra = -300;
      const u = use("Right One");
      u.focus();
      fireEvent.keyDown(u, { key: "Enter", code: "Enter" });
      fireEvent.click(u);
      fireEvent.keyUp(u, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
      geo.extra = -600;
      const n = not("Right Two");
      n.focus();
      fireEvent.keyDown(n, { key: " ", code: "Space" });
      fireEvent.keyUp(n, { key: " ", code: "Space" });
      fireEvent.click(n);
      await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10"]));
    });

    it("R322 a: a mouse press is never taken for a keyboard one: a key down and up on the control, then a mouse press without a movement, is not taken", async () => {
      open(mixed());
      await ready("Right Two");
      const u = use("Right One");
      u.focus();
      fireEvent.keyDown(u, { key: "Enter", code: "Enter" });
      fireEvent.keyUp(u, { key: "Enter", code: "Enter" });
      pressBy(u);
      await new Promise((r) => setTimeout(r, 50));
      expect(heldCalls).toHaveLength(0);
    });

    it("R322 b: a refusal's sentence is shown below the card's two controls", async () => {
      const GONE = "The record this file was found for is no longer in the library. Nothing was changed.";
      const o = project();
      o.extra = [http.post(`${SERVICE}/review/:itemId/held-file`, () => HttpResponse.json({ error: { code: "CONFLICT", message: GONE, reason: "source-gone" } }, { status: 409 }))];
      open(o);
      await ready(RECORD);
      fireEvent.click(use(RECORD));
      const alert = await within(card(RECORD)).findByRole("alert");
      for (const b of [use(RECORD), not(RECORD)]) expect(b.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("R322 b: the Creators and Year rows have their place from the card's first showing, before the record is read", async () => {
      const o = project();
      o.projectReview = { [P1]: [rightItem(8, "Right One")] };
      o.sources = { s8: source(8, "Right One") };
      o.extra = [http.get(`${SERVICE}/projects/:id/sources/:sid`, () => new Promise<Response>(() => {})), ...(o.extra ?? [])];
      open(o);
      const c = await waitFor(() => card("Right One"));
      const dts = [...c.querySelectorAll("dt")].map((d) => d.textContent);
      expect(dts.slice(0, 2)).toEqual(["Creators", "Year"]);
      expect([...c.querySelectorAll("dl")[0]!.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["…", "…"]);
    });

    // The reviewer's probe: the pointer rests at the place of the first card's Use this file (it moved there once), the
    // part of the page above the section goes away during the pressing, and the presses go on at every rhythm.
    it.each([200, 1_000, 3_000])(
      "R322 + R319 g: a press resting at the place of the first card's Use this file while the part above the section goes away, at every rhythm, against an answer of %i ms, decides ONE file",
      async (answer) => {
        for (const every of [100, 250, 550, 650, 1_000, 2_000]) {
          heldCalls = [];
          geo.extra = 300;
          open(mixedSlow(answer));
          await ready("Right Two");
          moving();
          const P = { x: 10, y: 810 };
          expect(controlAt(P.x, P.y)).toBe(use("Right One"));
          moveOver(use("Right One"));
          for (let t = 0; t < 15_000; t += every) {
            if (t >= 3_000) geo.extra = 0; // the part above goes away: every card is 300 px higher under the pointer
            pressAt(P.x, P.y);
            await tick(every);
          }
          await tick(answer + 100);
          expect({ every, decided: heldCalls.map((c) => c.id) }).toEqual({ every, decided: ["r8"] });
          cleanup();
          vi.useRealTimers();
          vi.useFakeTimers({ toFake: ["Date"] });
        }
      },
      60_000,
    );

    // R327: the press not taken for its place starts no quiet; a mouse press within SCROLL_SETTLE_MS of a scroll is not
    // taken; one sentence per cause, said when it appears; the first movement of a pointer does not count.
    describe("R327", () => {
      const keyEnter = (b: HTMLElement) => {
        b.focus();
        fireEvent.keyDown(b, { key: "Enter", code: "Enter" });
        fireEvent.click(b);
        fireEvent.keyUp(b, { key: "Enter", code: "Enter" });
      };
      const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

      it("R327 a: after a press refused for its place, a real movement onto the control and a press at once is taken", async () => {
        open(mixed());
        await ready("Right Two");
        const u = use("Right One");
        pressBy(u);
        await new Promise((r) => setTimeout(r, 30));
        expect(heldCalls).toHaveLength(0);
        moveOver(u);
        pressBy(u);
        await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
      });

      it("R327 a: after a refusal on one card, pointing at another card's control and pressing at once is taken", async () => {
        open(mixed());
        await ready("Right Two");
        pressBy(use("Right One"));
        await new Promise((r) => setTimeout(r, 30));
        expect(heldCalls).toHaveLength(0);
        moveOver(use("Right Two"));
        pressBy(use("Right Two"));
        await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r10"]));
      });

      it("R327 b: scroll, a real movement onto the control, a press 100 ms after the scroll is not taken; 300 ms after it is taken", async () => {
        for (const [gap, taken] of [[100, false], [300, true]] as const) {
          heldCalls = [];
          open(mixed());
          await ready("Right Two");
          const u = use("Right One");
          fireEvent.scroll(window);
          moveOver(u);
          later(gap);
          pressBy(u);
          await new Promise((r) => setTimeout(r, 30));
          expect({ gap, decided: heldCalls.map((c) => c.id) }).toEqual({ gap, decided: taken ? ["r8"] : [] });
          cleanup();
        }
      });

      it("R327 b: a scroll during the 250 ms renews it", async () => {
        open(mixed());
        await ready("Right Two");
        const u = use("Right One");
        fireEvent.scroll(window);
        later(200);
        fireEvent.scroll(window);
        moveOver(u);
        later(200); // 400 ms after the first scroll, 200 after the second
        pressBy(u);
        await new Promise((r) => setTimeout(r, 30));
        expect(heldCalls).toHaveLength(0);
        moveOver(u);
        later(260);
        pressBy(u);
        await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
      });

      it("R327 b: a keyboard press right after a scroll is taken", async () => {
        open(mixed());
        await ready("Right Two");
        fireEvent.scroll(window);
        keyEnter(use("Right One"));
        await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
      });

      describe("R327 c: one sentence for each cause, on the card and in the polite region", () => {
        const cases: Array<[string, string, (u: HTMLElement) => void]> = [
          ["a mouse press after the first movement of a pointer", MOVED, (u) => fireEvent.pointerMove(u, { pointerType: "mouse", pointerId: 1, clientX: 5, clientY: 5 })],
          ["a mouse press with no movement since the screen opened", MOVED, () => undefined],
          ["a mouse press after a scroll", MOVED, (u) => (moveOver(u), fireEvent.scroll(window))],
          ["a mouse press on a control that moved", MOVED, (u) => (moveOver(u), (geo.extra = -300))],
        ];
        it.each(cases)("%s", async (_name, sentence, before) => {
          open(mixed());
          await ready("Right Two");
          const h = listen();
          const u = use("Right One");
          before(u);
          pressBy(u);
          await waitFor(() => expect(note("Right One")?.textContent).toBe(sentence));
          expect(h.said).toEqual([sentence]);
          expect(heldCalls).toHaveLength(0);
          h.stop();
        });

        it("a tap on a control that had just moved", async () => {
          open(mixed());
          await ready("Right Two");
          const h = listen();
          geo.extra = -300;
          pressBy(use("Right One"), "touch");
          await waitFor(() => expect(note("Right One")?.textContent).toBe(MOVED_TOUCH));
          expect(h.said).toEqual([MOVED_TOUCH]);
          h.stop();
        });

        it("a press inside the quiet (by key)", async () => {
          open(mixed());
          await waitFor(() => card("Right Two"));
          const h = listen();
          keyEnter(use("Right One"));
          await waitFor(() => expect(note("Right One")?.textContent).toBe(QUIET_SHOWN));
          expect(h.said).toEqual([QUIET_SHOWN]);
          h.stop();
        });

        it("three refused presses in a row are said once; after the pointer really moves over the card, a further refusal is said again", async () => {
          open(mixed());
          await ready("Right Two");
          const h = listen();
          const u = use("Right One");
          pressBy(u);
          pressBy(u);
          pressBy(u);
          await waitFor(() => expect(note("Right One")?.textContent).toBe(MOVED));
          expect(h.said).toEqual([MOVED]);
          moveOver(card("Right One"));
          await waitFor(() => expect(note("Right One")?.textContent).toBe(""));
          pressBy(u);
          await waitFor(() => expect(note("Right One")?.textContent).toBe(MOVED));
          expect(h.said).toEqual([MOVED, MOVED]);
          h.stop();
        });

        it("a line that changes to another sentence is said again", async () => {
          open(mixed());
          await waitFor(() => card("Right Two"));
          const h = listen();
          const u = use("Right One");
          pressBy(u); // mouse, no movement: its place
          await waitFor(() => expect(note("Right One")?.textContent).toBe(MOVED));
          keyEnter(u); // inside the opening's quiet
          await waitFor(() => expect(note("Right One")?.textContent).toBe(QUIET_SHOWN));
          expect(h.said).toEqual([MOVED, QUIET_SHOWN]);
          h.stop();
        });
      });

      it("R327 d (i): ONE pointermove onto a control is the first pointer event the screen sees, then a press: not taken", async () => {
        open(mixed());
        await ready("Right Two");
        const u = use("Right One");
        fireEvent.pointerMove(u, { pointerType: "mouse", pointerId: 1, clientX: 40, clientY: 40 });
        pressBy(u);
        await new Promise((r) => setTimeout(r, 30));
        expect(heldCalls).toHaveLength(0);
      });

      it("R327 d (ii): a scroll, then a pointermove at the same point as the first pointer events, then a press: not taken", async () => {
        open(mixed());
        await ready("Right Two");
        const u = use("Right One");
        fireEvent.pointerMove(document.body, { pointerType: "mouse", pointerId: 1, clientX: 40, clientY: 40 });
        fireEvent.scroll(window);
        fireEvent.pointerMove(u, { pointerType: "mouse", pointerId: 1, clientX: 40, clientY: 40 });
        later(400);
        pressBy(u);
        await new Promise((r) => setTimeout(r, 30));
        expect(heldCalls).toHaveLength(0);
      });
    });
  });

  // R319 b changes what this asserts: the entry leaves the queue, but its card stays in its place, without controls, saying so.
  it("R282 d: a 409 whose reason says already decided takes the entry out of the queue; R319 b: its card stays, saying so, without controls", async () => {
    const o = project();
    o.extra = [http.post(`${SERVICE}/review/:itemId/held-file`, () => HttpResponse.json({ error: { code: "CONFLICT", message: "This entry has already been reviewed.", reason: "already-decided" } }, { status: 409 }))];
    const { user } = open(o);
    await ready(RECORD);
    await point(user, use(RECORD));
    await waitFor(() => expect(noUse(RECORD)).toBeNull());
    expect(screen.getByRole("status").textContent).toMatch(/had already been decided, so it left the queue: Rivers and Memory/u);
    expect(within(card(RECORD)).getByText("This entry had already been decided, so it left the queue.")).toBeTruthy();
    expect(within(card(RECORD)).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("listitem").filter((li) => li.querySelector("h4")).map((li) => li.querySelector("h4")?.textContent)).toEqual([RECORD, "A Second Record"]);
    // R313 a: to the next file's heading.
    await waitFor(() => expect(document.activeElement).toBe(head("A Second Record")));
  });
});
