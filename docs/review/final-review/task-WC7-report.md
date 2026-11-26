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
