# KG-1a fix round: report (Ruling R509: I1, M3, M4)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1`, branch `kg-1-rollback`, from 067e199.
The commits are `f6e4910` (I1), `908d400` (M3) and `ad99c57` (M4). Nothing is pushed, and `git status --short` is empty. M1 and M2 were not touched: they move to KG-1b.

## Point by point

### I1 (R505 b): the repair runs first in all three removals (`f6e4910`)

**What changed.** Each removal now calls the queue's existing repair, `mendFindQueueTail` (`find/queue-store.ts:737`), before its own change begins. There is no copy of it. The repair is a governed change of its own, audited as `project.find.repair`.
- **Deleting a source:** `repo/sources.ts:913-915`, in `deleteSource`. This covers the service's `DELETE …/sources/:sid`.
- **A duplicate decision in an import's review:** `import/bulk/review.ts`, `decideReview`, for "merge" and "skip" only. The call goes through a thin package-internal wrapper, `mendFindQueue(repo, projectId)`, in `repo/repo.ts` (next to `importChange`), because the import code holds a `Repo` and not a `RepoCore`.
- **Undoing an import:** `import/bulk/undo.ts`, before each source's removal.
- **The swallow is gone.** `recordRemovedLine` (`repo/review.ts:~344`) no longer swallows `TornFileError`. If the queue is still torn at that point, the removal is refused loudly. A queue that cannot be read still never stops a removal, as before.
- **The test seam moved.** `mendSeams.afterMend` (test-only, NODE_ENV=test) now runs at the end of `mendFindQueueTail` instead of inside `appendFindEntries`. It fires at the same point as before for the queue's own changes, and now also for every caller.

**Tests** (`repo/review-held.test.ts`, block "R503 a"). Each was seen failing first: 10 of the new tests failed for the right reason.
- **The changed test.** The old test "deleting the source is not stopped by it … the entry's line stays as it was" asserted the loss. It is replaced by tests that assert the `no-open-copy` / `record-removed` line is written.
- **For each of delete, skip, merge and undo:**
  - the repair is its own audited change and comes first, exactly once;
  - then the removal runs, and the source, the held file and its pending entries are gone;
  - the queue is whole and no marker is left.
- **A crash between the two changes,** for each of the four:
  - the queue is whole (cut) and no marker is left;
  - the source, the held file, the pending entries and the entry's `needs-check` state are untouched, so the removal had not begun;
  - a second try does no repair and writes the line.
- **A decision the project's rules refuse ("skip" and "merge"):** the rules now require a legal basis that the identifiable source lacks. The queue is left repaired and nothing else changes. The repair comes first in the audit.
- **Not tested for delete and undo:** the rules can never refuse those two. The policy engine allows every `delete` request (`core/governance/engine.ts:421-425`), so that case cannot be reached for them.

**The review's list, checked again against the code:**
- Every place it marked "Yes" or sound is untouched: the hold, both held-file decisions, the entry's removal, `appendFindEntries`, and the register.
- No other caller reaches `deleteSourceInTx` or `appendFindLinesInTx`.
- The undo's other `importChange` calls (merge revert, collections, bookkeeping) remove no source.

### M3: the 26 legacy shapes are back in the enumeration (`908d400`, `repo/rollback-rerun.test.ts`)

**How the markers are built.** `legacySteps` writes each of the 26 "append and rewrite" sequences directly to disk, the way an older build left them:
- a trash is moved into `.tmp/trash-<txn>-<hex>`;
- a rewrite records "replaced", with the file copied aside to `.tmp/txn-<txn>.orig-<n>` and its mode, or "created"; both carry the hash of what was written;
- an append records the size before it, once per file until that file is trashed.

`markerHead` builds the marker's head. A separate test proves that head equals the transaction's own (all fields except the id).

**The steps of each case:**
1. The marker's in-process roll-back is cut after each of its steps (`undoEntries` with `stopUndoAfter`).
2. The library is reopened, and reopened again.
3. Each case keeps the assertions it had at 579bdcd (the same `judge`), plus a new check that the marker is never found invalid.

**The comment at the head of the enumeration** gives the three groups:
- **Taken now:** 26 sequences, 85 cases.
- **Refused now:** 26 checks.
- **Left by an older build:** 26 sequences, 94 cases, split 6/6/45/37 (`EXPECTED_LEGACY`).
- **Total:** 179 roll-back cases, as before R503 a.

