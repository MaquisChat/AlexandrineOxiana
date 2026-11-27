# Task WC5 review — the service runs the downloads

Reviewed: worktree `.claude/worktrees/kg-5`, branch `wc-5-service`, range a210250..a0a1226. All probes removed and the worktree restored; `git status --short` is empty.

## Verdict: NOT READY

One Critical finding and three Important ones. The fixes are small and local to `downloads.ts`.

## Critical

**C1. A move refused for time leaves the runs halted for good, and leaves a continuation behind that later resumes a run by itself, even one the researcher paused.** `downloads.ts:248-249, 271-272, 307-311`, `state.ts:548, 1358-1361`.
- What happens:
  - `haltForMove` sets `h.halted = true` and aborts `h.stop`, and neither can be undone. When `drainWork` times out, it rolls `ctl.stopping` back to false. `quiesce` then calls `restartStoppedWork()` at once and refuses the move with 409. The drain limit is `SUSPEND_TIMEOUT_MS` (60 s), so a single long video in flight is enough to trigger this.
  - The run still finishes the video in hand, then throws `CaptureCancelledError` at its next `beforeItem`. Its continuation is pushed to `stoppedWork` after `restartStoppedWork` has already run, so nothing restarts it. The run shows "interrupted", and every run waiting its turn behind it is cut to "interrupted" too. Link queues carry on after a refused move (`shouldStop: () => ctl.stopping`); download runs do not.
  - The stale continuation then fires at the next `restartStoppedWork` for that root: a later move, or `activate` after a pending resume. `continueRun` only checks `runs.has(runId)`. It does not check the run's journal state or whether the researcher paused it.
- How I know (probe, since removed): with `suspendTimeoutMs: 300`, a video was held and a move attempted. Results:
  - The move answered 409. The run ended `interrupted` with done 2 of 3, and `stoppedWork.length === 1`.
  - Then: Resume, Pause (state `paused`, 3 videos downloaded), then a successful move. After the move the run was `finished` 5/5, and the fake downloaded videos …02 and …01 with nobody asking. This breaks R668: nothing goes to a platform that the researcher did not just ask for, and a pause stays a pause.
- Smallest fix:
  - At the end of the work body in `launch`, if `continues && !work.stopping` (the move was rolled back), call `continueRun(s, …)` at once instead of returning a continuation. Do the same for halted runs that were waiting their turn and never began: give them back their place in the order.
  - In `continueRun`, refuse to continue a run whose journal state is no longer `downloading` or `waiting`, or one that was paused or stopped meanwhile.
  - Add a test: a move refused for time keeps the run (and the one waiting its turn) going, and a later move does not resume a paused run.

## Important

**I1. A rejection after the route has answered is lost silently for a resumed run, and the screens keep showing it as downloading.** `downloads.ts:259-264, 273, 288-289`.
- What happens:
  - The work body catches every error. Once `answered` is true, the error goes only to `endQueue`, which returns at once for `queue === false`, as every Resume is.
  - So nothing is logged: `startWork`'s `log.warn` is bypassed because the function never rejects. Nothing is published either. The last `background.progress` said `downloading` or `waiting`, so WorkLines keeps showing Pause and Stop for a run that is no longer held. Pause then answers 409 "not running".
  - For a started run, the error does reach the Capture queue's `capture.progress` event, but no `background.progress` follows.
  - This answers the brief's question of where such a rejection goes: for a Resume, nowhere. It does not crash the service, and it leaves no unhandled rejection: `answering` is always awaited, and `continueRun` has `.catch(() => {})`.
- How I know: reading the code; there is no test for it.
- Smallest fix: in the catch, when `answered` is already true and the run was not cut by a lock, do three things:
  - log `state.describe(err)` with `opts.log.warn`;
  - after `forget`, publish `reader.get(...)` with `isHeld`, which now shows the run as interrupted;
  - publish it also when an encrypted project's run ends cut by a move.

**I2. Resume does not refuse a run of the same address while another run of that address is held.** `downloads.ts:360-369`.
- What happens: `resume` checks only `runs.has(runId)`. Take a run A that finished with failures (it stays, and its line offers "Resume downloads (N did not complete)"). The researcher starts the same channel again, so run B is held. A press of Resume on A answers 200: both runs are held, A queued behind B. After B, A lists the channel again and retries the same video.
- How I know (probe, since removed): the Resume answered 200 with `held(A) && held(B)` both true. The fake's run log shows the profile listed three times and video …02 asked for three times.
- Smallest fix: in `resume`, in the synchronous section just before `register`, refuse with `runningConflict()` when any held run of the project has the same `key`. This is the check `start` already makes.

