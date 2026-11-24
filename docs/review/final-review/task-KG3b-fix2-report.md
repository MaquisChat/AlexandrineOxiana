# KG-3b fix 2 — the capture queue and the move (R534 b)

Branch `kg-3b-locked-move`, worktree `.claude/worktrees/kg-3b`, from 7fa4041. Commit **e439ad5** (test only). Verdict: **(a) the test lagged a ruled change**; the product is right.

## 1. Reproduced

`capture-queues.test.ts` at 7fa4041: 1 of 30 failed, `expected [ …(3) ] to have a length of 1 but got 3` (line 625).

## 2. The timeline of the failing run (temporary logging, removed again)

The probes were `globalThis.__TL` calls in the move route (before and after `acceptMovePlan`, before `quiesce`, before `executeMove`), in `state.drainWork` (when `stopping` is set), in `state.endCaptures`, in `move.ts` before each `copyFileAtomic`, around the stand-in worker's `submit`, and on every service event. Times are measured from the move request (the first download was let go at once):

| ms | what |
|---|---|
| 2.9 | worker call 1 ENDS (released) |
| 4.0 | plan: taking |
| 5.1 | capture.progress done 1/3 (outcome of link 1) |
| 17.0 | worker call 2 BEGINS / ENDS |
| 17.9 | capture.progress done 2/3 |
| 29.3 | worker call 3 BEGINS / ENDS |
| **29.9** | **plan: ACCEPTED**; quiesce begins |
| **30.1** | **drainWork: `stopping` set on [capture]** (the stop) |
| 31.5 | capture.progress done 3/3, finished (link 3's outcome, reported inside the drain; drainWork waits for the work's `done`) |
| 32.4 | quiesce done; executeMove begins |
| **60.0** | **copy: first file write** (`Projects/Secret/audit/0001.jsonl`) |
| 172.0 | endCaptures("close") at the switch: the queue had already finished, so nothing was published for it |
| 172–611 | the moved library opens, index and backup run; **no worker call** |

## 3. Why (a)

- Calls 2 and 3 both begin AND end before the plan is accepted (29.9 ms), that is, while the move is still taking its plan, where work is allowed to start (R503 l, R513 M1, R521). No worker call begins after the stop (30.1 ms).
- The only queue activity after the stop is link 3 reporting its outcome. That happens inside `drainWork`, which waits for the capture's `done` before `quiesce` returns, and so before the copy (60 ms). Nothing of the queue runs, reports or writes during the copy.
- Each link writes only before its download (the audited capture decision in `link-capture.ts` `captureOne`) and cleans up its work folder before its run returns. All of that finished before the drain returned. `executeMove` then takes its plan AGAIN after the stop, so whatever the work wrote is in the copy list. Here the stand-in worker makes every download fail (TOOL_NOT_INSTALLED), so no source is stored.
- The queue is not continued on the moved library (no call after the switch). Its record is forgotten at the close (`endCaptures` deletes finished entries and calls `forgetProject`). The old test's later assertion `mine.at(-1).error ~ LibraryClosedError` would also have failed in this run, because the queue ran to its end before the stop and there was nothing left for the move to end. That is also allowed by the ruling.
- So "exactly one call" was true of the old order (stop first), not a property that must hold.

## 4. What changed (`apps/library-service/src/capture-queues.test.ts`)

- l.471–473: `running()` takes service options (the move's hooks).
- l.617–664: **the mended test.** The first download is held until the move's stop reaches running work. The true signal for the stop is a `vi.spyOn` around `state.drainWork`, which sets `stopping` before it returns; the download is let go right after that. The plan's acceptance is read with the service's own `afterMovePlan` hook and the copy's start with `beforeExecuteMove`. No sleep. The test asserts:
  - the download was still running when the plan was accepted (`atPlan` 1) and when the stop came (`atStop` 1);
  - between the copy's start and the move's end, the only queue event is its LibraryClosedError end;
  - no worker call begins after the stop or on the moved library (`calls` = `atStop` = 1);
  - at most one outcome is reported.

  Every earlier assertion is kept (the LibraryClosedError end, `captureQueue` undefined, `captures` empty, and a new capture works on the moved library).
- l.666–689: **new test**, "a move refused at its plan stops nothing". The destination holds someone else's file, so the move is refused, and `afterMovePlan` is never reached. The test asserts:
  - `drainWork` was never called and the queue is still unfinished;
  - after the release, the queue captures all 3 links (`done: 3`) with no error event, in the library still open.

  `transcription-jobs.test.ts` already had this case for a transcription, but nothing covered it for a capture queue.

Probes. Each was applied, its test run, and the change reverted:

| fault planted | mended test | new test |
|---|---|---|
| `shouldStop: () => false` (the queue ignores the stop) | **fails** | passes |
| a `drainWork` before the plan (the old "stop first" order) | — | **fails** ("drainWork … called 1 times") |

No product file changed. No researcher-visible sentence is new or changed.

## 5. Neighbours (step 4)

Every file that starts a move passed when run alone. None has the same lag.

## 6. Runs (each alone, `NODE_OPTIONS="--use-openssl-ca" nice -n 10`)

- capture-queues.test.ts: Tests 31 passed (31)
- transcription-jobs.test.ts: Tests 40 passed (40)
- fieldwork-governance.test.ts: Tests 23 passed (23)
- find-routes.test.ts: Tests 46 passed (46)
- library-audit.test.ts: Tests 11 passed (11)
- open-library.test.ts: Tests 25 passed (25)
- server.test.ts: Tests 151 passed | 1 skipped (152)
- zotero-sync-routes.test.ts: Tests 43 passed (43)
- zotero-sync-scheduler.test.ts: Tests 43 passed (43)
- `pnpm --filter @ao/library-service typecheck`: clean
- `git status --short`: empty. Not pushed.
