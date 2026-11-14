import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportApi, ReviewItem, SourceFile } from "../../api/import";
import { http, HttpResponse } from "msw";
import { BASE as SERVICE, mockService, PSEUDONYMISING_GOVERNANCE, server, type ServiceSetup, B1, P1 } from "../../test/importService";
import { renderToStaticMarkup } from "react-dom/server";
import { HELD_FILE_LOOKS_RIGHT_TEXT, HELD_FILE_WHY_TEXT } from "@ao/shared";
import { FilePreview } from "./FilePreview";
import { ReviewQueue } from "./ReviewQueue";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

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
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(m.bodies("POST /review/r1/decide")).toEqual([{ projectId: P1, decision: { action: "accept" } }]));
    // r1 is gone; r2 is now shown.
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Select kinship herat draft" })).toBeNull());
    await within(screen.getByRole("region", { name: "Imported record" })).findByText("Second paper");
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(m.bodies("POST /review/r2/decide")).toEqual([{ projectId: P1, decision: { action: "skip" } }]));
    await within(screen.getByRole("region", { name: "Imported record" })).findByText("Third paper");
    await user.click(screen.getByRole("button", { name: "Keep both" }));
    await waitFor(() => expect(m.bodies("POST /review/r3/decide")).toEqual([{ projectId: P1, decision: { action: "keep-both" } }]));
    expect(await screen.findByText(/Nothing is waiting for review/)).toBeTruthy();
    everyBodyHasProject(m);
  });

  it("accepting a candidate sends its index", async () => {
    const { m, user } = setup();
    const candidates = await screen.findByRole("region", { name: "Candidate matches" });
    await user.click(within(candidates).getAllByRole("button", { name: /Use this match/ })[1]!);
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
    await user.click(screen.getByRole("button", { name: "Save and accept" }));
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
    await user.click(await screen.findByRole("button", { name: "Merge into An older edition" }));
    await waitFor(() => expect(m.bodies("POST /review/r1/decide")).toEqual([{ projectId: P1, decision: { action: "merge", sourceId: "s-old" } }]));
  });

  it("offers the likely duplicate as the merge target", async () => {
    const { m, user } = setup({ ...BASE, review: [item(1, { duplicateOf: { sourceId: "s9", reason: "Same DOI" } })] });
    await screen.findByText(/Same DOI/);
    await user.click(screen.getByRole("button", { name: "Merge into the likely duplicate" }));
    await waitFor(() => expect(m.bodies("POST /review/r1/decide")).toEqual([{ projectId: P1, decision: { action: "merge", sourceId: "s9" } }]));
  });

  describe("pseudonymised projects (R64)", () => {
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
    await user.click(accept);
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

  it("after a decision, focus moves to the next item", async () => {
    const { user } = setup();
    await within(await screen.findByRole("region", { name: "Imported record" })).findByText("kinship herat draft");
    screen.getByRole("button", { name: "Accept" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show Second paper" })));
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
  beforeEach(() => {
    heldCalls = [];
  });
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
  const use = (title: string) => screen.getByRole("button", { name: `Use this file for ${title}` });

  it("has its own group, and shows the record (title, creators, year), the entry's sentence and what the check found, as text only", async () => {
    open(project());
    expect(await screen.findByRole("heading", { name: "Files found for records" })).toBeTruthy();
    const c = await waitFor(() => card(RECORD));
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
    expect(within(c).getByRole("button", { name: `Use this file for ${RECORD}` })).toBeTruthy();
    expect(within(c).getByRole("button", { name: `Not this file for ${RECORD}` })).toBeTruthy();
  });

  it("a file that looks right is shown with the service's sentence and advice, never with words of doubt", async () => {
    const o = project();
    o.projectReview = { [P1]: [rightItem(8, "Right One")] };
    o.sources = { s8: source(8, "Right One") };
    open(o);
    const c = await waitFor(() => card("Right One"));
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
    const c = await waitFor(() => card("Doubted Two"));
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
    await waitFor(() => card(RECORD));
    expect(screen.queryByRole("heading", { name: /^Files that look right/u })).toBeNull();
    expect(screen.getByRole("heading", { name: "Other files found (2)" })).toBeTruthy();
  });

  it("every file has its own two controls, named with its record; nothing decides several at once", async () => {
    const { user } = open(mixed());
    await waitFor(() => card("Right Two"));
    const section = screen.getByRole("region", { name: "Files found for records" });
    for (const t of ["Right One", "Right Two", RECORD, "Doubted Two"]) {
      const buttons = within(card(t)).getAllByRole("button");
      expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([`Use this file for ${t}`, `Not this file for ${t}`]);
    }
    // No control in the section is about more than one file.
    for (const el of within(section).queryAllByRole("button")) expect(el.getAttribute("aria-label") ?? el.textContent).not.toMatch(/\ball\b|every|selected/iu);
    expect(within(section).queryAllByRole("checkbox")).toHaveLength(0);
    // One request per press, one file per request.
    await user.dblClick(use("Right One"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use this file for Right One" })).toBeNull());
    await user.click(screen.getByRole("button", { name: "Not this file for Doubted Two" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Not this file for Doubted Two" })).toBeNull());
    expect(heldCalls).toEqual([
      { id: "r8", body: { projectId: P1, decision: "attach" } },
      { id: "r9", body: { projectId: P1, decision: "discard" } },
    ]);
    // The other two still wait, each with its own controls.
    expect(use("Right Two")).toBeTruthy();
    expect(use(RECORD)).toBeTruthy();
  });

  it("after Use this file focus goes to the next waiting file; after the last, to the heading or the empty message", async () => {
    const { user } = open(mixed());
    await waitFor(() => card("Right Two"));
    // The next in the same group.
    await user.click(use("Right One"));
    await waitFor(() => expect(document.activeElement).toBe(use("Right Two")));
    expect(screen.getByRole("status").textContent).toBe("File added to its record: Right One");
    // The last of its group: the first file of the other group.
    await user.click(use("Right Two"));
    await waitFor(() => expect(document.activeElement).toBe(use(RECORD)));
    expect(screen.queryByRole("heading", { name: /^Files that look right/u })).toBeNull();
    // Not this file moves on the same way.
    await user.click(screen.getByRole("button", { name: `Not this file for ${RECORD}` }));
    await waitFor(() => expect(document.activeElement).toBe(use("Doubted Two")));
    expect(screen.getByRole("status").textContent).toBe(`File removed; the record keeps no file: ${RECORD}`);
    // The last file of all: the message that says nothing is waiting.
    await user.click(use("Doubted Two"));
    const empty = await screen.findByText("Nothing is waiting for review in this project.");
    await waitFor(() => expect(document.activeElement).toBe(empty));
    expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10", "r7", "r9"]);
  });

  it("after the last found file, with other entries still waiting, focus goes to the queue's heading", async () => {
    const o = project();
    o.projectReview = { [P1]: [item(1, { batchId: undefined, title: "Dropped file" }), rightItem(8, "Right One")] };
    o.sources = { s1: source(1, "Dropped file"), s8: source(8, "Right One") };
    const { user } = open(o);
    await waitFor(() => card("Right One"));
    await user.click(use("Right One"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Review queue" })));
    expect(screen.queryByRole("region", { name: "Files found for records" })).toBeNull();
    expect(screen.getByRole("button", { name: /Show Dropped file/u })).toBeTruthy();
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
    await waitFor(() => card("Right Two"));
    await user.click(use("Right One"));
    await waitFor(() => expect(heldCalls.map((c) => c.id)).toEqual(["r8"]));
    // Its two buttons are busy and cannot be pressed again; focus stays on the one pressed.
    const one = within(card("Right One"));
    expect(one.getByRole("button", { name: "Use this file for Right One" }).getAttribute("aria-disabled")).toBe("true");
    expect(one.getByRole("button", { name: "Use this file for Right One" }).getAttribute("aria-busy")).toBe("true");
    expect(one.getByRole("button", { name: "Not this file for Right One" }).getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(use("Right One"));
    await user.click(use("Right One"));
    await user.click(screen.getByRole("button", { name: "Not this file for Right One" }));
    // Another file is decided meanwhile.
    expect(use("Right Two").getAttribute("aria-disabled")).toBeNull();
    await user.click(use("Right Two"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use this file for Right Two" })).toBeNull());
    expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10"]);
    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use this file for Right One" })).toBeNull());
    expect(heldCalls.map((c) => c.id)).toEqual(["r8", "r10"]);
  });

  it("a refusal keeps the entry, shows the service's sentence and keeps focus on the control", async () => {
    const GONE = "The record this file was found for is no longer in the library, so the file cannot be added to it. Choose “Not this file” to remove it. Nothing was changed.";
    const o = project();
    o.extra = [http.post(`${SERVICE}/review/:itemId/held-file`, () => HttpResponse.json({ error: { code: "CONFLICT", message: GONE, reason: "source-gone" } }, { status: 409 }))];
    const { user } = open(o);
    await waitFor(() => card(RECORD));
    await user.click(use(RECORD));
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
    await user.click(await screen.findByRole("button", { name: `Use this file for ${RECORD}` }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(PAUSED);
    expect(screen.getByRole("button", { name: `Use this file for ${RECORD}` })).toBeTruthy();
    expect(screen.queryByText(/had already been decided/u)).toBeNull();
  });

  it("R282 d: a 409 whose reason says already decided takes the entry away", async () => {
    const o = project();
    o.extra = [http.post(`${SERVICE}/review/:itemId/held-file`, () => HttpResponse.json({ error: { code: "CONFLICT", message: "This entry has already been reviewed.", reason: "already-decided" } }, { status: 409 }))];
    const { user } = open(o);
    await user.click(await screen.findByRole("button", { name: `Use this file for ${RECORD}` }));
    await waitFor(() => expect(screen.queryByRole("button", { name: `Use this file for ${RECORD}` })).toBeNull());
    expect(screen.getByRole("status").textContent).toMatch(/had already been decided, so it left the queue: Rivers and Memory/u);
    await waitFor(() => expect(document.activeElement).toBe(use("A Second Record")));
  });
});