**I3. Resume awaits three things before it records the run as held, against the plan's rule "Before anything is awaited, the run is recorded as held".** `downloads.ts:361-369`.
- What happens: `get`, `checkCaptureAllowed` and `workerClient()` are awaited first. Two presses are still safe because of the re-check. But two other requests can slip in during those awaits:
  - A Discard (`discard`: `runs.has` is false) can discard a run that is being resumed. That ends either as a 404 from the library's resume, or as a held run whose next journal write fails.
  - A Stop of a run that is not held (`stopNotRunning`) can write `stopped` after the Resume's `queued`. The run then downloads anyway, and the stale "stopped" summary is published after the newer "queued" one. That is an older summary published after a newer one (brief, item 5).
  - A lock during the awaits registers a run (with its address as `key`) for a project that is already locked, until the library rejects. There is no `requireUnlocked` re-check, unlike capture-profile, which has one (`capture.ts:270`).
- How I know: reading the code.
- Smallest fix: mark the run as "being resumed" synchronously at entry (a placeholder in `runs`, or a `resuming` set that `discard`, `request` and `start` respect), and remove it on every early exit. Re-check `requireUnlocked` before `register`.

## Minor

1. **A started run's double start answers 409 `CAPTURE_RUNNING`, not 409 `RUN_ALREADY_RUNNING`** (`capture.ts:271-272`). This is the implementer's point 2, and I agree it is the right trade:
   - It is a plain sentence: "This profile, channel or playlist is already being captured in this project, so nothing new was started. Wait until that capture has finished."
   - Exactly one run is held; I checked the concurrent case by reading. The route's awaits come before the synchronous `runningConflict` check and `start`'s synchronous key check and `register`.
   - It keeps `capture-queues.test.ts:341`.
   - No consumer depends on the reason: Task 8 shows `message`.
   - The plan's table should be amended to name both reasons. `RUN_ALREADY_RUNNING` is reached only by a held run that has no live capture queue: a resumed run, or a continuation.
2. **capture-profile checks the Video tools catalogue only when `quality` is sent** (`capture.ts:266`). With no quality, the run uses 720p (it needs ffmpeg), starts, and pauses `paused-tool` after listing. The plan says "when the quality needs ffmpeg". Task 8 always sends a quality, so this matters only for old or e2e callers. Either check `opts.quality ?? DEFAULT_QUALITY`, or name the choice in the plan.
3. **The test seam gate also accepts `VITEST`** (`server.ts:159`). R47 and `main.ts:39` say "only when NODE_ENV is exactly test". Vitest sets NODE_ENV=test anyway; drop the `VITEST` clause.
4. **The plan rule "`ctl.interrupt` aborts the signal" is not implemented**: `work.interrupt` is never set. It is harmless today, since nothing calls `interrupt` for this kind (a close cuts through `stopProject`), but it differs from the plan.
5. **capture-estimate:**
   - It is not re-checked for a lock after its long listing, so the channel's title can be answered after the lock, and the listing in flight goes on.
   - Listing failures other than a slow-down or a named tool become 502 INTERNAL "The media helper could not finish the job.", for example login required, not found, or a lost connection. That is not a sentence that says what happened.
   - `TOOL_NOT_INSTALLED` without a tool becomes 502 `TOOL_FAILED` "could not be installed or updated".
   - There is no test for the estimate's 409 `TOOL_NOT_INSTALLED` row, or for its 400 on an unknown quality.
6. **capture-profile with a link the library refuses**, such as a single post (`InvalidInputError UNSUPPORTED_URL` from `runs.start`), answers 400. But a capture queue has already been created and finished with an error, and it shows in `GET /captures` under an id the screen never got. Classify the link in the route before `start`.
7. **The test "a paused or stopped first run lets the next one begin" still passes with the turn removed** (mutation 1). It does not show that B waited until A paused or stopped. Assert from `runLog` as the "second channel" test does.
8. **The R464 b test inspects only `downloads.memory()`, the capture queues, the events and the logs.** Until the cut download returns, the address and titles remain in closures: `start`'s body closure (`url`), and the library's `segment` and `captureProfile`. The test cannot see them. That is the same as the old profile route, and in practice short. Only a heap snapshot would prove it either way.
9. **`resume` maps a library `InvalidInputError` RUN_FINISHED to 400 VALIDATION** if the run finishes between the pre-check and the library call. That is a narrow race.

