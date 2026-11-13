/**
 * The annotation list when a library search handed the reader its words (Task R12): "Annotations
 * matching your search (N)" with "Show all"; the groups, sort, windowing, roving focus and counts of
 * the unfiltered list kept right for the filtered one; "Show all" keeps the focus on the same entry;
 * a change made while filtered behaves as unfiltered; the sentence when nothing matches exactly.
 * The words themselves never reach the list: it gets the ids the reader matched (R1's matcher).
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { AnnotationRecord } from "../api/reader";
import { AnnotationList, SEARCH_LOOKING, type AnnotationListProps } from "./AnnotationList";

afterEach(() => cleanup());

function rec(id: string, o: Partial<AnnotationRecord> & { page?: number; assetId?: string } = {}): AnnotationRecord {
  const { page = 1, assetId = "a1", ...rest } = o;
  return {
    id,
    sourceId: "s1",
    kind: "highlight",
    pdfAnchors: [{ id: `${id}-a`, assetId, page, rects: [{ x: 50, y: 700, w: 100, h: 10 }], sortIndex: `${String(page).padStart(5, "0")}|000000|00000`, sortIndexDerived: false }],
    otherAnchorKinds: [],
    quote: `Words of ${id}`,
    colorName: "yellow",
    imported: false,
    author: "me",
    createdAt: "2026-11-13T10:00:00Z",
    ...rest,
  };
}

const noop = () => Promise.resolve();

function Harness(p: { initial: AnnotationRecord[]; ids?: string[]; words?: string; note?: string; focus?: { id: string; seq: number }; extra?: Partial<AnnotationListProps> }) {
  const [items, setItems] = useState(p.initial);
  const [ids, setIds] = useState<ReadonlySet<string> | undefined>(p.ids ? new Set(p.ids) : undefined);
  return (
    <AnnotationList
      annotations={items}
      assetId="a1"
      readOnly={false}
      pageCount={20}
      {...(p.words !== undefined ? { filterWords: p.words } : {})}
      {...(ids ? { filterIds: ids } : {})}
      {...(p.note !== undefined ? { searchNote: p.note } : {})}
      {...(p.focus ? { focusRequest: p.focus } : {})}
      onShowAll={() => setIds(undefined)}
      onJump={() => {}}
      onSaveNote={async (id, body) => setItems((l) => l.map((a) => (a.id !== id ? a : body === null ? (({ body: _b, ...r }) => r)(a) : { ...a, body })))}
      onRecolour={noop}
      onDelete={async (id) => setItems((l) => l.filter((a) => a.id !== id))}
      {...p.extra}
    />
  );
}

const five = () => [rec("a", { page: 1 }), rec("b", { page: 2 }), rec("c", { page: 3 }), rec("d", { page: 4 }), rec("e", { page: 5 })];
const shown = () => [...document.querySelectorAll<HTMLElement>("[data-entry]")].map((e) => e.dataset.entry);
const entry = (id: string) => document.querySelector<HTMLElement>(`[data-entry="${id}"]`)!;

describe("AnnotationList filtered by a search (Task R12)", () => {
  it("is headed 'Annotations matching your search (N)' with a Show all button, and lists only the matches", () => {
    render(<Harness initial={five()} ids={["b", "d"]} />);
    expect(screen.getByRole("region", { name: "Annotations matching your search (2)" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Annotations matching your search (2)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show all" })).toBeTruthy();
    expect(shown()).toEqual(["b", "d"]);
  });

  it("keeps the counts right: aria-setsize is the filtered count and positions run 1..N", () => {
    render(<Harness initial={five()} ids={["b", "d"]} />);
    expect(["b", "d"].map((id) => [entry(id).getAttribute("aria-setsize"), entry(id).getAttribute("aria-posinset")])).toEqual([
      ["2", "1"],
      ["2", "2"],
    ]);
  });

  it("keeps the groups: another file's and unplaced annotations are not matches here and are not listed; the sort is the list's own", () => {
    const items = [rec("late", { page: 9 }), rec("early", { page: 2 }), rec("other", { assetId: "a2", page: 1 }), rec("nowhere", { pdfAnchors: [] })];
    render(<Harness initial={items} ids={["late", "early"]} />);
    expect(shown()).toEqual(["early", "late"]);
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("moves between the filtered entries only, by arrows, Home and End (roving focus)", async () => {
    const user = userEvent.setup();
    render(<Harness initial={five()} ids={["b", "d"]} />);
    entry("b").focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(entry("d"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(entry("d"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(entry("b"));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(entry("d"));
    expect(entry("b").tabIndex).toBe(-1);
    expect(entry("d").tabIndex).toBe(0);
  });

  it("Show all returns to the full list with the focus kept on the same entry", async () => {
    const user = userEvent.setup();
    render(<Harness initial={five()} ids={["b", "d"]} />);
    entry("d").focus();
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("heading", { level: 2, name: "Annotations (5)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
    expect(shown()).toEqual(["a", "b", "c", "d", "e"]);
    await waitFor(() => expect(document.activeElement).toBe(entry("d")));
    expect(entry("d").getAttribute("aria-setsize")).toBe("5");
    expect(entry("d").getAttribute("aria-posinset")).toBe("4");
  });

  it("Show all by keyboard (Enter on the button) keeps the focus on the entry too", async () => {
    const user = userEvent.setup();
    render(<Harness initial={five()} ids={["b", "d"]} />);
    await user.tab();
    await user.tab();
    const button = screen.getByRole("button", { name: "Show all" });
    button.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(document.activeElement).toBe(entry("b")));
  });

  it("a change made while filtered behaves as unfiltered: a note is saved, the list stays filtered", async () => {
    const user = userEvent.setup();
    render(<Harness initial={five()} ids={["b", "d"]} />);
    await user.click(within(entry("b")).getByRole("button", { name: /^Add note/ }));
    await user.type(screen.getByRole("textbox"), "a thought");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(entry("b").textContent).toContain("a thought"));
    expect(shown()).toEqual(["b", "d"]);
    expect(screen.getByRole("heading", { level: 2, name: "Annotations matching your search (2)" })).toBeTruthy();
  });

  it("a delete made while filtered takes the entry out, the count follows, focus goes to the next match", async () => {
    const user = userEvent.setup();
    render(<Harness initial={five()} ids={["b", "d"]} />);
    await user.click(within(entry("b")).getByRole("button", { name: /^Delete/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(shown()).toEqual(["d"]));
    expect(screen.getByRole("heading", { level: 2, name: "Annotations matching your search (1)" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(entry("d")));
    expect(entry("d").getAttribute("aria-setsize")).toBe("1");
  });

  it("when the last match is deleted, says so and keeps Show all", async () => {
    const user = userEvent.setup();
    render(<Harness initial={five()} ids={["b"]} />);
    await user.click(within(entry("b")).getByRole("button", { name: /^Delete/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(shown()).toEqual([]));
    expect(screen.getByText("No annotation matching your search is left.")).toBeTruthy();
    expect(screen.queryByText("This file has no highlights or notes yet.")).toBeNull();
    expect(screen.getByRole("button", { name: "Show all" })).toBeTruthy();
  });

  it("while the words are being looked for says so, shows the whole list, and never shows the words", () => {
    render(<Harness initial={five()} words="secret words" />);
    expect(screen.getByText(SEARCH_LOOKING).getAttribute("role")).toBe("status");
    expect(SEARCH_LOOKING).toBe("Looking for the words…");
    expect(shown()).toHaveLength(5);
    expect(document.body.textContent).not.toContain("secret words");
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("a sentence from the reader (nothing matched exactly) is shown with the full list and the plain heading", () => {
    const note = "None of this source's annotations contains all of these words exactly; the search may have matched another form of a word.";
    render(<Harness initial={five()} note={note} />);
    expect(screen.getByText(note).getAttribute("role")).toBe("status");
    expect(shown()).toHaveLength(5);
    expect(screen.getByRole("heading", { level: 2, name: "Annotations (5)" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("a focus request puts the focus on that entry (once), in the filtered list", async () => {
    const { rerender } = render(<Harness initial={five()} ids={["b", "d"]} focus={{ id: "d", seq: 1 }} />);
    await waitFor(() => expect(document.activeElement).toBe(entry("d")));
    entry("b").focus();
    rerender(<Harness initial={five()} ids={["b", "d"]} focus={{ id: "d", seq: 1 }} />);
    expect(document.activeElement).toBe(entry("b"));
  });

  it("a windowed list (past 500) filtered to more than 500 keeps its counts, and a focus request reveals an entry far down", async () => {
    const items = Array.from({ length: 700 }, (_, i) => rec(`n${String(i).padStart(3, "0")}`, { page: (i % 19) + 1 }));
    const matches = items.slice(0, 600).map((a) => a.id);
    render(<Harness initial={items} ids={matches} focus={{ id: "n590", seq: 1 }} />);
    expect(screen.getByRole("heading", { level: 2, name: "Annotations matching your search (600)" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.getAttribute("data-entry")).toBe("n590"));
    expect(document.activeElement?.getAttribute("aria-setsize")).toBe("600");
    expect(shown().every((id) => matches.includes(id!))).toBe(true);
  });
});
