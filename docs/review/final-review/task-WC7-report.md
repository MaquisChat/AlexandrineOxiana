# Task WC7 — The transcription list, the project's switch, "Transcribe everything", and keeping the Mac awake

Worktree `.claude/worktrees/kg-3a`, branch `wc-7-list`, head **1c250a2** (one commit, as step 5 names it).

## What was built

### Library
- `packages/library/src/repo/automation.ts` — `setProjectAutomation(core, projectId, a)`: validates the boolean, one governed `store` change of project.json, audited with op `project.automation` (the `backup-settings.ts` pattern). Public wrapper `setProjectAutomation(repo, …)` in `repo/repo.ts` (beside `setProjectBackupSettings`), exported through `repo/index.ts`.
- `packages/library/src/untranscribed.ts` — `untranscribedSources(repo, projectId)`: sources with `recordingOf`, no non-destroyed `transcript` asset, not pending on the list, and no pending `audio.transcribe` job (queued, running, or cancelled `PROJECT_LOCKED`, since that one reruns at the unlock, R142). It returns title and `soundSec` (`soundSecondsOf`). Exported from `index.ts`.

### Service
- `apps/library-service/src/transcriptions.ts` — `whenEnded(s, projectId, jobId, signal?)`. The waiter is registered first and the journal read after. It resolves straight away when the record has ended (done, failed, or cancelled other than `PROJECT_LOCKED`), otherwise when the run this service holds reaches `end()`. A job left pending is waited for. `signal` cancels the wait. The optional `signal` parameter is my addition to the pinned signature.
- `apps/library-service/src/transcription-list.ts`:
  - `SpeedMeter`: the last 10 samples per model; speed is total sound ÷ total wall time.
  - `TranscriptionListRunner`: `kick`, `summary`, `pause`, `continue`, `stop`, `stopProject`, `stopAll`, `active`, `memory`, `publish`, `answer`.
  - The loop is registered work `transcription-list`, one per project.
  - It follows a job that is already pending for the source (one started by hand, or carried over a restart) instead of starting a second one.
  - When the mark answers `false` (R672), the loop cancels the job it started.
  - A source missing (`NotFoundError`) or without a recording (`NoMediaError`) is marked cancelled, and the list goes on.
  - `PolicyDeniedError` marks the entry failed `POLICY_DENIED` and pauses the list.
  - A job that ended `UNRECOVERABLE` is recorded as `TRANSCRIPTION_UNRECOVERABLE`.
  - A job cancelled by a lock ends the loop and leaves the entry running.
  - The speed is recorded only for jobs this loop started, measured with `state.opts.now()`.
  - Stop cancels the job in hand. If the job is not held, it uses `cancelPendingJob`. Stop also wakes the loop's wait.
  - A move's `onStopping` ends the loop and returns a continuation that calls `kick` again.
  - A failure is logged (`transcription-list failed`) and the list is published.
- `apps/library-service/src/keep-awake.ts` — `KeepAwake`:
  - On darwin only, it runs `spawn("/usr/bin/caffeinate", ["-i","-w",pid], {stdio:"ignore"})` once and `unref`s it.
  - SIGTERM is sent when it is no longer wanted.
  - The process is forgotten on `exit` or `error`, so a later update can start a new one. There is never more than one.
- `apps/library-service/src/routes/transcription-list.ts` — every route in the table:
  - The list routes and `untranscribed` answer 423 first. The four routes that change the list then check `requireWritable` and publish before they answer.
  - POST `transcription-list` order: model check (400), installed tool (409 `speech-<model>`), then `addToTranscriptionList` (403 on a deny, asked even with nothing to add), then `kick`.
  - Automation GET/PUT; PUT checks `requireWritable` and answers 400 for a non-boolean.
  - `/settings/background` uses `background.json` through `readAppSettingStrict` / `updateAppSettingStrict`, default `{keepAwake:true}`.
  - `readBackgroundSettings` is read once at service start.
- `state.ts`:
  - New members: the `transcriptionList`, `speedMeter`, `keepAwake`, `setKeepAwakeSetting`, `updateKeepAwake` (hooked into `onBackground` in the constructor).
  - The download runner's `onQueuedForTranscription` calls `kick`.
  - `attachWorker` kicks every unlocked project (this covers the open and the restart).
  - `closeLibrary` calls `stopAll()` and `keepAwake.stop()`; `shutdown` calls `keepAwake.stop()` again.
- `routes/projects.ts`: the unlock calls `kick`. The lock of an encrypted project calls `stopProject` and then `updateKeepAwake`.
- `server.ts`:
  - Registers the routes.
  - Adds the `keepAwake` test option, honoured only when `NODE_ENV === "test"`. In test mode without it, the platform is treated as linux, so no test ever starts a real caffeinate.
  - Reads the setting at start.
