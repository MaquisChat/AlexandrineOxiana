# KG-1a: adversarial review (FR-738, FR-737; R503 a, b; R505 b)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1`, branch `kg-1-rollback`, 579bdcd..067e199 (e4bbc18 FR-738, 067e199 FR-737). Nothing changed or committed. Both probe files were deleted, every scratch edit was restored with `git checkout`, and `git status --short` is empty at the end. No permission check refused anything.

**Verdict: APPROVE WITH SMALL POINTS.** Nothing is Critical. One finding is Important, and R505 b already rules it for the fix round. Four findings are Minor.

## What I ran (single files, `nice -n 15`, `@ao/library`)
- `src/repo/rollback-rerun.test.ts` 14/14 · `src/find/queue-store.test.ts` 81/81 · `src/repo/review-held.test.ts` 58/58 · `src/repo/watch-register.test.ts` 18/18.
- **Probe `src/repo/txn.probeKG1a.test.ts`** (6 cases, deleted):
  - a sibling path that only looks nested;
  - a folder trashed, made again, trashed again and made again, with a file moved to another folder, at every cut of the first roll-back, then a second and a third run;
  - a put-back original whose bytes equal the change's own write, tested at `undoEntries` level and through the real API;
  - the kept copy deleted by hand with a different file at the path, and with nothing at the path.
- **Probe `src/repo/watch-register.probeKG1a.test.ts`** (12 cases, deleted): a torn register, plain and sealed, with a crash at before-changes, before-audit and before-marker-delete of the repair's change and of the append's change, then a reopen and a further write.
- **Guard checks by scratch edit**, each restored at once. The named tests failed each time:
  - the "at or under" rule removed: R503 b 1 failed (3/3);
  - `ownBytesAt` removed: R503 b 2 failed (1 failed; the R493 control still passes);
  - `refuseMixed(…, "append")` removed: R503 a failed (both orders);
  - `mendFindQueueTail` removed from `appendFindEntries`: 3 queue-store R503 tests failed;
  - the mend removed from the hold: the review-held R503 test failed;
  - `mendTail` removed: the watch-register R503 test failed.

## Findings

### Important

**I1: FR-738 / R505 b. Inside a larger change, a torn queue still loses the entry's "record-removed" line. The new test asserts this gap.**
- **Where.** `packages/library/src/repo/review.ts:344-359`. `recordRemovedLine` swallows `TornFileError`. Nothing mends the queue before these changes, which reach it through `deleteSourceInTx` (`sources.ts:891-896`) and `resolveEntriesOfRemovedSource`.
- **Behaviour today, at every place a queue or register line is added inside a larger change:**

| Place | Mended first? | With a torn last line, now |
|---|---|---|
| Deleting a source: `repo.deleteSource`, service `DELETE …/sources/:sid` (`apps/library-service/src/routes/sources.ts:251`) | **No** | The held file is destroyed and the review entry is resolved "source-removed". The queue entry keeps its earlier state (e.g. `needs-check`) and gets no "record-removed" line. The torn line stays until the queue's next change cuts it. |
| A duplicate decision in an import's review, "merge" and "skip" (`import/bulk/review.ts:203`, `:207` → `ops.deleteSource` → `deleteSourceInTx`) | **No** | Same as deleting a source. |
| Undoing an import (`import/bulk/undo.ts:210`, decision "undone") | **No** | Same as deleting a source. |
| Holding a found file (`holdMismatchedFile`, `review.ts:623`) | Yes | Repaired, then the hold. |
| Attaching or discarding a held file (`resolveHeldFile`, `:738`, `:775`) | Yes | Repaired, then the decision. |
| Removing the entry with its held file (`removeFindEntryWithHeld`, `:805`) | Yes | Repaired, then the removal. |
| The queue's own changes (`appendFindEntries`, `queue-store.ts:611`) | Yes | Repaired, then the append. |
| The watched-folder register (`recordWatchedFiles`, `watch-register.ts:279`; reached from `import/watch.ts:976`, `:2815`, `:2828`) | Yes | It is always its own change: the register is never appended to inside a larger change. |

- **No other place adds a queue or register line inside a larger change.** `appendFindLinesInTx` has no other caller. Moving a source to another project and merging sources outside an import do not exist as library functions.
- **The test that holds the gap.** `review-held.test.ts`, the "R503 a" test "deleting the source is not stopped by it", asserts `stateOf(w) === "needs-check"` after the deletion. The fix round must change it to assert the "no-open-copy / record-removed" line.
- **Direction.** Call `mendFindQueueTail(core, projectId)` before the `runMutation` of every top-level change that can reach `deleteSourceInTx`: `deleteSource`, the import-review decision's `importChange`, and the import undo's `importChange`. A cheap way is a mend of the queue, when a queue file exists, at the start of each of those entry points. Then drop the `TornFileError` swallow, so that a queue still torn there refuses loudly rather than dropping the line.

