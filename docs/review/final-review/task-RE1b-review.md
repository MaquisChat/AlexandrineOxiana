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
