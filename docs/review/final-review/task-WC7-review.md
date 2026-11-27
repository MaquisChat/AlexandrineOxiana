# Task WC7 review: the transcription list, the project's switch, "Transcribe everything", keeping awake

Worktree `.claude/worktrees/kg-3a`, branch `wc-7-list`, range abf9041..1c250a2 (one commit). Reviewer: adversarial, did not build it.

## Verdict: READY WITH FIXES

There are two Important findings and nine Minor ones.

## Important

**I1. A source being transcribed by a link capture right now is counted as having no transcript, and is transcribed a second time.**
- Where: `packages/library/src/untranscribed.ts:15-19`. The loop's own check has the same gap: `apps/library-service/src/transcription-list.ts:175-176`.
- What happens:
  - A single-link capture, or a link queue, with Transcribe (`link-capture.ts:638` → `runTranscription` → `worker.submit`, `link-capture.ts:406`) submits **without `about`**.
  - `transcriptionRecords` keeps only records with `about.sourceId` (`transcription-jobs.ts:119`), so that pending job is invisible.
  - The source is stored before its transcription starts, so for the whole length of the transcription it has a recording and no transcript.
  - Result: `GET …/untranscribed` counts it, `POST …/transcription-list` adds it, and the loop starts a second transcription of the same recording. That leaves two transcripts, and doubles the work on a long recording.
- How I know: by reading. The record is built at `worker-client.ts:498`, where `about` is added only when the job carries one. `runTranscription` passes `entity: {type:"asset", id: media.id}` and no `about`.
- Smallest fix: in `untranscribedSources`, and in the loop's "already pending" lookup, also treat as pending any `audio.transcribe` record that is queued or running (or cancelled `PROJECT_LOCKED`) whose `job.entity.id` (or `job.inputAsset.assetId`) is one of the source's asset ids.
- Do not simply add `about` in link-capture: `Transcriptions.rerun` would then take those records over after a restart, which is a behaviour change.
- Add a probe test: a pending `audio.transcribe` record with an asset entity and no `about`.

**I2. A locked project's switch: the real service and Task 9's fakes disagree.**
- Where: `apps/library-service/src/routes/transcription-list.ts:114-118`.
- The real service: `GET /projects/:id/automation` of a locked encrypted project answers **200** `{"transcribeNewMedia":false}` (probe P1).
- Task 9's fakes (`kg-4/packages/ui/src/test/backgroundService.ts:76-78`, `automationLocked`, and `msw-governance.ts:18-19`, `lockedAutomation`) answer **423 "as the service does"**. The Governance screen is being built and tested against 423.
- The real PUT answers 423 (P1), so the two agree only on PUT.
- Also, 200 with `false` for a locked project is not even true: the value could not be read under its key.
- Smallest fix: `requireUnlocked(s, projectId)` in the GET (one line), matching the list routes' "423 before anything else". Otherwise the coordinator rules that the fakes change.

## Minor

**M1. A loop that throws leaves the list "running" with nothing behind it.**
- Where: `transcription-list.ts:129-140`.
- Probe P3: I made `transcriptions.start` reject, and separately made `whenEnded` reject. In both cases:
  - the error is logged ("transcription-list failed");
  - the list is published once;
  - `active()` goes false;
  - the summary stays `{state:"running", total:2, done:0}`, so the line reads "Transcribing: 0 of 2" with nothing running.
- It carries on only at the next kick (an add, Continue, the unlock, a reopen). Nothing retries, and the researcher is told nothing.
- Fix: re-kick once after a delay through the injected timer, or pause the list so that Continue is offered.

**M2. A Stop that lands just as a job ends leaves the counters at 1 of 1.**
- Where: `transcription-list.ts:213` together with Task 1's `markTranscriptionEntry`.
- Task 1 refuses only an ended → running/queued move. An entry cancelled (`STOPPED`) by a Stop can still be marked `done` by the loop when the job ended just before the Stop's journal write. The counters then move by (−1 → 0 total, +1 done), giving total 1, done 1.
- So after the Stop the line says "Transcriptions finished: all 1 done.", not nothing (R672).
- Fix: Task 1 answers `false` for any move out of an ended state, or the loop marks only when the entry is still pending.

