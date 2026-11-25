# FR-755 (R573, R578, R581): adversarial review

Worktree `.claude/worktrees/kg-3a`, branch `fr-755-move-failure` at 9b1a1fa (three commits on 7d8d861). I changed no product code. Three probe files were written and deleted, three scratch edits were made and restored, and `git status --short` is empty.

**Verdict: NOT APPROVED.** The whole-library cases are sound and well tested. One Important finding holds the join: split moves (a move that leaves some projects behind) still get the old behaviour. After a late failure, a split move's old library carries on, takes changes into folders already marked as moved, and then either stays read-only for good or is "finished" over those changes with "nothing was lost".

## What I ran
- The builder's tests, unchanged: `move-finish.test.ts` 15 passed; `MoveLibrary.test.tsx` 28 passed; the `FR-755` block of `move.test.ts` 11 passed.
- Service probes (`*.probeFR755.test.ts`, deleted). They covered:
  - split moves failing at three points;
  - two openings at once, and an open while the reopening at start is finishing;
  - a destination reached through a symbolic link;
  - a file deleted by hand at the new place before the opening;
  - Quit during the finishing, after "register" and after "audit-move";
  - a failure at "unlink" or "mark-complete", followed by opening the old place;
  - deleting the old copy before the new place is opened.
- Three planted faults, each restored at once (point 8).

## Findings

### Critical
None.

### Important

**I1. Split moves: the failure path and the finishing both miss them. A change is accepted into the marked old copy, and then either stranded under "nothing was lost" or the library stays read-only for good.**
- Where:
  - `apps/library-service/src/routes/libraries.ts:354` decides "marked" only by `<oldRoot>/MOVED.json`. A split marks `Projects/<moved>/MOVED.json` and rewrites `library.json` (`packages/library/src/move.ts:940-517`, `markOld`).
  - `packages/library/src/move.ts:891`: `oldCopyMarked` returns `false` for every split.
- Probe: two projects, the move keeping "Kept" behind.
  - `crashAfter = "mark-old"` (the journal says `["mark-old"]`):
    - The move answers `INTERNAL` "Something went wrong…", and the dialog adds "the library stays where it was". That is false: the old `library.json` now carries a new id, and `Projects/Study/MOVED.json` is written.
    - The service keeps the OLD library open read-write.
    - `POST /projects/:id/attach` with `c.pdf` answers 200, and the source is written into `Projects/Study/` of the old copy, which is marked as moved.
    - Opening the new place then **finishes the move**, read-write, and says "move-finished-at-opening" ("…nothing was lost"). The new place has 2 sources. The third stays in the old copy, unseen.
  - `crashAfter = "register"`: the same result.
  - `fail = {at:"journal", after:"mark-old"}`, the realistic one (the copy has just filled the destination disk):
    - The move answers DISK_FULL, followed by "stays where it was".
    - The old library carries on read-write and takes the change.
    - The new place opens `move-incomplete` and is never finished, so R578's original fault remains for splits.
    - At the next start the remembered place holds the remaining library, which has a different id, so the library is not found.
- Why it matters: R581 confirmed the rule as "an old copy that is marked as moved must take no more changes". For splits the rule is not met, and R578 (1) is not met in the journal-write state. The real triggers once mark-old is done are a failing registry write or a failing journal write at the destination, so the reach is narrow but real.
- Direction:
  - Decide "marked" from the journal's and the record's view, not from the root marker: the switching journal exists and the step has run. Or let `executeMove` tell the route which steps completed (an error carrying the done steps).
  - Make `oldCopyMarked` recognise a split's markers (each moved folder's `MOVED.json` naming the library, and `library.json`'s `splitFrom`).
  - Add a service test for a split.

### Minor

