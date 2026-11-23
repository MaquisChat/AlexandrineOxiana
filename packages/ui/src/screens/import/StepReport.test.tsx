import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ImportApi, ImportReport } from "../../api/import";
import { REPORT } from "../../test/importService";
import { StepReport, undoQuestion } from "./StepReport";

const report = (over: Partial<ImportReport> = {}, counts: Partial<ImportReport["counts"]> = {}): ImportReport => ({
  ...REPORT,
  ...over,
  counts: { ...REPORT.counts, created: 0, needsReview: 0, merged: 0, updated: 0, ...counts },
});

function show(r: ImportReport) {
  const api = { report: async () => r, undo: async () => ({ removedSources: 0, revertedMerges: 0, kept: [] }) } as unknown as ImportApi;
  render(<StepReport api={api} projectId="p" batchId="b" />);
}

describe("StepReport: highlights deleted here", () => {
  it("says in plain words how many were not added again (plural)", async () => {
    show(report({ annotationsDeletedHere: 3 }));
    expect(await screen.findByText("3 highlights you deleted here were not added again.")).toBeTruthy();
  });

  it("singular", async () => {
    show(report({ annotationsDeletedHere: 1 }));
    expect(await screen.findByText("1 highlight you deleted here was not added again.")).toBeTruthy();
  });

  it("says nothing for zero or an older report", async () => {
    show(report({ annotationsDeletedHere: 0 }));
    await screen.findByRole("heading", { name: "Report and undo" });
    await screen.findByText(/Import \d+\./);
    expect(screen.queryByText(/you deleted here/)).toBeNull();
  });

  it("says nothing when the field is absent", async () => {
    const r = report();
    delete (r as { annotationsDeletedHere?: number }).annotationsDeletedHere;
    show(r);
    await screen.findByText(/Import \d+\./);
    expect(screen.queryByText(/highlights? you deleted here/)).toBeNull();
  });
});

describe("the undo question", () => {
  it("for a run that created, merged and updated nothing (for instance one that only filled in highlight order) does not claim sources are removed", async () => {
    const r = report();
    expect(undoQuestion(r)).toBe("This import added and changed no sources. Undo it anyway?");
    show(r);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Undo import" }));
    expect(within(screen.getByRole("alertdialog")).getByText("This import added and changed no sources. Undo it anyway?")).toBeTruthy();
  });

  it("is unchanged when sources were created, merged or updated", () => {
    expect(undoQuestion(report({}, { created: 1284, merged: 3 }))).toBe("Remove 1,284 imported sources and restore 3 merged sources?");
    expect(undoQuestion(report({}, { updated: 1 }))).toBe("Revert 1 updated source?");
  });
});

describe("changed in Zotero and here (Z6, R236 e)", () => {
  it("the undo question counts the Zotero values it takes off, and never says the import changed nothing when it raised one", () => {
    expect(undoQuestion(report({}, { conflicts: 2 }))).toBe("Take the Zotero values waiting for your decision off 2 sources (your values stay as they are)?");
    expect(undoQuestion(report({}, { conflicts: 1, updated: 1 }))).toBe("Revert 1 updated source and take the Zotero values waiting for your decision off 1 source (your values stay as they are)?");
    // Cleared in Zotero and kept here: nothing of the sources' values to undo.
    expect(undoQuestion(report({}, { clearedInZoteroKept: 3 }))).toBe("This import added and changed no sources. Undo it anyway?");
  });

  it("the result says what was done in the same terms", async () => {
    const { undoneText } = await import("./StepReport");
    expect(undoneText({ removedSources: 0, revertedMerges: 2, reverted: { merged: 0, updated: 0, unmarked: 0, remarked: 0, conflicts: 2 }, kept: [] })).toBe("Took the waiting Zotero values off 2 sources.");
    expect(undoneText({ removedSources: 0, revertedMerges: 1, reverted: { merged: 0, updated: 1, unmarked: 0, remarked: 0, conflicts: 1 }, kept: [] })).toBe("Reverted 1 updated source and took the waiting Zotero values off 1 source.");
  });

  it("the report table has the rows for values waiting and values cleared in Zotero, each only when not zero", async () => {
    show(report({}, { conflicts: 2, clearedInZoteroKept: 1 }));
    const table = await screen.findByRole("table", { name: "Items by outcome" });
    const row = (name: string) => within(table).getByRole("rowheader", { name }).closest("tr")!.textContent;
    expect(row("Changed in Zotero and here — waiting for you")).toContain("2");
    expect(row("Cleared in Zotero, kept here")).toContain("1");
  });

  it("no such rows when zero", async () => {
    show(report({}, { conflicts: 0, clearedInZoteroKept: 0 }));
    const table = await screen.findByRole("table", { name: "Items by outcome" });
    expect(within(table).queryByText(/Zotero/)).toBeNull();
  });
});

