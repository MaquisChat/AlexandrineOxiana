# Task RE-1d — report (Ruling R484 A, with R479 a)

Worktree `.claude/worktrees/re-1b`, branch `re-1b-core`, 54b9f25..b9cdb0a. Six commits, one per point. Not pushed.

| Commit | Point |
|---|---|
| 11260bd | 1. I1 (R484 a): the app's own writes are not taken for outside changes |
| df6dffe | 2. M1 (R484 b) and R479 a: the kind and the sentence |
| 5463aa5 | 3. M6 (R484 f): one banner per project and kind |
| 80bb617 | 4. M5 (R484 e): the integrity check's confirmation |
| 2c0c3b3 | 5. M4 (R484 d): a test for the hash-finding rule |
| b9cdb0a | 6. M3 (R484 c): the seams are inert outside the tests |

## 1. I1 (R484 a)

**Change.** `packages/library/src/repo/txn.ts:566-622`, `changedSinceMarker`. Marker lines are now grouped by path, and each path is judged once:
- **A trashed path whose trash copy is gone** was put back by the app's own roll-back, so it is never reported.
- **A trashed path whose trash copy is still there** is reported when something is at the path again, unless a later step of the change wrote at or under that path. This keeps 54b9f25's guard.
- **A written path** is judged against its first line's "before" state and the change's own writes:
  - not reported if it is absent;
  - not reported if its hash equals any hash the change wrote there (the last write first among them);
  - not reported if it equals the content of a backup kept by one of its "replaced" lines (the state before the change, or an earlier write of the change);
  - otherwise reported.
- **A path whose last write has no hash** (a copied file) is not judged, as before.
- The roll-back itself (`rollBackMarker`, `undoEntries`) is unchanged.

**Goes one step beyond the ruling's wording.** The ruling says to judge "against the first line's before and the LAST write's hash". I also accept an EARLIER write of the change. The brief requires a test of a crash during the reopen's own roll-back, followed by a second reopen. When that crash comes half-way through undoing two writes of the same file, the file is left holding the change's first write: neither the state before nor the last write. Under the literal rule it would be reported as an outside change, against the point's title ("the app's own writes are never reported"). The test "cut while the source still holds the change's first write" covers this case. If the coordinator wants the literal rule, that test must go, and that false report comes back.

**Tests** in `packages/library/src/repo/rollback-own-writes.test.ts` (new), 9 cases under "R484 a":

| Case | At head (54b9f25) |
|---|---|
| P1: a source written twice, the in-process undo fails at "replaced"; reopen gives no outside-change warning, and the earlier state comes back | failed first (2 false warnings) |
| P1 with a real hand edit of `source.json`: reported exactly once | failed first (3 warnings) |
| P2: an original trashed, then a source write, then the failure; reopen gives none | failed first |
| P2 with a real hand edit: reported exactly once | failed first |
| Reverse order: a file trashed, then written again by the change (54b9f25's case) | passes at head; fails with 54b9f25's guard removed (checked against `54b9f25^:txn.ts`) |
| Reverse order with a real edit of that file: reported once | passes at head; guard against going blind |
| Crash during the reopen's roll-back (simulated by undoing the marker's last steps with `undoEntries`, then reopening): the source holds the change's first write | failed first |
| Same crash, cut after the trashed original was put back | failed first (3 false warnings) |
| Same crash, then a real hand edit before the second reopen: reported once | passes at head; guard |

Every case asserts that the earlier state is put back: `source.json` is byte-identical to before, the notes are "first" and "second", the original's bytes are unchanged, and no marker is left.

## 2. M1 (R484 b) and R479 a

**Changes.**
- `packages/library/src/repo/repo.ts:633-643`: every file a roll-back finds changed outside the app is now recorded as `changed-outside-before-rollback`, annotations files included.
  - `annotations-hash-mismatch` is still recorded by a source read (`sources.ts:275`), which is where annotations ARE shown as they are now.
  - The `detail` (never shown to the researcher) now reads: "A file was changed outside the app while an interrupted change waited to be undone; the state before that change was put back (transaction …)".
