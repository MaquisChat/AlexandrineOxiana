# FR-068 strict (R607): report

The branch is `fr-068-strict` in worktree `.claude/worktrees/kg-3a`, built on 4588572. It has four commits, one per point, and has not been pushed. `git status --short` is empty. No process of mine is left running.

| commit | point |
|---|---|
| 518d256 | (a) The engine refuses. The mark carries the move's id. The crash seam. |
| 99553d7 | (b) A resumed copy walks its destination first. |
| 099945d | (c) The stale folder says what it is. |
| 87c1b26 | (d) The dialog's sentence after such a failure. |

There is no copy-again path. Nothing at a stopped move's folder is ever copied over, removed or overwritten.

## The one judgement

The judgement is `stoppedSwitch(lib, dest, journal)` at `packages/library/src/move.ts:411`. It reads files and writes nothing. It is used in two places:
- **The plan:** `preflight` (`move.ts:388-394`), which serves `planMove`, `acceptMovePlan` and `executeMove`'s own plan.
- **The move:** `finishesSwitch` (`move.ts:592`), which serves `executeMove` and `acceptMovePlan`, also when the move is asked for without a plan.

It returns "resume" only when all of these hold:
- **(i) The library being moved is the journal's old place.** The library's id is the journal's `libraryId`, and `sameFolder(rec.oldRoot, lib.root)` holds.
  - One addition: the library's id may instead be the journal's own `remainingLibraryId`. That id is the id a split writes into its old place's `library.json` when it marks it. No other folder can carry it.
  - The existing test "R33 I6" needs this: the remaining library of a split that crashed after its marks resumes that split's switch.
- **(ii) This computer's record of that move exists.** The record is found by the journal's `pendingId`. Its `libraryId` and `moveId` must equal the journal's, and `sameFolder(rec.newRoot, dest)` must hold.
- **(iii) The old copy's mark of that move is recorded or seen.** Either the journal's `switch.done` includes `mark-old`, or `oldCopyShowsMark(rec, j, "id-only")` (`move.ts:1094`) finds the mark at the old place:
  - whole library: the top `MOVED.json` names the library and carries this move's id;
  - split: a moved project's `MOVED.json` names the library and carries this move's id, or the old folder's `library.json` already carries this move's `remainingLibraryId`.

If the old place cannot be reached, the mark is not seen, so the move is refused.

### What happens in each case

| case | result |
|---|---|
| the mark of this move is recorded in the journal (whole, or split) | resume, nothing copied (test) |
| the mark of this move is seen, not recorded: the journal write failed after `mark-old`, or a split stopped after its first mark | resume, nothing copied (test) |
| the remaining library of this split (its marks made) is moved into the folder | resume (existing test R33 I6) |
| the FR-068 sequence: failed before the mark; the old library changed; the move asked again | **refuse** (engine and service tests) |
| C-1: A→B fails; A→C succeeds; a change at C; a move from C to B | **refuse**: (i) fails (engine and service tests) |
| a mark at the old place naming another library | **refuse** (test) |
| a stale mark from an earlier move (A→B, B→A, then A→C failing): the earlier move's mark copied back into A, with an id, with the other move's id, or with no id | **refuse** (test) |
| a split whose library holds a project marked by an EARLIER split; the later split fails before its marks | **refuse** (test) |
| the old place cannot be reached | **refuse** (test) |
| a hand-made copy of the library (same id) moved to the folder | **refuse**: (i) fails (test) |
| the process killed after the switching journal, before the mark (the seam) | **refuse** (test) |
| a mark without an id (older build), not recorded in the journal | **refuse** for the move. The finishing at an opening still finishes it (test). |
| no record on this computer (moved from another computer, or record lost) | **refuse**: (ii) fails |