### Minor

**M1: FR-737 (2). A put-back original whose bytes equal the change's own write is held "incomplete" for ever.** (`txn.ts:225-235`, `:262-266`)
- **What happens.** `ownBytesAt` tells "the change's own bytes" from "the original put back" by hash only.
- **Probe.** The change trashes `kept.txt` and writes the same bytes back. It crashes before-audit. The reopen's roll-back is cut just before the marker goes, so the original has been put back. Results:
  - every later reopen keeps the marker and raises `rolled-back-incomplete-write`;
  - `resolvePendingWrite(…, "roll-back")` refuses with "The change could not be undone completely: a step failed. The choice is recorded; try again, or reopen the library.";
  - `undoEntries` returns false on every run.
- **The only way out** is to remove the researcher's ORIGINAL from the path by hand. Advice that FR-736 (KG-1c) might write ("move the file in the way aside") would lead there.
- **Reachability.** I found no change of the app that writes back the trashed bytes unchanged:
  - an encrypted write never repeats its bytes (fresh nonce);
  - the tombstones' set-aside writes a new secret;
  - an unreadable annotations file is replaced by valid JSON.
  So this is latent.
- **Direction.** Have the "trashed" line carry the trashed file's hash. KG-1b adds hash lines anyway. Treat a file at the path equal to it as put back. Or skip the check when the recorded write's hash equals that original's hash.

**M2: FR-737 (2) is built only for writes with a recorded hash. The neighbours are still reported as undone.**
- **Probe results** (the kept copy deleted by hand):
  - a **different** file at the path: the marker is removed, the file stays, the outcome is "rolled back";
  - **nothing** at the path: the same.
- In both, the researcher gets the banner "…was undone…, so nothing half-saved was kept", while the original is gone.
- A file the change **copied** (`tx.copyFile`, no hash) behaves the same way. The implementer says so and leaves it to KG-1b's completion hash.
- **What R503 b 2 rules, and what holds.** It rules only the change's own file, so none of these breaks it. "Gone" and "could not look" are told apart, and each fails the safe way:
  - `exists` throwing (permission) gives `ok = false`, the later lines skipped, nothing deleted;
  - an unreadable file at the path throws in `sha256File`, which also gives `ok = false`.
  - These two I judged by reading only: the machine runs as root, so permissions cannot be probed.
- **Direction.** KG-1b feeds its completion hashes to `ownBytesAt`. KG-1c makes the sentences true for the hand-deleted-copy cases.

**M3: The R493 enumeration no longer covers undoing the 26 mixed shapes.** (`rollback-rerun.test.ts:372`, `:433-463`)
- **Why they left.** The 26 sequences that left the roll-back enumeration are exactly those with an append and a create or replace at one path (`mixed`). Each is unreachable now, because `TxnLog.refuseMixed` throws at the first offending step, before it records or writes. The prefix sequences stay enumerated. A crash in the refused change's in-process undo leaves a marker equal to an enumerated prefix. The fall from 179 to 85 cases is therefore honest for new changes.
- **What is lost.** Markers of those shapes written by 579bdcd's code (the queue's and the register's cut-and-append) can still be on a disk. Their undo is no longer enumerated, and FR-737's two new rules apply to them too.
- **Direction.** Keep the 26 shapes enumerated at `undoEntries` level with hand-built markers, as R503 b 1's test does.

**M4: The register's split has no crash test of its own, and the developer error names a ruling.**
- **No crash test.** `watch-register.test.ts` checks only the two audit entries. My probe of 12 crash points, plain and sealed, passed every time:
  - the register is whole each time: the torn line is still there, or cut, never half;
  - no marker is left;
  - no outside-change or "could not be checked" warning appears;
  - the next write succeeds;
  - a line is lost only when its own change was not committed, as before.
  The test that holds this belongs in the file.
- **The developer error.** `MIXED_WRITE` (`txn.ts:91`) says "(R503 a)". Through the service it becomes the generic 500, "Something went wrong. Nothing was changed by this request unless it says otherwise." That sentence is true, because the in-process undo is complete. The CLI, however, prints an unknown error's message raw (`apps/cli/src/index.ts:170`).
- **Reachability.** No production change reaches the refusal today: I checked every `tx.writeFile`/`tx.copyFile` target against every `appendLine`/`appendChanges`/audit append.
- **Direction.** Drop the ruling number from the message.