**M1. `{newRoot}` matches only by exact string.** `move.ts:853` and `:831` compare `resolve(rec.newRoot) !== dest` with no `realpath` and no folding of case.
- Probe: a move to `<tmp>/LinkToMoved/Lib` (a link to `Moved`) that stopped after close-source. Opening `<tmp>/Moved/Lib` gives read-only `move-incomplete` with no words. Opening it by the link path finishes the move.
- On macOS (`/tmp` → `/private/tmp`, a disk that ignores case) a path from the folder picker may differ from the recorded one. The sentence names the recorded path, so following it works; the picker may not.
- Direction: compare `realpath`s, or the folder's identity (device and inode), on both sides.

**M2. A failure at "unlink" (the record already marked complete) leaves the move unfinished, but:**
- (a) The old place says "the old copy of a library that was moved. Changes are off." and does not name the new place. `movedToFor` judges "unfinished" by `!rec.complete` (`old-copies.ts:183`). Probe: `moveUnfinishedTo: undefined`.
- (b) `deleteOldCopy(old, {confirm:true})` is allowed while the journal is still at the new place.
  - Probe: 11 files deleted and the folder removed. The record is then pruned, `finishMoveAt` finds no record, and the new place stays read-only for good with no words.
  - Only an engine or API caller can do this today: the service deletes only by the move's token, so I did not raise it higher.
- Direction: treat a journal still at `newRoot` as unfinished in both places, or have `markPendingComplete` and the unlink order make that impossible.

**M3. "Told once" can become "told never".**
- When the finishing succeeds but its opening is refused, the note is dropped. Probe: Quit during the finishing gives the open a 503 "shutting down"; the move is finished; the next opening shows nothing.
- The same happens when a reopening at start is superseded.
- A second opener that waited on a shared finishing that FAILED gets no note either (`state.ts:376-379`).
- Nothing is lost here, only the words.

**M4. Words that can be untrue in narrow cases.**
- `move-not-finished-in-use` says "open on another computer". `locked-by-other-device` and `old-copy-in-use` are also raised for another process on THIS computer (the command line) (`move.ts:423`, `:880-886`; `library.ts` same-process double open).
- `move-not-finished-not-writable` is also used for `newer-format`.
- The dialog's and the old place's promise ("open it at its new place … and the move will be finished then") is false in three states:
  - the journal is damaged;
  - the journal's write failed after mark-old and the old copy's drive is now unplugged (`oldCopyMarked` reads the old copy, gets `false`, and returns undefined, with no words saying why);
  - the split states in I1.
- By reading.

**M5. "Nothing was lost" and point 1(f): finishing trusts the old verification.**
- Probe: one PDF deleted by hand at the new place, then the opening. The move is finished and the researcher is told "nothing was lost". The PDF is still in the old copy, and a later confirmed `deleteOldCopy` would delete it there too: it checks the old copy against the recorded hashes, not the new place.
- A normal move has the same window. But finishing can come days later (and on cloud folders), and the record holds the verified hashes, so a quick re-check of the new place against them before finishing would make the sentence true.
- Related: an old copy's deletion offer expires 24 h after `createdAt` (`old-copies.ts:236`), so a move finished later is past its window at once.

**M6. Paths that do not finish.** The `AO_LIBRARY` start path (`main.ts:97`) opens with `@ao/library`'s `openLibrary` directly, so it does not finish (development and test only, by reading). The command line does not finish either (outside R578's three paths).

## Point by point