## The coordinator's three points

1. **The `capture-queues.test.ts` ≈:180 change is exactly what the new behaviour requires.**
   - The gated worker's listing fails with `TOOL_NOT_INSTALLED video-downloader`. Under Task 3's rule (coordinator, R674) "The listing with hooks: … `TOOL_NOT_INSTALLED` → `paused-tool`", a run with hooks reports `paused-tool`. Only `status` changed; `errorCode`, `tool`, `reason` and the no-items assertion stand.
   - The diff touches nothing else in the file.
   - The test at :578, "a profile run: a lock then an unlock ends it; nothing more of it is published", is unchanged and passes (31/31).
   - The plan's "is NOT changed" predates R674; I recommend the coordinator accept the change.
2. **Not every way of starting the same address twice is refused.**
   - These are refused, each with a plain sentence and one run held: a second start (CAPTURE_RUNNING, concurrent included); a start over a resumed run (RUN_ALREADY_RUNNING); a double Resume; a Discard of a held run.
   - These are not:
     - a Resume of ANOTHER run of the same address while one is held (I2, probed);
     - the stale continuation after a refused move (C1, probed: it resumed a paused run).
   - Also: after a lock and unlock, a start of the address while the cut started run is still unwinding gets CAPTURE_STOPPING, as before. A resumed run cut by the lock has no queue, so a new start proceeds at once; the per-video lane (R116) still keeps the two downloads apart.
3. **Where the free-space switch belongs.**
   - Read it in `apps/library-service/src/main.ts`, next to `useSecretsFromEnv`/`useZoteroApiOriginFromEnv`, which already hold the pattern "read once, honoured only when NODE_ENV is exactly test" (R289 a). Pass it as `downloadFreeBytes` to `createService`, whose `downloadSeams` (`server.ts:158`) already gates it; drop the `VITEST` clause there (Minor 3). The e2e fixture sets it beside `NODE_ENV: "test"` (`e2e/fixtures.ts:383`).
   - On this path, only the download runs read free space: the disk floor in `beforeItem`/`afterItem` and the estimate's `readFree`, both through the same `deps.freeBytes` seam, so one switch covers both. `diskName` reads `/Volumes` or `diskutil` only on a Mac, so it gives null here.
   - Other readers of free space are not on the capture path and have their own seams:
     - backup `freeBytes`;
     - bulk import `space.ts`;
     - `sqlite-copy` `statfsFree`;
     - Zotero Web;
     - `freeRoomFor` (library place);
     - the worker's `shutil.disk_usage`, used only when a tool is installed.

## Contract check

These match the plan:
- `ServiceState.downloads`, `publishBackground` (only while unlocked: it checks `isUnlocked`) and `onBackground`.
- `DownloadRunner`: the constructor and `held`, `active`, `estimate`, `start`, `resume`, `request`, `discard`, `list`, `problems`, `stopProject`, `onQueuedForTranscription`. There are extra public members (`memory`, `videoToolsInstalled`, `addressKey`).
- `EventType` adds `"background.progress"`.
- The `Same<DownloadQuality, …>` assertion and the 400 `"…" is not a quality.`.
- The transcription default.

The routes table, row by row:

| Route | Check | Result |
|---|---|---|
| All new routes | 423 before anything else; extension token refused with 403 | Tested |
| `capture-estimate` | `checkCaptureAllowed` first, 429 with `estimateRateLimitedText`, `videoToolsInstalled` from the catalogue | Tested |
| `capture-estimate` | 409 `TOOL_NOT_INSTALLED` (via `WorkerToolError`) | Correct by reading; not tested |
| `capture-profile` | `{queueId: runId}`; `queued` behind another run; 409 `TOOL_NOT_INSTALLED` reason `ffmpeg` with `VIDEO_TOOLS_NEEDED_TEXT` | Tested |
| `capture-profile` | The tools check | Only when a quality is sent (Minor 2) |
| `pause` | 409 `CONFLICT` with `RUN_NOT_RUNNING_TEXT`, for a run not held and for one waiting its turn | Matches |
| `stop` | `stopNotRunning` when not held; a run waiting its turn leaves the queue `stopped` | Matches |
| `resume` | 409 `RUN_ALREADY_RUNNING`; 403 `POLICY_DENIED` | Matches |
| `discard` | 409 when held | Matches |

The sentences come from `@ao/shared` and match Task 1 character for character.