describe("gone from Zotero, and back (Z5, R224)", () => {
  it("the undo question counts marked and returned sources as sources it will change", () => {
    expect(undoQuestion(report({}, { goneInZotero: 1, goneInZoteroBin: 1 }))).toBe("Take the Zotero mark off 1 source?");
    expect(undoQuestion(report({}, { goneInZotero: 3 }))).toBe("Take the Zotero mark off 3 sources?");
    // A bare back: undo puts the mark back. A back that also changed the item is an updated source (counted once).
    expect(undoQuestion(report({}, { backInZotero: 2, backInZoteroUpdated: 1, updated: 1 }))).toBe("Revert 1 updated source and mark 1 source as gone from Zotero again?");
    // Already marked earlier, or gone with no source of its own here: nothing to undo for those.
    expect(undoQuestion(report({}, { goneAlready: 4, goneNotMarked: 2 }))).toBe("This import added and changed no sources. Undo it anyway?");
  });

  it("the undo question never names a zero, and reads as a sentence for every combination (R224, last round)", () => {
    const combos: Array<[Partial<ImportReport["counts"]>, string]> = [
      [{ created: 2, goneInZotero: 1 }, "Remove 2 imported sources and take the Zotero mark off 1 source?"],
      [{ merged: 1, backInZotero: 3 }, "Restore 1 merged source and mark 3 sources as gone from Zotero again?"],
      [{ created: 1, merged: 2, updated: 3, goneInZotero: 4, backInZotero: 5 }, "Remove 1 imported source, restore 2 merged sources, revert 3 updated sources, take the Zotero mark off 4 sources and mark 5 sources as gone from Zotero again?"],
      [{ backInZotero: 1, backInZoteroUpdated: 1, updated: 1 }, "Revert 1 updated source?"],
    ];
    for (const [counts, q] of combos) {
      const text = undoQuestion(report({}, counts));
      expect(text).toBe(q);
      expect(text).not.toMatch(/\b0 /u);
    }
  });

  it("the undo's result line says what was done in the question's terms, leaving out zeros", async () => {
    const r = report({}, { goneInZotero: 1, backInZotero: 1 });
    const api = { report: async () => r, undo: async () => ({ removedSources: 0, revertedMerges: 2, reverted: { merged: 0, updated: 0, unmarked: 1, remarked: 1 }, kept: [] }) } as unknown as ImportApi;
    render(<StepReport api={api} projectId="p" batchId="b" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Undo import" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Undo import" }));
    expect(await screen.findByText("Took the Zotero mark off 1 source and marked 1 source as gone from Zotero again.")).toBeTruthy();
    expect(screen.queryByText(/merged or updated/)).toBeNull();
  });

  it("the undo's result line: removed and reverted, and nothing to change", async () => {
    const { undoneText } = await import("./StepReport");
    expect(undoneText({ removedSources: 5, revertedMerges: 1, reverted: { merged: 0, updated: 1, unmarked: 0, remarked: 0 }, kept: [] })).toBe("Removed 5 imported sources and reverted 1 updated source.");
    expect(undoneText({ removedSources: 0, revertedMerges: 0, reverted: { merged: 0, updated: 0, unmarked: 0, remarked: 0 }, kept: [] })).toBe("No source needed to be changed.");
    // An older service, without the detail: the sentence as before.
    expect(undoneText({ removedSources: 1284, revertedMerges: 3, kept: [] })).toBe("Removed 1,284 sources and restored 3 sources that had been merged or updated.");
  });

  it("the table has the row for sources still gone from Zotero, only when not zero", async () => {
    show(report({}, { goneAlready: 2 }));
    const table = await screen.findByRole("table", { name: "Items by outcome" });
    expect(within(table).getByRole("rowheader", { name: "Still gone from Zotero (marked earlier)" }).closest("tr")!.textContent).toContain("2");
  });

  it("the report table has the three rows, only when not zero", async () => {
    show(report({}, { goneInZotero: 3, goneInZoteroBin: 1, backInZotero: 2 }));
    const table = await screen.findByRole("table", { name: "Items by outcome" });
    const row = (name: string) => within(table).getByRole("rowheader", { name }).closest("tr")!.textContent;
    expect(row("Marked as no longer in Zotero")).toContain("2");
    expect(row("In the Zotero bin")).toContain("1");
    expect(row("Back in Zotero")).toContain("2");
  });

  it("no Zotero rows when they are zero or absent (an older report)", async () => {
    show(report({}, { goneInZotero: 0 }));
    const table = await screen.findByRole("table", { name: "Items by outcome" });
    expect(within(table).queryByText(/Zotero/)).toBeNull();
  });

  it("the table has rows for the collections and tags the import created, only when not zero (FR-170)", async () => {
    show(report({ created: { collectionIds: ["c1", "c2"], tagIds: ["t1"] } }));
    const table = await screen.findByRole("table", { name: "Items by outcome" });
    const row = (name: string) => within(table).getByRole("rowheader", { name }).closest("tr")!.textContent;
    expect(row("Collections created")).toContain("2");
    expect(row("Tags created")).toContain("1");
  });

  it("no such rows when the import created none, or for an older report without them (FR-170)", async () => {
    show(report({ created: { collectionIds: [], tagIds: [] } }));
    const table = await screen.findByRole("table", { name: "Items by outcome" });
    expect(within(table).queryByRole("rowheader", { name: "Collections created" })).toBeNull();
    expect(within(table).queryByRole("rowheader", { name: "Tags created" })).toBeNull();
  });

  it("an availability kept by the undo is said once, with the number", async () => {
    const r = report({}, { goneInZotero: 2 });
    const kept = [
      { kind: "availability", id: "/availability", sourceId: "s1", reason: "its availability was changed after this import, so it was left as it is" },
      { kind: "availability", id: "/availability", sourceId: "s2", reason: "its availability was changed after this import, so it was left as it is" },
    ];
    const api = { report: async () => r, undo: async () => ({ removedSources: 0, revertedMerges: 0, kept }) } as unknown as ImportApi;
    render(<StepReport api={api} projectId="p" batchId="b" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Undo import" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Undo import" }));
    expect(await screen.findByText("2 sources' availability was changed after this import, so it was left as it is.")).toBeTruthy();
    expect(screen.queryByText(/Kept: its availability/)).toBeNull();
  });

  it("the kept availability sentence, singular", async () => {
    const r = report({}, { goneInZotero: 1 });
    const kept = [{ kind: "availability", id: "/availability", sourceId: "s1", reason: "x" }];
    const api = { report: async () => r, undo: async () => ({ removedSources: 0, revertedMerges: 0, kept }) } as unknown as ImportApi;
    render(<StepReport api={api} projectId="p" batchId="b" />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Undo import" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Undo import" }));
    expect(await screen.findByText("1 source's availability was changed after this import, so it was left as it is.")).toBeTruthy();
  });
});

