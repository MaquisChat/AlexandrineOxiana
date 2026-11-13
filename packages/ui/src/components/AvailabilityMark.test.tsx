import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AvailabilityMark, availabilityText } from "./AvailabilityMark";
import { SourceTable } from "./SourceTable";

// Task Z5: an item deleted in Zotero, or moved to its bin, is marked on its source with the date it was
// noticed, "12 March 2027" (en-GB, long), in the researcher's own time zone (the expected day comes from the
// machine's zone, as in LibraryParts.test.tsx; mid-month keeps month and year the same everywhere).
const AT = "2027-03-12T12:00:00.000Z";
const DAY = new Date(AT).getDate();

describe("AvailabilityMark: gone from Zotero (Z5)", () => {
  it("says no longer in your Zotero library with a British date", () => {
    render(<AvailabilityMark availability={{ status: "unavailable-on-platform", zotero: "deleted", firstNoticedAt: AT }} />);
    const text = `No longer in your Zotero library, noticed on ${DAY} March 2027`;
    expect(screen.getByRole("note").textContent).toBe(text);
    expect(screen.getByRole("note").getAttribute("aria-label")).toBe(text);
  });

  it("says in your Zotero bin with a British date", () => {
    render(<AvailabilityMark availability={{ status: "unavailable-on-platform", zotero: "bin", firstNoticedAt: AT }} />);
    expect(screen.getByRole("note").textContent).toBe(`In your Zotero bin, noticed on ${DAY} March 2027`);
  });

  it("without a date it says the same, without one; the other statuses keep their words", () => {
    expect(availabilityText({ status: "unavailable-on-platform", zotero: "deleted" })).toBe("No longer in your Zotero library");
    expect(availabilityText({ status: "unavailable-on-platform", zotero: "bin" })).toBe("In your Zotero bin");
    expect(availabilityText({ status: "unavailable-on-platform" })).toBe("No longer available at its source");
    expect(availabilityText({ status: "unavailable-on-platform", firstNoticedAt: "2026-11-15T12:00:00.000Z" })).toBe(
      `No longer available at its source, noticed on Nov ${new Date("2026-11-15T12:00:00.000Z").getDate()}, 2026`,
    );
    expect(availabilityText({ status: "available" })).toBeUndefined();
    expect(availabilityText({ status: "incomplete" })).toBeUndefined();
    // A zotero field with another status says nothing of Zotero (only the status decides whether there is a mark).
    expect(availabilityText({ status: "available", zotero: "deleted" })).toBeUndefined();
  });

  it("the mark reaches the list row through the existing mark", () => {
    const row = { id: "s9", projectId: "p1", type: "book", title: "Gone from Zotero", creatorsText: "", folder: "f", needsReview: false, locked: false };
    render(<SourceTable items={[{ ...row, availability: { status: "unavailable-on-platform", zotero: "bin", firstNoticedAt: AT } }]} total={1} onOpen={vi.fn()} />);
    const table = screen.getByRole("table", { name: "Sources" });
    expect(within(table).getByRole("note").textContent).toBe(`In your Zotero bin, noticed on ${DAY} March 2027`);
  });
});