| point | verdict | note |
|---|---|---|
| 1 Finishing only this computer's own move, only when safe | partly | Whole-library moves are sound: the record by `pendingId`, `newRoot` and `libraryId`; marked by the journal or a root marker naming the library. A hand copy (probe and builder's test), no record (engine test), a different move (paired by `pendingId`), a damaged journal (does nothing) and an unmarked old copy all write nothing. FR-068 is not newly reachable in the service, since changes are refused from the plan to the mark, except in I1. Splits: I1. Path identity: M1. 1(f): M5. |
| 2 Every journal state | partly | Whole-library: every state finishes (table). Split: I1. Unlink with the record complete: M2. |
| 3 Locks and R247 c | holds | The new place's lock throughout; the old copy's lock only for re-marking, taken before anything is written. Quit in the middle: nothing changed in either folder after `close()` resolved, no lock left, the next opening finishes. Two openings and the race with the reopening at start: the session keeps the lock. |
| 4 Two openings at once, and the three paths | holds (Minor M3) | Probed: two opens; an open during the reopening at start (finished once, told, lock held). Not-writable: by reading (tests run as root, so `chmod` cannot simulate it). |
| 5 The move's own failure path | partly | Whole-library: closed, no hang, 503 "No library is open.", no 500; before the mark, unchanged; no existing test assertion changed (all four test files only add lines). R581's in-flight point holds (`moving` stays true until `closeLibrary`; changes are drained before the plan). Splits: I1. |
| 6 Every sentence | partly | `{newRoot}` is shown through `UserText` (dialog and banner), the service's answer has no path, and the log is scrubbed. M2a, M4, M5. |
| 7 The small points | holds | The window in a successful move answers MOVE_IN_PROGRESS (builder's test); every index reader goes through `requireSession`. The comments and `MoveOptions.index` are now true. |
| 8 The new tests | holds | Held promises and whole-folder hashes. Planted faults: (1) the record's folder check removed from `finishMoveAt`: the hand-copy tests fail (engine and service); (2) the note given without finishing: the service hand-copy test fails; (3) the failure path taking the session up again: 13 of 15 fail. All restored. |

## The journal's states

| state (whole-library unless named) | opening the new place | opening the old place | end state |
|---|---|---|---|
| stop or failure in mark-old itself (journal `[]`, no marker) | read-only `move-incomplete`, no words; nothing written | read-write: it is still the library (the route carries on) | as before. A later move to the same folder finishes through `completeMove` without re-checking the source (FR-068, pre-existing) |
| journal write fails after mark-old (`[]`, marker present) | re-marks under the old copy's lock, then finishes: read-write, told once | read-only, names the new place | as a normal move (builder's test) |
| crash after mark-old (`[mark-old]`) | finishes | read-only, names the new place (the reopening at start goes here) | normal |
| register fails or crash after register | finishes | names the new place | normal |
| after close-source, or its journal write fails | finishes | names the new place | normal |
| mark-complete fails (`…audit-move`) | finishes: register, finalize | names the new place | normal, one audit event |
| unlink fails (record complete) | finishes | "a library that was moved": does not name the new place (M2a) | normal, unless the old copy is deleted first through the API (M2b: stuck) |
| finishing itself fails (disk full) | read-only, says why; nothing changed in either folder; the next opening finishes | names the new place | normal after the retry |
| **split**: journal write fails after mark-old | read-only for good (I1) | the remaining library; the moved project's folder is marked; the session carries on read-write | stuck; changes go into the marked folders |
| **split**: crash after mark-old or register | finishes (I1) | the session carries on and takes changes | changes stranded in the old copy, "nothing was lost" said |

## What I could not judge
- Real "not writable" folders (tests run as root) and real process death. A same-host dead process's lock is taken as stale, by reading.
- The page from end to end. I did not run a browser scenario; the UI tests pass.
- How a researcher's folder picker spells paths on macOS (M1).

## Message to the coordinator
NOT APPROVED. 1 Important, 6 Minor.

**I1 (Important):** split moves are not covered.
- After a failure once the moved projects are marked but before the close, the route checks only `<old>/MOVED.json` (`routes/libraries.ts:354`), so the old library carries on read-write. A change is accepted into a folder already marked as moved (probe: attach answers 200).
- Opening the new place then finishes the move without that change and says "nothing was lost". Or, when the journal's write failed, `oldCopyMarked` refuses every split (`move.ts:891`) and the library stays read-only for good, R578's original fault.
- To mend before a join: decide "marked" from the journal or the steps completed, not from the root marker; recognise a split's markers when finishing; add a service test for a split.

Minor, can follow: the path is matched only by exact string (symbolic link or case); after a failure at "unlink" the old place does not name the new one, and the old copy can be deleted through the API before finishing; the note is lost when its opening is refused; "another computer" also covers the same computer; finishing does not re-check the new place against the recorded hashes before saying "nothing was lost".