What the screens of Task 6 call (`packages/ui/src/api/background.ts`):
- The paths and methods all exist.
- `backgroundProgress` needs `downloads.projectId`, `title`, `url`, `platform` and the counts. All are present in the service's summaries.
- `discarded` is sent as a string.

## Mutations (each restored)

1. **The turn removed** (`const turn = {}`): "a second channel … waits its turn …" FAILED. "Stop on a run waiting its turn …" FAILED (hung to its time limit). "a paused or stopped first run …" still PASSED (Minor 7).
2. **The lock no longer forgets** (`h.key = undefined` and `forget(h)` removed from `stopProject`): "a lock stops the run …" FAILED, and "at the lock no address or title …" FAILED.
3. **Resume's second `runs.has` check removed**: "two presses of Resume downloads …" FAILED (`[200, 200]`).

## Runs (single files, nice -n 10)

- `downloads-routes.test.ts`: 25 passed.
- `capture-queues.test.ts`: 31 passed.
- `capture-routes.test.ts`: 10 passed.
- `server.test.ts`: 160 passed, 1 skipped.
- `ui-only-routes.test.ts`: 128 passed.
- `transcription-jobs.test.ts`: 40 passed.
- `streams.test.ts`: 3 passed.
- `pnpm --filter @ao/library-service typecheck`: exit 0.

## Timing

The tests use gates that are released after each test and `state.idle()`, with no sleeps. The two-presses test uses `Promise.all`, and its assertion holds whichever press wins. The restart tests really close the service and create a new one over the same library.

## What I could not check

- The e2e (not run, as instructed).
- The real macOS `diskutil` and `/Volumes` naming.
- Real yt-dlp and ffmpeg behaviour on a long download during a move. C1 was reproduced with a short drain limit, not a real 60 s download.
- Whether the closures of the library's `captureProfile` keep an address after the lock until the cut job returns (needs a heap snapshot).

---

# Second look (R687)

Range a0a1226..1181aa2 (A 6a4dfce, B 70e9c48, C 3df82ef, D 1181aa2). All probes were removed and every file restored; `git status --short` is empty.

## Verdict: CHANGES NEEDED

One Important finding (I4), which may need a ruling. Everything else the fix brief asked for holds.

## Important

