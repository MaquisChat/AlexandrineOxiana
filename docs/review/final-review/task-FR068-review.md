# FR-068 — adversarial review (`fr-068-move-rerun` 838852f, two commits on 4588572)

Reviewer: no part in the build. Nothing on the branch was changed. My probe files (`packages/library/src/zz-probe-fr068.test.ts`, `apps/library-service/src/zz-probe-fr068.test.ts`) were written, run and deleted. `move.ts` was edited three times to take a mend out; each time it was copied aside first and copied back, and `git diff` was empty afterwards. `git status --short` is empty. No process is left running.

## Verdict: NOT APPROVED

There is one Critical. In a sequence a researcher on today's builds is pushed towards, FR-068 lets the page reach the very fault it was built to close. The rest of the work holds: the copy and the verification made again, the removal proof, the records, crash recovery, and the stale banner. The Critical needs a small mend in one place (`finishesSwitch`), with a matching change to the plan's acceptance and to the mark's contents. After that I would expect "approved with small points".

---

## Critical

### C-1. A mark made by ANOTHER, later move counts as "seen": the dialog's plan and the move then resume the stale switch with no copy, report done, and the library lands at the stale place without the changes

**Sequence, proved through the service** (probe S1: the dialog's plan route, then the move route):
1. Library at A. A move A→B fails after the copy was verified and before the mark. B holds a stale switching journal.
2. The old library goes on and takes a change (a source attached).
3. On build 12 the researcher can only move to another empty folder, so they move A→C. This **succeeds**: A is marked, and its `MOVED.json` names the library.
4. At C, another source is attached. C now has 4 sources.
5. Later the researcher moves C→B, the folder they first wanted:
   - `POST /libraries/move/plan` → **200**. Before FR-068 this was refused as "not empty".
   - `POST /libraries/move` → `done: true`, `filesCopied: 0`, no copy and no verify phase.
   - The service now has the library open read-write at B with **2 sources**.
   - C is left **read-write and unmarked**: a living copy of the library holding the two changes, which the app now treats as an old path (`lastKnownPaths`). No deletion offer is ever made for it, and nothing tells the researcher.
   - This computer keeps **two complete records** for A (A→B and A→C), so point (3) is broken too.

Engine probe P1 shows the same: `planMove` accepts, and `executeMove` resumes with 0 files copied. B then opens read-write with 3 sources where 5 were expected.

**Why.** The "one judgement" asks only whether the mark names the library, never whether it is THIS move's mark.
- `packages/library/src/old-copies.ts:310` and `:311`: `markNames(…, sw.libraryId)`. The mark records `libraryId`, `movedAt` and `toHint` (`move.ts:1173`) but no move id. Here both destinations are named `Lib`, so `toHint` is the same string too.
- `move.ts:575-576` `finishesSwitch` accepts any library with the journal's id (`prior.libraryId === lib.id`). It then judges at the **record's** old place A, not at the library being moved, C.
- `preflight` (`move.ts:399`) judges at `lib.root`, which is C and unmarked, so the plan accepts.

The two halves of the judgement look at different folders, so together they let the stale switch through.

**Also exposed (pre-existing in FR-755, but point (1) claims to close it):**
- Probe P1b: after step 3, merely opening B runs `finishMoveAt`, which judges A as "seen".
- It was refused only because the anchors moved: "2 file(s) at the new place no longer match the move's check".
- With no change at all after the failure it would finish. It would re-mark A and register B, and leave C (if C was then changed) unregistered as current.

**Smallest true mend:**
1. In `finishesSwitch` (`move.ts:571-577`), resume only when the library being moved IS the record's old copy: `if (!(await sameFolder(lib.root, rec.oldRoot))) return false;` before the judgement. Otherwise fall through to the copy path, which is correct here: it copies C exactly, removes the A→B record by its own checksums, and writes one record.
2. Write `moveId: sw.moveId` into the mark (`move.ts:1173`). In `oldCopyState`, count a mark as "seen" only when its `moveId` equals the journal's. A mark without a `moveId` (written by released builds) keeps today's rule. This closes P1b for `finishMoveAt`.
3. In `preflight` (`move.ts:399`), take the record (`getPendingOldCopy(j.switch.pendingId)`) and accept only when all of these hold:
   - the record exists;
   - `sameFolder(rec.newRoot, destRoot)`;
   - `sameFolder(rec.oldRoot, lib.root)`;
   - `oldCopyState(rec, …) === "unmarked"`.

   The plan and the move then decide on the same folder (see I-3).
4. Test: the sequence above, through `move-finish.test.ts`: plan, then move. Expect a copy (`filesCopied > 0`), 4 sources at B, C marked, one record.

---

## Important

### I-1. A file the person CHANGED at the new place, at a path the library has, is overwritten with no proof that it was the move's own copy
- **Probe P3:** after the failure, the stale copy's PDF at `Projects/A/Sources/…/original/….pdf` is rewritten "by the researcher" (for instance, annotated in a viewer that saves in place). Plan → accepted. Move → done. The researcher's version is gone.
- **Where:** the copy loop, `move.ts:725-740`. A journaled file that differs from the source is copied over, and so is a file that is not journaled. Neither is checked against what the first attempt verified (`earlier.files`).
- **Why it matters:** the report's own line says "the only things removed at the new place are files the first attempt itself put there and that are still byte for byte what it put" (R604 b). That holds for removals. It does not hold for overwrites.
- This behaviour is old for a copy resumed in its copying phase. FR-068 now applies it to a folder that sat there as a complete, openable library, possibly for weeks.
- **Mend:** when `earlier` is set, before overwriting `to`: if `to` exists and its hash is neither the source's nor `earlier.files[rel]`, do not copy. Add it to `bad`, so the verification refuses and names it, as for a file added by hand.

### I-2. A symbolic link at the new place in place of a folder: the copy follows it OUT of the new folder and overwrites a file there, before the verification refuses
- **Probe P2:** `Dest/Exports` is replaced by a link to `Outside/`, which holds `private.txt` = "PRECIOUS OUTSIDE FILE". Plan → accepted. Move → `MoveVerificationError … Exports`. **`Outside/private.txt` now reads "owner only"** (the library's file).
- **Where:**
  - `move.ts:715-716`: `mkdir(…, {recursive:true})` succeeds through the link.
  - `move.ts:729-738`: `lstat(to)` follows the parent link, and `copyFileAtomic` renames into the target.
  - Only the later walk (`move.ts:796-800`) sees the link.
- **Severity:** it needs a link made by hand inside the stale folder, and it is pre-existing for the copying-phase resume. But it destroys a file outside the library, and FR-068's plan now accepts such a folder.
- **Mend:** before the first write, walk the destination and refuse on any link or special file (`abortOnOdd(await walk(dest, …))` before `move.ts:715`). Alternatively, `assertContained(dest, to)` on the real path of each parent.

### I-3. The plan's acceptance is not limited to "this very move's stale copy"
Checked at `move.ts:399`:

| condition | checked? |
|---|---|
| same library id | yes |
| journal in switching phase | yes |
| no mark | yes, but at `lib.root`, not at the record's old place |
| same old place by real path | **no** |
| a record of the move on this computer | **no** |
| the record's new place is this folder | **no** |

Consequences:
- **C-1.**
- **Probe P5:** with this computer's record gone, the plan **accepts** and the move then refuses: "This move was started on another device or its record is missing; finish it on that device". The researcher is told yes, then no, and can never use that folder.
- **Probe P5b:** a hand-made copy H of the library (same id), moved to B. The plan accepts. The move copies from H, removes the A→B record and writes H→B. A stays read-write with no deletion offer, which is correct. Nothing wrong is offered and nothing is deleted. This answers the report's uncertain point: harmless.

**Mend:** C-1 point 3.

---

## Minor (7)

- **m-1 (one of the two that matter): a crash between the removal of the earlier record and the writing of the new one leaves the folder unusable for good.**
  - Probe P6 recreated that state by hand: journal back in `copying` with `replaces`, earlier record removed. A source was then deleted at A.
  - Every later run is accepted by the plan and fails verification. It names the move's own stale copies, which nothing can now remove.
  - Window: `move.ts:811-835`.
  - **Mend:** write the new record FIRST, then remove the earlier one. A crash in between leaves two records, and the journal's `replaces` still names the earlier one, so the next run removes it.
- **m-2 (the other that matters): "Verification failed; nothing was switched or deleted" is now untrue on a re-run.**
  - Probes P11 and P16: the re-run removed the move's own stale copies (a `source.json`, a PDF) and then stopped at verification on a file added by hand. The message says nothing was deleted, and the dialog adds "nothing was deleted".
  - Only the move's own unchanged copies went, and the source is intact. But the words are untrue.
  - **Mend:** run the removal after a verification that ignores the removable set, or say "nothing of the library was deleted".
- **m-3: after a re-run that failed, the stale place loses its new banner.** The journal is now in `copying`, so `staleMoveCopyAt` no longer matches (probes P11 and S2). The generic words, "a move into this folder has not finished. Changes are off.", are still true. No untrue warnings appeared, because the copy had already brought the logs up to date.
- **m-4: a `replaces` naming a record that is not this move's is honoured.**
  - Probe P13: a journal is hand-edited to name ANOTHER library's complete record. The move removes that record (`move.ts:812`), and the other library's old copy loses its deletion offer.
  - Removal at the destination is still limited to byte-identical files.
  - **Mend:** use `replaces` only for a record with `libraryId === lib.id`, `sameFolder(newRoot, dest)` and `!complete`.
- **m-5: names differing only in letter case on macOS (reasoned, not run on Linux).**
  - Suppose a source's file or folder name changed only in case at A after the failure. On a case-insensitive disk the copy writes into the existing old-case entry.
  - The removal walk (`move.ts:759-763`) then sees the old-case path as "not expected" but present in `earlier` with an equal hash, and unlinks it. That removes the file just copied.
  - Verification refuses, and for a renamed folder it refuses on every run. No library data is lost, because the source is intact.
  - **Mend:** compare by `fold()` and NFC where the disk folds case.
- **m-6: the old place cannot be reached at the re-run.** `finishesSwitch` swallows "unreachable" as `true` (`move.ts:576`), so the move resumes the switch and fails at `mark-old` (the lock cannot be written). The plan accepted. The result is a refusal after a yes, with no loss. With C-1's `sameFolder` condition this case falls to the copy path or a clear refusal.
- **m-7: an unreachable old place at an opening of the stale copy.** It gives the generic `move-incomplete` words and makes the anchor comparison (probe P7: no warning when nothing changed since). This is the report's own uncertain point and acceptable.

---

## A. Everything the re-run can remove or overwrite at the new place, and its proof

| what | done by | proof it was the first attempt's own unchanged copy | probe |
|---|---|---|---|
| a file at a path the source no longer has | unlink, `move.ts:762` | path in the earlier record's checksums AND current SHA-256 = recorded | P16: a changed one is kept |
| a folder at a path the source no longer has | rmdir, `move.ts:765` | in the earlier record's `dirs`, and empty (rmdir fails otherwise) | — |
| a file at a path the source has, differing from the source | **overwritten**, `move.ts:738` | **none** (I-1) | P3: the researcher's change is lost |
| a file the person ADDED at a path the source does not have | kept, named by verification | not in record → kept | the builder's (2) test; P11 |
| a file added at a path the source has too | **overwritten** | none (as I-1) | — |
| a link in place of a folder | kept, but the copy **writes through it outside** (I-2) | — | P2 |
| a link in place of a file | replaced by rename (the link itself; the target is untouched) | — | read |
| a file in place of a folder / a folder in place of a file | copy fails (mkdir or rename error); nothing removed | — | read |
| journal `filesDone` naming `../` or absolute paths | filtered to source paths (`move.ts:705`); removal paths come from walking the destination, never from the journal | — | read |
| journal `replaces` naming another record | that record's checksums are used and **the record is removed** (m-4) | removal still byte-identical only | P13 |
| another library's files (folder reused) | refused: the journal's `libraryId` must equal the library's | — | P10 |
| the stale copy opened and written | it opens read-only (`move-incomplete`); the builder's service test and my S3 show nothing written | — | S3 |
| case or Unicode variants | m-5 (macOS) | — | reasoned |

## B. The copy made again
- These are proved by the builder's (2), (4) and (5) tests and by my P9 and S3 probes:
  - a record edited;
  - a source attached;
  - a source deleted;
  - a project added;
  - a file changed to content of the same size with the same modification time (P9: recopied, because the hash decides; `filesDone` is not trusted);
  - the index changed;
  - in a split, both the staying project and a moving one changed.
- The independent listings were equal, and the counts true.
- Not probed separately: deleting or renaming a project, locking or unlocking, a Bulk Import, a backup. They go through the same path (a full walk, every file hashed against the source), and I see no special case.

## C. The one judgement: the cases
- **A mark naming another library:** not "seen" (`markNames` compares `libraryId`).
- **A mark of another move of the same library:** **"seen" — C-1** (whole library, probed). For a split, a moved project marked by a LATER successful split of the same library is "seen" in the same way (reasoned from `old-copies.ts:311`).
- **A mark left by an EARLIER split:** that project is in `movedAway`, so it is not in this move's `movedFolders` and is not counted.
- **A stale mark from an earlier move back and forth (A→B, B→A, then B→A' failing):** the old place B of the failing move cannot carry a mark naming the library while it is read-write. That case is not reachable except as C-1.
- **The old place unreachable at the re-run:** see m-6. The plan accepts, the move resumes, then fails at `mark-old`, with no loss.
- **A hand-made copy (same id) moved to the same destination:** probe P5b, harmless. The other folder's record is removed, but that folder was never marked and never offered for deletion. Nobody is told anything wrong.

## D. Crashes
- **The re-run killed after its switching journal, `mark-old`, `register`, `close-source` or `audit-move`** (probe P15): each was then run again or opened, and each finished with the change at B and exactly one complete record.
- **Killed during the copy** (journal `copying` with `replaces`, record kept; probe P6b): finished, with one record.
- **Killed between the record's removal and the new record:** m-1.
- **`moveSeams.crashAfter = "switching-journal"`:** not exported from `@ao/library`'s index; only tests reach it by a deep import. It is inert in production.

## E. Records
After every path in B and D: one record, complete.

Exceptions:
- **C-1:** two complete records for A.
- **m-1:** possibly an orphan incomplete record. Pre-existing window; `listUnfinishedMoves` is used by no service route.
- **m-4.**

## F. What must not have moved
- The (6) tests (whole and split, recorded and seen) resumed with no copy.
- A first run, and a resumed copy: the existing tests pass unchanged.
- A non-empty folder that is not this move's, through the move without the plan: refused, "The destination folder is not empty" (probe P10).
- The finishing at an opening refuses an unmarked old copy (the builder's (6)).

## G. The stale new place
- Read-only, no anchor warning, and the new banner. All verified (S3; the builder's (7)).
- The banner's claims hold:
  - the library is still at the old place;
  - nothing here is the library yet;
  - moving it to this folder again finishes the move (S3: done, 3 sources);
  - deleting the folder is harmless.
- **With the old place deleted or unreachable:** the banner is not shown. The generic words, "a move into this folder has not finished. Changes are off.", are true. The anchor comparison is made; if the old library changed since, warnings could show "removed outside the app", which is untrue (the report says so; m-7).
- **After the library moved on elsewhere (C-1 step 3):** A is "seen", so B gets the generic words, the anchor comparison, and the finishing attempt of P1b.
- The other refusals' warnings (a log emptied or cut after the mark) are still shown: the builder's (7) second test and the service's R590 N2 tests.

## H. The dialog's words after the failure
**Can the route tell this state?** Yes.
- In the "Not moved" branch (`apps/library-service/src/routes/libraries.ts:377-389`), `staleMoveCopyAt(state.deps, dest, s.lib.id)` returns the old root exactly when:
  - the switching journal is there;
  - it is this computer's record, for this folder;
  - the old copy is unmarked.
- What it takes:
  - export `staleMoveCopyAt`;
  - a reason code;
  - the sentence in `packages/shared`;
  - `MoveLibrary.tsx:64-67` shows that sentence IN PLACE OF the INTERNAL message plus suffix. The prefix "Nothing was changed by this request unless it says otherwise" must go too.

**Is the proposed sentence true in every failure that reaches it?**
- "The move stopped before the library was switched": true (no mark).
- "the library stays where it was": true.
- "The copy made at the new place is not used: move the library to it again to finish, or delete it": true once C-1 is mended (until then, "move it again" may resume a stale switch).
- "nothing was deleted": untrue in one case. A **re-run** that removed its own stale copies and then failed after its new switching journal also reaches this branch. Say "nothing of the library was deleted" instead.
- Failures in the copy phase (journal `copying`) do not reach it. They keep today's sentence, which is equally untrue of the partial copy, as before FR-068.

## I. Tests
- **Taking the mend of (1) out** (`finishesSwitch` → `return true`): 5 of the 12 FR-068 engine tests fail, (2), (2'), (3), (4) and (5). The (6) and (7) guards pass, as they should. They fail for the right reason.
- **No test covers:**
  - C-1;
  - I-1;
  - I-2;
  - P5's plan/move disagreement;
  - m-1 to m-5;
  - **the byte-for-byte proof of the removal.** With the hash condition taken out of `move.ts:762` (keeping "in the record"), all 12 FR-068 tests still pass. My probe P16 shows the condition does work.
- One `move-finish` FR-068 run under load showed 1 failure. Run again alone: 4 of 4 passed.

## Runs (each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)

| package | file | result |
|---|---|---|
| `@ao/library` | `move` | 137 passed |
| | `device-and-old-copies` | 18 passed |
| | `retention-old-copies` | 40 passed |
| | `reconnect` | 55 passed |
| | `library` | 35 passed |
| | `library-place` | 19 passed |
| `@ao/library-service` | `move-finish` | 41 passed |
| | `library-place-routes` | 8 passed |
| | `open-library` | 26 passed |
| `@ao/ui` | `StatusBanner` | 82 passed |
| | `MoveLibrary` | 29 passed |

Typecheck clean for `@ao/library`, `@ao/library-service`, `@ao/ui` and `@ao/shared`.

---

# Second look (R610): the strict version (`fr-068-strict` 87c1b26, four commits on 4588572)

The same reviewer looked again. Nothing on the branch was changed. Probe files (`packages/library/src/zz-probe2.test.ts`, `apps/library-service/src/zz-probe2.test.ts`) were written, run and deleted. `move.ts` was edited three times to take a mend out; each time it was copied aside first and copied back, and `git diff` was empty afterwards. `git status --short` is empty. No process is left running.

## Verdict: APPROVED WITH SMALL POINTS

No Critical remains. Every finding of the first look that could lose or overwrite data is closed or no longer applies: probes and grep found no path that copies, removes or overwrites anything at a folder holding a switching journal, except the resumed switch of that very move after its own mark.

Two points are not yet built and go to the coming mend:
- **R610 (1)**, the refusal's two sentences. One correction to how R610 (1) splits the cases is needed (see I-A below).
- **R610 (2)**, the dialog showing the refusal's reason.

## The earlier findings

| finding | now | evidence |
|---|---|---|
| C-1 | **closed** | Through the service (probe S1): the plan route gives 403 with the new reason, and the move route without a plan is refused the same way. The settings folder, B and C are byte for byte unchanged. The library is still open read-write at C with all 4 sources. The opening of B (probe G6) gives `finishMoveAt` → undefined, so P1b is closed too. Builder's tests: engine and service. |
| I-1 (overwrite) | **no longer applicable** | There is no copy-again path. A switching journal is either resumed or refused in `preflight` before any write (`move.ts:386-394`, `finishesSwitch` at `:592`). |
| I-2 (link) | **closed** for the resumed copy | Probes G3a–d, each with a copying-phase journal: a link deep in the tree (`Projects/A/Sources`), a link in place of a FILE (`Exports/private.txt` → an outside file), a link replacing `Projects` itself, and a fifo. Each is refused before any write, naming the path. The outside files are untouched. The walk is at `move.ts:416-419`. |
| I-3 (plan's acceptance) | **closed** | The plan and the move decide by the same `stoppedSwitch`. A missing record, another folder, or another place each give "refuse". |
| m-1, m-2, m-4 | **no longer applicable** | They lived in the copy-again path, which is gone. |
| m-3 | superseded | A refused folder keeps its journal, so the banner stays. |
| m-5 | no longer applicable at a switching journal | Still possible, as before FR-068, for a resumed copy (copying phase). |
| m-6 | **closed** | An unreachable old place now refuses ("refuse" when the mark is not recorded). It used to resume and fail. |
| m-7 | **open** (Minor m-B below) | |

**No code path writes at a switching-journal folder except that move's resumed switch:**
- `executeMove` and `acceptMovePlan` call `finishesSwitch` first, which resumes only on "resume". Otherwise `preflight` throws before the journal flush, mkdir or copy.
- `finishMoveAt` is judged by `oldCopyShowsMark` ("id-or-none").
- Opening such a folder is read-only (the builder's tests and my S3: nothing written).
- `completeMove` is exported with no judgement of its own. No production caller exists: grep finds only the service's `finishMoveAt` use and an advice string in `reconnect.ts`. See m-C.

## The one judgement (`stoppedSwitch`, `move.ts:345-356`): the cases I tried

**Must resume.** Probe G1: the move killed or failed at each step, then run again from the same handle, or the new place opened (`finishMoveAt`). The steps tried, 11 states × 2:
- whole library: a crash after `mark-old`, `register`, `close-source` or `audit-move`; the journal write failing after `mark-old`; `mark-complete` failing; the journal's removal failing;
- split: a crash after `mark-old` or `audit-split`; the split's mark failing after 1 of 2 projects; the journal write failing after `mark-old`.

**All 22 finished, with no journal left.**

**A move an OLDER build left half-switched** (its mark has no id). Probe G2: the mark is seen, not recorded.
- The move is refused, with nothing written.
- The old place opens read-only, "moved, unfinished, open at B", so the researcher cannot even reach the refusal from it: the library is read-only.
- Opening B finishes the move. Nothing is stranded.
- With the mark recorded in the journal, the move resumes (the builder's test).

**Must refuse. Each was refused, with nothing written:**
- the FR-068 sequence;
- C-1;
- a mark naming another library;
- back and forth with stale marks;
- a split beside an earlier split's mark;
- the old place unreachable;
- a hand-made copy, with the old place unmarked (builder) and with it marked by THIS move (probe G2b);
- the crash seam.

**The remaining-library clause (R610 (3)): it does not widen the judgement.**
- It applies only together with (i)'s `sameFolder(rec.oldRoot, lib.root)` and (ii)'s record with the same `moveId`.
- `remainingLibraryId` is a fresh `newId()` per move, written only by that split's `markOld` AFTER all of its project marks.
- No other folder or library can pass. The remaining library of an EARLIER split has another split's id and another record.
- A split's mark of the same library id from an earlier split is under `movedAway`, so it is not in `movedFolders`.
- Old behaviour (R33 I6) that it keeps: moving the remaining library R into its split's new place finishes the split and answers "done". R itself is not moved. The service closes R and opens the moved library at B. Nothing is lost, but the answer is not about what was asked. This is m-D, pre-existing.

**`finishMoveAt` ignoring another move's id cannot strand a legitimate move.**
- Every mark this build writes carries the journal's own `moveId`.
- Older builds' marks have no id and count.
- G1's "open" column shows every step finishing.

**Tests fail for the right reason:**
- Take the mend out (`stoppedSwitch` → "resume" for any same-id library): 9 of the 13 (a) tests fail; the 4 "unchanged" guards pass.
- Make it count id-less marks for the move ("id-or-none"): 2 tests fail (back and forth; older build).
- Take the destination walk of (b) out: the P2 test fails.

## The mark's new field
Readers of `MOVED.json`:
- `library.ts` checks only that the file exists;
- `projectMovedAway` needs `libraryId` and a parsable `movedAt` (same in the released `7d8d861:packages/library/src/library.ts`);
- `reconnect.ts:201`, `:743` read `toHint`;
- `unfinishedSplitFrom` and `markNames` read `libraryId`;
- `staleMoveCopyAt` checks only that a mark is present;
- `markOfMove` reads `moveId`;
- `deleteOldCopy` and `retention.ts:1454` work by the file's name.

None of them rejects an extra field or needs it to be absent. An older build reads the new mark unchanged, and this build reads old marks.

## The refusal's words: what each refused case gets today, and what R610 (1) would give
Today EVERY refused case gets "That folder holds the copy of an earlier move that did not finish. Choose another, empty folder, or delete that folder first." (`move.ts:333`). The planner alone still says "not empty" in the resume case.

| refused case | is the folder the library? | today | R610 (1) as written | right |
|---|---|---|---|---|
| FR-068 sequence; crash seam; split beside an earlier split's mark; hand copy with the old place unmarked | no, a stale copy (old place seen living and unmarked) | delete-words | delete-words | delete-words |
| **C-1: old place marked by ANOTHER move (another move's id)** | no, stale: B's own move never marked, and the library is at C | delete-words | **"…To finish that move, open the library at that folder."**, which is UNTRUE: opening B finishes nothing (probe G6) | delete-words |
| **a mark naming another library at the old place** | no, stale | delete-words | the "open to finish" sentence, UNTRUE (`finishMoveAt` → undefined) | delete-words |
| this move's mark seen, not recorded, asked by a hand copy or another library (G2b) | **yes**, B is the library's real new place | delete-words (**wrong**) | "open to finish", true: opening B finishes (G1) | R610 sentence |
| an older build's mark (no id) seen, not recorded (G2) | **yes** | delete-words (**wrong**) | "open to finish", true (G2) | R610 sentence |
| old place unreachable | may be | delete-words (**wrong**) | "open to finish", true once it can be reached | R610 sentence |
| record missing (another computer, or a lost list) | may be | delete-words (**wrong**) | "open to finish", untrue on this computer but "may" | R610 sentence |

**(ii) Does the Move dialog show a plan refusal's reason? No, confirmed.**
- "Check destination" shows only `err.message`, which is "The library cannot be moved there." (`packages/ui/src/screens/MoveLibrary.tsx:178`). That is so for "not empty" and for this refusal alike. The reason travels as `ApiClientError.reason` (`api/client.ts:34`) and is never shown.
- A refusal on the move route shows "The library cannot be moved there. The move stopped; nothing was deleted, and the library stays where it was." (`:76`), also without the reason.
- **Mend:** in both places, show `err.reason` after the message when the code is `POLICY_DENIED`, and do not append "The move stopped…" to a refusal.

## The stale folder and the dialog after the failure
**The banner** (`StatusBanner.tsx:251`): "Read-only — this folder holds the copy of a move that did not finish. The library is still at {oldRoot}, and nothing here is the library. This folder can be deleted."
- It is shown only when (`old-copies.ts:297-321`) the old place's `library.json` has the same id and no mark of any move is there. In that state every claim is true.
- With the old library closed, it is still shown (G6b) and still true.
- After C-1 (A→C done): not shown. B gives the generic "a move into this folder has not finished. Changes are off.", which is true, and "audit log … changed outside the app" warnings, which are untrue (G6). See m-B.
- With A deleted or unreachable: generic words, plus the same untrue "truncated" warning (G6b). See m-B.
- The finishing's own refusals and the R590 N2 "empty"/"truncated" warnings are unchanged (service tests).

**The dialog after the failure:**
- The sentence is shown IN PLACE of the generic one (`MoveLibrary.tsx:72-74`; route `libraries.ts:386-389`) exactly when `staleMoveCopyAt` matches.
- Probe S1 got it for a whole library failing at the mark. The builder covers a split failing at its first mark. Both are true.
- A split that failed after one of two marks gets FR-755's split sentence and the library is closed (probe S2). That is right, and opening B then finishes (G1).
- See m-A for the cause being hidden.

## New findings

### Important
- **I-A (for the coming R610 (1) mend, not yet built): R610 (1)'s split sends two provably stale cases to a sentence that promises something untrue.**
  - R610 gives the delete-words ONLY where the old place is seen as the living, unmarked library.
  - In C-1 and in "a mark naming another library", the old place IS marked, but by ANOTHER move or library. The folder is then provably stale: its own move never marked, and `finishMoveAt` refuses it. Yet it would be told "To finish that move, open the library at that folder", and opening it finishes nothing and shows the untrue anchor warnings.
  - **Smallest true split:** the delete-words where the old place is seen to be (a) the living unmarked library of the same id, OR (b) marked by a mark that names another library or carries ANOTHER move's id. The "open the library at that folder" words where this move's mark is recorded or seen, the mark has no id, the old place is unreachable, or the record is missing.
  - Test: C-1's plan refusal reason.

### Minor (5)
- **m-A:** the (d) sentence hides the failure's own cause. Suppose the mark cannot be written because of a full disk or a permission fault AT THE OLD PLACE. "To move the library, choose another, empty folder" then sends the researcher into the same failure, leaving another stale copy each time. **Mend:** add the cause when it is a disk or permission error at the old place (the builder's uncertain point 4).
- **m-B:** the untrue accusation outside the banner's state. B opened after the old place was moved on (C-1) or became unreachable or deleted shows "truncated: audit log … changed outside the app" (probes G6, G6b). R607 (c) limits its promise to "while the old place is seen to be the living library", so this is within the ruling, but the words are untrue. **Mend:** in `staleMoveCopyAt`'s callers, skip the anchor comparison for any switching journal of this computer whose own mark is neither recorded nor seen. No anchor can be newer than the copy unless the library went on elsewhere.
- **m-C:** `completeMove` is exported from `@ao/library` and resumes ANY switching journal with this computer's record, with no judgement. Nothing in the app calls it, so it is inert. **Mend:** apply `stoppedSwitch`'s (ii)+(iii), or stop exporting it.
- **m-D (pre-existing, R33 I6):** moving the remaining library of a split into that split's new place answers "done" for a move that finished the OTHER library's split; the remaining library stays where it is. Nothing is lost.
- **m-E (mixed builds):** an older build moves A→B, which fails before the mark, then moves A→C, which succeeds (its mark has no id). In this build, opening B counts that id-less mark in `finishMoveAt` ("id-or-none") and goes on to its checks. Only the anchor and checksum checks then refuse (as P1b did). It is pre-existing and reachable only across an upgrade.

## Runs (each file alone, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)

| package | file | result |
|---|---|---|
| `@ao/library` | `move` | 143 passed |
| | `device-and-old-copies` | 18 passed |
| | `retention-old-copies` | 40 passed |
| | `reconnect` | 55 passed |
| | `library` | 35 passed |
| | `library-place` | 19 passed |
| `@ao/library-service` | `move-finish` | 43 passed |
| | `library-place-routes` | 8 passed |
| | `open-library` | 26 passed |
| `@ao/ui` | `StatusBanner` | 82 passed |
| | `MoveLibrary` | 30 passed |

Typecheck clean for `@ao/library`, `@ao/library-service`, `@ao/ui` and `@ao/shared`.

`moveSeams` is not exported from the package index; only tests reach it by a deep import, so it is inert in the app.
