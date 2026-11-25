/**
 * FR-756's remainder (R601 b, R617): the review queue's own first read has the time limit. A read of the queue that
 * never settles is given up at the limit and says "The library service did not answer in time."; one that fails with
 * no answer says "The library service could not be reached." as before; each with one "Try again", which reads the
 * queue again ("Loading…" meanwhile). The picker's reads (`/import/review` with no project) have it too, and the page
 * (picker and queue) says one sentence with one "Try again" (R602 M1, R605 I2).
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importRoute } from "../../routes/import";
import { B1, BASE, mockService, P1, server } from "../../test/importService";
import type { ReviewItem } from "../../api/import";
import { ReviewQueue } from "./ReviewQueue";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const NO_ANSWER = "The library service did not answer in time.";
const UNREACHABLE = "The library service could not be reached.";
const LIMIT = 300;
const alerts = () => screen.queryAllByRole("alert").map((a) => a.textContent);
const tryAgains = () => screen.queryAllByRole("button", { name: "Try again" });
const url = (p: string) => `${BASE}${p}`;
const hang = () => new Promise<void>(() => undefined);

const ENTRY: ReviewItem = { id: "r1", projectId: P1, sourceId: "s1", kind: "import", group: "attach", status: "pending", createdAt: "2026-11-11T10:00:00.000Z", fields: {}, reasons: ["Low confidence"], title: "Entry 1" } as ReviewItem;
const RECORD = { source: { id: "s1", type: "webpage", title: { variants: [{ lang: "en", kind: "original", value: "Entry 1" }] }, issued: "2019", creators: [], collectionIds: [], tagIds: [], provenance: {} }, assets: [], fieldEvidence: [], fields: [] };

/** GET of the project's queue, step by step: "hold" never settles, "fail" gets no answer, "answer" answers. */
function queueAsks(steps: Array<"hold" | "fail" | "answer" | "refuse">) {
  const requests: Request[] = [];
  const h = {
    count: 0,
    get signals(): AbortSignal[] {
      return requests.map((r) => r.signal);
    },
  };
  return {
    h,
    handler: http.get(url("/projects/:id/review"), async ({ request }) => {
      requests.push(request);
      const step = steps[Math.min(h.count++, steps.length - 1)];
      if (step === "hold") await hang();
      if (step === "fail") return HttpResponse.error();
      if (step === "refuse") return HttpResponse.json({ error: { code: "INTERNAL", message: "The queue's file could not be read." } }, { status: 500 });
      return HttpResponse.json({ items: [ENTRY], total: 1 });
    }),
  };
}

