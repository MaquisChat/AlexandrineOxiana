# N12 (R570 a): `packages/library/src/integrity-confirm-batches.test.ts` after FR-749

Worktree `.claude/worktrees/kg-3b`, branch `n12-integrity-close`, from 6c33ea1; commit **e3527e6** (not pushed).

## Reproduced
At 6c33ea1: 6 tests, 3 failed (two `queueFree` assertions at :147 and :186; the "waits for its first turn" test timed out at 30 s and its `afterEach` timed out too). The test file is unchanged since facf73d; the change is in the engine (FR-749).

## Per failing test

| Test | Cause | Test or product |
|---|---|---|
| a close in mid-confirmation | Only the test's way of showing "the queue is free" (a turn asked of the closed library) is refused, by R546 1. The check's own ending was already right: `ReadOnlyLibraryError`, order `["batch 1"]` (`endIfClosed` runs before the second batch's turn). | TEST |
| a move in mid-confirmation | The same: only `queueFree`. The check still ends with `ReadOnlyLibraryError` reason `"moved"`; 250 sources at the new place. | TEST |
| a close while the check waits for its first turn (hang) | The test's own wait: it held a turn (`holdQueue`: `writeQueueTurn(kit.repo)(() => open)`) and released it only AFTER `await kit.lib.close()`. `close()` now waits (`drain` = `whenIdle`, no time limit) for that turn; the turn waits for `release()`, which comes after the close. The `afterEach` `kit.close()` returns the same pending `closing` promise (R551 M1), so it hung too. | TEST for the hang; but behind it a PRODUCT fault (below) |

### Evidence (temporary probe file, removed)
- Probe A (held turn, check queued, close called): after 50 `setImmediate` turns the log was `["--- 50 ticks, turn still held"]` — close unresolved; on `release()` it went `held turn settled`, `check rejected LibraryClosedError`, `close resolved`. So the only thing the close waited for was the test's turn.
- Probe B (the product-level scenario, NO test-held turn): a real governed change (`importChange`) in its turn, the check queued behind it, `close()` called while the change runs → `["close called","change body done","change resolved","check rejected LibraryClosedError","close resolved","all settled","lock present: false","closed: true"]`. Everything settles; no wait for ever.
- Probe C (a move — `MOVED.json` written — while the check waits for its first turn, then close): `check rejected LibraryClosedError` (reason none). **Product fault:** the check's queued turn is refused at its start (`state.ts` `enqueue`, R546 1) before `endIfClosed` inside it can run, so the check ends with the closed library's refusal even for a move, where at facf73d (and still between two batches) it ends with `ReadOnlyLibraryError("moved")`. For a plain close it also changed (`LibraryClosedError` instead of the `ReadOnlyLibraryError` a close between batches gives), so the same event gave two errors by timing.

The three candidate product waits were ruled out: (i) the check holds nothing `close()` waits for (no drain, no `inFlight` registration; GET `/libraries/integrity` is not counted in `inFlightMutating`); (ii) a refused turn IS settled — `enqueue` rejects it and calls `startNext`, so the check's promise ends; (iii) a second `close()` returns the first's promise, which resolves once the queue is idle.

## Can a researcher reach a wait that never ends?
No, by this path. The service runs the check only from `GET /libraries/integrity` (`apps/library-service/src/routes/libraries.ts:431`; not at opening — `state.ts` has no `checkIntegrity`). `closeLibrary` (state.ts:1285) does not await the check; its lock release waits only for the queue's turn in progress, and the check's turn, when it runs, reads one batch of at most 200 sources and ends. A waiting check turn is refused as it comes up, the check ends, the route answers 409 with R491 C b's sentence ("The check was stopped because the library was closed or moved. Open the library again and run the check again."). The move route waits for mutating requests with a 60 s bound. Only a turn that itself never ends could hold a close, which is FR-749's ruled no-time-limit wait (R247 d), not something the check introduces.

## What changed
- `packages/library/src/reconnect.ts:618` (`confirmFindings`): a `LibraryClosedError` from the confirm turn is passed through `endIfClosed(lib)`, so a refused turn ends the check with the closed or the moved library's error exactly as a close between batches does; any other error (or a closing-signal refusal on a still-open handle) is rethrown unchanged. Import at :34. The service's answer is unchanged (both errors map to R491 C b's sentence).
- `packages/library/src/integrity-confirm-batches.test.ts`:
  - :73 `holdQueue` releases its turn also at test end (`onTestFinished`) and records "held turn ended";
  - :91 `queueDrainedAndClosed()` replaces `queueFree` after a close: `close()` resolved, `isClosed`, `.lock` gone, and a turn asked now is refused with `LibraryClosedError` without running (no further turn). `queueFree` stays for the cancel test (library still open);
  - :160 close mid-way: also asserts reason is not "moved" and one ask only;
  - :183 `closeWhileWaiting`: releases the held turn WHILE the close waits, asserts `["held turn ended", "close resolved"]`, the check's turn never ran (`order` empty, one ask);
  - :208 close while waiting: `ReadOnlyLibraryError`, not "moved"; :214 NEW: move while waiting → `ReadOnlyLibraryError` reason `"moved"`;
  - :220 move mid-way: one ask, `queueDrainedAndClosed`.
  - Before the product mend, the two waiting tests failed for the right reason ("expected LibraryClosedError … to be an instance of ReadOnlyLibraryError"), with no hang.

No researcher-visible sentence is new or changed.

## Other test files that pass for a wrong reason
None found. Read: `integrity-confirm.test.ts` (holds a turn, releases it, no close), `retention-confirm.test.ts`, `repo/audit-reasons.test.ts` (closes only in teardown), `repo/closed-library-stale.test.ts` (asserts `LibraryClosedError` deliberately), `repo/sources-confirm-bound.test.ts` (already mended, 855c5f1), `export/closed-reads.test.ts` (releases the held change while the close waits — the right pattern), `apps/library-service/src/server.test.ts` R491 C b (its 409 sentence would fail if the read-only sentence came back), and the close sites of the rollback/import/find/index tests (teardown or close-then-reopen; no turn asked of a closed handle, no swallowed refusal).

## Runs (each alone, `nice -n 10`)
- `@ao/library` `src/integrity-confirm-batches.test.ts`: 7 passed (7) — three times in a row
- `src/integrity-confirm.test.ts`: 5 passed (5)
- `src/repo/closed-library.test.ts`: 6 passed (6)
- `src/repo/close-inside-change.test.ts`: 3 passed (3)
- `src/repo/sources-confirm-bound.test.ts`: 6 passed (6)
- `src/reconnect.test.ts`: 54 passed (54)
- `@ao/library-service` `src/server.test.ts`: 160 passed, 1 skipped (161); `src/documents-route.test.ts`: 25 passed; `src/close-during-attach.test.ts`: 13 passed; `src/device-notices.test.ts`: 17 passed; `src/source-availability.test.ts`: 5 passed
- typecheck `@ao/library`, `@ao/library-service`: clean
- `git status --short`: empty; no background process.
