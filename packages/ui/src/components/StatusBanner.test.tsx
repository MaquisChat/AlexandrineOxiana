import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StatusBanner, bannersFor, volumeOf, warningText } from "./StatusBanner";

describe("device-level notices (Task 68)", () => {
  it("the identity notice: what happened, what it changes (not the locks: review round 1, M2), the damaged file kept", () => {
    render(<StatusBanner variant={{ kind: "notice", notice: "device-identity-renewed" }} onDismiss={() => undefined} />);
    const t = screen.getByRole("status").textContent ?? "";
    expect(t).toMatch(/This computer's identity for the app could not be read and had to be renewed/);
    expect(t).toMatch(/Your libraries are not affected/);
    expect(t).toMatch(/recorded under this computer's new identity/);
    expect(t).toMatch(/kept beside the app's settings/);
    expect(t).not.toMatch(/locked/i);
  });

  it("the old-copies notice: what happened, old copies may still be here, the damaged list is kept", () => {
    render(<StatusBanner variant={{ kind: "notice", notice: "old-copies-list-set-aside" }} onDismiss={() => undefined} />);
    const t = screen.getByRole("status").textContent ?? "";
    expect(t).toMatch(/list of old library copies awaiting deletion was damaged and was set aside/);
    expect(t).toMatch(/may still be on this computer/);
    // Not an overstatement when only part of the list was damaged (review round 1, M6).
    expect(t).toMatch(/Some old copies/);
    expect(t).toMatch(/a move that had not finished may not be able to finish from here/);
    expect(t).toMatch(/kept beside the app's settings/);
  });

  it("the watched-folders notice: what happened, what stopped, what to do, the damaged list is kept", () => {
    render(<StatusBanner variant={{ kind: "notice", notice: "watched-folders-list-set-aside" }} onDismiss={() => undefined} />);
    const t = screen.getByRole("status").textContent ?? "";
    expect(t).toMatch(/list of watched folders was damaged and was set aside/);
    expect(t).toMatch(/must be added again/);
    expect(t).toMatch(/kept beside the app's settings/);
  });

  it("“Got it” is a keyboard-operable button that names the notice it dismisses", async () => {
    const onDismiss = vi.fn();
    render(<StatusBanner variant={{ kind: "notice", notice: "old-copies-list-set-aside" }} onDismiss={onDismiss} />);
    const b = screen.getByRole("button", { name: "Got it" });
    b.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(onDismiss).toHaveBeenCalledWith("old-copies-list-set-aside");
  });

  it("bannersFor: one banner per known notice, after the others; none for an unknown kind or none at all", () => {
    expect(bannersFor({ mode: "read-write", notices: [] })).toEqual([]);
    expect(
      bannersFor({
        mode: "read-only",
        readOnlyReason: "newer-format",
        notices: [
          { kind: "old-copies-list-set-aside", at: "2026-11-12T10:15:30.000Z" },
          { kind: "unknown-kind" as never, at: "2026-11-12T10:15:30.000Z" },
        ],
      }),
    ).toEqual([{ kind: "read-only-newer-format" }, { kind: "notice", notice: "old-copies-list-set-aside" }]);
  });
});

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
    ["recovery-code-unshown", /new recovery code for Dissertation was issued, but the app stopped before it could be shown.*New recovery code…/],
    ["anchor-missing", /audit log may have been changed outside the app/],
    ["audit-unrecorded", /A change to Dissertation is not recorded in its audit log yet.*recorded the next time the library is opened with write access.*audit screen/],
    ["audit-unrecorded-blocked", /A change to Dissertation is not recorded in its audit log, and it cannot be while that log does not verify or a problem reported for Dissertation is unresolved.*set it aside/],
    ["attention-unreadable", /An unrecognised item is in the attention folder of Dissertation.*set it aside/],
    ["audit-waiting", /kept on this computer.*another computer had the library open.*next opens the library with write access/],
    ["permissions-not-set", /restored to Dissertation could not be made private to you.*tried again.*set it aside/],
    ["audit-recorded-late", /recorded in the audit log of Dissertation now.*marked as recorded late/],
    ["refusal-unrecorded", /refused request could not be recorded in the library's audit log. Nothing was changed/],
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
      "annotations-hash-mismatch", "destroy-incomplete", "backup-failed", "retention-due", "protocol-manifest-unreadable",
      "recovery-code-unshown", "recovery-staging-discarded", "recovery-staging-unverifiable",
      "audit-unrecorded", "permissions-not-set", "audit-recorded-late", "refusal-unrecorded",
      "audit-unrecorded-blocked", "attention-unreadable", "audit-waiting",
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
