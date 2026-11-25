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

---

# Second look (R583)

Branch `fr-755-move-failure` at 6e33ae2: seven commits on 9b1a1fa. I changed no product code. Probes `*.probeFR755b.test.ts` were written, run alone at `nice -n 10`, and deleted; `git status --short` is empty.

**Verdict on the whole change now: NOT APPROVED.**
- Most of the fix round holds: I1 for every probed state, M1 and M4, and M2 in the service.
- Two Important points remain:
  - **N1:** the stuck state R588 (b) names is confirmed, and it is reached without any change by the researcher.
  - **N2:** the M5 check lets an audit log that was emptied or shortened by hand through, and finishing then hides it.

## The findings, each ruled again

| finding | verdict | probe |
|---|---|---|
| I1 split moves | **partly** | Nine late states of a split, each probed (first mark, last mark, journal write after the marking, crash after mark-old, register, close-source, audit-split, mark-complete, unlink). In each: the split's answer `move-not-finished-split`; my old probe (attach into a marked project) now answers 503; opening the new place finishes, read-write, told once; the old library opens read-write with "Kept" only; in "Kept" only `audit/0001.jsonl` changed (audit-split's `library.split`, by design); a change to Kept is accepted. Still open: the part-way state (N1) and a recorded step whose mark is missing (N3). |
| M1 real paths | closed, for the new place | The engine test covers the link. In the service, a move to a destination reached through a link is refused before it starts ("That path is not allowed."). Letter case could NOT be probed: this machine's disk (ext4) keeps case; `realpath.native` is right by reading. A hand-made copy is still refused (builder's tests). The old place is still matched by text in `movedToFor` (`old-copies.ts:182`), by reading only (N5). |
| M2 deleting the old copy while unfinished | partly | After a failure at "unlink", `deleteOldCopy({confirm})` is refused with `move-unfinished`. **But** with the new place's drive unplugged, `journalStillAt` reads nothing and returns false, so the deletion is ALLOWED: 11 files deleted. With the drive back, the new place opens read-only `move-incomplete`, with no words and no finishing, for good. Only an engine/API caller can do this (the service deletes only by the move's token), so Minor (N4). The day-long offer now runs from `completedAt`, which is never earlier than `createdAt`. No deletion can come earlier than before, or before the check passed: `complete` is set only by `runSwitch`'s finalize, which `finishMoveAt` reaches only after its check. |
| M4 words | closed (Minor N5) | The builder's tests cover in-use by another program, newer format, damaged journal, and the old drive unreachable; the sentences are true by reading. Left over: the old place's words in the damaged-journal state still promise that opening the new place finishes it (`movedToFor` gives `!complete`, and the journal cannot be parsed). |
| M5 check before finishing | **partly** | One file deleted and one changed at the new place, with the old copy changed too: read-only, `move-not-finished-files-differ-old-unconfirmed`, count 2, place = the old root. Deleted only: `…files-differ`, count 1. A file added by hand at the new place: finished (nothing is lost; R588 does not ask for it). `library.json` emptied or garbage: the opening answers 409 and nothing is finished. `library.json` rewritten with valid content (renamed, history emptied): finished, which is harmless. **An audit log emptied, or cut to its first line, by hand: finished, "nothing was lost", no warning at all (N2).** Timing: 300 MB extra took 0.56 s from the page cache. The opening's request waits for the whole check; I could not measure a cold external disk (the builder estimates 1–2 min per 10 GB); I found no service time limit on `/libraries/open`. The count and place reach the page only (`integrityWarnings[].place`, through `UserText`); the log carries `describe(err)`, with no path. |

## The stuck state (R588 b): CONFIRMED, and worse than the builder says
- Probe: a split with Study and Field moving and Kept staying; `fail = {at:"split-mark", afterFolders:1}`.
  - Field is marked; Study is not.
  - The move answers the split sentence; the library is closed.
  - Opening the OLD place gives read-write, projects ["Kept","Study"]: the moving Study is shown as the old library's own.
- **With no change by the researcher at all**, merely opening the old library changes Study's `audit/0001.jsonl`: the daily backup runs at the opening and records `backup.create` in every project.
  - Opening the new place then refuses with `move-cannot-finish-source-changed`, read-only, both folders byte for byte unchanged by the refusal. Nothing is lost.
  - The move is stuck for good, and the words tell the researcher to "Tell the developer".