**M3. A hand start at the same moment stalls the list (named by the implementer).**
- Where: `transcription-list.ts:239-244`.
- A reservation clash ends the loop, and nothing kicks it when the hand-started job ends. The list stalls exactly as in M1.
- Fix: follow the hand-started job (wait for `current()` to appear), or re-kick after the job ends.

**M4. The loop can leave something of a locked project in memory.**
- Where: `Transcriptions.start`, `transcriptions.ts:148-153`.
- A lock that lands while the loop is inside `transcriptionJob` (its source read and policy read are I/O) lets `track()` create a live job afterwards. That job carries the job id and source id of a now-locked project, and it stays in `live` until it is pruned.
- This race already exists for a hand start, but the loop makes it happen with nobody pressing anything.
- Fix: re-check `s.repo.isUnlocked(projectId)` after `transcriptionJob`, before `track`.

**M5. Keeping awake can quietly stop, or never stop.**
- Where: `keep-awake.ts:31-44`.
- A `caffeinate` that dies, or fails to spawn (the `error` event), is forgotten silently and started again only at the next `background.progress`.
- The list publishes only between entries. So if the process dies during a 3-hour transcription, the Mac is not kept awake for the rest of it, and nothing is logged.
- The opposite case: a loop waiting (`whenEnded`) on a pending job that is never rerun (the media helper gone) keeps `active()` true, so the Mac is kept awake while nothing runs.
- Fixes:
  - log the spawn error;
  - restart on an unexpected `exit` while the process is still wanted;
  - count a loop as active only while a job it follows is live.

**M6. `background.json` has no way out when it cannot be read.**
- `/settings/reset` (`routes/settings-reset.ts`) knows only `extension-pairings`, `fonts` and `appearance`.
- If `background.json` cannot be read, the PUT is refused for good, and the screen keeps showing the default "on".
- Fix: add `background` to the resettable settings (Task 68 pattern), or accept a replace for this one-field file.

**M7. Any transcript asset counts, not only a derived one.**
- Where: `untranscribed.ts:28`.
- Any `kind === "transcript"` asset not destroyed counts, an original transcript file included. The plan says a *derived* transcript, and `source-actions.ts:140` checks `role === "derived"`.

**M8. The tests have gaps.**
- No test for:
  - the policy pause in the middle of the list;
  - a failed job → entry failed with its code, and `UNRECOVERABLE` → `TRANSCRIPTION_UNRECOVERABLE`. Probe P2 shows that the list goes on with done 1, failed 1, but the code is not asserted;
  - a read-only library refusing the four list routes (R684);
  - a destroyed transcript counting as untranscribed;
  - a running (not only queued) job being excluded.
- The lock test checks only `transcriptionList.memory()`, which returns map keys. It does not check `Transcriptions`' waiters or `live` (see M4).
- Under mutation, the key tests fail by **timeout** (60 s / 30 s), not by an assertion naming the fault.

**M9. `kick` does not check that a move is in progress.**
- `kick` does not check `state.moving`. A download run's `onQueuedForTranscription`, or an unlock landing in a move's window, could start a loop that writes while the library is copied.
- The move's drain halts it only if it is registered before the drain. The risk is low.

## The coordinator's two coming rulings: what else they touch
1. **The counters are reset only by Stop / "Remove from this list".**
   - Task 1 `addToTranscriptionList` (`lists/transcription-list.ts:169`, the `pending.length === 0` reset) and its test "adding to an empty list resets total, done and failed": that test must change and be named.
   - Task 7's test "a run with transcribe feeds the list…" should then assert "N of M" across the run.
   - Task 9's fake already adds to the total on POST (`total: l.total + added`), so it matches the ruling.
   - Task 6's "Remove from this list" (stop of an idle list) becomes the usual way a finished line goes away.
   - M2 matters more once the counters persist.