describe("kept edits", () => {
  it("shows the kept line as text, whatever the page label holds", async () => {
    show(report({ keptFields: [{ item: "zotero:AAAA1111", fields: ["highlight on page <b>iv</b> (changed here, kept)"] }] }));
    await screen.findByText(/Import \d+\./);
    expect(screen.getByText(/highlight on page <b>iv<\/b>/)).toBeTruthy();
    expect(document.querySelector("li b")).toBeNull();
  });
});

describe("failures grouped by reason, the notes above them (R393)", () => {
  const EMFILE = "The item could not be imported: the computer would not open more files at once. Close other programs and import again.";
  const TYPE = "The item could not be imported: an unexpected error (TypeError).";
  const STOP = "The import stopped because the computer would not open more files at once; close other programs and resume the batch to continue.";
  const many = (n: number, reason: string, prefix: string) => Array.from({ length: n }, (_, i) => ({ item: `${prefix}:${i}`, reason }));

  it("one entry per reason with its number of items; more than ten items are collapsed, fewer are shown", async () => {
    show(report({ failures: [...many(12, EMFILE, "zotero:A"), ...many(2, TYPE, "zotero:B")], notes: [STOP] }, { failed: 14 }));
    const failures = (await screen.findByText("Failures (14)")).closest("details")!;
    expect(failures.open).toBe(true);
    // The sentence once per reason, not once per item.
    expect(within(failures).getAllByText(EMFILE, { exact: false })).toHaveLength(1);
    const big = within(failures).getByText(`${EMFILE} (12 items)`).closest("details")!;
    expect(big.open).toBe(false);
    expect(within(big).getAllByRole("listitem")).toHaveLength(12);
    // Ten items or fewer: listed under their reason, not collapsed.
    const small = within(failures).getByText(`${TYPE} (2 items)`);
    expect(small.closest("details")).toBe(failures);
    expect(within(failures).getByText("zotero:B:1")).toBeTruthy();
  });

  it("the notes (the batch's stopping sentence) come right under the summary, before the failures", async () => {
    show(report({ failures: many(3, EMFILE, "k"), notes: [STOP] }, { failed: 3 }));
    const note = await screen.findByText(STOP);
    const failures = screen.getByText("Failures (3)").closest("details")!;
    expect(note.compareDocumentPosition(failures) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const table = screen.getByRole("table", { name: "Items by outcome" });
    expect(table.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