**I4. A move ends a slow-down wait at once, and the run then asks the platform straight away.** This holds whether the move goes ahead or is refused. `downloads.ts:299-302, 366-392` (`afterMove`, then the library's `resume("continue")`).
- What happens:
  - `haltSignal` wakes the wait, as R680 requires, and the run ends with `CaptureCancelledError`. The journal still says `waiting {ms, why: "rate-limited"}`.
  - The continuation then calls `resume(…, "continue")`. That starts a fresh try: the run is listed again at once.
  - Whatever was left of the platform's slow-down is dropped, and the growing schedule and the 12-hour clock start again from zero.
  - A refused move does the same, because the run goes on at once.
- How I know (probe, since removed):
  - Set-up: listing slowed down (`FAKE_TOOL_MODE=enumratelimit`); a sleep seam that wakes only on abort.
  - The run was `waiting` (60 000 ms, rate-limited), with 1 listing in the run log. After a successful move, the run log had 2 lines (a new listing), the run was `downloading`, and no new wait had been started.
  - This answers your question: the run continues "from a fresh try", not "in the same wait".
- Smallest fix: when the journal says `waiting` with a `wait`, the continuation's body first sleeps for the rest of that wait before it calls `resume`.
  - The rest is measured from the run's `updatedAt` plus `wait.ms`.
  - The sleep goes through the seam, and a Stop or a cut ends it early.
  - The run stays `waiting` while it sleeps.
- If the growing schedule must carry on as well (rather than only the current wait), that needs `packages/library`: NEEDS A RULING.

## Minor

1. **A Pause asked of a run still finishing its video after a refused move ends "interrupted", not "paused"** (probe). It never goes on by itself, and Resume works. But `afterMove` drops the run without writing the pause; without a move, the same press gives "paused".
2. **The continuations after a refused move are audited as `capture.profile.continue`** (probe: `["capture.profile", "capture.profile.continue", "capture.profile.continue"]`).
   - That records a continuation for a move that did not happen.
   - For a run that was waiting its turn, it is also the run's FIRST decision: its start is audited as a continuation.
3. **An estimate whose listing fails for another reason answers 502 with code `INTERNAL`.**
   - The message is now the library's plain sentence, with the error code as `reason`, which is fine.
   - The status and code still describe an internal failure, for conditions such as a sign-in being needed or the channel being gone.
4. **`resume` computes `before` at the press.** If every run ahead ends during the Resume's awaits, the answer is `queued` and a `downloading` event follows at once. This is only cosmetic.

## The fix brief's points, checked

**A (the Critical): closed.**

These tests are in place and pass:
- the refused-move test (the run and the run behind it go on in their order, `stoppedWorkCount() === 0`);
- Resume, Pause, then a successful move: the run stays paused and the run log has no new line;
- a run stopped after the halt is not continued.

Beyond the brief, by probe and by reading:

| Case | How checked | Result |
|---|---|---|
| A refused move while one run downloads and two wait | Probe | All three stay held. A Stop of the third while it waits works. The order is kept (A, then B; nothing of C asked). Nothing is left in `stoppedWork`. |
| A run stopped, finished or discarded between the halt and its continuation | Reading | The journal check (`LIVE`) drops it, and the run is published as it now reads. |
| A run stopped while its continuation is pending | Reading | The old `Held` has no `asked`, but the journal check catches it. |
| A run resumed between the halt and its continuation | Reading | `runs.has` prevents a second hold. Resume, Pause, Stop, a lock and a close all answer 503 during a move (server.ts `preHandler`), so the window is only the refused path. |
| Two moves in a row, the first refused | Test | Covered by the test above. |
| An encrypted project's run at a successful move | Reading | Not continued; shown interrupted. It is published only if its project is unlocked: `publishRun` swallows `ProjectLockedError`. |
| A close or a lock during a move | Reading | Refused with 503. |
| A two-hour wait at a move | Probe | **I4.** |

**B: closed.**
- I3: the run is registered synchronously at entry. Every early exit lies inside the `try`, whose `finally` forgets the run and settles it when it was not launched:
  - the run not found;
  - `RUN_FINISHED`;
  - an address conflict;
  - a policy refusal;
  - the media helper missing;
  - a lock found by `stillHeld`;
  - the final `requireUnlocked`.

  A Discard, a Pause, a start of the address and a second Resume all meet the mark; each is tested. A Stop during the Resume ends `stopped` with nothing asked of the platform. A lock during the awaits gives 423, with `memory()` empty and the library's resume never called.
- I2: a Resume is refused while another held run of the project has the same address. Tested: 409, one run held, no second listing.
- I1: a failure after the answer is logged as `download-run failed` and the run is published as interrupted. Runs cut by a lock or a close are excluded (`late && !h.cancelled`). Tested.
- Minor 9: 409 with the `RUN_FINISHED` sentence. Tested.

**C: closed, except Minor 3 above.**
- No quality in the request means none is passed on (a guard test).
- The estimate checks the lock again after its listing and on every failure path (423, no title).
- A missing tool with no id answers 409 with the general sentence.
- A link the runs refuse answers 400 before any queue or run exists.

**D: closed.**
- `downloadFreeBytesFromEnv` returns undefined unless `NODE_ENV === "test"`. A unit test covers undefined, `production`, `development`, `Test` and `"test "`.
- It is read in `main.ts` beside the other test-only switches and gated a second time in `downloadSeams` (`NODE_ENV === "test"` only; the `VITEST` clause is gone).
- `e2e/fixtures.ts` sets `AO_TEST_FREE_BYTES` to 500 GB.

**Nothing loosened.**
- `capture-queues.test.ts` was not touched in this range, so :578 is unchanged.
- The three lines removed from `downloads-routes.test.ts` were replaced by stricter assertions in Minor 7's test.

## Mutations (each restored)

1. **The immediate `afterMove` after a rollback removed**: the refused-move test FAILED.
2. **The `LIVE` journal check removed**: "a run stopped after the move halted it…" FAILED. The paused-run test still passed: there the `asked` check covers it.
3. **The turn removed**: "a paused or stopped first run lets the next one begin" now FAILS, as Minor 7 asked.

## Runs (single files, nice -n 10)

- `downloads-routes.test.ts`: 42 passed.
- `capture-queues.test.ts`: 31 passed.
- `capture-routes.test.ts`: 10 passed.
- `server.test.ts`: 160 passed, 1 skipped.
- `ui-only-routes.test.ts`: 128 passed.
- `transcription-jobs.test.ts`: 40 passed.
- `streams.test.ts`: 3 passed.
- `move-finish.test.ts`: 48 passed.
- `pnpm --filter @ao/library-service typecheck`: exit 0.
- The e2e was not run, as instructed.

## What I could not check

- The e2e.
- A real 60 s drain on a Mac.
- Whether a real platform punishes a listing sent early during its slow-down (I4).