## Checked and sound
- **The refusal** (`txn.ts:150-153`, called first in `created`, `replaced` and `append`):
  - **Ordering.** It is raised before the offending step records or writes anything. In `appendLine` the only earlier act is `tx.mkdir` of the file's folder, which already exists for a file that was written whole.
  - **Clean-up.** `runMutation` undoes what came before in the same process and removes the marker (the R503 a tests check bytes, marker and `.tmp`).
  - **Callers, every one checked:** `mutate.ts:258-270, 287, 483, 520`; `projects.ts:180`; `restore.ts:808`; `pending-writes.ts:197, 253`; `library-audit.ts:52`; `state.ts:319`. Also every `tx.writeFile`/`tx.copyFile` of `packages/library/src`: the review file, batch and capture journals, `audit-reasons`, the change log, the audit segments, the queue's compaction and every `*.jsonl`.
  - **Result.** Only the queue and the register ever rewrote a file they appended to. Both are split. No caller throws now.
  - **The undo's check.** `offsetProblem` is unchanged.
- **FR-737 (1):**
  - **Look-alike paths.** `a/b` against `a/bc` is not skipped: the probe's `Fc` is removed and `F` is kept.
  - **Trailing slash.** Marker paths are normalised by `toRel`, and `markerProblem` rejects other paths.
  - **A folder trashed twice with a file moved out.** Every cut, then a second and a third run: the original comes back byte for byte, and the moved file is removed.
  - **Can the rule skip a step that must be undone?** By reading, no: a line under a put-back trashed path can only describe something inside the remade folder, which the folder's `dir` undo removed as a whole.
  - **Case on a case-insensitive disk.** The comparison is case-sensitive, which is the old behaviour, so nothing regresses. The app never writes paths that differ by case. Reading only.
- **FR-738's split (queue)** is tested at 15 crash cases, plain and sealed, with the reopen's roll-back cut. Compared with the old single change:
  - nothing is lost that it kept: a crash between the two changes equals a crash before the old one, and the torn line was cut either way;
  - each change is audited: the repair as `store`, op `project.find.repair` / `project.watched-folder.repair`, `{ bytes }` (`{ watch, bytes }` for the register). True and plain; no screen names ops.
  - each change is governed by the queue's own `store` request, so a project's rules can refuse the repair only where they would refuse the append itself;
  - read-only and locked projects refuse before the repair;
  - the R379 lock-race tests pass (the implementer's run). I did not re-run `key-lock-race.test.ts`.
- **Item 6: FR-738's blocked state.** I confirm the implementer by reading the old code (`git show 579bdcd:packages/library/src/find/queue-store.ts`, :677-699):
  - The cut is `raw.subarray(0, lastIndexOf('\n') + 1)`. The append's `prevSize` is that length, so every state the file can be in after any crash or partial undo meets `offsetProblem`'s condition: the torn original, the cut, or the cut plus appended bytes. That condition is size ≥ prevSize and a newline at prevSize-1.
  - A torn multi-byte character or a line torn inside its seal changes nothing: the test is byte-wise, and the cut is a byte prefix ending in a newline.
  - A file with no newline gives prevSize 0, which is skipped.
  - I did not swap the old code in to run it. The argument is complete at byte level.
- **Existing tests changed:**
  - The R493 enumeration change is honest (M3).
  - `review-held.test.ts` and `watch-register.test.ts` only add tests; no assertion was loosened. The one new assertion of the gap is I1.
  - The new tests wait for true states (reopens and file contents), with no sleep or retry. `mendSeams.afterMend` is honoured only under NODE_ENV=test, and is cleared in `afterEach`.

## Table

| FR | Implementer's claim | Verdict | Note |
|---|---|---|---|
| FR-738 (refusal) | Refused before anything is written, either order; only the queue and the register mixed | **holds** | All append callers checked; none throws in production. The message names R503 a (M4). |
| FR-738 (split) | Repair and append are two governed, audited changes; crash-safe | **holds** for the queue and the register | Register crash cases probed (M4: no test there). |
| FR-738 (R505 b) | A torn queue inside a source deletion loses its "record-removed" line | **does not hold** against R505 b (as reported) | I1: three entry points, none mended. |
| FR-738 (blocked state) | Does not reproduce | **holds** | By reading, byte-prefix argument. |
| FR-737 (1) | At-or-under skip | **holds** | Look-alikes and a folder trashed twice probed. |
| FR-737 (2) | Own file at the path and copy gone → incomplete, nothing deleted | **partly** | Correct for hashed writes. A false "incomplete" for identical bytes, stuck for ever (M1). Copied files and other neighbours still "undone" (M2). |
| rollback-rerun 179→85 | Mixed sequences unreachable | **holds** | Legacy markers lose enumeration coverage (M3). |

## What I could only judge by reading
- Permission failures. Root ignores modes, so "could not look" is judged from the code: `exists` and `sha256File` throw, which gives `ok = false`.
- Case-insensitive disks.
- The old code's blocked state: not executed.
- The R379 lock race: not re-run.
- What the Find screen offers for a `needs-check` entry whose held file was destroyed with its source (I1).