In every refused case:
- The code is `destination-not-empty`, as for today's "not empty" refusal; the service answers 403 `POLICY_DENIED`.
- The reason is "That folder holds the copy of an earlier move that did not finish. Choose another, empty folder, or delete that folder first."
- The plan, the early plan and the move all refuse. Before and after the refusals, every test compares the app's settings folder (this computer's records, registry and anchors) and both places byte for byte, and they are unchanged.

In the resume case the plan alone (`planMove`) still answers today's "not empty", because the move finishes the switch before its plan. That keeps the existing test at `move.test.ts:705` unchanged. The new words are deliberately not used there: in that case the folder is the library's real new place, and "delete that folder" would be wrong.

### The finishing at an opening (`finishMoveAt`)
- **Today:** it finished a switch once the journal recorded `mark-old`, or the old copy showed any mark naming the library.
- **Now** (`move.ts:943`): it uses the same `oldCopyShowsMark`, in its "id-or-none" setting:
  - a mark carrying ANOTHER move's id no longer counts;
  - a mark without an id still counts as today.
- **Why this cannot strand an older build's move:** only this build writes ids, so a move an older build left half-switched has a mark without an id, and it still counts.
- **What it closes:** the review's P1b (the C-1 sequence, then an opening of B). Today the opening went on and threw a "files differ" refusal, which also accused the folder. Now it does nothing (test, which failed first).
- **Unchanged:** the R590 N3 check ("a recorded mark is still there") and the split source-changed check still use `markNames`.
- `oldCopyMarkedFor`, the service's check after a failure, uses "id-or-none" too.

## The mark's new field, and how builds read each other's marks

`mark-old` now writes `moveId` (`move.ts:1201`). The whole library's top `MOVED.json` and each moved project's `MOVED.json` look like this:

```
{ libraryId, movedAt, toHint, moveId }
```

**Older builds reading the new mark** (read in the code at 4588572; these readers are unchanged here):
- `library.ts` looks only at whether the top `MOVED.json` exists.
- `projectMovedAway` needs `libraryId` and a parsable `movedAt`, and ignores other fields.
- `reconnect.ts` reads `toHint`.
- `unfinishedSplitFrom` and `markNames` read `libraryId`.
- The service's `state.ts` checks whether the file exists.
- `deleteOldCopy` ignores the file by its name.

None of them requires the absence of a field, so an older build reads the new mark as before.

**This build reading an older mark:** every reader keeps working. The new rule is an id-less mark counts for a move only where its journal records the mark, and for the finishing at an opening as before.

The existing test "copies, verifies and switches…" asserted the mark's exact three fields. It now also expects `moveId`, equal to the move's audit event's `moveId`. That is the only existing test that changed.

## What I took from the rejected branch (`fr-068-move-rerun`)
- **The crash seam** `moveSeams.crashAfter = "switching-journal"` (`move.ts:240`, `:849`). It is inert in the app:
  - `moveSeams` is not exported from `@ao/library`'s index; tests reach it by a deep import of `move.ts`;
  - it is unset by default;
  - it clears itself once it has fired.
- **The test shapes:** a planted folder where the mark goes, then removed; the (6) "resumed without copying" cases, which I kept as guards; the (7) stale-place tests, adapted.
- **The stale-folder work from 838852f:** `Library.staleMoveOf`, passing it through the service and the page, the anchor comparison left out for such a place (`repo.ts:632-633`, `:710`, `:733`; `library-audit.ts` `compareAnchors`), and the banner plumbing.
  - `staleMoveCopyAt` (`old-copies.ts:297`) was rewritten stricter. It now needs the old place's `library.json` to carry the same id, and NO mark of any move at the old place: no top mark and no moved project's mark, whatever its id. A mark is anything there except a folder of that name.
  - So after C-1 (A marked by the move to C), B is not called "the copy whose library is still at A".
- **Not taken:** the copy-again, the removals, `replaces`, the record removal, and the copy-again wording.

## Per point: the tests that failed first, and the mend

