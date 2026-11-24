# KG-3b fix round — report (Ruling R513: I1, M1, M2, M3)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-3b`, branch `kg-3b-locked-move`, 4216a0c..a7e8f9f. Four commits, one per point, not pushed. `git status --short` is empty. Nothing in `executeMove`'s own steps changed. The only change in `move.ts` is to the early plan's handling of interrupted changes (`preflight` with `checkPending=false`; `planMove` and `executeMove` behave exactly as before).

## Per point

| Point | What changed (file:line) | Its test, and whether it failed first | Commit |
|---|---|---|---|
| **I1** (FR-739 2) | `packages/ui/src/screens/import/ReviewQueue.tsx`. New ref `refocusOnlyFrom` (`:422-427`). It holds the element that the first move (the look's close during a re-read) put focus on: set to the screen's heading in `closeLook` (`:1071-1075`), then to the element actually focused by the focus effect (`:886-887`). When the read lands (`:556-562`), the second move to the card's heading happens only if `document.activeElement` is still that element. R313 e's own path (a given-up decision, `:958-962`) clears it, so that path is unchanged. | `ReviewQueue.look.test.tsx`: "R513 (I1): … focus moved to a control OUTSIDE the screen …" (the reviewer's probe: a button outside the screen; the read is held by a promise the test controls, released by `onTestFinished`) and "… another control INSIDE the screen …" (the link "Show every entry waiting in this project"). Both **failed first**: `expected <h4 …> to be <button>` / `<a>`. "Focus still on the heading → it moves to the card's heading" is the existing FR-739 (2) test, unchanged and passing. | bbac00c |
| I1, the other later move | **FR-739 (4), a lock found during the visit: it moves focus at once.** The read that finds the lock calls `forget()`, which bumps `lockFound`. The effect at `:619-623` runs in the same commit as that answer, so nothing happens later than the event that caused it. It moves focus only when focus is on the page body, so it never takes focus from where the researcher put it. No change. | — | — |
| **M2** (FR-733) | `packages/library/src/move.ts:316-336`. In the early plan (`checkPending=false`), a project left refusing changes by an interrupted change (the open repo's `recoveryPendingProjects`, which running work does not change) is refused at once as "pending writes", unaudited. A write-ahead marker in `.tmp` (which may belong to a change still being written by running work, or to an interrupted one) ends the early plan with nothing judged: private `PlanAfterStop`, caught in `acceptMovePlan` (`:588`). The move then stops its work and `executeMove`'s own plan answers in the old order. `acceptMovePlan`'s comment is updated (`:566-577`). | `move.test.ts`: "R513 M2 (the reviewer's probe): marker AND a HIPAA project to OneDrive …" and "R513 M2: a project left refusing changes … AND a project whose rules forbid …". Both **failed first** (policy refusal, audited). `transcription-jobs.test.ts`, new describe "R513 M2 (FR-733): the move's refusals, as before and in the old order" (11 tests through the route: status, sentence, audit entries per project). Two **failed first**: the probe (marker + forbidding project) and "marker + destination not empty". All 11 were also run against the **old** route and move (579bdcd's `libraries.ts` and `move.ts` written into the worktree, then restored with `git checkout`): **11 passed**. So "before" and "after" are equal. | 4cbddce |
| **M1** (FR-733) | See "M1: which way" below. `apps/library-service/src/state.ts:290-303`: new `planningMove` flag and getter `startsHeld` (`moving && !planningMove`). Every gate that skipped a background start on `moving` now checks `startsHeld`: `state.ts:378` (resume after a refused quiesce), `:1504` resumeFind, `:1515/:1527` wakeFind…, `:1579` attachWorker, `:1592` resumeWorkerJobs, `:1622` resumeProject, `:1776` runScheduledBackups, `routes/tools.ts:90` retryWaitingWork, `routes/zotero-sync.ts:351` the automatic sync. `routes/libraries.ts:285` sets `planningMove = true` with `moving`; `:315` sets it false once the plan is accepted, right before `quiesce`; `:389` sets it false in the route's `finally`. Test seam `beforeMovePlan` (`server.ts:73`, called at `libraries.ts:301`). | `transcription-jobs.test.ts` "R513 M1 (FR-733): the media worker becomes ready while a move's plan is taken; the plan is refused: the transcription left pending runs again at once, stored once". **Failed first** (`timed out waiting` at the rerun). Now it passes: one run not cancelled, two stored versions. | f5b616e |
| **M3** | `apps/library-service/src/routes/libraries.ts:297-300`: one sentence on what planning twice costs and why it is accepted. | — (a comment) | a7e8f9f |

## M2: the order of checks, old and new

Old order (579bdcd): route, then `quiesce`, then `executeMove`. New order (a7e8f9f): route, then the early plan, then `quiesce`, then `executeMove`.

| # | Old (579bdcd) | New (a7e8f9f) |
|---|---|---|
| 1 | A move already running: 409 "A move of this library is already running." (preHandler / route) | same |
| 2 | `requireWritable` (no library, read-only) | same |
| 3 | Body: `dest` absolute (400), `excludeProjectIds`, `attempt` (400) | same |
| 4 | Changes in flight finish (409 after 60 s) | same |
| 5 | `quiesce`: 409 if work cannot pause | (moved to after 6–14, see the note) |
| 6 | executeMove: a switch already decided is finished (no plan) | early plan: the same (`finishesSwitch`) |
| 7 | preflight: read-only | same |
| 8 | preflight: **pending writes** (marker or recovery-pending project), 409 CONFLICT, unaudited | recovery-pending project: refused here, the same answer, unaudited. **Marker: nothing more judged here**; the plan after the stop gives 8–14 as before |
| 9 | preflight: overlap | same |
| 10 | preflight: destination not empty / not a folder (own journal accepted) | same |
| 11 | locate; readProjects: unreadable project | same |
| 12 | walk: symbolic links / special files; name collisions | same |
| 13 | unknown project to exclude | same |
| 14 | policy refusal, **audited** in each refusing project | same (once, by the same `refuseUnaccepted`) |
| 15 | — | `quiesce`: 409 if work cannot pause |
| 16 | — | executeMove: 6–14 again (its own plan after the stop), then the rest unchanged |

**Note (follows from R503 l, not changed here):** `quiesce`'s 409 ("Some background work could not be paused in time…") used to come before every plan refusal. Now that the plan is accepted before anything is stopped, a move that would be refused both by its plan and by work that cannot pause gets the plan's refusal. The test "background work that cannot be paused (the plan accepted)" shows that 409 is unchanged when the plan is accepted. When a marker is present, the early plan judges nothing, so for that case the move again stops its work before it refuses: exactly the old behaviour. This is the one case where FR-733's gain is given up.

## M1: which way, and why

- **The flag is `state.moving`.** The route sets it before the in-flight wait (`libraries.ts:284`), so it was also set during the early plan. It is cleared on the early refusal and in the route's `finally`. `attachWorker` (and the other gates listed above) returned early on it, so a worker that became ready during the plan resumed nothing.
- **Chosen: the first way.** Starts are no longer skipped before the plan is accepted. `moving` itself stays as it was, because three things need it from the request on:
  - the double-move guard, set synchronously;
  - the 503 refusals, without which the in-flight wait could not end;
  - the status's `running` (R399 b).
- **Only the "background work waits" part is now taken at the plan's acceptance** (`planningMove`).
- **Why the gates are not needed for the early plan's correctness:**
  - The plan only reads.
  - Work already runs during it: a running transcription is the very case of R503 l.
  - A failure that is not a refusal is left to executeMove. A marker written by a started job ends the early plan with nothing judged (M2).
  - executeMove takes its plan again after the stop.
  - Everything a gate would now let start is a kind of work that may already be running when a move is asked for, and `quiesce` stops or drains it: worker-resume (transcription interrupted, others drained), proxy/OCR queues, Find, backup and retry work, Zotero.
- **Why not the second way:** the old refusal path's `state.activate(s)` restarts watches, Find, the schedulers and the worker. Run when nothing was stopped, it would start them twice.
- **Side effect:** the same holds for the wait for changes in flight. A start there (an unlock in flight when the move was asked, a scheduler tick, a tool install finishing) is no longer skipped either. It is stopped by `quiesce` if the move goes on.
- **Unchanged:** the two existing tests that set `state.moving = true` directly and expect starts held (`server.test.ts` "does not run while the library is being moved…", "nothing is resubmitted while a move holds the library") pass, because `planningMove` defaults to false.

## Sentences a researcher can see

None new or changed. The refusals' sentences are those of 579bdcd, shown by the comparison run.

## NEEDS A RULING

None. For the coordinator's information: the precedence of `quiesce`'s 409 against plan refusals (see the M2 note) follows from R503 l itself.

## What only a real Mac or a real service can show

- The worker becoming ready during a move's plan with the real media worker; the test uses the stand-in worker.

## Runs (single files, `nice -n 10`)

- `@ao/ui` `ReviewQueue.look.test.tsx`: **17 passed (17)**. `ReviewQueue.test.tsx`: **125 passed (125)**. `ProjectReviewQueue.test.tsx`: **25 passed (25)**. `MoveLibrary.test.tsx`: **26 passed (26)**. The look dialog's tests are in `ReviewQueue.look.test.tsx`.
- `@ao/library` `move.test.ts`: **77 passed (77)**.
- `@ao/library` `repo/lock-mid-read.test.ts` (untouched): **44 passed (44)** in 767 s.
- `@ao/library-service` `transcription-jobs.test.ts` (the route's FR-733/R513 tests): **40 passed (40)**.
- `@ao/library-service` `server.test.ts` (the move route's own tests): **151 passed, 1 skipped (152)**.
- `@ao/library-service` `media.test.ts` (untouched): **34 passed (34)**.
- The R513 M2 route tests run against 579bdcd's `libraries.ts` and `move.ts`: **11 passed (11)**. Restored with `git checkout`.
- Typechecks: `@ao/library`, `@ao/library-service`, `@ao/ui` and `@ao/cli` pass with no errors.
- `@ao/ui` `lint:css` is clean. `lint:colours`: "ok: no hard-coded colours".
- `@ao/ui` build: "✓ built in 5.34s".
- e2e, Chromium, `--trace off`: `maintenance.spec.ts` **3 passed**; `review-queue.spec.ts` **11 passed**.
- No time-limit failures. `git status --short` is empty.
