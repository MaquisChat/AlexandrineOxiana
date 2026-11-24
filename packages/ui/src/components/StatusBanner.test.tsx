import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SOURCE_CHANGE_UNFINISHED, SOURCE_CHANGE_UNFINISHED_READ_ONLY } from "@ao/shared";
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
    // R465 b (FR-413): a statement about the opening, which stays true when a folder is added or retried later.
    expect(t).toBe(
      "This computer's list of watched folders could not be read when this library was opened, so its watched folders were not started then. Files put in them are not imported until they run. Open the library again to start them all.",
    );
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

  it("FR-158: a right-to-left project name is isolated on its own; the English sentence keeps its direction", () => {
    const name = "مقابلات هرات";
    render(<StatusBanner variant={{ kind: "warning", warning: "retention-due", project: name }} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toBe(`${name} has reached its retention date. Review which raw data must now be destroyed or kept.`);
    // Only the name is laid out by its own direction: nothing around the sentence takes it from its first letter.
    const isolated = [...banner.querySelectorAll("[dir=auto]")];
    expect(isolated.map((el) => el.textContent)).toEqual([name]);
    // A name named twice in one sentence is isolated each time.
    cleanup();
    render(<StatusBanner variant={{ kind: "warning", warning: "audit-append-failed-at-open", project: name }} />);
    expect([...screen.getByRole("status").querySelectorAll("[dir=auto]")].map((el) => el.textContent)).toEqual([name, name]);
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
      "source-change-unfinished", "source-change-unfinished-read-only", "interrupted-change-closed", "recovery-warnings-set-aside",
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

describe("R484 f: changes to sources that did not finish and could not be undone: one banner per project and kind", () => {
  // FR-736: no "close the library and open it again", which cannot help while a file is in the way (these asserted it).
  const ONE = "A change to a source in Dissertation <i>1</i> did not finish and could not be undone. Choose “Resolve…” to see what can be done.";
  const SEVERAL = (n: number, p: string) => `Changes to ${n} sources in ${p} did not finish and could not be undone. Choose “Resolve…” to see what can be done.`;
  const ONE_RO = "A change to a source in Dissertation <i>1</i> did not finish and could not be undone. It can be put back only when the library is opened for changes.";
  const SEVERAL_RO = (n: number, p: string) => `Changes to ${n} sources in ${p} did not finish and could not be undone. They can be put back only when the library is opened for changes.`;
  const w = (projectId: string, project: string, kind: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ projectId, project, kind, detail: `Sources/folder ${i}: the library's own sentence` }));
  /** What the researcher reads on each banner, rendered (the project's name as text). */
  const shown = (warnings: ReturnType<typeof w>) =>
    bannersFor({ integrityWarnings: warnings }).map((b) => {
      const { container, unmount } = render(<StatusBanner variant={b} />);
      const t = container.textContent ?? "";
      expect(container.querySelector("i")).toBeNull();
      unmount();
      return t;
    });

  it("one source: one banner, a source in the project", () => {
    expect(shown(w("p1", "Dissertation <i>1</i>", "source-change-unfinished", 1))).toEqual([ONE]);
    expect(shown(w("p1", "Dissertation <i>1</i>", "source-change-unfinished-read-only", 1))).toEqual([ONE_RO]);
  });

  it("several sources: one banner with their number", () => {
    expect(shown(w("p1", "Dissertation <i>1</i>", "source-change-unfinished", 3))).toEqual([SEVERAL(3, "Dissertation <i>1</i>")]);
    expect(shown(w("p1", "Dissertation <i>1</i>", "source-change-unfinished-read-only", 2))).toEqual([SEVERAL_RO(2, "Dissertation <i>1</i>")]);
  });

  it("both kinds in one project: one banner for each", () => {
    expect(shown([...w("p1", "Dissertation <i>1</i>", "source-change-unfinished", 2), ...w("p1", "Dissertation <i>1</i>", "source-change-unfinished-read-only", 1)])).toEqual([
      SEVERAL(2, "Dissertation <i>1</i>"),
      ONE_RO,
    ]);
  });

  it("two projects: one banner for each, beside the other warnings in their place", () => {
    const other = { projectId: "p2", project: "Fieldwork", kind: "rolled-back-incomplete-write", detail: "x" };
    expect(
      shown([...w("p1", "Dissertation <i>1</i>", "source-change-unfinished", 1), other, ...w("p2", "Fieldwork", "source-change-unfinished", 4), ...w("p1", "Dissertation <i>1</i>", "source-change-unfinished", 1)]),
    ).toEqual([SEVERAL(2, "Dissertation <i>1</i>"), "An interrupted change in Fieldwork was undone when the library opened, so nothing half-saved was kept.", SEVERAL(4, "Fieldwork")]);
  });

  it("the sentence with \"this source\" stays the library's own, for the source itself", () => {
    expect(SOURCE_CHANGE_UNFINISHED).toBe("A change to this source did not finish and could not be undone. The app's list of interrupted changes says what can be done.");
    expect(SOURCE_CHANGE_UNFINISHED_READ_ONLY).toBe("A change to this source did not finish and could not be undone. It can be put back only when the library is opened for changes.");
  });
});

describe("FR-736: an interrupted change whose undo is not complete says the state it is in", () => {
  const P = "Dissertation <b>2</b>";
  const SAYS = {
    "try-again": `An interrupted change in ${P} could not be undone completely: a step failed. Nothing was lost; the app keeps what it needs to finish. Changes to ${P} are off until it is undone. Choose “Resolve…” to try again.`,
    "in-the-way": `An interrupted change in ${P} could not be undone completely, because a file changed or put there outside the app is in the way. Nothing was lost. Changes to ${P} are off until it is undone. Choose “Resolve…” to see which file to move.`,
    lost: `An interrupted change in ${P} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. That file is lost. Changes to ${P} are off until you close the change. Choose “Resolve…” to see what was lost.`,
    // R527: the copy is gone but something stands at the place: never "that file is lost".
    unconfirmed: `An interrupted change in ${P} cannot be undone completely: the copy the app kept of a file it removed is gone, so the app cannot put that file back. Something is at its place now, which may be that file, but the app cannot confirm it, so it left it as it is. Changes to ${P} are off until you close the change. Choose “Resolve…” to see what is there.`,
    // R528 M4: a file that could not be read is said so, as in the list, never "a step failed".
    "could-not-read": `An interrupted change in ${P} could not be undone completely: the app could not read a file. Nothing was lost; the app keeps what it needs to finish. Changes to ${P} are off until it is undone. Choose “Resolve…” to see which file.`,
    // R528 I1, M2: a copy gone with something else to deal with first; and with a copy kept and nothing left to do.
    "lost-and-blocked": `An interrupted change in ${P} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. Something else also stops the undo, and you can deal with it first: move the file the list names, or try again. After that, you can close the change as it is. Changes to ${P} are off until then. Choose “Resolve…” to see what to do first.`,
    "lost-copy-stuck": `An interrupted change in ${P} cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. The app still keeps a copy of another file of the change, which it cannot put back either, and closing the change would let that copy go, so it cannot be closed. Changes to ${P} are off. Restoring the project from a backup made before the change is the way to undo it.`,
  } as const;
  for (const state of ["try-again", "in-the-way", "lost", "unconfirmed", "could-not-read", "lost-and-blocked", "lost-copy-stuck"] as const) {
    for (const kind of ["rolled-back-incomplete-write", "incomplete-write-pending"]) {
      it(`${kind}, ${state}: its sentence, the name as text, never the detail; "Resolve…" opens the list`, async () => {
        const detail = "transaction 7f3a: Projects/P/sources/x/kept.txt";
        const [b] = bannersFor({ integrityWarnings: [{ projectId: "p1", project: P, kind, detail, state }] });
        const onResolve = vi.fn();
        render(<StatusBanner variant={b!} onResolve={onResolve} />);
        const status = screen.getByRole("status");
        expect(status.querySelector("span")!.textContent).toBe(SAYS[state]);
        expect(status.querySelector("b")).toBeNull();
        expect(status.textContent).not.toContain("kept.txt");
        await userEvent.click(screen.getByRole("button", { name: `Resolve the interrupted change in ${P}…` }));
        expect(onResolve).toHaveBeenCalledTimes(1);
        cleanup();
      });
    }
  }

  it("R529: a change left as it is because its audit log could not be checked: never \"tried again\"; a backup is the way; only \"Resolve…\" to see it", () => {
    const [b] = bannersFor({ integrityWarnings: [{ projectId: "p1", project: P, kind: "txn-recovery-skipped-audit-unverifiable", detail: "x" }] });
    render(<StatusBanner variant={b!} onResolve={() => undefined} onDismissWarning={() => undefined} />);
    const status = screen.getByRole("status");
    expect(status.querySelector("span")!.textContent).toBe(
      `An interrupted change in ${P} was left as it is, because its audit log could not be checked first. The app cannot undo it safely. Restoring a backup made before the change is the way to undo it.`,
    );
    expect(screen.getAllByRole("button").map((x) => x.textContent)).toEqual(["Resolve…"]);
  });

  it("a complete undo keeps its sentence, and offers nothing to resolve", () => {
    const [b] = bannersFor({ integrityWarnings: [{ projectId: "p1", project: "P", kind: "rolled-back-incomplete-write", detail: "x" }] });
    render(<StatusBanner variant={b!} onResolve={() => undefined} />);
    expect(screen.getByRole("status").textContent).toBe("An interrupted change in P was undone when the library opened, so nothing half-saved was kept.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("R509: a change closed as it was says what was lost, and where it is recorded, never the file", () => {
    const [b] = bannersFor({ integrityWarnings: [{ projectId: "p1", project: P, kind: "interrupted-change-closed", detail: "1 file(s) (transaction 7f3a)" }] });
    render(<StatusBanner variant={b!} onResolve={() => undefined} />);
    expect(screen.getByRole("status").querySelector("span")!.textContent).toBe(
      `An interrupted change in ${P} was closed as it was. A file it had removed could not be put back, because the copy the app kept of it was gone: that file is lost. The closing is recorded in the audit log of ${P}.`,
    );
    expect(screen.queryByRole("button", { name: /Resolve/ })).toBeNull();
  });

  it("R527: a change closed as it was, where something stood at the place, never says the file is lost", () => {
    const [b] = bannersFor({ integrityWarnings: [{ projectId: "p1", project: P, kind: "interrupted-change-closed", detail: "x", state: "unconfirmed" }] });
    render(<StatusBanner variant={b!} onResolve={() => undefined} />);
    expect(screen.getByRole("status").querySelector("span")!.textContent).toBe(
      `An interrupted change in ${P} was closed as it was. A file it had removed could not be put back, because the copy the app kept of it was gone; the app could not confirm that what is at its place is that file. The closing is recorded in the audit log of ${P}.`,
    );
    expect(screen.queryByRole("button", { name: /Resolve/ })).toBeNull();
  });

  it("a source whose change did not finish offers the list, where what can be done is said", async () => {
    const [b] = bannersFor({ integrityWarnings: [{ projectId: "p1", project: "P", kind: "source-change-unfinished", detail: "x" }] });
    const onResolve = vi.fn();
    render(<StatusBanner variant={b!} onResolve={onResolve} />);
    await userEvent.click(screen.getByRole("button", { name: "Resolve the interrupted change in P…" }));
    expect(onResolve).toHaveBeenCalledTimes(1);
  });
});

describe("FR-729: a warning kept with the library until dismissed", () => {
  const warning = { projectId: "p1", project: "Dissertation <b>2</b>", kind: "rolled-back-incomplete-write", detail: "x", keptId: "019a7000-0000-7000-8000-0000000000k1" };
  it("offers \"Dismiss\", named for its project, which asks once for its id", async () => {
    const [b] = bannersFor({ integrityWarnings: [warning] });
    const onDismissWarning = vi.fn();
    render(<StatusBanner variant={b!} onDismissWarning={onDismissWarning} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss this warning about Dissertation <b>2</b>" }));
    expect(onDismissWarning).toHaveBeenCalledWith(warning.keptId);
    expect(screen.getByRole("status").querySelector("b")).toBeNull();
  });
  it("offers nothing to dismiss where the screen gives no way to (a read-only library), nor for a warning not kept", () => {
    const [b] = bannersFor({ integrityWarnings: [warning] });
    const { unmount } = render(<StatusBanner variant={b!} />);
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    const [c] = bannersFor({ integrityWarnings: [{ ...warning, keptId: undefined }] });
    render(<StatusBanner variant={c!} onDismissWarning={() => undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
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
