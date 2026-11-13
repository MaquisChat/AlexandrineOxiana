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
    expect(undoQuestion(report({}, { updated: 1 }))).toBe("Remove 0 imported sources and revert 1 updated source?");
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