**Did anything unexpected happen? No.** All 94 cases pass under the old assertions. How I checked this, with scratch edits that were each restored:
- **Faithfulness.** I disabled the refusal temporarily and ran the same 26 sequences through the real transaction. All 94 per-case outcomes, reported at the first reopen, were identical to the hand-built ones.
- **The new cases guard the undo.** With R493's skip rule disabled, legacy cases fail on their own (6 listed as failing, beside the API cases).
- **Did it fail first?** No, and it could not: this restores coverage and fixes no defect.

**For the coordinator to know.** Outcomes at the first reopen of the 94 legacy cases:
- **67** cases: rolled back cleanly.
- **12** cases: rolled back, but with the false "changed outside the app" warning (FR-738's real symptom).
- **15** cases: refused as `txn-recovery-skipped-audit-unverifiable`; the marker is kept and the project stays blocked.
  - This is FR-738's blocked state, real for markers whose contents are not prefixes of each other.
  - It was already accepted by the old assertions.
  - A project holding such an old marker stays blocked; nothing here unblocks it, as before.

### M4 (`ad99c57`)

**(a) The register's crash test** (`repo/watch-register.test.ts`, 12 cases, block "R503 a: a crash at …"). The setup: a torn register gets a new entry, and a crash happens at before-changes, before-audit or before-marker-delete of the cut's change and of the add's change, plain and sealed. Then the library is reopened. Each case checks:
- no marker is left;
- no "changed outside the app" warning and no "could not be checked" refusal;
- the file is the torn original, the cut, or the cut plus the new line, never half;
- the new entry is there only when its own change committed;
- the earlier entry is unchanged, so no origin is lost;
- the add, retried as the watch would, gives exactly 2 lines, so no file is brought in twice;
- a later write succeeds.

It needed a test-only seam between the two changes: `registerMendSeams.afterMend` (`repo/watch-register.ts`, honoured only under NODE_ENV=test, R47), the same shape as the queue's. The cases failed first, because the seam did not exist; they pass with it.

**(b) The developer's error.** `MIXED_WRITE` (`repo/txn.ts:91`) now reads: "A change must not both append to a file and rewrite that same file: if it were interrupted, it could not always be undone. Cut a torn last line in a change of its own, then append in the next." The test asserts the exact text and that no ruling number appears; it failed first. No caller in production reaches this error. A researcher never sees it through the service, which gives a generic 500; the CLI would print it raw.

## Built differently from the ruling

- The import code calls the repair through a one-line wrapper (`mendFindQueue`), because it holds a `Repo` and not a `RepoCore`. The repair itself is the one function.
- The "refused by the rules" test exists only for the duplicate decisions. The rules never refuse a deletion or an undo's removal (see I1).
- The I1 test for undo uses a batch record written by hand. The bulk test file's "finds sources by provenance" test does the same.

## NEEDS A RULING

None.

## Researcher-visible sentences

None are new or changed. The only text that changed is the developer's error in M4 (b).

## Runs

Each file was run alone, at `nice -n 10`, in `@ao/library`:
- `src/repo/rollback-rerun.test.ts`: 15 passed (15)
- `src/repo/rollback-own-writes.test.ts`: 14 passed (14)
- `src/repo/pending-writes.test.ts`: 22 passed (22)
- `src/find/queue-store.test.ts`: 81 passed (81)
- `src/find/runner.test.ts`: 300 passed (300)
- `src/find/runner.linked-missing.test.ts`: 23 passed (23)
- `src/repo/review-held.test.ts`: 67 passed (67)
- `src/repo/review-held.linked.test.ts`: 6 passed (6)
- `src/repo/watch-register.test.ts`: 30 passed (30)
- `src/import/watch.test.ts`: 143 passed (143)
- `src/import/bulk/bulk.test.ts` (the duplicate decisions and the undo): 103 passed (103)
- `src/repo/key-lock-race.test.ts`: 11 passed (11)
- `src/repo/key-read-race.test.ts`: 32 passed (32)
- `src/repo/lock-mid-read.test.ts`: 44 passed (44). The two bibliography rows pass now that the citation styles are in place.
- `pnpm --filter @ao/library typecheck`: clean.
- `pnpm --filter @ao/ui build`: built. End to end, `e2e/import.spec.ts` in Chromium passed 4 of 4; it covers an import's undo, a review decision and a merge.
  - The end-to-end harness's own global setup created the media worker's Python environment, `services/media-worker/.venv`, which is git-ignored. I did not ask for that install.

**Concurrency.** The lock-mid-read and key-read-race runs moved to the background after the shell's time limit. I ran nothing else from this task until they finished. Another agent's run in `@ao/library-service` was on the machine at the same time.

No permission check refused anything.