describe("the review queue's own first read (FR-756 remainder)", () => {
  it("a read that never settles is given up at the limit: the alert and “Try again”; pressed, “Loading…” and then the queue, focus on the heading", async () => {
    const q = queueAsks(["hold", "hold", "answer"]);
    const m = mockService({ extra: [q.handler], sources: { s1: RECORD } });
    render(<ReviewQueue client={m.client} projectId={P1} firstReadMs={LIMIT} />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(q.h.signals[0]!.aborted).toBe(true);
    const user = userEvent.setup();
    await user.click(tryAgains()[0]!);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Review queue" }));
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    await user.click(tryAgains()[0]!);
    await screen.findByText("1 entry is waiting", { exact: false });
    expect(alerts()).toEqual([]);
    expect(tryAgains()).toHaveLength(0);
    expect(q.h.count).toBe(3);
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Review queue" }));
  });

  it("a read that FAILS with no answer says “could not be reached” as before, now with “Try again”", async () => {
    const q = queueAsks(["fail", "answer"]);
    const m = mockService({ extra: [q.handler], sources: { s1: RECORD } });
    render(<ReviewQueue client={m.client} projectId={P1} firstReadMs={LIMIT} />);
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    await userEvent.setup().click(tryAgains()[0]!);
    await screen.findByText("1 entry is waiting", { exact: false });
    expect(alerts()).toEqual([]);
  });

  it("a read refused with an answer says the service's sentence as before, with no “Try again”", async () => {
    const q = queueAsks(["refuse"]);
    const m = mockService({ extra: [q.handler] });
    render(<ReviewQueue client={m.client} projectId={P1} firstReadMs={LIMIT} />);
    await waitFor(() => expect(alerts().join(" ")).toContain("The queue's file could not be read."));
    expect(tryAgains()).toHaveLength(0);
  });

  it("an answered failure after a give-up takes the give-up's sentence away", async () => {
    const q = queueAsks(["hold", "refuse"]);
    const m = mockService({ extra: [q.handler] });
    render(<ReviewQueue client={m.client} projectId={P1} firstReadMs={LIMIT} />);
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    await userEvent.setup().click(tryAgains()[0]!);
    await waitFor(() => expect(alerts().join(" ")).toContain("The queue's file could not be read."));
    expect(alerts().join(" ")).not.toContain(NO_ANSWER);
    expect(tryAgains()).toHaveLength(0);
  });

  it("one import's queue (a batch) has the limit too", async () => {
    let answer = false;
    const m = mockService({
      extra: [
        http.get(url("/imports/:batchId/review"), async () => {
          if (!answer) await hang();
          return HttpResponse.json({ items: [] });
        }),
      ],
    });
    render(<ReviewQueue client={m.client} projectId={P1} batchId={B1} firstReadMs={LIMIT} />);
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    answer = true;
    await userEvent.setup().click(tryAgains()[0]!);
    await screen.findByText("Nothing is waiting for review in this import.");
    expect(alerts()).toEqual([]);
  });

  it("leaving the queue cancels its held read", async () => {
    const q = queueAsks(["hold"]);
    const m = mockService({ extra: [q.handler] });
    const { unmount } = render(<ReviewQueue client={m.client} projectId={P1} />);
    await waitFor(() => expect(q.h.count).toBe(1));
    expect(q.h.signals[0]!.aborted).toBe(false);
    unmount();
    await waitFor(() => expect(q.h.signals[0]!.aborted).toBe(true));
  });
});

describe("the review queue's side reads of collections and tags (the bulk bar's lists): the limit, silently (FR-756 remainder, R623 Minor 3)", () => {
  /** The collections and tags, each held (never settling); their requests' signals. */
  function heldLists() {
    const requests: Request[] = [];
    const held = async ({ request }: { request: Request }) => {
      requests.push(request);
      await hang();
      return undefined;
    };
    return {
      get signals(): AbortSignal[] {
        return requests.map((r) => r.signal);
      },
      handlers: [http.get(url("/projects/:id/collections"), held), http.get(url("/projects/:id/tags"), held)],
    };
  }
  const options = (name: string) => within(screen.getByRole("combobox", { name })).getAllByRole("option").map((o) => o.textContent);

  it("held, they are given up at the limit: no alert, and the bulk bar's lists show what a failure showed (nothing to choose)", async () => {
    const lists = heldLists();
    const m = mockService({ extra: [queueAsks(["answer"]).handler, ...lists.handlers], sources: { s1: RECORD } });
    render(<ReviewQueue client={m.client} projectId={P1} firstReadMs={LIMIT} />);
    await screen.findByText("1 entry is waiting", { exact: false });
    await waitFor(() => expect(lists.signals).toHaveLength(2));
    expect(lists.signals.some((s) => s.aborted)).toBe(false);
    await waitFor(() => expect(lists.signals.every((s) => s.aborted)).toBe(true), { timeout: 5000 });
    expect(alerts()).toEqual([]);
    expect(tryAgains()).toHaveLength(0);
    expect(options("Add tag")).toEqual(["Choose a tag"]);
    expect(options("Move to collection")).toEqual(["Choose a collection"]);
  });

  it("leaving the queue cancels them", async () => {
    const lists = heldLists();
    const m = mockService({ extra: [queueAsks(["answer"]).handler, ...lists.handlers], sources: { s1: RECORD } });
    const { unmount } = render(<ReviewQueue client={m.client} projectId={P1} />);
    await waitFor(() => expect(lists.signals).toHaveLength(2));
    expect(lists.signals.some((s) => s.aborted)).toBe(false);
    unmount();
    await waitFor(() => expect(lists.signals.every((s) => s.aborted)).toBe(true));
  });
});

describe("the review queue's route with no project: the picker's reads have the limit, one sentence for the page (FR-756 remainder)", () => {
  it("a list of projects that never settles is given up at the limit: the alert and “Try again”; pressed, the picker is filled", async () => {
    let answer = false;
    let asks = 0;
    const m = mockService({
      extra: [
        http.get(url("/projects"), async () => {
          asks++;
          if (!answer) await hang();
          return HttpResponse.json({ projects: [{ id: P1, name: "Thesis", encrypted: false, unlocked: true }] });
        }),
      ],
    });
    render(<>{importRoute({ pathname: "/import/review", search: "" }, m.client, { firstReadMs: LIMIT })}</>);
    await screen.findByRole("button", { name: "Try again" }, { timeout: 5000 });
    expect(alerts()).toEqual([NO_ANSWER]);
    answer = true;
    await userEvent.setup().click(tryAgains()[0]!);
    await screen.findByRole("option", { name: "Thesis" });
    await waitFor(() => expect(alerts()).toEqual([]));
    expect(tryAgains()).toHaveLength(0);
    expect(asks).toBe(2);
  });

  it("the list of imports failed with no answer: “could not be reached”, with one “Try again”, which reads it again", async () => {
    let answer = false;
    const m = mockService({
      extra: [
        http.get(url("/projects"), async () => HttpResponse.json({ projects: [{ id: P1, name: "Thesis", encrypted: false, unlocked: true }] })),
        http.get(url("/projects/:id/imports"), () => (answer ? HttpResponse.json({ batches: [] }) : HttpResponse.error())),
      ],
    });
    render(<>{importRoute({ pathname: "/import/review", search: "" }, m.client, { firstReadMs: LIMIT })}</>);
    await screen.findByRole("button", { name: "Try again" });
    expect(alerts()).toEqual([UNREACHABLE]);
    expect(tryAgains()).toHaveLength(1);
    answer = true;
    await userEvent.setup().click(tryAgains()[0]!);
    await waitFor(() => expect(alerts()).toEqual([]));
  });
});

describe("the review queue's route naming an import and no project: the picker and the queue are one page, one sentence and one “Try again” (FR-756 remainder, R623 I1)", () => {
  type Step = "hold" | "fail" | "answer";
  const STEPS: Step[] = ["hold", "fail", "answer"];
  const BATCH = { batchId: B1, number: 1, kind: "folder", state: "finished", startedAt: "2026-11-11T10:00:00.000Z", counts: { created: 1, merged: 0, skipped: 0, failed: 0, needsReview: 1 } };
  const EMPTY = "Nothing is waiting for review in this import.";
  const queueLoading = () => screen.queryAllByRole("status").some((s) => s.textContent === "Loading…");
  /** "could not be reached" wins over "did not answer in time"; with both read, nothing is said. */
  const sentenceFor = (imports: Step, queue: Step) => (imports === "fail" || queue === "fail" ? UNREACHABLE : imports === "hold" || queue === "hold" ? NO_ANSWER : undefined);

  for (const imports of STEPS)
    for (const queue of STEPS)
      it(`the list of imports ${imports === "hold" ? "held" : imports === "fail" ? "failed with no answer" : "answered"}, the import's queue ${queue === "hold" ? "held" : queue === "fail" ? "failed with no answer" : "answered"}`, async () => {
        const asks = { imports: 0, queue: 0 };
        const held: { imports: Request[] } = { imports: [] };
        let answerAll = false;
        const m = mockService({
          extra: [
            http.get(url("/projects"), () => HttpResponse.json({ projects: [{ id: P1, name: "Thesis", encrypted: false, unlocked: true }] })),
            http.get(url("/projects/:id/imports"), async ({ request }) => {
              asks.imports++;
              if (!answerAll && imports === "hold") {
                held.imports.push(request);
                await hang();
              }
              if (!answerAll && imports === "fail") return HttpResponse.error();
              return HttpResponse.json({ batches: [BATCH] });
            }),
            http.get(url("/imports/:batchId/review"), async () => {
              asks.queue++;
              if (!answerAll && queue === "hold") await hang();
              if (!answerAll && queue === "fail") return HttpResponse.error();
              return HttpResponse.json({ items: [] });
            }),
          ],
        });
        render(<>{importRoute({ pathname: "/import/review", search: `?batch=${B1}` }, m.client, { firstReadMs: LIMIT })}</>);
        const sentence = sentenceFor(imports, queue);
        // At rest: the queue's read has landed (its "Loading…" gone), and so has the list's (answered, or its sentence said).
        await screen.findByRole("heading", { level: 1, name: "Review queue" });
        await waitFor(
          () => {
            expect(queueLoading()).toBe(false);
            if (imports === "answer") expect(screen.queryByRole("option", { name: /Import 1/ })).not.toBeNull();
            if (imports === "hold") expect(held.imports.every((r) => r.signal.aborted)).toBe(true);
            if (sentence !== undefined) expect(alerts()).toContain(sentence);
          },
          { timeout: 5000 },
        );
        if (sentence === undefined) {
          expect(alerts()).toEqual([]);
          expect(tryAgains()).toHaveLength(0);
          expect(screen.getByText(EMPTY)).toBeTruthy();
          return;
        }
        expect(alerts()).toEqual([sentence]);
        expect(tryAgains()).toHaveLength(1);
        const before = { ...asks };
        answerAll = true;
        await userEvent.setup().click(tryAgains()[0]!);
        await screen.findByText(EMPTY);
        await screen.findByRole("option", { name: /Import 1/ });
        await waitFor(() => expect(alerts()).toEqual([]));
        expect(tryAgains()).toHaveLength(0);
        // The press reads again what was out, and only that (the queue, read again, reads its list of imports beside it too).
        const again = { imports: imports === "answer" ? 0 : 1, queue: queue === "answer" ? 0 : 1 };
        expect(asks).toEqual({ imports: before.imports + again.imports + again.queue, queue: before.queue + again.queue });
      });
});