### (a)
Engine, `move.test.ts:1825`. Nine tests failed before the change; the four "unchanged" guards passed before and after:
- the FR-068 sequence;
- C-1, including the P1b opening (before the change it threw `files-differ`);
- a mark naming another library;
- back and forth with stale marks;
- a split beside an earlier split's mark;
- the old place out of reach;
- a hand-made copy;
- the crash (before the change, the move resolved: it had resumed);
- an older build's mark.

Service, `move-finish.test.ts:584`: the FR-068 sequence and C-1, each through the plan route and then the move route without it. I checked out the old `move.ts`, ran these, saw both fail, and restored the file.

The mend is in `move.ts`: `stoppedSwitch`, `finishesSwitch`, `preflight`, `oldCopyShowsMark`/`markOfMove`, the mark's `moveId`, the seam, and the one line in `finishMoveAt`.

### (b)
Test: `move.test.ts:2021`, the review's P2 with a copying-phase journal. Before the change, the file outside read "owner only" instead of "PRECIOUS OUTSIDE FILE".

Mend (`move.ts:686-689`): once the plan returns a copying journal, and before any write (the journal's flush, the leftovers' removal, mkdir, copy), the destination is walked. Any link or special file throws `MoveVerificationError` with the verification's own words, naming the path. Those words are now one constant, `VERIFICATION_FAILED`.

`abortOnOdd`'s words ("The library contains symbolic links…") speak of the source, so I did not use them.

### (c)
Tests:
- **Engine** (`move.test.ts:2051`): the stale place opens read-only, with `staleMoveOf` = the old place, no warnings and nothing written. This failed first: before the change it had anchor warnings.
- **Engine guards:** the old place out of reach gives today's words and warnings; the old place marked by a later move gives no `staleMoveOf`; once the move's own mark is made, a log emptied by hand still gives "empty".
- **Service** (`move-finish.test.ts:637`): the open route returns `staleMoveOf`, with no warnings and nothing written. It failed first.
- **Service, existing tests:** the R590 N2 cases now also assert there is no `staleMoveOf`, and their "empty"/"truncated" warnings are exactly as before. This is the "prove one".
- **Page** (`StatusBanner.test.tsx:566`): failed first.

Mend:
- `staleMoveCopyAt` (`old-copies.ts:297`), used at the opening (`library.ts:295`);
- `repo.ts` and `library-audit.ts` (no anchors, no device check; chains still checked);
- `state.ts` and `routes/libraries.ts` pass `staleMoveOf`;
- on the page, `api/library.ts` and `StatusBanner.tsx:251`.

### (d)
Tests:
- **Service** (`move-finish.test.ts:656`):
  - a whole library, and a split, that fail before any mark get the new answer, which is kept in move/status (failed first: the sentence did not exist);
  - the library is still open read-write at its old place;
  - "every other failure keeps its words": a folder that is not empty, and a failure after the mark.
- **Page** (`MoveLibrary.test.tsx:145`): the sentence, the path in UserText, one alert only, no generic ending. It failed first.

Mend:
- In the route's "Not moved" branch (`routes/libraries.ts:386`), when `staleMoveCopyAt(dest, lib.id)` returns a place, the answer is `409 CONFLICT` with reason `move-stopped-before-switch` and the sentence without a path (it is recorded).
- `packages/shared/src/api/library-move.ts` holds `MOVE_STOPPED_BEFORE_SWITCH_REASON`, `moveStoppedBeforeSwitchParts` and `moveStoppedBeforeSwitchText`.
- `MoveLibrary.tsx` shows the parts with the folder through `UserText`, and appends nothing.
- `staleMoveCopyAt` is exported from `@ao/library`.

