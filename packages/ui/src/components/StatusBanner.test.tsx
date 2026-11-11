import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StatusBanner, bannersFor, volumeOf, warningText } from "./StatusBanner";

describe("StatusBanner", () => {
  it("read-only, locked by another computer", () => {
    render(<StatusBanner variant={{ kind: "read-only-locked", hostname: "lab-mac" }} />);
    expect(screen.getByRole("status").textContent).toContain("Read-only (locked by lab-mac)");
  });

  it("read-only, locked, holder unknown", () => {
    render(<StatusBanner variant={{ kind: "read-only-locked" }} />);
    expect(screen.getByRole("status").textContent).toContain("Read-only (locked by another device)");
  });

  it("read-only, newer format", () => {
    render(<StatusBanner variant={{ kind: "read-only-newer-format" }} />);
    expect(screen.getByRole("status").textContent).toContain("Read-only — newer format");
  });

  it("offline, reconnecting when the volume returns", () => {
    render(<StatusBanner variant={{ kind: "offline", volume: "Fieldwork SSD" }} />);
    expect(screen.getByRole("status").textContent).toContain("Offline — reconnecting when Fieldwork SSD returns");
  });

  it("index rebuilding N/M", () => {
    render(<StatusBanner variant={{ kind: "index-rebuilding", done: 3, total: 10 }} />);
    expect(screen.getByRole("status").textContent).toContain("Index rebuilding 3/10");
  });

  it.each([
    ["backup-failed", /last automatic backup of Dissertation failed/],
    ["deleted-records-unreadable", /record of deleted items in Dissertation could not be read/],
    ["annotations-unreadable", /annotations in Dissertation could not be read/],
    ["destroy-incomplete", /destruction of raw data in Dissertation did not finish/],
    ["retention-due", /Dissertation has reached its retention date/],
    ["anchor-missing", /audit log may have been changed outside the app/],
  ])("warning %s in plain language", (warning, text) => {
    render(<StatusBanner variant={{ kind: "warning", warning, project: "Dissertation" }} />);
    expect(screen.getByRole("status").textContent).toMatch(text);
    // never the raw code
    expect(screen.getByRole("status").textContent).not.toContain(warning);
  });

  const SECRET_DETAIL = "txn 7f3a in /Users/rana/Library/Thesis library/Projects/p1-secret/journal failed for p1-secret";
  it.each([
    ["rolled-back-incomplete-write", /interrupted change .* was undone/],
    ["head-mismatch", /audit log .* does not match/],
    ["audit-append-failed-at-open", /could not be recorded in the audit log/],
    ["made-up-kind", /Something in Dissertation needs attention/],
  ])("warning %s: a plain sentence, never the detail, ids or paths", (warning, text) => {
    render(<StatusBanner variant={{ kind: "warning", warning, project: "Dissertation", detail: SECRET_DETAIL }} />);
    const t = screen.getByRole("status").textContent ?? "";
    expect(t).toMatch(text);
    expect(t).not.toContain(warning);
    expect(t).not.toContain("p1-secret");
    expect(t).not.toContain("/Users");
    expect(t).not.toContain("7f3a");
  });

  it("every warning kind the service emits has its own sentence", () => {
    const kinds = [
      "chain-broken", "head-mismatch", "truncated", "empty", "anchor-missing", "anchors-unreadable", "rolled-back-incomplete-write",
      "invalid-txn-marker", "incomplete-write-pending", "txn-recovery-skipped-audit-unverifiable", "trimmed-incomplete-audit-line",
      "incomplete-audit-line-pending", "audit-append-failed-at-open", "deleted-records-unreadable", "annotations-unreadable",
      "annotations-hash-mismatch", "destroy-incomplete", "backup-failed", "retention-due",
    ];
    const generic = warningText("made-up-kind", "P");
    const seen = new Set<string>();
    for (const k of kinds) {
      const t = warningText(k, "P");
      expect(t, k).not.toBe(generic);
      seen.add(t);
    }
    expect(seen.size).toBe(kinds.length);
  });
});

describe("bannersFor", () => {
  it("maps library state, warnings and index progress to banners", () => {
    const b = bannersFor(
      {
        mode: "read-only",
        readOnlyReason: "locked-by-other-device",
        integrityWarnings: [{ projectId: "*", project: "library", kind: "anchor-missing", detail: "x" }],
        projectWarnings: { p1: ["backup-failed"] },
      },
      { projectNames: { p1: "Dissertation" }, index: { done: 1, total: 4 }, volume: "Fieldwork SSD" },
    );
    expect(b.map((v) => v.kind)).toEqual(["read-only-locked", "index-rebuilding", "warning", "warning"]);
  });

  it("offline libraries name the volume", () => {
    expect(bannersFor({ mode: "read-only", readOnlyReason: "offline" }, { volume: "Fieldwork SSD" })).toEqual([{ kind: "offline", volume: "Fieldwork SSD" }]);
  });
});

describe("volumeOf", () => {
  it("names the drive a library lives on", () => {
    expect(volumeOf("/Volumes/Fieldwork SSD/Thesis library")).toBe("Fieldwork SSD");
    expect(volumeOf("/media/r/USB STICK/Lib")).toBe("USB STICK");
    expect(volumeOf("E:\\Research\\Lib")).toBe("E:");
    expect(volumeOf("\\\\nas\\share\\Lib")).toBe("\\\\nas\\share");
    expect(volumeOf("/home/r/Lib")).toBe("the drive holding Lib");
  });

  it.each(["incomplete-write-pending", "invalid-txn-marker", "txn-recovery-skipped-audit-unverifiable"])("%s offers Resolve… (R27)", async (warning) => {
    const onResolve = vi.fn();
    render(<StatusBanner variant={{ kind: "warning", warning, project: "Dissertation" }} onResolve={onResolve} />);
    const b = screen.getByRole("button", { name: "Resolve the interrupted change in Dissertation…" });
    b.click();
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  it("other warnings, and banners without a handler, offer no Resolve…", () => {
    render(
      <>
        <StatusBanner variant={{ kind: "warning", warning: "backup-failed", project: "Dissertation" }} onResolve={vi.fn()} />
        <StatusBanner variant={{ kind: "warning", warning: "invalid-txn-marker", project: "Dissertation" }} />
      </>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