- `packages/ui/src/components/StatusBanner.tsx:101-104`, the new banner sentence:
  > "A file in <project> was changed outside the app while a change the app had not finished was waiting to be undone. When the library opened, the app undid its unfinished change, and the outside change to that file was not kept."

  The project name goes through `UserText`, with the whole sentence inside one `UserText`, as for every banner.

**Tests.**

| Test | At head |
|---|---|
| `rollback-own-writes.test.ts` "R484 b": a hand-edited source record | passes (the kind already existed; it had no test, R479 a) |
| a hand-edited annotations file | failed first (`annotations-hash-mismatch`) |
| a trashed path filled again by hand | passes (kind only, see NEEDS A RULING) |
| `StatusBanner.test.tsx` "R479 a, R484 b": the exact sentence on a rendered banner; the project name's markup is text; the detail is not shown | failed first |

**Existing test changed:** `sources-read-race.test.ts`, "a file the marker names, changed by hand meanwhile …". It asserted `annotations-hash-mismatch`, the behaviour this point corrects. It now asserts `changed-outside-before-rollback`, and that no `annotations-hash-mismatch` is recorded.

## 3. M6 (R484 f)

**Change.** `StatusBanner.tsx`:
- `WARNINGS` functions take `(p, n)`, and `warningText(kind, project, count = 1)` passes the count.
- The banner variant gains `count`.
- `bannersFor` merges `source-change-unfinished` and `source-change-unfinished-read-only` into one banner per (projectId, kind), with the number of warnings, at the place of the first one.

New sentences, word for word:
- "A change to a source in <project> did not finish and could not be undone. Close the library and open it again to put it back."
- "Changes to N sources in <project> did not finish and could not be undone. Close the library and open it again to put them back."
- "A change to a source in <project> did not finish and could not be undone. It can be put back only when the library is opened for changes."
- "Changes to N sources in <project> did not finish and could not be undone. They can be put back only when the library is opened for changes."

**The "this source" sentences.** The two constants (`packages/shared/src/api/annotations.ts:110-111`) are unchanged and still used as the library's warning `detail` (`sources.ts:244`). **No screen of a source shows them.** I searched the UI and the service: source warnings reach the screens only through the library-state banner, and the `detail` is never shown there (R114 I1). R473 asked for them to be "shown where a source's warnings are shown"; no such place exists today. I left everything as it is and only state this.

**Tests** (`StatusBanner.test.tsx` "R484 f"): one source; several sources; both kinds in one project; two projects interleaved with another warning (order kept); the constants unchanged. The project name has markup and is checked to be shown as text. The 4 behaviour tests failed first.

## 4. M5 (R484 e)

**Change.** `packages/library/src/reconnect.ts:552-690`:
- **Batches.** `CONFIRM_BATCH_SOURCES = 200` (exported). `confirmFindings` groups the flagged entries by source folder, or by a locked project's manifest. Each batch of at most 200 groups is one `confirm` call (one turn), so the queue is left between batches.
- **One read per source.** `freshRecord` reads the source (or the manifest) once per group, and `stillWrong` judges each entry against that fresh record.
- **Cancel.** `signal.throwIfAborted()` runs before each batch.
- **Close or move.** `endIfClosed` runs before asking for a turn and again at its start. If the handle is closed it throws `ReadOnlyLibraryError`: reason "moved" when `MOVED.json` is at the root (a whole move), otherwise the handle's own reason. This follows the existing pattern for a closed handle (`import/watch.ts:2649`); a moved library's own handle gives `ReadOnlyLibraryError("moved")`.
- Reports keep the check's order. The R404 lock retry is unchanged.

**Tests** (`packages/library/src/integrity-confirm-batches.test.ts`, new). Source reads are counted by wrapping `readSource` with `vi.mock`. All 6 failed first.
- a source with 3 flagged files is read once in the turn;
- 450 flagged sources give three turns reading 200, 200 and 50 sources, and a turn asked meanwhile runs between batch 1 and batch 2;
- a signal aborted after batch 1: rejects with its reason, no second turn;
- a close after batch 1: `ReadOnlyLibraryError`, no second turn, the queue free;
- a close while the check waits for its first turn: the same;
- a move after batch 1 (`MOVED.json` written, the Sources folder taken away, the handle closed, as a move leaves it): `ReadOnlyLibraryError` with reason "moved", the queue free.

