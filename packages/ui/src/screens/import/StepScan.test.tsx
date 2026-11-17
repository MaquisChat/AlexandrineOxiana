/** R413 a: the scan step says, as a warning, when the files to be copied do not fit on the library's disk. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ScanSummary } from "../../api/import";
import { SUMMARY } from "../../test/importService";
import { NO_APPROVALS, StepScan } from "./StepScan";

const SENTENCE =
  "This import needs about 2.9 GB free on the library's disk (2.4 GB of files to copy, and room the library keeps free to work), but only 812 MB is free. Free some space, or choose to leave the files where they are, and start again.";

function show(summary: ScanSummary) {
  render(<StepScan summary={summary} sourceName="Papers" approvals={NO_APPROVALS} onApprovals={() => {}} />);
}

describe("StepScan: room on the library's disk (R413 a)", () => {
  it("shows the service's sentence as a warning when the files do not fit", () => {
    show({ ...SUMMARY, copyBytes: 2.4e9, freeBytes: 812e6, spaceWarning: SENTENCE });
    const note = screen.getByText(SENTENCE);
    expect(note.closest('[role="note"]')).toBeTruthy();
    expect(note.closest(".ao-import__warning")).toBeTruthy();
  });

  it("says nothing of room when they fit, or from an older service", () => {
    show({ ...SUMMARY, copyBytes: 2e6, freeBytes: 812e6 });
    expect(screen.queryByText(/needs about/)).toBeNull();
  });
});