- The same happens with a change made in Study (attach answers 200).
- **And it is reached without any act**: after a part-way failure, quit and start the app. The reopening at start opens the OLD place, because register had not run, so `lastKnownPaths[0]` is still the old one. That reopening runs the backup and is stuck the same way (probe B3).
- The split's dialog sentence ("The library they came from can be opened again for the projects that stayed") leads the researcher straight into this state.
- **The cure R588 rules is right, and small.**
  - The old library CAN know the moving projects: this computer's record (`PendingOldCopy`, in the app's config folder) holds `split`, `movedFolders` and `movedProjectIds`. The old folder itself holds nothing until it is marked; the journal is only at the new place.
  - Smallest safe place: `openLibraryInternal` (`library.ts`, beside the `MOVED_MARKER` check at :279). When a record for this root and `meta.libraryId` is an unfinished split (`!complete || journalStillAt`), open READ-ONLY `moved` with `movedTo`. The banner naming the new place already exists (`moveUnfinishedTo`). That is about 5–10 lines plus a test.
  - It matches only the part-way state: once fully marked, `library.json` carries the remaining id, so the record no longer matches and the remaining library opens normally.
  - Because the opening is read-only, the backup and every other write are off. A per-project variant (R588's literal wording) would have to reach all six callers of `projectMovedAway` (repo state, attention, index changes, restore record, move) and must also HIDE the projects, not only refuse changes, or the backup would still write. That is larger. I recommend the whole-library read-only opening; the projects that stayed are then read-only only until the new place is opened.
  - The lookup must use the real path (as M1 does). The split sentence should then say to open the new library FIRST.
  - Nothing can be done on another computer, which has no record; there the finishing still refuses safely.

## New findings

### Important
**N1. The part-way split state is stuck, reached by the reopening at start or by any opening of the old library** (above). Files: `move.ts` (the source-changed check in `finishMoveAt`); `library.ts:279` is where the cure goes.

**N2. An audit log emptied or shortened by hand at the new place passes the check, and finishing hides it.**
- `finishMoveAt` checks audit logs for presence only (`move.ts`, `AUDIT_LOG` rule).
- Probe D5/D5d: the log cut to 0 bytes, or to its first of 5 lines, before the opening. The move is finished, "nothing was lost" is shown, and `GET /libraries/integrity` and every later opening show **no warning**.
- The same cut made AFTER a finished move is caught at the next opening ("empty", D5c).
- So the finishing launders it. The anchor check runs inside the finishing's own `openRepo`, whose warnings are dropped; audit-move then appends and re-anchors.
- The old copy still holds the full log, but a later confirmed `deleteOldCopy` deletes it there (its hash matches the record), and the project's audit history is then gone.
- R588 (a) rested on "the integrity check at opening verifies the audit chains", which is not true across a finishing.
- Direction:
  - Refuse when the finishing's `openRepo` reports any audit-anchor problem (truncated, empty, chain-broken, head-mismatch).
  - And/or require each audit log at the new place to begin with the verified bytes: record each file's size with its hash; the prefix of that size must hash to the recorded value.

### Minor
- **N3.** A recorded step whose mark is missing: the journal records mark-old, and a mark is deleted by hand (a moved project's `MOVED.json`, or for a whole library the top's).
  - The old place then opens read-write and takes a change (attach 200).
  - Opening the new place finishes without that change and says "nothing was lost" (probes C and C2).
  - It needs a hand deletion. Direction: finishing could check that the marks the journal records are still present, and refuse otherwise.
- **N4.** `journalStillAt` returns false when the new place cannot be read, so `deleteOldCopy({confirm})` deletes the old copy of an unfinished move whose new drive is unplugged, and the new place is then stuck. API only. Direction: fail closed (an unreadable `newRoot` means "cannot tell": refuse).
- **N5.** Words:
  - The old place in the damaged-journal state still promises that opening the new place finishes the move.
  - `movedToFor` matches the old root by text, not by real path.
  - In a split, the old library hides the moved projects rather than "showing them as moved" (R583 (2)'s wording). No words there say where they went.

## The existing tests
`git diff 9b1a1fa..HEAD --stat -- '*.test.ts' '*.test.tsx'`: the only lines removed are:
- import and helper lines that were refactored;
- three expectations of FR-755's OWN first-round tests, for words this round changed on purpose (the in-use regex, the disk-full sentence, the engine's in-use matcher, now `code: "in-use"`).

No test from before FR-755 was changed.

## Message to the coordinator
NOT APPROVED.
- **I1:** holds in all nine late split states (the attach into a marked project is refused; the new place finishes; Kept unchanged apart from its `library.split` audit line), except the part-way state.
- **R588 (b) is confirmed, and worse:** no change by the researcher is needed. The daily backup at the old library's opening writes into the unmarked moving project's audit log, and the reopening at start opens the OLD place after a part-way failure, so quitting and restarting is enough to make the move stuck for good.
- **The cure is small:** in `openLibraryInternal`, open read-only `moved` while this computer's record shows an unfinished split for that root and library id (the record holds `movedFolders`). About 10 lines.
- **New Important (N2):** an audit log emptied or shortened at the new place passes the presence-only check. The finishing then hides it: no warning ever, "nothing was lost" said, and the old copy's full log is deletable later.
- M1, M4 closed. M5 and M2 partly closed (M2: the deletion is allowed when the new drive is unplugged; API only).
- Minor: a hand-deleted mark the journal records is finished over.

---

# Third look (R596)

Branch `fr-755-move-failure` at 704506d: six commits on 6e33ae2. I changed no product code. Probes `*.probeFR755c.test.ts` were run alone and deleted; `git status --short` is empty.

**Verdict: APPROVED WITH SMALL POINTS for this round.** N1–N5 are closed and R596 b holds.
- Question (c) brings up an older fault, FR-068: it is now reachable in exactly the path the move dialog invites, and it is the one thing I would mend before calling the move safe (I-1).
- Question (e) found a real stuck state the round made. It is narrow and safe (M-1).

## N1–N5

| finding | verdict | probe, file |
|---|---|---|
| N1 part-way split | **closed** | `fail={at:"split-mark",afterFolders:1}`. The old place opens read-only `moved`, `moveUnfinishedTo` = the new place; no byte under the old place changed after `idle()`, so no backup ran. Restart + `reopenLast()` reopens the OLD place read-only, still no byte changed. The new place then finishes, told once. The old place then opens read-write with "Kept" only. (`library.ts:283`, `old-copies.ts:377`) |
| N2 audit logs | **closed** | Log emptied at the new place: read-only, `["empty","move-not-finished-files-differ"]`. Cut to its first line: `["truncated", …files-differ]`. Both folders unchanged by the refusal. (`move.ts:902`, `:982` `beginsWithVerified`, `:1013` `auditFaultsAt`) |
| N3 mark removed | **closed** | The top mark of a whole library removed by hand (C2): `move-cannot-finish-mark-missing`, nothing written. The old place itself opens read-write, since its mark is gone; the finishing then refuses, so nothing is run over. The split variant (C) is covered by the builder's test. (`move.ts:893`) |
| N4 unreachable new place | **closed** | Failure at unlink with the new drive renamed away: `deleteOldCopy` refused with the cannot-reach sentence. FINISHED move, drive away: refused the same way. Drive back: allowed (11 files). (`old-copies.ts:317`, `move.ts:1390`) |
| N5 damaged journal at the old place; real path | **closed** | Damaged journal: the old place gives read-only `moved` with `moveUnfinishedTo` and `moveCannotFinish: true`, and the banner sentence does not promise a finishing. Real-path matching: the builder's engine test (symbolic link), by reading `recordFrom` (`old-copies.ts:299`). Letter case still cannot be probed here (ext4). |
| R596 b | **holds** | The old place of a FINISHED move with its new drive away shows plain "moved" words (`moveUnfinishedTo` absent in the open route and in `libraryState`), and the deletion is refused with the cannot-reach sentence. After a failure at unlink with the drive away (complete + journal, "cannot tell"): also the plain words, as ruled. No reader turns "cannot tell" into "has not finished": all three go through `movedToOf` (`old-copies.ts:364`). |
| (4) refusals write nothing | **holds** | Whole-folder snapshots of BOTH places around the opening, for: log emptied, log cut to its first line, a PDF deleted, mark removed, damaged journal. Changed files: `[]` and `[]` in every case. `auditFaultsAt` opens read-only (`move-incomplete`, no lock) with `noHeal`. |

## The three questions

### (c) A split that fails after the record and the journal, before the first mark
- Probe: a directory planted where each moved project's `MOVED.json` must go, so the first mark write fails.
- **Dialog:** `INTERNAL` "Something went wrong. Nothing was changed by this request unless it says otherwise." The page adds "The move stopped; nothing was deleted, and the library stays where it was."
  - Broadly true: the old library carries on, read-write.
  - But a full copy and a switching journal now sit at the new place, and nothing says so.
- **Each place:**
  - The old place opens read-write as the library (all three projects). N1's fourth condition is right: nothing is marked, so `finishMoveAt` returns undefined, and a read-only old library would leave both places read-only for good.
  - The new place opens read-only `move-incomplete`, with `["truncated","truncated"]`: "The audit log of … is shorter than this computer's record of it: recent entries may have been removed outside the app." That is untrue: the old library simply went on writing (M-2).
- **Can anything be written at the old place that a later finishing runs over? Through `finishMoveAt`: no** (it never acts on an unmarked old copy). **Through the move itself: YES (I-1):**
  1. A change is made at the old library after the failure (attach: 200).
  2. The obstacle is removed and the move is run again to the same folder, as the dialog's "stays where it was" invites.
  3. `executeMove` → `finishesSwitch` → `completeMove` resumes the switch with NO copy, NO verification and NO re-check of the source.
  4. The move answers `done`, the library opens at the new place, and Study has **2 sources, not 3**. The change is left behind in the marked old copy, silently.
- This is FR-068 (listed since Task 13), not made by this round, and the same holds for a whole library. But it is now the natural next step after the very failure this item is about.

### (e) Can the finishing's own writable opening append something other than `library.move`?
**Yes: `audit.anchor-missing`.**
- Engine probe: a whole-library switch stopped with mark-old done but not recorded. Before the finishing, this computer's `audit-anchors.json` is removed. The finishing is then interrupted after each step in turn (mark-old, register, close-source, audit-move, and a failure at mark-complete).
- Its writable `openRepo` appends `audit.anchor-missing` to every moved project's log. The next opening **refuses for good** (`files-differ`, count 2) in all five cases.
- With the anchors present, and with an outbox mark planted, all five finish at the second opening.
- **How likely:** low. Anchors are kept per library id in this computer's config folder and carry over a move on the same computer. The state needs the anchors lost or set aside AND the finishing interrupted (killed, or a full disk at a later step).
- **Effect:** stuck, read-only, nothing lost. The words ("N files here no longer match what was checked…") blame files the app itself wrote.
- **Smallest true mend:** count `audit.anchor-missing` among the lines a finishing may have written after the verified beginning (`SWITCH_OWN_ACTIONS`, `move.ts`). It records a fact about this computer, not a change to the library; `anchor-mismatch` stays refused, as it is now. The library's own `audit/` log keeps the whole-hash rule, so the same applies there if this device ever wrote to it: let it take the same "begins" rule.

### (f) `listUnfinishedMoves` versus `moveFinished`
- Its only reader is `reconnect` (`reconnect.ts:760`), which sets `moveIncomplete` for a folder that opened normally or as a part-way split's old library.
- The page only types `moveIncomplete` and shows nothing for it, and the service passes it as a bare flag.
- Where the two judgements differ (record complete but journal still there), the folder is either the new place (opens `move-incomplete`, first branch) or the old place (top `MOVED.json` → `LibraryMovedError` with `movedToFor`, the one judgement).
- **No disagreement a researcher meets.** Deletion offers go only through `deleteOldCopy` (one judgement) and the move's token; the retention screen's `offerOpen` is about opening an old copy, not deleting it.
- Minor: `listUnfinishedMoves` still matches folders by text (`m.oldRoot === here`).

## New findings

### Important
**I-1 (FR-068, older than FR-755; reached by (c)).** After a move that failed before the old copy was marked, the old library carries on and takes changes. Running the move again to the same folder then finishes the switch with no copy and no check, leaving those changes behind while it reports `done`.
- Sequence: split or whole move; the first mark write fails; attach at the old library (200); the move again to the same folder → `done`; the new place lacks the change.
- `move.ts` `executeMove` → `finishesSwitch` → `completeMove`.
- Mend: when the journal does not record mark-old and the old copy shows no mark, do not resume the switch. Treat the journal as copying, so the copy and verification run again (the journal's `filesDone` keeps it quick), or re-hash the source against the verified record first.

### Minor
- **M-1 (from (e)).** `audit.anchor-missing` is not counted as the finishing's own, so an interrupted finishing on a computer whose anchors were lost refuses for good. One line in `SWITCH_OWN_ACTIONS`.
- **M-2.** In state (c), the stale new place shows "recent entries may have been removed outside the app". Untrue: the old library went on.
- **M-3.** `listUnfinishedMoves` matches the old place by text, not by real path (a flag no screen shows).

## Tests run (each alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)
- `@ao/library`: move 118, device-and-old-copies 18, reconnect 54, library 35, library-place 19, retention-old-copies 40.
- `@ao/library-service`: move-finish 37, open-library 26, library-place-routes 8.
- `@ao/ui`: StatusBanner 81, MoveLibrary 29.
- All passed.
- `tsc --noEmit`: shared, library, library-service, ui clean.
- Existing tests: only the split sentence's expectations changed, as R590 ruled.

## Message to the coordinator
APPROVED WITH SMALL POINTS (round R590/R596).
- **N1–N5:** closed (probes rerun).
- **R596 b:** holds.
- **Refusals:** every refusal writes nothing in either folder.
- **(c):** the fourth condition is right. That state's dialog says "stays where it was", which is broadly true, but running the move again finishes it with no check and strands later changes (I-1, FR-068).
- **(e):** yes, `audit.anchor-missing` with lost anchors; one-line mend (M-1).
- **(f):** no visible disagreement.