## Every sentence shown, word for word
- **NEW (a)**, the refusal's reason (`move.ts:399`; the service's answer: message "The library cannot be moved there.", reason as follows): "That folder holds the copy of an earlier move that did not finish. Choose another, empty folder, or delete that folder first."
- **(b)**: no new words. `MoveVerificationError` "Verification failed; nothing was switched or deleted: Exports". The service maps it as before to "The copied library did not verify; the old copy is kept and nothing was switched."
- **NEW (c)**, banner, the whole sentence inside UserText as the other "moved" banners are: "Read-only — this folder holds the copy of a move that did not finish. The library is still at {oldRoot}, and nothing here is the library. This folder can be deleted."
- **(c)**: unchanged elsewhere: "Read-only — a move into this folder has not finished. Changes are off."
- **NEW (d)**:
  - the dialog: "The move stopped before the library was switched. Nothing of the library was deleted, and it stays where it was. The copy made at {newRoot} is not used and can be deleted. To move the library, choose another, empty folder."
  - the service's own answer (no path): "The move stopped before the library was switched. Nothing of the library was deleted, and it stays where it was. The copy made at the new place is not used and can be deleted. To move the library, choose another, empty folder."
- No other sentence changed.

## Runs
Each file was run alone, at `nice -n 10`, with `NODE_OPTIONS=--use-openssl-ca`, on the final tree unless noted.

| package | file | scenarios | result |
|---|---|---|---|
| `@ao/library` | `move.test.ts` | 143: 13 (a), 1 (b), 4 (c) new | 143 passed |
| | `device-and-old-copies` | | 18 passed |
| | `retention-old-copies` | | 40 passed |
| | `reconnect` | | 55 passed |
| | `library` | | 35 passed |
| | `library-place` | | 19 passed |
| `@ao/library-service` | `move-finish.test.ts` | 43: 2 (a), 1 (c), 3 (d) new | 43 passed |
| | `library-place-routes` | | 8 passed |
| | `open-library` | | 26 passed |
| `@ao/ui` | `StatusBanner` | 82 (1 new) | 82 passed |
| | `MoveLibrary` | 30 (1 new) | 30 passed |

The library's other files were run after (c); the library did not change in (d) apart from the index export.

Also run:
- typecheck of `@ao/shared`, `@ao/library`, `@ao/library-service`, `@ao/ui`, `@ao/cli`: clean;
- `lint:css` and `lint:colours`: clean;
- `@ao/ui` built; e2e `maintenance.spec.ts` in Chromium: 3 passed.

## Uncertain, and for the coordinator
1. **The refusal's "or delete that folder first".** R607 rules these words for EVERY refused case. In a few of those cases the folder is the real, unfinished new place of a move whose mark IS made:
   - the move is asked by another library;
   - the move is asked from another computer;
   - this computer's record is lost.

   There, "delete that folder" would be wrong. The old copy keeps everything, marked, so nothing is lost, but the move is stranded. I built the ruling as written.

   Recommendation: keep the new words where the folder's own move is unmarked (`staleMoveCopyAt` true, or the old place unmarked), and today's "The destination folder is not empty; choose an empty folder" otherwise. This needs a ruling.
2. **The page shows only the message.** For a refusal at "Check destination", the dialog shows the service's message "The library cannot be moved there." and not the `reason`. So the new refusal words, like today's "not empty" reason, reach the researcher only through the move route's recorded failure and the API, not on the page. This is older than this work, and I did not change it (not asked).
3. **The remaining-library clause in (i).** I extended "library id" to include the move's own `remainingLibraryId`, so that the existing R33 I6 behaviour holds. Without it, that test is refused with the new words, which would tell the researcher to delete the library's new place. The reviewer should judge this.
4. **(d)'s sentence replaces EVERY failure in that state**, including a full disk at the old place ("The disk is full…"). The brief says "IN PLACE of the generic message". I read the review's H as covering every failure that reaches this state.
5. **A user's newer-build move that failed before the mark**, followed by an older build: the older build still resumes as before. That is FR-068 in the older build, unchanged.

None of the brief's stop conditions arose:
- an older build reads the new mark;
- (iii) relies only on the journal's `done` (written atomically) and on marks carrying this move's id;
- the route tells (d)'s state by `staleMoveCopyAt`.