2. **A missing tool pauses the list.**
   - `TranscriptionListData` / `TranscriptionListSummary` (Task 1, shared) need a `tool` field. Tasks 6 and 9's fakes, WorkLines and `transcriptionLines` need it too, and the paused sentence with the tool is new shared wording.
   - `markTranscriptionEntry` must allow running → queued and clear `jobId`.
   - The loop must map a job that ends `TOOL_NOT_INSTALLED` (tool id in `error.reason`) to: entry back to queued, list `paused` with the tool. This applies also to a rerun after a restart.
   - Continue must clear the tool.
   - A paused list must stay out of `active()` (it already is).
   - The POST's 409 `speech-<model>` check stays as it is.

## Contract check
- **Library:** I compared the plan's Interfaces with the code. `setProjectAutomation` (repo wrapper, op `project.automation`, audited, read-only refused) and `untranscribedSources` match.
- **Service:**
  - `SpeedMeter.record/speed`, `TranscriptionListRunner` (kick, summary, pause, continue, stop, stopProject, active, plus extras) and `KeepAwake(opts).update/stop` match.
  - `whenEnded(s, pid, jobId)` matches, with an extra optional `signal` that callers can leave out.
  - `onQueuedForTranscription` is wired in `state.ts`, not in `downloads.ts`. That has no effect on anyone else.
- **Routes:**
  - Every route in the table is there.
  - 423 comes first on the list routes and `untranscribed`.
  - `requireWritable` is on pause, continue, stop, POST and the automation PUT.
  - A non-boolean is 400 on both PUTs.
  - 409 `TOOL_NOT_INSTALLED` reason `speech-<model>` comes before anything is added; 403 comes on a deny.
  - `measuredSpeed` is the meter's value, the same number as the summary's `soundPerSecond`.
  - None of the new routes is an extension route (the test asserts 403 for the extension token).
- **The screens' calls:**
  - `packages/ui/src/api/background.ts` (`transcriptionList`, `listAction`) and `api/capture.ts:617` (`automation` GET) exist as they are called.
  - WorkLines and Capture call nothing missing.
- **Task 9's fakes (kg-4) against the real routes:**
  - (a) A locked project's automation GET: 423 against 200 (I2).
  - (b) The fake's pause / continue / stop publish no `background.progress`; the real ones do (R679). The fake does less, which is harmless.
  - (c) The fake's POST adds `added` to an idle list's existing total; the real one resets it today. Ruling (1) removes this difference.
  - (d) The fake's Stop of a paused list gives idle total 0, matching the real one.

## Three mutations (each restored; `git status --short` empty)
1. I removed the cancel when the mark answers false (`transcription-list.ts:191`). "a Stop that falls between starting a job and marking its entry…" FAILED, by a 60 s timeout: `idle()` waits on the job that is never cancelled.
2. I made `NoMediaError` / `NotFoundError` rethrow (`:251`). "a source deleted before its turn is skipped and the list goes on" FAILED, by a timeout.
3. I made the loop ignore `paused` (`:154`). "pause lets the transcription in hand finish and stays paused across a restart" FAILED, by a timeout.

## Runs (single files, nice -n 10)
- `transcription-list-routes.test.ts`: 14 passed.
- `keep-awake.test.ts`: 2 passed.
- `transcription-jobs.test.ts`: 40 passed.
- `downloads-routes.test.ts`: 46 passed.
- `server.test.ts`: 160 passed, 1 skipped.
- `ui-only-routes.test.ts`: 128 passed.
- `capture-queues.test.ts`: 31 passed.
- `repo/automation.test.ts`: 1 passed.
- `untranscribed.test.ts`: 1 passed.
- typecheck `@ao/library`, `@ao/library-service`: clean.
- No existing test was changed.
- The probes (`probe-wc7.test.ts`) were deleted.

## What I could not check
- A real `caffeinate` on macOS:
  - that `-i -w <pid>` keeps the Mac from idle sleep and ends with the service;
  - behaviour across a lid close and wake;
  - SIGTERM delivery to an unref'd child.
- Real whisper speeds feeding the meter.
- WebKit, and e2e (not run, as the brief says).
- A read-only library refusing the list routes: checked only by reading (`writable()` calls `requireWritable`).