- `routes/downloads.ts`: the estimate answers `measuredSpeed = speedMeter.speed(speechModel)`, and leaves it out before anything has been measured.

## Tests (all written first; all failed first)
- Library:
  - `repo/automation.test.ts`: "setProjectAutomation is governed and audited".
  - `untranscribed.test.ts`: "untranscribedSources leaves out sources with a transcript, on the list, or pending".
  - Both failed first because the function and module did not exist.
- `transcription-list-routes.test.ts`: every test the plan names, plus "transcribe everything is refused by the project's rules (403) and for a speech model that is not installed (409)".
  - The three switch and route tests failed first with 404.
  - The list tests failed first by timing out, because the routes did not exist.
- `keep-awake.test.ts`: both named tests; they failed first because the module was missing.
- Waits are for events (`listEvent`), for `worker.posted(n)`, or for `state.idle()`. The stand-in worker holds each job until it is released.

## Researcher-visible sentences
- No new shared sentence.
- New service errors: `"<model>" is not a transcription model.` (the transcribe route's own wording); `"transcribeNewMedia" must be true or false.`; `"keepAwake" must be true or false.`
- 409 reuses the existing missing-tool sentence.

## Existing tests changed
None.

## NEEDS A RULING
1. **The list's counters restart while a channel is still being transcribed.** Task 1's rule is that adding to an empty list resets total, done and failed (`transcription-list.ts:169`). Transcription is often faster than downloading, so the list empties between videos. The screen then shows "Transcribing: 1 of 1" again and again, and between videos "Transcriptions finished: all 1 done." — never "14 of 412". I found this in my test "a run with transcribe feeds the list…", which I wrote to assert transcripts rather than counters.
   - (a) Accept it as it is.
   - (b) Reset the counters only when the list is emptied by a Stop or by "Remove from this list", never when an entry is added.
   - (c) Keep the counters running while any download run of the project with transcribe is held.
   - I recommend (b): a small change in Task 1's `addToTranscriptionList`.
2. **A missing speech model fails every remaining entry one after another** (`TOOL_NOT_INSTALLED`). The plan pauses download runs for a missing tool but says nothing for the list. I built what the plan says (the entry fails with its code). Pausing the list on `TOOL_NOT_INSTALLED`, as `POLICY_DENIED` does, would be a one-line change.

## Found in the code / minor
- The interfaces matched the plan. `markTranscriptionEntry` returns `Promise<boolean>` as the brief said, and `stopTranscriptionList` resets the counters as described.
- The plan put `onQueuedForTranscription` wiring in `downloads.ts`. It is set in `state.ts`'s `downloads` getter instead, and `downloads.ts` is unchanged.
- The loop starts when the media helper is attached (`attachWorker`), not before. With `autoStartWorker` off, it starts at the first worker use.
- minor (deferred): if a transcription is being started by hand at the very moment the loop reaches that source (the source's reservation is held), the loop ends with a log line. The next change, unlock or open starts it again.
- `GET /projects/:id/automation` does not answer 423 for a locked project: the switch is plain project.json and identifies nothing. PUT on a locked encrypted project is refused by the library itself.

## Runs (last summary line of each)
- library `automation.test.ts` + `untranscribed.test.ts` + `lists/transcription-list.test.ts`: Tests 13 passed (13)
- service `transcription-list-routes.test.ts`: Tests 14 passed (14)
- `keep-awake.test.ts`: Tests 2 passed (2)
- `transcription-jobs.test.ts`: Tests 40 passed (40)
- `downloads-routes.test.ts`: Tests 46 passed (46)
- `server.test.ts`: Tests 160 passed | 1 skipped (161)
- `ui-only-routes.test.ts`: Tests 128 passed (128)
- typecheck `@ao/library`, `@ao/library-service`: no errors
- `git status --short`: empty

## Fix round (R692)

Fresh implementer. Branch `wc-7-list`, from 1c250a2 to **bf9120e**. There is one commit per group: A c6ef5cf, B 752de70, C 9b4032a, D 7dc58ee, E b929be1, F bf9120e.

### A. The counters are reset only by a Stop (c6ef5cf)
- `addToTranscriptionList` (`packages/library/src/lists/transcription-list.ts`) no longer resets anything. An add only adds.
- (M2) `markTranscriptionEntry`: any move out of an ended state (done, failed, cancelled, including cancelled → done) writes nothing and answers `false`. Marking an ended entry with the status it already has also writes nothing, and answers `true`.
- Tests:
  - Task 1's test "adding to an empty list resets total, done and failed" is **CHANGED and renamed** to "adding to an emptied list keeps total, done and failed: only a Stop sets them to 0 (R692)". It failed first.
  - New: "an entry that has ended never moves again: a Stop that lands as its job ends leaves the counters at 0". It failed first.
  - Service: "a run with transcribe feeds the list…" (**changed**) now checks four things:
    - it asserts "2 of 2" after the two stored so far;
    - it asserts "3 of 3" at the end;
    - every published line's total and done only grow;
    - "Transcriptions finished: all 3 done."
  - The changed service test failed first: run against the old library file, it failed by assertion.

### B. A missing tool, or a stalled loop, pauses the list (752de70)
- Types:
  - `TranscriptionListData` (`job-journal.ts`), `TranscriptionListView` and `TranscriptionListSummary` gain `tool?` and `stalled?`. The summary carries them only while the list is paused.
  - `markTranscriptionEntry` gains `{status:"queued"}`, which clears `jobId`.
  - `setTranscriptionListState(repo, pid, state, extra?)`: running clears both fields. A pause sets exactly what it is given; a plain pause sets neither. A Stop clears both.
- `transcriptionLines` gains `why`, with the brief's three sentences exactly. The paused title is unchanged.
- Loop (`apps/library-service/src/transcription-list.ts`):
  - A job that ends `TOOL_NOT_INSTALLED` (the tool id comes from `error.reason`, for a live run or a rerun) puts its entry back to queued. The list is paused with that tool and published.
  - B4: any other throw is logged, then tried once more after `LIST_RETRY_MS` = 30 s through the new test seam `transcriptionListTimer` (ServiceOptions/StateOptions, NODE_ENV=test only). If that try fails too, the list is paused `stalled` and published.
  - A lock or close cancels the retry.
- `WorkLines.tsx`: `ListLine` shows `why` under the title.
- Tests: shared (1), library (1), service "a speech model not installed…" (which includes the rerun after a restart) and "a loop that fails is tried once more…", and UI (3, it.each). All failed first.

### C. No transcript made twice; the locked switch (9b4032a)
- `untranscribedSources` reads the journal itself. It also leaves out a source whose asset is the `job.entity` (asset) or the `job.inputAsset` of a pending `audio.transcribe` record that has no `about`.
- Only `transcriptVersions` counts as having a transcript: a derived transcript that is not destroyed.
- `GET /projects/:id/automation` checks `unlocked(req)` first and answers 423.
- Tests:
  - The link-capture case failed first.
  - In the derived-transcript test, the original-file case failed first. The destroyed case and the running-job case are **guards**: the old code already handled them.
  - The 423 test ("every new route…", **changed**: the automation GET moved into the locked list) failed first.
- Not done: the loop's own "already pending" lookup does not follow a link capture's job. Such a job is not tracked by `Transcriptions`, and its record has no `about`, so `whenEnded` could never see it end. With C1, "Transcribe everything" no longer adds such a source.

### D. The loop's corners (7dc58ee)
- D1:
  - New `Transcriptions.whenStarted(pid, sid, signal)`. It is told by `track`, by a release, by `drop`, and by the lock check.
  - A reservation clash now returns "busy", and the loop follows the hand-started job.
  - The test failed first.
- D2:
  - `Transcriptions.start` checks `isUnlocked` again after `transcriptionJob`. If the project was locked meanwhile, it frees the source and throws ProjectLockedError.
  - New `Transcriptions.memory()`.
  - The list's lock test (**changed**) and a new test with a lock landing inside the start (a gate on its source read) both check `live`, `waiters` and `sources`.
  - The new test is a **guard**: it passed before the mend, for two reasons. The lock route's `forgetProject` already frees the reservation, so `start` throws busy. And `authorizeProcessing` refuses a locked project, with no await between it and `track`. I found no way to make it fail first.
- D3:
  - `kick` while `state.moving` records the project.
  - `runMove`'s `finally` (`routes/libraries.ts`) calls `transcriptionList.afterMove()`, which kicks the recorded projects.
  - The test (a move refused at its plan, with a kick during the planning) failed first.

### E. Keeping awake, and the setting's file (b929be1)
- `KeepAwake`:
  - Gains `log` and `now`.
  - A spawn that throws, or an `error` event, is logged once, and nothing more is tried until the next change (not wanted, then wanted).
  - An unexpected `exit` while still wanted restarts at once if the process ran at least 10 s. Otherwise it is logged and waits for the next change.
  - At most one process.
- The runner's `active()` counts a loop only between entries, or while the job it follows is queued or running in this service. `following` is set around `whenEnded`. `updateKeepAwake` is called when it changes and when `Transcriptions.track` starts a job.
- E2:
  - `background` joins `RESETTABLE_SETTINGS` (shared) and `SETTINGS_FILES` (errors.ts).
  - The reset sets the file aside and turns keeping awake back on.
- Tests:
  - keep-awake: 2 new tests, which failed first.
  - The existing unit test "starts caffeinate…" is **CHANGED**: a process that ends by itself within 10 s is now started again only after a change, so the test calls `update(false)` before `update(true)`.
  - Service: "a loop waiting on a job that nothing runs does not keep the Mac awake". It failed first.
  - settings-files: a `background` entry in the reset table, and "an unreadable background.json … names itself". Both failed first.

### F. The missing tests (bf9120e)
- New tests, which are **guards** of existing behaviour:
  - the policy refusing transcription in the middle of the list;
  - a failed job's code, and UNRECOVERABLE → TRANSCRIPTION_UNRECOVERABLE;
  - a read-only library refusing the four routes.
- I checked these guards against mutations: the first two fail by assertion.
- Three existing tests were **changed** so that the reviewer's three mutations now fail by assertion, not by the time limit (each mutation checked):
  - "a Stop that falls between…" now waits for the loop's end and asserts that `cancel` was called;
  - "a source deleted before its turn…" now uses `idle()`, then asserts the list;
  - "pause lets…" sets `worker.instant` before the release.

### New researcher-visible sentences
- The three `why` sentences, exactly as in the brief.
- `The setting for keeping this Mac awake could not be read, so it was not changed.` This is the 503 `reason: "background"`, formed by the existing SETTINGS_FILES pattern.
- The reset's 400 sentence now lists `"background"`.

### NEEDS A RULING
- E1: "wait for the next change" is read as "until keeping awake is no longer wanted, then wanted again". During one long run, a caffeinate that dies twice within 10 s therefore stays off until that run ends.
- E2 adds a shared value (`background`) to `RESETTABLE_SETTINGS`. The UI has no reset offer for it yet; that belongs to Task 9's Governance/ToolsSetup screens, which I did not touch.

### Runs (single files, nice -n 10)
- library:

  | Test file | Result |
  | --- | --- |
  | transcription-list | 13 passed |
  | untranscribed | 3 passed |
  | automation | 1 passed |
  | job-journal | 28 passed |
  | download-run | 36 passed |

- shared background: 29 passed.
- service:

  | Test file | Result |
  | --- | --- |
  | transcription-list-routes | 23 passed |
  | keep-awake | 4 passed |
  | transcription-jobs | 40 passed |
  | downloads-routes | 46 passed |
  | settings-files (the settings-reset test) | 28 passed, 1 skipped |
  | server | 160 passed, 1 skipped |
  | ui-only-routes | 128 passed |
  | move-finish | 48 passed |

- ui WorkLines: 54 passed.
- typecheck shared, library, library-service, ui: no errors.
- lint:css and lint:colours: clean.
- `git status --short`: empty.

## Last fix (R693)

One commit: 4546a90. Each test below was written first and failed first; the D2 test is only renamed.

1. **(E) Keeping awake after two quick deaths.**
   - Code: `keep-awake.ts` gains `RETRY_AFTER_MS = 60_000`. After any failure, while keeping awake is still wanted, the next update at least 60 s after the last failure (by the injected clock) tries again. There is still at most one process, and each failure is logged once.
   - Test: "is tried again at the first update at least 60 seconds after the last failure". Two quick deaths, then no restart at an update 5 s later, then a restart at an update 61 s later. It also covers a failed start, which is retried the same way.
2. **(M-c) Every mark of an ended entry is refused.**
   - Code: `markTranscriptionEntry` answers `false` and writes nothing for any mark of an ended entry, including a mark with the status it already has.
   - Test: an assertion added to the library test "an entry that has ended never moves again". It marks done → done, expects `false`, and expects the journal file's bytes unchanged.
3. **(M-b) A Stop beats the stalled pause.**
   - Code: the runner's `failed()` reads the list before it pauses as `stalled`. If nothing is pending (a Stop emptied the list), the list is left as the Stop left it.
   - Test: "a Stop that empties the list as its retry fails leaves it as the Stop left it, not paused". The summary is idle with total 0 and no `stalled`, and the stored list is running with counters at 0.
4. **(M-a) The D2 test is renamed.**
   - New name: "a lock landing while a job is being started leaves no live job and no waiter of that project".
   - The re-check in `Transcriptions.start` stays. Its comment now says it is the second line of defence: the first is the lock route dropping the reservation, with the library refusing a locked project.

Runs (each alone, nice -n 10):
- library `lists/transcription-list`: 13 passed
- service `transcription-list-routes`: 24 passed
- service `keep-awake`: 5 passed
- service `transcription-jobs`: 40 passed
- typecheck `@ao/library` and `@ao/library-service`: no errors
- `git status --short`: empty
