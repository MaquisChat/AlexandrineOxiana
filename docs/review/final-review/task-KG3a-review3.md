# KG-3a — third look (R515 N1, N2), c4f0bf2..57d550c

Scope: the two commits 737ccda (N1) and 57d550c (N2) only. Everything below was run at `nice -n 15`, one file at a time. The probes (`*.probeKG3a3.*`) are deleted, every scratch edit is restored, and `git status --short` is empty.

**Verdict: APPROVE WITH SMALL POINTS.** Nothing is Critical or Important. N1 and N2 are built as ruled, and each test fails without its change.

## Findings

### Minor
- **P1 — the refusal at the bound has no test** (`state.ts:1184-1185`). Nothing tests that a move is refused when a start of watches is still under way after the bound. My probe shows it is correct (below). Direction: keep that probe as a test (start held for good, small `suspendTimeoutMs`).
- **P2 — the service's stop can now last up to 60 s longer.** The close goes through the same whole-library `stopWatches`, so a start that hangs adds up to `SUSPEND_TIMEOUT_MS` (60 s) before `closeGraceMs`. The stop is still bounded: my probe with small bounds ended in 3.3 s. Check that the desktop shell's own wait for the service's stop is longer than the sum.
- **P3 — after a reconnect, a job that ended in the gap leaves an empty status.** The status line goes blank rather than saying "Recheck finished…". That is true and calm, and the badges are read again; noted only.

## N1 — a move waits for starts of watches under way

**Held start across the move's beginning** (the implementer's test, with the real `POST /libraries/move`):
- When the copy begins, no watch runs, both registers are empty, and the warning is still there.
- After the move, the session's root is the moved library, each project has exactly one watch, a further read starts nothing more, and each file reaches the moved library's register.
- With the new wait removed by a scratch edit, that test fails; the edit was restored.

**Its place in the sequence** (`state.ts` `quiesce`):
- It runs inside the final `try`, after `drainWork`, `suspendBatches` and the transcriptions' stop, as the first thing `stopWatches(s)` does.
- That is before the proxy and OCR disposal, before `endFind`, and before `executeMove` (the copy).
- The move's own stop of the watches is that same call, so the wait comes first.

**Deadlock** (by reading): a start reads this computer's settings file (`listWatchedFolders`) and builds watches; their folder calls run in each watch's own `ready`, which is not awaited. It needs nothing the move holds: `moving` is only a flag, the library's write turns are not held, and `startWatches` takes no `startWork` slot. No deadlock.

**A start that never ends** (probe: one project's start held for good, `suspendTimeoutMs` 1500):
- The move answers 409 with "Some background work could not be paused in time, so the library was not moved; try again in a moment." That is true: a start that did not end in time is background work.
- Afterwards `moving` is false and the library is still open at its old root.
- The catch block's `activate(s)` started the watches again, and the find runner is the same one (`startFind` does nothing when a runner exists).
- Once released, each project has exactly one watch, thanks to M3's `watchStarting`, and the warning cleared.
- A second move then succeeds (200, `done`).
- So the refused move leaves nothing stopped behind it. `restartStoppedWork` and `resumeBatches` run as in every other refusal of that block.

**The stop** (probe: a start held when `close()` begins):
- The stop ended in 3.3 s, within its bounds (`inFlightWaitMs` + `suspendTimeoutMs` + `closeGraceMs`).
- After release, no watch is held on the closed session: `closeLibrary` clears `session` first, so `startWatches` stops its own watches.

**Lines where a move begins and stops things, in THIS diff** (for the join with KG-3b):
- `apps/library-service/src/state.ts:1058-1071`: `stopWatches`, the bounded wait for `s.watchStarting` when no project is named. It is used by `quiesce` and by `closeLibrary`.
- `apps/library-service/src/state.ts:1183-1185`: in `quiesce`'s last `try`, the refusal when a start is still under way. It is caught by the existing `activate`/`resumeBatches`/`restartStoppedWork` rollback.
- `apps/library-service/src/state.ts:1023`: the restart leaves the warning if a move or the stop began meanwhile.
- `routes/libraries.ts` (`runMove`) is NOT changed by this diff. A planning step that KG-3b puts before `quiesce` should still reach this wait unchanged. Check that any rollback KG-3b adds for a refused plan does not run before this `try`'s own `activate`.

## N2 — the recheck asks again at a reconnect

- `Library.tsx` counts streams opened after a drop. The count rises at the first event of a new stream, the fresh state, and is passed to the button.
- The button asks with `again`, and acts only on the job it showed as running when it asked:
  - the service says none: the job is cleared, the button is free, and the badges are read again;
  - the same job still runs: its progress moves forward only.
- A start being answered is never overridden.
- An end event that arrives first leaves the job "finished", so the `again` branch does not apply.
- After unmount the `live()` flag drops the answer.
- Both new tests fail when the effect is disabled by a scratch edit: 2 failed, restored; 12/12 pass with the code.
- They wait on true states with `waitFor`/`findBy` across the screen's real 2-second retry. They do not sleep.

## Runs
- `watched-folders-routes.test.ts`, alone: **58 passed (58)**, 110 s. The earlier time-out was load.
- `device-notices.test.ts -t R515`: passes; fails with the wait removed.
- `Library.recheck.test.tsx`: 12 passed.
- e2e: believed. The UI was built at 09:22:12, after the last commit (57d550c at 09:12:59), and `.last-run.json` says passed at 09:24:39. That fits watched-folders (2.0 m) followed by maintenance (24 s).

## Judged by reading only
- The deadlock question.
- That `activate` on a refused move restores everything; the probe covers watches, find and the next move.
