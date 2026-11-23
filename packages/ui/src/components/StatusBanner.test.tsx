import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StatusBanner, bannersFor, volumeOf, warningText } from "./StatusBanner";

describe("device-level notices (Task 68)", () => {
  it("the identity notice: what happened, what it changes (not the locks: review round 1, M2), the damaged file kept", () => {
    render(<StatusBanner variant={{ kind: "notice", notice: "device-identity-renewed" }} onDismiss={() => undefined} />);
    const t = screen.getByRole("status").textContent ?? "";
    expect(t).toMatch(/This computer's identity for the app could not be read and had to be renewed/);
    // R181 b: only what is true.
    expect(t).toMatch(/Your libraries and what is in them are unchanged/);
    expect(t).toMatch(/A library that was open when the app last stopped may show as read-only for up to 2 minutes; open it again after that/);
    expect(t).toMatch(/recorded under this computer's new identity/);
    expect(t).toMatch(/kept beside the app's settings/);
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
    // Partial damage is not overstated, and no screen that does not exist is named (R181 d; review Rm3).
    expect(t).toMatch(/some watched folders on this computer may have stopped/);
    expect(t).toMatch(/files put in those folders are not imported/);
    expect(t).not.toMatch(/added again|import settings/);
    expect(t).toMatch(/kept beside the app's settings/);
  });

  it("the Zotero sync settings notice (R242): what happened, that automatic sync is off, that the library is unchanged", () => {
    render(<StatusBanner variant={{ kind: "notice", notice: "zotero-sync-settings-set-aside" }} onDismiss={() => undefined} />);
    expect(screen.getByRole("status").textContent).toContain(
      "This computer's Zotero sync settings could not be read and were set aside. Automatic sync is off until you set it up again. Nothing in your library has changed.",
    );
    expect(bannersFor({ notices: [{ kind: "zotero-sync-settings-set-aside", at: "2026-11-13T10:15:30.000Z" }] })).toEqual([{ kind: "notice", notice: "zotero-sync-settings-set-aside" }]);
  });

  it("the Zotero sync settings from a newer version (R244 M7): says so, says what to do, nothing changed", () => {
    render(<StatusBanner variant={{ kind: "notice", notice: "zotero-sync-settings-newer" }} onDismiss={() => undefined} />);
    const t = screen.getByRole("status").textContent ?? "";
    expect(t).toContain("These sync settings were written by a newer version of the app. Update the app to change them.");
    expect(t).toMatch(/automatic sync with Zotero is off/);
    expect(t).not.toMatch(/set aside|damaged/);
  });

  it("watched folders that could not be read at open: a plain warning for this session (review round 2, Rm4)", () => {
    const t = warningText("watched-folders-unreadable", "library");
    expect(t).toMatch(/list of watched folders could not be read when this library was opened/);
    expect(t).toMatch(/files put in them are not imported/);
    expect(t).toMatch(/Open the library again/);
    expect(t).not.toMatch(/needs attention/);
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
      "source-change-unfinished", "source-change-unfinished-read-only", "changed-outside-before-rollback",
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

describe("R473 I1: a source whose change did not finish and could not be undone", () => {
  it("says the ruled sentence, for a library open for changes and for one opened without them", () => {
    expect(warningText("source-change-unfinished", "P")).toBe("A change to this source did not finish and could not be undone. Close the library and open it again to put it back.");
    expect(warningText("source-change-unfinished-read-only", "P")).toBe(
      "A change to this source did not finish and could not be undone. It can be put back only when the library is opened for changes.",
    );
  });
});

describe("R479 a, R484 b: a file changed outside the app while an unfinished change waited to be undone", () => {
  const SENTENCE =
    "A file in Dissertation <b>2</b> was changed outside the app while a change the app had not finished was waiting to be undone. When the library opened, the app undid its unfinished change, and the outside change to that file was not kept.";
  it("says the ruled sentence on the banner, the project's name shown as text, never the file or the detail", () => {
    const detail = "transaction 7f3a: /Users/rana/Thesis library/Sources/x/source.json";
    const [b] = bannersFor({ integrityWarnings: [{ projectId: "p1", project: "Dissertation <b>2</b>", kind: "changed-outside-before-rollback", detail }] });
    render(<StatusBanner variant={b!} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(SENTENCE);
    expect(status.querySelector("b")).toBeNull();
    expect(status.textContent).not.toContain("7f3a");
  });
});

describe("R409 d: old copies of the library still holding destroyed data", () => {
  const BY_HAND =
    "Old copies of this library, left by a move, still hold data that was destroyed here. Delete the folder named below by hand to complete the destruction; the app will notice when it is gone.";
  const IN_APP = "Old copies of this library, left by a move, still hold data that was destroyed here. Delete them on the Move library screen to complete the destruction.";
  const NO_RECORD =
    "An old copy of this library, left by the move of 2026-11-10, may still hold data that was destroyed here. This computer has no record of where it is: open the library on the computer that moved it.";
  const UNCHECKED =
    "This computer's list of old copies of this library left by a move could not be read, so whether such a copy still holds the destroyed data could not be checked. Any that does was not destroyed.";
  const place = "/Volumes/Field <b>SSD</b>/Old library";
  const banner = (oldCopies: Array<{ movedOn?: string; place?: string; canDelete: boolean }>, unchecked?: true) =>
    bannersFor(
      {
        projectWarnings: { p1: ["destruction-old-copies-pending"] },
        destructionOldCopiesPending: { p1: { message: "ignored: the sentence is chosen from the facts", destructions: [], oldCopies, ...(unchecked ? { unchecked } : {}) } },
      },
      { projectNames: { p1: "Dissertation" } },
    )[0]!;

  it("the app can no longer delete it: by hand, with the folder named below through UserText", () => {
    render(<StatusBanner variant={banner([{ movedOn: "2026-11-10", place, canDelete: false }])} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(BY_HAND);
    const item = screen.getByRole("listitem");
    expect(item.textContent).toBe(place);
    expect(item.querySelector("b")).toBeNull(); // shown as text, never as markup
    expect(item.querySelector("[dir=auto]")).not.toBeNull();
  });

  it("the app can still delete it: on the Move library screen, its place named", () => {
    render(<StatusBanner variant={banner([{ movedOn: "2026-11-10", place, canDelete: true }])} />);
    expect(screen.getByRole("status").textContent).toContain(IN_APP);
    expect(screen.getByRole("listitem").textContent).toBe(place);
  });

  it("this computer has no record of where it is: the date of the move, no place", () => {
    render(<StatusBanner variant={banner([{ movedOn: "2026-11-10", canDelete: false }])} />);
    expect(screen.getByRole("status").textContent).toBe(NO_RECORD);
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("the list could not be checked: round 1's sentence", () => {
    render(<StatusBanner variant={banner([], true)} />);
    expect(screen.getByRole("status").textContent).toBe(UNCHECKED);
  });

  it("R429 f: one copy with no record beside one with a known place: both sentences, the known place listed", () => {
    render(<StatusBanner variant={banner([{ movedOn: "2026-11-10", canDelete: false }, { movedOn: "2026-11-20", place, canDelete: false }])} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(`${NO_RECORD} ${BY_HAND}${place}`);
    expect(screen.getByRole("listitem").textContent).toBe(place);
    expect(screen.getByRole("listitem").querySelector("b")).toBeNull();
    // The known one can still be deleted in the app: that sentence beside the "no record" one.
    cleanup();
    render(<StatusBanner variant={banner([{ movedOn: "2026-11-10", canDelete: false }, { movedOn: "2026-11-20", place, canDelete: true }])} />);
    expect(screen.getByRole("status").textContent).toBe(`${NO_RECORD} ${IN_APP}${place}`);
  });

  it("R429 f: a destruction that could not be checked: the known places stay listed under that sentence", () => {
    render(<StatusBanner variant={banner([{ movedOn: "2026-11-20", place, canDelete: false }], true)} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(`${UNCHECKED} ${BY_HAND}${place}`);
    expect(screen.getByRole("list")).not.toBeNull();
    expect(screen.getByRole("listitem").textContent).toBe(place);
    expect(screen.getByRole("listitem").querySelector("[dir=auto]")).not.toBeNull();
  });

  it("without what stands behind it yet, the warning still has a sentence of its own", () => {
    expect(warningText("destruction-old-copies-pending", "P")).toBe("Old copies of this library, left by a move, still hold data that was destroyed here.");
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
