# Task WC5 report: the service runs the downloads

Status: **DONE_WITH_CONCERNS**. Branch `wc-5-service`, head **a0a1226** (one commit: `feat(service): journaled download runs with pause, stop, resume, discard and the estimate`). Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-5`; `git status --short` is empty.

## What was built (all under `apps/library-service/src/`)

- **`downloads.ts`, new: `DownloadRunner`** (class at :98), with the plan's interface: `held`, `active`, `estimate` :153, `start` :328, `resume` :360, `request` (pause/stop) :380, `discard` :403, `list`, `problems`, `stopProject` :422, `onQueuedForTranscription` (does nothing by default). Two extras: `memory()` :119 (what the runner holds, for the R464 b test) and `videoToolsInstalled()` :145 (reads ffmpeg from the catalogue; null when not known).
  - A run is recorded as held synchronously, in its project's order, before anything is awaited (`register`). `ctl.turn` waits until every run before it has settled (R669). The `start`/`resume` promise settles in a `finally` when the run ends.
  - Each run is registered work `startWork("download-run")` (`launch` :196). Every `onChange` publishes `background.progress { downloads }`. The first event goes out at `createRun` (state `queued`), as R679 asks. Discard publishes `{ discarded }`.
  - **A start keeps the capture queue alive:** `captureQueues.startProfile` plus `profileRunStarted`, fed by `onItem` and `onReport`. The queue ends in `endQueue` :288; nothing is published once `endCaptures` has ended the run.
  - **Starting an address again** first discards its older unfinished runs that are not held (finished runs stay). Each discard is published.
  - **A move:** a `WorkControl.onStopping` hook sets `halt()` true and aborts `haltSignal` (R680). A plain project's run that was downloading returns a continuation `resume(…, "continue")` (`continueRun` :314). An encrypted project's run, or one only waiting its turn, does not continue and is shown interrupted.
  - **A lock** (`stopProject(id, "lock")`) cuts every held run of the project, including those waiting their turn: `cancelled` is set and `signal` aborted. The runner then forgets the run's id and address at once. Nothing more is written or published.
- **`routes/downloads.ts`, new:** the plan's routes (estimate :53, list :73, problems :78, pause/stop :83, resume :90, discard :96). On every route, a locked project gets 423 before anything else.
- **`routes/capture.ts`:**
  - `captureOptions` reads `quality`; a value outside the list gets 400 `"…" is not a quality.` (:112). The plan's `Same<DownloadQuality, …>` assertion is in place.
  - `profileRunOptions` (:127) applies the transcription default: the request's value if given, else `automation?.transcribeNewMedia === true`.
  - capture-profile (:256) now starts a run. It checks for missing Video tools (`VIDEO_TOOLS_NEEDED_TEXT`, reason `ffmpeg`) only when a quality is sent. It answers `{ queueId: runId }`.
- **`state.ts`:**
  - `downloads` getter (:376), `publishBackground` (:386, only while the project is unlocked), `onBackground`.
  - New `WorkControl.onStopping` hook (:332), called by `drainWork` (:545).
  - `closeLibrary` calls `stopProject(p, "close")` for every project (:1489).
  - New test seams in `StateOptions.downloads`.
- **`routes/projects.ts`:190:** the lock of an encrypted project calls `downloads.stopProject(id, "lock")`; `endCaptures` is unchanged.
- **`events.ts`:** `"background.progress"` added. **`server.ts`:** `registerDownloads`. The test seams `downloadSleep` and `downloadFreeBytes` are honoured only under NODE_ENV=test or VITEST (R47, `downloadSeams` :158).

## Tests (`downloads-routes.test.ts`: 25 tests; `capture-routes.test.ts`: 1 added)

All 21 named tests plus `capture-profile passes the quality to the run` were written first. I ran them and they failed for the right reason: route 404, or `downloads` undefined. I also added, with the plan's names style:
- "a slowed-down listing is 429…", which failed first;
- "a project that is not encrypted is not touched by its lock", which failed first;
- two move tests, written after the code. They passed at once, so I checked that the plain-move test bites by disabling the continuation; it then fails.

The tests use the library's stand-in worker (`packages/library/src/capture/testing.ts`, relative import as `server.test.ts` already does), the fake yt-dlp with two synthetic TikTok profiles switched per job, and an injected sleep and free-space reading.

## Researcher-visible sentences

Exactly the plan's table and Task 1's shared sentences: `RUN_ALREADY_RUNNING_TEXT`, `RUN_NOT_RUNNING_TEXT`, `VIDEO_TOOLS_NEEDED_TEXT`, `estimateRateLimitedText`, and the library's `RUN_FINISHED`. The new sentences are:
- `"<value>" is not a quality.` (the plan's wording);
- for a capture-estimate link that is not a profile, channel or playlist: "That is not the link of a profile, channel or playlist on YouTube, Instagram or TikTok."

## Existing tests changed

- `capture-queues.test.ts` ≈:180, "a profile run: its address, its posts so far and its report": `report.status` is now expected to be `"paused-tool"` instead of `"failed"`. A profile capture is now a run with hooks, and Task 3's executor pauses on a missing tool (Review Focus 3). Its other assertions (errorCode, tool, reason, no items) are unchanged. The test at :578 is unchanged and passes.

## NEEDS A RULING

1. **The plan says `capture-queues.test.ts` is NOT changed, but one of its tests had to change** (above). The options are:
   - (a) keep my one-line change. **I recommend this:** it is the truth of the new design.
   - (b) have the capture queue report `paused-tool` as `failed`. That would misreport the run.
2. **RUN_ALREADY_RUNNING versus CAPTURE_RUNNING.** `capture-queues.test.ts:341` requires a profile address that is still downloading to be refused with `CAPTURE_RUNNING` "…already being captured in this project". Since a start keeps the capture queue alive, that existing check (`runningConflict`) answers first. The plan's `RUN_ALREADY_RUNNING` on capture-profile is therefore reached only for a held run without a live capture queue, which in practice means a resumed run. My test pins exactly that.
   - The options are: (a) keep this, **which I recommend**; (b) check the held run first, which breaks :341.
   - Resume and discard of a held run always answer `RUN_ALREADY_RUNNING`.
3. **The e2e scenario 10 depends on the machine's free disk.** This machine has 7.9 GB free, below the fixed 10 GB floor. The run correctly pauses with "Paused: the disk is nearly full…", so scenario 10 fails here.
   - With the free-space reading replaced by a temporary, uncommitted change (reverted), scenario 10 passes (27.7 s).
   - Proposal: a test-only free-space switch honoured under NODE_ENV=test and set by `e2e/fixtures.ts` (Task 10, or a fix round). I did not touch `e2e/`.

## Found in the code that the plan did not expect

- `RunControl` matches the plan, plus `haltSignal` (R680), as the brief said. `WorkControl.stopping` is a plain boolean with no notification, so I added `onStopping`, called by `drainWork`.
- **A close cuts runs rather than halting them**, for every project. The reason is that nothing must be written after the library's lock goes (closeLibrary's rule). The video in flight is asked to stop and the run is shown interrupted. The plan left the close's manner open.
- If a move is refused after its drain, a halted encrypted or waiting run is shown interrupted instead of going on. A plain downloading run does continue.
- For a Resume, the runner first asks the project's rules (`checkCaptureAllowed`, 403 with the reason) so the route can answer 403. The run's own `capture.profile.resume` decision is still the only audited allow; the test checks this.

## Runs (last summary line each)

- `downloads-routes.test.ts`: Tests 25 passed (25)
- `capture-routes.test.ts`: Tests 10 passed (10)
- `capture-queues.test.ts`: Tests 31 passed (31)
- `server.test.ts`: 160 passed | 1 skipped (161)
- `ui-only-routes.test.ts`: 128 passed (128)
- `transcription-jobs.test.ts`: 40 passed (40)
- `streams.test.ts`: 3 passed (3)
- Also run: `move-finish` 48 passed, `library-place-routes` 8 passed, `lock-during-change` 3 passed.
- `pnpm --filter @ao/library-service typecheck`: exit 0.
- `@ao/ui build`: built.
- `e2e/capture.spec.ts` (chromium): 3 passed, 1 failed (scenario 10, disk floor: ruling 3). With the floor bypassed temporarily: scenario 10 passed.

## Fix round (R687)

Fresh implementer. Branch `wc-5-service`, five commits after a0a1226. Each test below failed before its fix unless it is marked as a guard. `packages/library` is untouched.

### A. Runs after a move (C1, Critical): commit 6a4dfce
- `downloads.ts`:
  - **Places in the order.** A run's turn is read from the project's order by `seq` each time it is checked (`launch`, `ahead`/`turn`). A continuation is registered again under its old `seq`, so it takes back its place.
  - **The move's end.** When a halted run ends while `work.stopping` is still true, it returns a continuation (`afterMove`). When it ends after the drain was rolled back, `afterMove` runs at once on the same session.
  - **`afterMove`**:
    - On the same root (refused or rolled back), every halted run goes on, including those waiting their turn and those of encrypted projects.
    - On a new root, only a begun run of a plain project goes on.
    - A run never goes on when: a Pause or Stop was asked of it, it is held again, its project is locked, or the session has changed.
    - The continuation's body reads the journal first. If the state is not queued, downloading or waiting, it throws `NotContinued`: the continuation is dropped and the run is published as it now reads.
- `state.ts`: `stoppedWorkCount()` (for diagnostics and tests).
- Tests:
  - "a move refused for time leaves the runs as they were…" (the reviewer's probe);
  - "after a refused move, a run paused meanwhile stays paused through a later successful move…";
  - "a run stopped after the move halted it is not continued…": it failed with the journal check removed;
  - the existing plain-move test now also asserts `stoppedWorkCount() === 0`.

### B. Around a Resume (I1, I2, I3, Minor 9): commit 70e9c48
- **I3.** `resume` registers the run in `runs` and in the order synchronously at entry.
  - The run gets its address key once `get` returns, and the same-address check (`addressHeld`) runs then.
  - `stillHeld()` is checked after every await, and `requireUnlocked` right before `launch`.
  - A `finally` forgets the run and settles it on every early exit.
  - Pause on a run being resumed answers 409 (not running). Stop marks the run, waits for it to settle, then writes `stopNotRunning` if nothing holds it.
  - `discard` and `start` see the run as held.
- **I1.** A failure after the route answered is logged with `log.warn` as `download-run failed` and published through `publishRun`. A run cut by a lock or a close is excluded.
- **Minor 9.** `InvalidInputError` RUN_FINISHED becomes 409 CONFLICT with the RUN_FINISHED sentence.
- Tests: six, under "around a Resume (R687)".

### C. Routes (Minors 2, 5, 6): commit 3df82ef
- **Estimate.** After the listing, and also after a failed listing, the lock is checked again: 423.
  - `WorkerToolError` goes through unchanged (409 with the tool id).
  - TOOL_NOT_INSTALLED without a tool id answers 409 with `TOOL_NOT_INSTALLED_TEXT` (now exported from `errors.ts`, the same sentence as before).
  - Any other listing failure answers 502 INTERNAL with the library's own plain sentence (`err.message`, which is `plainReason(code)`) and `reason` = the code.
- **capture-profile** classifies the link right after the lock check. A link the runs refuse answers 400 with `plainReason("UNSUPPORTED_URL")` before any queue or run exists.
- **No quality.** The service already passed none on, so the new test passed at once: it is a **guard**.
- The estimate tests for the tool-id row and for 400 on an unknown quality also passed at once: they are guards. The other estimate tests failed first. The lock test gates `videoToolsInstalled`, because a gate on the listing passed by accident (the library's repo read met the lock).

### D. Test-only free space (Minors 3, 7): commit 1181aa2
- `downloadFreeBytesFromEnv` in `downloads.ts` reads `AO_TEST_FREE_BYTES`, only when `NODE_ENV === "test"`. In test mode, a value that is not 1–16 digits refuses the start and names the variable.
- `main.ts` reads it beside the other test-only switches and passes it as `downloadFreeBytes`. `e2e/fixtures.ts` sets it to `500000000000`.
- The `downloadSeams` gate is now `NODE_ENV === "test"` only.
- Unit tests:
  - the switch is ignored under any other NODE_ENV;
  - the seams are ignored under NODE_ENV=development (this failed first, because VITEST let them through).
- "a paused or stopped first run lets the next one begin" now asserts from `runLog`. With the turn removed, it fails.

### New researcher-visible sentences
- None. The routes reuse existing sentences: `plainReason(...)` and the existing missing-tool sentence.

### NEEDS A RULING
- None.

### Runs
- See the final message.
- downloads-routes 42 passed; capture-queues 31; capture-routes 10; server 160 passed | 1 skipped; ui-only-routes 128; transcription-jobs 40; streams 3; move-finish 48; library-place-routes 8; lock-during-change 3; typecheck @ao/library-service exit 0; e2e tsc exit 0; `@ao/ui build` built; `e2e/capture.spec.ts` (chromium) 4 passed, scenario 10 included; `git status --short` empty.