# Mend round (R612)

Branch `fr-068-strict` in `kg-3a`, five commits on 87c1b26, one per mend, not pushed. `git status --short` is empty. No process of mine is left running (other agents' test runs were seen on the machine; none was mine).

| commit | mend |
|---|---|
| 8cea032 | I-A: which sentence a refusal gets |
| 7cf2f4a | R610 (2): the dialog shows the refusal's reason |
| 9ee588b | m-A: the sentence after the failure names the cause at the old place |
| 715d515 | m-B: no anchor-comparison warning at any unmarked switching copy |
| 4b1496c | m-C: `completeMove` no longer exported |

## I-A: the refused cases and their sentences

The one judgement `stoppedSwitch` (`packages/library/src/move.ts:417`) now returns "resume", "stale" or "unfinished". It reads the old place ONCE (`oldPlaceShows`, `move.ts:443`) and both resumes and chooses the words from that one reading; `preflight` (`move.ts:388-392`) throws S1 for "stale", S2 for "unfinished". The resume rule is unchanged (the 4 "unchanged" guards and every resume test pass).
- "stale" (S1) only where this computer's record of that move exists and its old place is seen to be the living, unmarked library of the move's id (`living`), or shows a mark naming another library or carrying another move's id (`another`).
- "unfinished" (S2) otherwise: the mark recorded in the journal; a mark of this move seen; a mark without an id; a mark that cannot be read; the old place out of reach, or holding another/no library; the record missing (or not that move's).
- Precedence when several marks are seen (a split): this move's > no id > unreadable > another.

Sentences (`packages/shared/src/api/library-move.ts`, `MOVE_FOLDER_STALE_COPY_TEXT`, `MOVE_FOLDER_UNFINISHED_TEXT`):
- S1: "That folder holds the copy of an earlier move that did not finish. Choose another, empty folder, or delete that folder first."
- S2: "That folder holds a library whose move there has not finished. Choose another, empty folder. To finish that move, open the library at that folder."

| refused case | sentence | test (engine `move.test.ts`, describe "FR-068 (R607 a)…", unless named) |
|---|---|---|
| FR-068 sequence (old place living, unmarked) | S1 | "the FR-068 sequence: …"; service "the FR-068 sequence: …" |
| C-1 (A→B failed before the mark, A→C succeeded; plan to B from C) | S1 | "C-1: …"; service "C-1 (the review's sequence): …" |
| a mark naming another library | S1 | "a mark naming another library at the old place does not count: refused" |
| back and forth: a stale mark with another move's id (two marks) | S1 | "back and forth …" (first two marks) |
| back and forth: a mark without an id | S2 | "back and forth …" (third mark) |
| split beside an earlier split's mark | S1 | "a split whose library holds a project marked by an EARLIER split: …" |
| hand copy, old place unmarked | S1 | "a copy of the library made by hand …" |
| crash seam | S1 | "the process killed between the switching journal and the mark; …" |
| an older build's mark (no id), not recorded | S2 | "a mark written by an older build (no move id) …" |
| this move's mark SEEN, asked by a hand copy (G2b) | S2 | "R612 I-A: this move's mark seen at the old place, the move asked by a copy of the library made by hand: …" (new) |
| this move's mark RECORDED, asked by a hand copy | S2 | "R612 I-A: this move's mark recorded in the journal, …" (new) |
| the old place out of reach | S2 | "the old place cannot be reached: …" |
| this computer's record missing | S2 | "R612 I-A: this computer's record of the move is missing: …" (new); service "R612 I-A: this computer's record of that move missing: …" (new) |

Failed first: 6 engine tests (the three new; back and forth, out of reach, older build) failed with S1 received where S2 was expected. Existing tests changed: those three now expect S2 (they had asserted the delete-words). The service's new test was written after the engine change (it checks the same judgement through the routes).

## R610 (2): what the dialog shows for each refusal, word for word

`packages/ui/src/screens/MoveLibrary.tsx`: a refusal (`POLICY_DENIED` with a reason) shows the message and, after one space, the reason in `UserText`, in the dialog's one existing alert. At "Check destination" (`check`), and when the move is refused at its own plan (`failedWith`), then without the old ending "The move stopped; nothing was deleted, and the library stays where it was." (it spoke of a move that never began). Other failures keep that ending.
- S1: "The library cannot be moved there. That folder holds the copy of an earlier move that did not finish. Choose another, empty folder, or delete that folder first."
- S2: "The library cannot be moved there. That folder holds a library whose move there has not finished. Choose another, empty folder. To finish that move, open the library at that folder."
- ordinary: "The library cannot be moved there. The destination folder is not empty; choose an empty folder"
  (the engine's reason has no final full stop; it was so before and I did not change it.)
- Any other refusal reason (overlap, a project's rules…) is shown the same way.

Tests (`MoveLibrary.test.tsx`, describe "R610 (2), R612: …"): the three at Check destination (failed first: only the message), and the move's own refusal with S2 (failed first: the old ending).

## m-A: the sentence and its causes

Route (`apps/library-service/src/routes/libraries.ts`, the "Not moved" branch; `oldFolderNotWritable` at `:85`): when the folder is the stale copy (`staleMoveCopyAt`) and the error's code (or one it wraps) is:
- ENOSPC, EDQUOT → "the disk is full"
- EACCES, EPERM → "permission was refused"
- EROFS → "the disk can only be read"

the answer is 409 CONFLICT, reason `move-stopped-before-switch-<cause>` (`disk-full`, `permission`, `read-only-disk`), sentence (shared `moveStoppedBeforeSwitchParts(newRoot, cause)`):

"The move stopped before the library was switched, because the library's old folder could not be written to ({cause}). Nothing of the library was deleted, and it stays where it was. The copy made at {newRoot} is not used and can be deleted. Free space or restore access at the library's folder before moving the library again."

The service's own answer says "the new place" for {newRoot}; the dialog names the folder through UserText. The one tightening: "there" became "at the library's folder", since after "The copy made at {newRoot}" the word "there" read as the copy's place. Any other cause keeps the general sentence (the existing test "every other failure keeps its words" and the (d) tests still pass).

Why the code is the old place's: in that state (switching journal, no mark recorded, the old place unmarked) the only step that ran after the switching journal is the mark's write into the old folder (and, when the source is not open, its lock there). The record and known-path writes come before the switching journal; the split's registration comes after its marks. I did not tag the error in the engine.

A test seam `moveSeams.fail = { at: "mark-old", code }` (`move.ts`, in `markOld`, before any write) makes the mark's write fail. Tests: service `move-finish.test.ts` "R612 m-A: the mark could not be written to the old folder (ENOSPC|EACCES): …" (failed first: the move finished); page "R612 m-A: … (disk-full|permission|read-only-disk) …" (failed first).

## m-B: the rule and the banner

- `unmarkedMoveCopyAt` (`packages/library/src/old-copies.ts:332`): a switching journal at the folder, without "mark-old" done; this computer's record of that move (same library, same move id, naming this folder); and the old place out of reach, or showing no mark of that move (whole: the top's MOVED.json; split: a moved project's; naming the library with that move's id or with none, as the finishing at an opening counts it; for a split, nor its library.json rewritten as the remaining library).
- The opening (`packages/library/src/library.ts:302-307`) sets `anchorsNotCompared` when `staleMoveOf` is set or that holds; `openRepoInternal` (`packages/library/src/repo/repo.ts:633`) then compares no anchor (chains still checked).
- The banner is unchanged and follows `staleMoveOf` alone:
  - old place seen as the living, unmarked library: "Read-only — this folder holds the copy of a move that did not finish. The library is still at {oldRoot}, and nothing here is the library. This folder can be deleted."
  - old place moved on, deleted or out of reach: "Read-only — a move into this folder has not finished. Changes are off." (true in each).
- Tests: engine (describe "FR-068 (R607 c)…"): the old place out of reach (G6b), deleted, marked by a later move (G6): no warnings (the three failed first with "truncated"/anchor warnings); "this move's mark seen at the old place (not recorded): … a log emptied by hand gives its warning" and the existing "once the old copy is marked by the move …" still give "empty". Service: "G6: …" and "G6b: …" (both failed with `repo.ts` put back, then restored).
- Changed existing test: "the old place out of reach: not said to be the library; today's words and checks stay" asserted the warnings (the gap); it now asserts none.

## m-C

`completeMove` removed from `packages/library/src/index.ts` (a comment says why). No caller outside the package; the tests already imported it from `./move.js`. Test: `seams-inert.test.ts` "FR-068 (R612 m-C): completeMove … is not exported from the package's entry" (failed with the old index). `pnpm -r typecheck`: all nine packages Done.

## New or changed sentences, word for word
- S2 (new): "That folder holds a library whose move there has not finished. Choose another, empty folder. To finish that move, open the library at that folder."
- S1 (now only in its cases): "That folder holds the copy of an earlier move that did not finish. Choose another, empty folder, or delete that folder first."
- Dialog: "The library cannot be moved there. {reason}" (reason in UserText), without "The move stopped; …" for a refusal.
- m-A, with {cause} one of "the disk is full", "permission was refused", "the disk can only be read": "The move stopped before the library was switched, because the library's old folder could not be written to ({cause}). Nothing of the library was deleted, and it stays where it was. The copy made at {newRoot} is not used and can be deleted. Free space or restore access at the library's folder before moving the library again."

## Runs (each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`, on the final tree)

| package | file | result |
|---|---|---|
| `@ao/library` | `move.test.ts` | 148 passed (3 new I-A, 2 new m-B cases plus 1 changed) |
| | `device-and-old-copies.test.ts` | 18 passed |
| | `retention-old-copies.test.ts` | 40 passed |
| | `reconnect.test.ts` (the only reconnect file) | 55 passed |
| | `library.test.ts` | 35 passed |
| | `library-place.test.ts` | 19 passed |
| | `seams-inert.test.ts` | 10 passed (1 new) |
| `@ao/library-service` | `move-finish.test.ts` | 48 passed (1 I-A, 2 m-A, 2 m-B new) |
| | `library-place-routes.test.ts` | 8 passed |
| | `open-library.test.ts` | 26 passed |
| `@ao/ui` | `StatusBanner.test.tsx` | 82 passed |
| | `MoveLibrary.test.tsx` | 37 passed (4 R610 (2), 3 m-A new) |

Also: `pnpm -r typecheck` clean; `lint:css` and `lint:colours` clean; `@ao/ui` built; e2e `maintenance.spec.ts` (Chromium, app only): 3 passed.

## Uncertain
1. **EROFS's words.** The house groups EROFS with the permission faults ("cannot be written to"). I gave it its own words, "the disk can only be read", since "permission was refused" is not what a read-only disk says. Three reasons rather than two.
2. **m-A tells the cause by the state, not by the engine.** The argument is above (only the mark's write runs in that window). If a later change writes elsewhere between the switching journal and the mark, the route would need the engine to tag the error.
3. **G6b's other note.** Opening the stopped folder with the old place out of reach still gives the finishing's own session note "move-not-finished-old-copy-unreachable" ("…could not be finished now because its old copy at {place} cannot be reached. Connect the drive…"). It is not an anchor warning, so m-B leaves it; "could not be finished now" is true, but once the drive is back the folder would be judged stale and still not finished. Not changed (not asked).
4. **"another or no library" at the old place, no mark** gets S2 (the ruling's "every other case"). Such a folder is probably stale too, but it is not proved.
5. **The ordinary "not empty" reason** has no final full stop, so the dialog's line ends without one. Older than this work.
