/**
 * R528 I1, M2, M4: which banner an incomplete undo gets, over every combination of its causes. The banner speaks of the
 * WORST thing true of the change: a file that cannot be put back (lost, or not confirmed) before a file in the way,
 * before a file the app could not read, before a step that failed; "Nothing was lost" only where no copy is gone. A loss
 * with something the researcher can still deal with leads with that, then the close; a loss with a copy the app still
 * keeps and cannot put back (nothing left to do) says a backup is the way, never an act that is not offered.
 */
import { describe, expect, it } from "vitest";
import { INCOMPLETE_ROLLBACK_BANNER, ROLLBACK_INCOMPLETE_ANSWER, ROLLBACK_LIST_NEXT, incompleteRollbackOf, type IncompleteRollback } from "./interrupted-changes.js";

type Flags = { lost: boolean; unconfirmed: boolean; hand: boolean; occupied: boolean; unread: boolean; failed: boolean; copyKept: boolean };

/** The state each combination must have, by the ruled order. */
function expected(f: Flags): IncompleteRollback {
  const gone = f.lost || f.unconfirmed;
  if (gone) {
    if (f.hand || f.occupied || f.unread || f.failed) return "lost-and-blocked";
    if (f.copyKept) return "lost-copy-stuck";
    return f.lost ? "lost" : "unconfirmed";
  }
  if (f.hand || f.occupied) return "in-the-way";
  if (f.unread) return "could-not-read";
  return "try-again";
}

function causesOf(f: Flags): Array<{ kind: string; path: string; somethingThere?: true }> {
  return [
    ...(f.lost ? [{ kind: "kept-copy-gone", path: "a.txt" }] : []),
    ...(f.unconfirmed ? [{ kind: "kept-copy-gone", path: "u.txt", somethingThere: true as const }] : []),
    ...(f.hand ? [{ kind: "hand-changed-file", path: "b.txt" }] : []),
    ...(f.occupied ? [{ kind: "path-occupied", path: "c.txt" }] : []),
    ...(f.unread ? [{ kind: "could-not-look", path: "d.txt" }] : []),
  ];
}

const NAMES = ["lost", "unconfirmed", "hand", "occupied", "unread", "failed", "copyKept"] as const;
const ALL: Flags[] = Array.from({ length: 2 ** NAMES.length }, (_, n) => Object.fromEntries(NAMES.map((k, i) => [k, (n >> i) % 2 === 1])) as Flags);

describe("R528: every combination of causes gives the banner of the worst thing true", () => {
  for (const f of ALL) {
    const label = NAMES.filter((k) => f[k]).join(" + ") || "no cause";
    it(`${label} → ${expected(f)}`, () => {
      expect(incompleteRollbackOf(causesOf(f), f.failed, f.copyKept)).toBe(expected(f));
    });
  }

  it("\"Nothing was lost\" is said only in a state with no copy gone", () => {
    for (const f of ALL) {
      const s = incompleteRollbackOf(causesOf(f), f.failed, f.copyKept);
      const said = INCOMPLETE_ROLLBACK_BANNER[s]("P");
      if (f.lost || f.unconfirmed) expect(said, NAMES.filter((k) => f[k]).join("+")).not.toMatch(/Nothing was lost/u);
    }
  });

  it("a cause of a kind this build does not know is never taken for one that can be closed", () => {
    const gone = [{ kind: "kept-copy-gone", path: "a" }, { kind: "a-later-kind", path: "b" }];
    const later = [{ kind: "a-later-kind", path: "b" }];
    expect(incompleteRollbackOf(gone, false)).toBe("lost-and-blocked");
    expect(incompleteRollbackOf(later, false)).toBe("try-again");
  });
});

describe("R528: the words of each state, word for word", () => {
  it("the banners", () => {
    expect(Object.fromEntries(Object.entries(INCOMPLETE_ROLLBACK_BANNER).map(([k, f]) => [k, f("P")]))).toEqual({
      "try-again":
        "An interrupted change in P could not be undone completely: a step failed. Nothing was lost; the app keeps what it needs to finish. Changes to P are off until it is undone. Choose “Resolve…” to try again.",
      "could-not-read":
        "An interrupted change in P could not be undone completely: the app could not read a file. Nothing was lost; the app keeps what it needs to finish. Changes to P are off until it is undone. Choose “Resolve…” to see which file.",
      "in-the-way":
        "An interrupted change in P could not be undone completely, because a file changed or put there outside the app is in the way. Nothing was lost. Changes to P are off until it is undone. Choose “Resolve…” to see which file to move.",
      lost: "An interrupted change in P cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. That file is lost. Changes to P are off until you close the change. Choose “Resolve…” to see what was lost.",
      unconfirmed:
        "An interrupted change in P cannot be undone completely: the copy the app kept of a file it removed is gone, so the app cannot put that file back. Something is at its place now, which may be that file, but the app cannot confirm it, so it left it as it is. Changes to P are off until you close the change. Choose “Resolve…” to see what is there.",
      "lost-and-blocked":
        "An interrupted change in P cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. Something else also stops the undo, and you can deal with it first: move the file the list names, or try again. After that, the list says whether the change can be closed as it is. Changes to P are off until then. Choose “Resolve…” to see what to do first.",
      "lost-copy-stuck":
        "An interrupted change in P cannot be undone completely: a file it removed cannot be put back, because the copy the app kept of it is gone. The app still keeps a copy of another file of the change, which it cannot put back either, and closing the change would let that copy go, so it cannot be closed. Changes to P are off. Restoring the project from a backup made before the change is the way to undo it.",
    });
  });

  it("the answers to \"Roll it back\"", () => {
    expect(ROLLBACK_INCOMPLETE_ANSWER).toEqual({
      "try-again": "The change could not be undone completely: a step failed. The choice is recorded; try again, or reopen the library.",
      "could-not-read": "The change could not be undone completely: the app could not read a file. The list shows which file; make sure it can be read, then choose “Roll it back” again.",
      "in-the-way": "The change could not be undone completely: a file changed or put there outside the app is in the way. The list shows which file; move it, then choose “Roll it back” again.",
      lost: "The change cannot be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back. You can now close the change as it is from the list.",
      unconfirmed: "The change cannot be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back. You can now close the change as it is from the list.",
      "lost-and-blocked":
        "The change could not be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back, and something else also stops the undo. The list shows what; deal with it first (move the file it names, or try again), then choose “Roll it back” again. After that, the list says whether the change can be closed as it is.",
      "lost-copy-stuck":
        "The change cannot be undone completely: the copy the app kept of a file it removed is gone, so that file cannot be put back, and the app keeps a copy of another file of the change, which it cannot put back either. Restoring the project from a backup made before the change is the way to undo it.",
    });
  });

  it("R530: the list's next step (never a promise of the close after that, which one rare combination does not keep)", () => {
    expect(ROLLBACK_LIST_NEXT).toEqual({
      "lost-and-blocked": "Deal with what is named above first, then choose “Roll it back” again. After that, this list says whether the change can be closed as it is.",
      "lost-copy-stuck":
        "The app still keeps a copy of another file of this change, which it cannot put back either, and closing would let that copy go, so this change cannot be closed. The way forward is to restore the project from a backup made before this change.",
    });
  });
});