No timer is used anywhere, so none can be left.

## 5. M4 (R484 d)

`integrity-confirm.test.ts`, "R484 d": two files changed in place. The queue is held, and one file is replaced (new file renamed over it) between its hashing and the confirmation. Only the untouched file is reported. It passes with the rule and fails with the rule replaced by an unconditional `"mismatched"` (checked, then restored with `git checkout`). No code change.

## 6. M3 (R484 c)

`packages/library/src/seams-inert.test.ts` (new):
- `retentionSeams.afterScan` (through `listDestructions`) and `confirmationSeams.onRun` (through a read of a source whose annotations file is gone) are not called under `NODE_ENV=production`, and are called under `test`.
- Neither seam is among the package entry's exports.

The first two fail with the `NODE_ENV` guards removed (checked, then restored). The export test passes at head; it is a guard by nature.

## NEEDS A RULING

1. **A trashed path filled again by hand loses the original (found while testing point 2; it predates this round).**
   - **What happens.** A change trashed a stored original, its undo failed, and a file was put at that path by hand before the reopen. The reopen records `changed-outside-before-rollback` correctly. But `undoEntries` (`txn.ts`, the "trashed" step) moves the trash copy back only when nothing is at the path, so it leaves the hand-put file. The step still counts as success, the marker is removed, and `sweep` (`repo.ts:535`) then deletes `.tmp/trash-*` once no marker is left.
   - **Effect.** The researcher's original is lost, the hand-put file stays, and the ruled sentence ("the outside change … was not kept") is untrue in this case. This breaks the house rule that the earlier state is always put back.
   - **Why I did not fix it.** Making the undo overwrite the path is not safe as a small change. A later re-run of a "created" undo for the same path would delete the original just put back. It needs a decision on the roll-back's semantics.
   - **My test.** It asserts only the warning kind and that `source.json` is put back; it does not assert the stored original.
   - **Options.**
     - (a) Keep the marker, as `rollback-incomplete`, when such a path is found, so that the trash copy survives and the researcher resolves it.
     - (b) Move the hand-put file aside to the trash, then put the original back, and make the "created" undo remove only bytes the change wrote (by hash).

     I recommend (b), in its own task with its own review.
2. **The error at a close or a move (point 4).** At the service, `ReadOnlyLibraryError` becomes 409 READ_ONLY: "This library is open read-only, so nothing can be changed." That is an odd sentence for an integrity check. A split move (some projects moved, no `MOVED.json` at the root) gives the closed handle's own reason, normally none. Confirm this error, or rule a sentence of its own.
3. **Point 1 goes slightly beyond the ruling's wording** (earlier writes of the change are accepted too); the reason is given under point 1.

## Only a real Mac or a real service can show
- A real move during a check. The test reproduces what a move leaves at the old place, not a full move.

## Runs (single files, `nice -n 10`)
- Library roll-back, recovery, integrity, reconnect and retention files, together: `rollback-own-writes`, `sources-read-race`, `pending-writes`, `repo`, `annotations`, `workspace-tags`, `retention`, `integrity-confirm`, `integrity-confirm-batches`, `reconnect`, `seams-inert`, `retention-confirm`, `sources-confirm-bound`. Result: Test Files 13 passed (13); Tests 251 passed (251).
- `repo/lock-mid-read.test.ts`: Tests 43 passed (43).
- `StatusBanner.test.tsx` (ui): Tests 52 passed (52).
- `server.test.ts -t integrity` (library-service): Tests 2 passed | 147 skipped (149).
- Typecheck (`tsc`), each exit 0: `@ao/shared`, `@ao/library`, `@ao/library-service`, `@ao/ui`.
- `git status --short`: empty.

There are no `txn*.test.ts` files; the roll-back is tested through the files above.
