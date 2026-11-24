# KG-1a: second look at the fix round (R509: I1, M3, M4)

Checkout `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1-look`, detached at ad99c57. I judged 067e199..ad99c57 (f6e4910 I1, 908d400 M3, ad99c57 M4) and nothing else. I changed no product code and committed nothing. The one probe was deleted, every scratch edit was restored, and `git status --short` is empty. The old worktree was not touched.

**Verdict: APPROVE.** Nothing is Critical or Important. Two Minor points follow; neither needs a fix before the join.

## I1: deleting a source, a duplicate's "merge" or "skip", and an import's undo repair the queue first

**One repair function.**
- `mendFindQueueTail` (`find/queue-store.ts:736`) is the only repair. `repo.ts`'s `mendFindQueue` is a one-line wrapper, because the import code holds a `Repo` and not a `RepoCore`; it is not a copy.
- The test seam `mendSeams.afterMend` moved into the function. It fires at the same point for the queue's own appends, and now for every caller.

**The three places, and nothing else touched.**
- **Deleting a source:** `sources.ts:914`, before `runMutation`. The service route `DELETE …/sources/:sid` goes through it.
- **A duplicate decision:** `import/bulk/review.ts:162`, for "merge" and "skip" only, which are the two branches that call `ops.deleteSource`.
- **Undoing an import:** `import/bulk/undo.ts:211`, before each source's removal. This is the undo's only `ops.deleteSource`.
- **The swallow** of `TornFileError` in `review.ts:recordRemovedLine` is gone.
- **Every way in, checked again:** a grep of `deleteSourceInTx`, `.deleteSource(`, `resolveEntriesOfRemovedSource(` and `appendFindLinesInTx(` across `packages` and `apps` finds no other way in. The places my first review marked sound (the hold, both held-file decisions, the entry's removal, `appendFindEntries`, the register) are untouched.

**Crash between the repair and the larger change.** This is tested for all four ways (delete, skip, merge, undo) through `mendSeams.afterMend`. In each case:
- the queue is whole and no marker is left;
- the source, the held file, the pending entries and the entry's `needs-check` state are untouched;
- a second try does no repair and writes the "record-removed" line.

**Crash inside the repair.** It is the same function whose before-changes, before-audit and before-marker-delete crashes, with the reopen's roll-back cut, are proven in `queue-store.test.ts` (15 cases, plain and sealed). It is not repeated per way, which is acceptable.

**The repair refused or failing.** The larger change never goes ahead without it: the old swallow did not come back under another name. Each case, by reading:
- **Read-only library.** `deleteSource` asserts writable first. For the decision and the undo, the repair runs `runMutation` only when the queue is torn, and that raises the same `ReadOnlyLibraryError` the change itself would raise.
- **Locked project.** `deleteSource` and the repair assert unlocked first; the decision reads the source before the repair.
- **Full disk.** The repair's error propagates and the removal is not begun. The service gives its existing "The disk is full. Free some space and try again." In an undo, the loop stops at that source, as a failing removal stopped it before.
- **A queue still torn inside the removal** (only after another crash): the removal is refused, and the service gives "A library record is damaged; see the library's integrity warnings." Nothing is lost.

**"The engine always allows deletes": true.**
- `core/governance/engine.ts:421-425` returns `allow` for `delete`. Delete and undo can therefore be refused only before the repair, or by a governance file that cannot be read, which denies the repair's own `store` request first.
- The decision's own `store` requests can be refused. The test covers both "skip" and "merge" (a legal basis newly required):
  - the queue is left repaired, and nothing else changes;
  - the audit holds a `store` entry with op `project.find.repair` and `{ bytes }`, then the decision's audited deny;
  - that repair entry is true: the torn line was an earlier crash's, and cutting it is what every later change would do;
  - no screen shows ops. Not plain wording, but researcher-facing text is not involved.

**Tests.** `review-held.test.ts` now asserts the `no-open-copy` / `record-removed` line for each of the four ways, and that the repair is exactly once and first.

**Guards** (scratch edits, each restored):

| Repair removed from | Tests that fail |
|---|---|
| `deleteSource` | 2 |
| the decision | 6 (skip and merge, 3 each) |
| the undo | 2 |

## M3: the 26 legacy shapes are back

**Construction.** `legacySteps` writes the marker as the 579bdcd transaction did:
- a trash goes to `.tmp/trash-<txn>-<hex>`;
- a rewrite records "replaced" with a backup copy and its mode, or "created", each with its hash;
- an append records the size before it once per file, and again after a trash. This matches `TxnLog.trashed` clearing `appended`.

A separate test proves `markerHead` equals the transaction's own head. Every case also asserts that the marker is never found invalid.

**Assertions.** Diffed against `git show 579bdcd:…/rollback-rerun.test.ts`, `judge` is identical, line for line. Nothing was weakened, and two checks were added:
- the marker is never found invalid;
- the cut in-process roll-back must not report complete.

The counts hold: 6/6/45/37 = 94 legacy cases, plus 85 = 179.

**The 15 that block.** I reproduced them with a logging copy of the test (deleted). At the first reopen:
- **15 cases** are `txn-recovery-skipped-audit-unverifiable`, with the marker kept;
- **12 cases** carry the false "changed outside the app" warning;
- the rest roll back cleanly.

All 15 come from the undo's end-of-file check on the append line (`offsetProblem`, unchanged):
- **8 because the file "does not end a line where the change recorded it began":**
  - [replace, append] cut 2
  - [trash, create, append] cut 3
  - [replace, replace, append] cut 3
  - [replace, append, trash] cut 3
  - [replace, append, replace] cut 3
  - [replace, append, append] cut 2
  - [append, replace, append] cut 0
  - [create, append, replace] cut 0 (from no file)
- **7 because the file "is now shorter than when the change began":**
  - [append, replace] cut 0
  - [append, trash, create] cut 0
  - [append, replace, trash] cut 1
  - [append, replace, replace] cut 0
  - [append, replace, replace] cut 1
  - [append, append, replace] cut 0
  - [create, replace, append] cut 2 (from no file)

**It is the blocked state FR-738's entry described.** The audit cannot be checked, the change is refused at every opening, and it cannot be resolved from the list. In the enumeration it happens because the contents are not prefixes of each other: the step's own text against the original.

**The queue's own repair never reached it.** Its shape was [replaced, append], and the cut is always a byte prefix of the torn file ending in a newline, so the check always held (first review). The register's was the same shape and the same argument.

**Plainly:** this state exists only in a library that holds a marker of a mixed shape left by an older build, with contents that are not prefixes of each other. No change of the app can start such a change now. The coordinator's later task, letting the researcher close such a change, is the remedy.

## M4

- **Seams.** The register's twelve crash cases are honest:
  - the cut's change crashes through the transaction's own `seams.crashAt`;
  - the add's change crashes through the test-only `registerMendSeams.afterMend` (NODE_ENV=test), which arms `seams.crashAt` after the cut has committed;
  - `expect(seams.crashAt).toBeUndefined()` proves each crash fired.
- **True states.** Each case waits on true resting states: a reopen, then the file's bytes compared exactly, the register's entries, a retry, and a later write. There is no sleep and no retry loop.
- **The tests match my probe and go further.** They also assert that nothing is brought in twice (2 lines after the retry) and that no origin is lost (`a` unchanged).
- **The developer's error.** `MIXED_WRITE` now says what is wrong, why, and what to do. It names no ruling, and the test asserts `not.toMatch(/\bR\d+/)`.

## Runs (each alone, `nice -n 15`)

| File | Result |
|---|---|
| `review-held.test.ts` | 67/67 |
| `queue-store.test.ts` | 81/81 |
| `watch-register.test.ts` | 30/30 |
| `lock-mid-read.test.ts` | 44/44 |
| `rollback-rerun.test.ts` | 15/15 (includes the 94 legacy cases) |

## Minor

**m1: No test of a full disk or an unreadable queue during the repair for the three new callers.** By reading, each stops before its own change, with the existing sentences. A one-case test for `deleteSource` would hold that the swallow cannot come back.

**m2: The mixed-shape blocked state stays reachable from an older build's marker.** This is what R509 expects, and the task the coordinator names will close it. It is recorded here so that it is not read as a regression.

## Could only judge by reading
The repair refused because the library is read-only, the project is locked, or the disk is full, for the three new callers.
