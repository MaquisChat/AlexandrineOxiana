# RE-1b — adversarial review (FR-368, FR-420, FR-423, FR-425 with R473 I1)

Worktree `.claude/worktrees/re-1b`, branch `re-1b-core`, 05451c3..54b9f25 (six commits; no further commit arrived, no uncommitted work of the implementer's was found). Rulings read: R469, R473, R479.

**Verdict: NOT APPROVED.** There is one Important finding, in FR-425/R473 I1. FR-368, FR-420 and FR-423 hold; their remaining points are Minor.

## What I ran
- Probe `packages/library/src/repo/rollback.probeRE1b.test.ts` (deleted). It has four cases. Results below.
- The implementer's tests, each file run alone. All passed:
  - `src/integrity-confirm.test.ts` 4/4
  - `src/retention-confirm.test.ts` 3/3
  - `src/repo/sources-confirm-bound.test.ts` 6/6
  - `src/repo/sources-read-race.test.ts` 13/13
  - UI `src/routes/library.test.tsx` 10/10
- Guards taken out, one at a time, then restored with `git checkout <file>`:
  - `strayInTurn` call: 2 of 3 retention tests fail.
  - `confirmFindings` call: 3 of 4 integrity tests fail.
  - The hash-finding rule (`reconnect.ts:627`, made always "mismatched"): **nothing fails**.
  - 54b9f25's `rewritten` guard (`txn.ts:578`): **nothing fails**. It has no test.
- `git status --short` is empty at the end. No typecheck or whole-suite runs.

## Findings

### Important

**I1 (FR-425 / R473 I1 3): the reopen records the app's OWN writes as "changed outside the app".** In `packages/library/src/repo/txn.ts:572-591`, `changedSinceMarker` judges each marker entry on its own, not against what the change itself did later. This gives two false alarms, both in exactly the situation FR-425 is about: an in-process roll-back that failed.
- **(a) A path the change wrote twice.** Examples: created then replaced, or replaced twice. Each entry holds the hash of its own write, so the earlier entry sees the later write's bytes and flags the file.
  - Probe P1: `importChange` writes the source twice, then fails, with `seams.failUndo = "replaced"`; then a reopen.
  - Result: `annotations-hash-mismatch` for `…/annotations.json` and `changed-outside-before-rollback` for `…/source.json`. Nobody touched either file.
- **(b) A trashed path that the in-process roll-back had already put back.** The undo runs in reverse order, so the trash is restored before the failing step. At the reopen, `exists(from)` is true, so the path is flagged. A crash during the reopen's own roll-back, followed by a second reopen, takes the same route.
  - Probe P2: `trashAssetFile`, then `writeSource`, then a failure, with `failUndo = "replaced"`.
  - Result: `changed-outside-before-rollback` for the stored original (`…/original/….pdf`).
- **Effect:** with R479 a's sentence, the researcher is told that "the outside change to that file was not kept" when there was no outside change. For annotations, the existing sentence says they are "shown as they are now", which is also false (see M2).
- **Direction:**
  - For (a), judge a path only against its first entry's "before" and its LAST write's hash.
  - For (b), a trashed path whose trash copy (`to`) is gone was put back by the roll-back, not by someone else.
  - Give each case a failing test: P1, P2, and the reverse order (trashed then written again). 54b9f25 itself has no test.
- What still holds:
  - The earlier state is always put back. `changedSinceMarker` only reads, and `rollBackMarker` is unchanged.
  - P3: a hand edit that restores exactly the earlier bytes is not reported.
  - P4: a hand-edited `source.json` is recorded once, and the earlier state is put back.

### Minor

**M1 (FR-425): the banner sentence is wrong for an annotations file the roll-back overwrote.**
- `repo.ts:636-644` records an annotations file found changed before the roll-back as `annotations-hash-mismatch`, which R473 asked for ("the existing warning").
- The banner shows a sentence chosen by kind only (`StatusBanner.tsx:91`): "…They are shown as they are now." Here the outside change was discarded, so the sentence is untrue. This needs a ruling: either the R479 a sentence for this case too, or a sentence of its own.

**M2 (FR-425): the new warnings are kept in memory only.**
- This includes the record that a researcher's outside edit was discarded. A restart before the banner is seen loses it for good.
- This matches the existing recovery warnings (`repo.ts` comment "kept in memory only"). It is noted for the coordinator, not a deviation from the ruling.
- The warnings cannot be dismissed. They come back on each open only while the marker remains.

**M3 (R479 b): there is no test proving the new seams inert.**
- `retentionSeams.afterScan` (`retention.ts:482/487`) and `confirmationSeams.onRun` (`sources.ts:173/194`) both act only when `NODE_ENV === "test"`, and neither is exported from `@ao/library` (`index.ts:285` names only what it exports). I judged this by reading.
- No test in the library proves any seam inert outside `NODE_ENV=test`. The only such test is `resources.test.ts:23` (`useResolverForTests`). R479 b's condition ("the test that proves seams inert … covers it") assumes a test that does not exist.

**M4 (FR-420): the hash-finding rule in the confirmation has no test.**
- The rule is at `reconnect.ts:625-627`. A hash finding is dropped when the record or the file (inode, size, mtime) changed since it was hashed.
- Making it always "mismatched" fails no test. The tests only cover a real hash mismatch that stands, and a missing file during a destruction.

**M5 (FR-420): the confirmation's cost and end conditions.**
- `confirmFindings` reads `source.json` again once per flagged entry, in ONE turn. A source with many flagged assets is read many times, and a library with thousands of findings (a volume half gone) holds the queue for all of it. A lock asked meanwhile waits for that turn.
- `opts.signal` is not checked inside the turn.
- Unlike FR-423's confirmation, it does not stop at a close or a move. After a move, the old root's sources are gone, so `readSource` gives nothing and every finding is dropped (`reconnect.ts:597-601`): the check of a moved library answers "nothing missing". I judged this by reading.
- A lock is handled correctly: the R404 retry gives a presence-only report (test 4).

**M6 (FR-425): `source-change-unfinished` reaches the screen only as the banner sentence "A change to this source…".** `file` is not passed by `state.integrityWarnings`, so the banner does not say which source, and there is one identical banner per named folder. The wording is ruled; where it shows is the point.

**M7: the implementer's report ends with `RUNS_PLACEHOLDER`.** The whole-suite runs it was asked to report are not stated.

## Per item

| FR | Implementer's claim | Verdict | Note |
|---|---|---|---|
| FR-368 | Checks after 2, 4, 8, then every 15 s; one timer; cleared on unmount | holds | The count resets when the reopening ends or names another library. The `.catch` re-arms at the next step, so when the service comes back the screen is stale for at most 15 s. The test uses fake `setTimeout`/`clearTimeout` and settles without moving the clock. |
| FR-420 (i) integrity | Flagged entries re-read in ONE turn; no re-hash; lock → locked check | holds (M4, M5) | Every kind is confirmed: missing, not a file, size, hash, placeholder. The queue is entered through `serial`, with no re-entrance (`writeQueueTurn` runs `fn` directly inside a turn). |
| FR-420 (ii) retention | A stray amendment is reported only if still unrecorded in the turn | holds | The direction is safe. A stray is dropped only when the in-turn audit log records it. `resumeLocked` then decides from a fresh verified log (`sure`) before `settleBackups`. A real stray still blocks. Locks between maintenance and the queue are always taken in the same order (maintenance, then queue), so there is no deadlock. |
| FR-423 | Wait ≤2 s, then no warning; one confirmation per source; ends at lock/close/move | holds | The timer is cleared in `finally`. A rejection always has a handler. When the queue is held for minutes, the warning is recorded when the turn comes; the screen shows it at its next fetch of warnings (not verified in the UI). |
| FR-425 / R473 I1 | Only named sources are spared; changes found before the roll-back are recorded; the earlier state is always put back | partly | Narrowing and sentences hold. The roll-back always restores the earlier state. **I1:** the app's own writes are flagged as outside changes. M1, M2, M6. |
| R479 a sentence | (to be reworded and tested next round) | n/a | Built at `StatusBanner.tsx:95-96`, shown through `warningText` inside one `<UserText>` for the whole sentence (`StatusBanner.tsx:212`), as for every other warning. The project name is filled from `state.integrityWarnings` (the name, or "a project"). No path can reach it: the `detail` (which holds the transaction id) is never shown by `warningText`. |
| R479 b seam | Inert outside tests | holds by reading (M3) | No test proves it. |

## Judged only by reading
- Seam inertness (M3).
- The move/close behaviour of the integrity confirmation (M5).
- The UI picking up a late-recorded FR-423 warning.
- Large files in `changedSinceMarker`: it reads a whole file into memory. Such a file was already held in memory when it was written.
- Encrypted projects: the marker hash is of the ciphertext written, so no key is needed at the reopen.
- `holdsTurn()` is true in callbacks a turn started, even after that turn ends. This pattern existed before.

## Second look (R484 A, R491 C)

Head 0cacb9f: eight commits, 54b9f25..0cacb9f. The brief is `task-RE1d-brief.md` and the report is `task-RE1d-report.md`.

**Verdict: APPROVED WITH SMALL POINTS for this round's own changes. Batch 1 as a whole is NOT whole:** one **Critical, older than the round** (C1 below) loses a researcher's annotations with no hand edit involved. It needs a ruling before batch 1 can be called whole.

### What I ran
- **Probe** `packages/library/src/repo/rollback2.probeRE1b.test.ts`, since deleted. Q1 fails (C1). Q2 passes: the occupied-trash rule holds across three reopens, a refused resolve, and a final completion.
- **Test files, each run alone; all passed:**
  - `rollback-own-writes` 14/14
  - `integrity-confirm-batches` 6/6
  - `integrity-confirm` 5/5
  - `seams-inert` 3/3
  - `sources-read-race` 13/13
  - UI `StatusBanner` 52/52
  - service `server.test.ts -t "integrity|R491"` 3 passed
- **Guards taken out, one at a time, then put back with `git checkout`:**
  - The occupied-trash `ok = false` (`txn.ts:222`): 3 of 14 tests fail.
  - M4's hash rule: 1 test fails.
  - Each seam's `NODE_ENV` gate in `seams-inert`: 1 test fails per seam.
  - In `changedSinceMarker`, each of these taken out alone fails nothing, because the rules overlap: `putBack`, accepting the change's EARLIER writes, and the skip for a trashed path the change did not refill. Each case is still caught by another rule: the backups of later "replaced" lines, or the check that a path's last write has no hash. So no false report comes back. But no one of these three rules is held by a test of its own.
- **Final state:** `git status --short` is empty, and no implementer work is uncommitted.

### Findings

**C1, Critical, older than this round (the roll-back runs twice; `txn.ts:211` and the "trashed" step).** A "created" undo is not safe to run twice when the same path was also trashed.

- **Probe Q1:**
  1. One change empties a source's annotations (the annotations file is trashed), then writes annotations again (the file is created).
  2. The change fails, and its in-process undo fails at "replaced".
  3. That undo already deleted the change's new file and moved the original annotations back from the trash. The trash copy is now gone, and the marker is kept.
  4. At the reopen, the roll-back runs again. The "created" step deletes `annotations.json` again: by now that file is the researcher's ORIGINAL annotations.
  5. The "trashed" step then finds no trash copy and does nothing. The outcome is "rolled-back" and the marker is removed.
- **Result:** the source's annotations are gone for good. Neither the file nor a trash copy remains. The only warning is `rolled-back-incomplete-write` ("…nothing half-saved was kept"). The next read says the annotations "could not be read".
- **No hand edit is needed.** A crash during the reopen's own roll-back, cut after the trashed step was undone, reaches the same point.
- **What this round changed:** nothing in the steps involved. R491 C a now keeps markers through partial roll-backs in a new case, which means more re-runs. In my Q2 shape, though, re-running is safe: `replaced` restores the same backup, a trashed step whose copy is gone does nothing, and `created` deletes what is already absent.
- **Direction:** the remedy R491 listed as FR-735 (a "created" undo removes only bytes the change wrote, by hash) closes this case too. It is a data-loss case with no outside edit, so it should not wait as a listed item.

**M8, Minor (M6, R484 f): the "N sources" count can be too low.** A `source-change-unfinished` warning is recorded only when a source is READ. So the count is the named sources read so far, not the sources the change named, and before any read there is no banner. On the "this source" constants: no screen shows them. They are the warning's `detail` only, and the `detail` is never shown. R484 f's "where they are said on the source's own screen" has no such place. The implementer says so too.

**M9, Minor (R491 C a): the words shown while a trashed path is occupied.** I judged these by reading, together with the Q2 output.

### Item by item

| Point | Verdict | Note |
|---|---|---|
| I1 (R484 a) | holds | P1 and P2 give no false report. The reverse order and 54b9f25's case are tested. A real edit is reported once, never twice. Equally a crash during the reopen's roll-back followed by a real edit: reported once. The earlier state is put back in every tested case, but C1 is a case where it is not. **Blindness:** a real edit equal to one of the change's earlier writes is missed. This does not matter: those bytes are the app's own half-written state, and the roll-back replaces them with the earlier state. |
| R491 C a | holds | **Occupied trashed path:** the step is not done, the marker and trash copy are kept, nothing is overwritten, and no outside-change warning is raised. Removing the hand-put file lets a reopen finish: the original is back, then the trash copy and marker are gone. A second and third reopen change nothing. **Resolving from the list** refuses with `PendingWriteIncompleteError`: "The change could not be undone completely: a step failed. The choice is recorded; try again, or reopen the library." **The sweep** deletes `trash-*` only when no marker is left (`repo.ts:535`). `retention.strayCopies` skips trash with a live marker. A commit purges only its own trash. `removeMarker` is called only after a complete undo or resolve. A move does not remove project markers. **Re-runs:** replaced, append (the project is blocked, so nothing is appended), dir and trashed are safe to run twice. `created` is not, see C1. **Read-only open:** nothing is written, and `incomplete-write-pending` is raised. |
| M1 / R479 a | holds | An annotations file found changed is recorded as `changed-outside-before-rollback`. The banner's words match R479 a exactly (`StatusBanner.tsx`). The project name goes through the usual `UserText`, and the `detail` is not shown. |
| M6 | holds (M8) | One banner per project and kind, with the four ruled sentences. |
| M5 + R491 C b | holds | Each source is read once. A batch is at most 200 sources per turn. The signal is checked between batches. The close check runs before the turn is asked for and again inside it. A close or move gives 409 CONFLICT with the ruled sentence, only when the session is gone or replaced. A library really open read-only keeps its own answer. |
| M4, M3 | holds | Each new test fails with its guard taken out. |

### Point 4, my line
The `rollback-incomplete` banner ("…was undone when the library opened, so nothing half-saved was kept") is false. In the occupied-trash case, these are the other things the researcher can be told, and each is false or unhelpful:
- **The source's banner,** once the source has been read: "Close the library and open it again to put it back". Reopening never helps while the hand-put file stays.
- **The list of interrupted changes:** the refusal "a step failed… try again, or reopen".
- **What is never said:** that a file at that place blocks the undo.

None of these is false in a way that loses data. Nothing tells the researcher to delete anything, and no instruction reaches the kept trash copy. The researcher ends up stuck, but loses nothing. They should still be told what blocks the roll-back, and the banner should stop claiming "nothing half-saved was kept". I recommend listing both.

## Third look (R493)

Head 435bc78. Two commits: 0cacb9f..435bc78. The worktree is clean.

**Verdict for `re-1b-core` as a whole: APPROVED WITH SMALL POINTS.** C1 is fixed.

### What I ran
Each test file was run alone:
- `rollback-rerun`: 7/7
- `rollback-own-writes`: 14/14
- `sources-read-race`: 13/13
- `pending-writes`: 22/22
- `repo.test`: 61/61
- `integrity-confirm`: 5/5
- `seams-inert`: 3/3

I then took the fix out. Only the line `if (done.has(i)) continue;` was removed, so the test seam still works. The run gave 4/7 failing:
- the Q1 test and the crash-in-reopen test;
- 11 enumeration cases per run, all "reported complete with the path gone". These are exactly the trash-then-create/append families: [trash,create], [trash,append], [trash,create,trash|replace], [trash,append,trash|replace|append], [append,trash,create|append].

Afterwards `txn.ts` was restored with `git checkout`. No probe file was needed.

### Points

**1. Q1 and the crash during the reopen's own roll-back: fixed.**
- The annotations are back byte for byte, and the source reads "first" and "second".
- No marker is left.
- A second and a third reopen leave the same state.

**2. The rule as built.** I confirm it by reading.
- Every forward step records its line before it acts.
- Only the following remove trash copies, and none of them while a marker stands:
  - the commit purge (after the marker is gone);
  - the sweep (only with no marker left);
  - a committed marker's finish (never rolled back);
  - `retention.strayCopies` (skips trash with a live marker).
- `removeMarker` never touches trash.
- A move refuses while any marker stands (`move.ts:322`).

Edge cases:
- **A hand-deleted trash copy (Minor, M10).** Later lines at that path are now skipped. For [trash, create], this keeps the change's own written bytes at the path, and the outcome is reported "rolled-back" with no warning. Before the fix, the path was emptied. The original was already lost by the hand deletion either way, so nothing more is lost. But the change's half-written content now stands as if it were the earlier state.
- **When the existence check throws.** The later lines are skipped and the roll-back is marked incomplete, so the marker is kept. That is the safe direction.
- **The folder case (Minor, M11; a latent hole).** `dir` lines at the trashed folder's own path are skipped, which is right. But a file inside a folder that was trashed and then made again gets a "replaced" line once it is written a second time: `TxnLog.replaced` does not check `inNewDir`. That line is not at the same path, so it is not skipped. On a re-run after the original folder was put back, it would write the change's first write over the original file.
  - The only caller that trashes a folder is `deleteSourceInTx` (`sources.ts:898`). The folder name carries the source id, and I found no change that makes the same folder again afterwards.
  - So it is unreachable today, and I agree it can be listed. The direction for the fix: skip lines at or under the trashed path.

**3. The enumeration is a real proof, within its scope.**
- It uses the real `repo.mutate`, `tx.trash`, `tx.writeFile` and `tx.appendLine`, on real files.
- It cuts the first roll-back after every step, including after all steps (the Q1 crash shape).
- It runs a second roll-back to the end, and then a third.
- It asserts that each case either ends "complete and byte for byte as before" or ends incomplete with the marker and its copies kept.

The loosening (a trash copy may be gone if something is at its path) lets no loss through:
- With the fix, nothing later at that path is undone again.
- An earlier line, if refused as unverifiable, does not run.
- So the trash copy's content is what stands at the path, and in the append cases the original can still be recovered from the kept backups.

Two weaknesses:
- That alternative checks only that something is present at the path, not that it is the copy's bytes.
- The enumeration covers one file path only: no folders, no `dir` lines, so M11 is not exercised.

Both are Minor and need no action now.

**4. Yes, there is a caller that appends to and rewrites the same file in one change.**
- In `find/queue-store.ts:677-699`, a torn last line of the Find queue is cut by `tx.writeFile`, which records "replaced". The same change then calls `tx.appendLine` on the same file. That is the [replace, append] shape.
- It reaches "refused as unverifiable" only when a torn line meets an undo that fails, or a cut after the undo.
- Nothing is lost then, but the project is blocked.
- It is rare and real, so listing it is right. All other appends go to logs and journals that are never rewritten in the same change.

**5. The earlier guarantees of this branch still hold** (the runs above).
