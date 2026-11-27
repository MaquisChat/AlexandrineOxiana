# Task WC10 review: the end-to-end scenarios (whole channels)

Worktree `.claude/worktrees/kg-7`, branch `wc-10-e2e`, range 540cee3..8371e56. No product file changed (`git diff --stat`: `e2e/fixtures.ts`, `e2e/whole-channel.spec.ts`, `packages/library/tests/fixtures/fake-tools/yt-dlp` only). `git status --short` is empty at the end; every mutation and probe has been reverted or removed.

## Verdict: READY WITH FIXES

## Important

**I1. The restart steps of scenarios 2 and 3 pass when the product continues the downloads by itself.** (`e2e/whole-channel.spec.ts:286-295`, `:324-331`)
- The check "nothing is asked of the platform before the click" (`expect(asked(app)).toHaveLength(before)`) is read once, right after the page reloads. That is before the new service has started its worker, so no run could have reached the fake yet.
- Mutation M1 below makes the service resume every interrupted or paused run by itself after a restart. Both "after the restart" steps then **passed**: the title still read "interrupted" or "paused", the run log had no new line, and there was no audited resume.
- A probe (a copy of scenario 2 that waits after those assertions) showed what the mutated service did next. It asked the fake for video 2 by itself (5 runs against 4) and audited one `capture.profile.resume`, with nobody pressing anything.
- So the scenarios did not fail where the fault is. Each failed only later, after the full 480 s test timeout, on `locator.click` of a "Resume downloads" button that was gone. The failure message does not name the fault.
- This is an assertion that something "has not happened yet", taken before it could have happened.
- **Fix:** before asserting, wait for a resting state that proves the new service's worker has served something since the restart. In scenario 2 that is the transcription in I2, held over the restart, released, and finished. In scenario 3, transcribe and wait for a transcription done after the restart, or wait for a worker-backed reply (for example an estimate). Then read the run log and the audit.

**I2. Scenario 2 does not show "transcriptions carry on by themselves".** (`:292`)
- Video 1 is transcribed before the quit, so the list is already idle at "all 1 done". After the restart, "Transcriptions finished: all 1 done." would show even if the transcription list never restarted itself. The implementer says so in the report.
- The name of the scenario promises the design's central guarantee after a quit (design §4, "After a quit or a restart").
- **Fix (small):** add a hold to the fake faster-whisper. For example, `transcribe()` waits while a file named by an env var exists; `fakeControlFor` sets the variable and adds `holdSpeech()` / `releaseSpeech()`. Then: hold speech, restart, release, and assert "all 1 done" with no click and the list's done count rising after the restart.
- The service test `transcription-list-routes.test.ts` "the list transcribes one at a time in order and carries on by itself after a restart" covers the behaviour itself. Only the browser proof is missing.

**I3. Scenario 1's "every video transcribed" rests on the counter alone.** (`:248`)
- "Transcriptions finished: all 3 done." is read from the list's line. Nothing checks that videos 1, 2 and 4 each have a stored transcript, or that the private video has none.
- A list that counts entries done without storing a transcript would pass.
- **Fix:** after the list ends, read each source with `storedSources` and assert that each of the 3 downloaded videos has a transcript (the transcript asset or annotation the transcription route stores), and that the private video has no source.

## Minor

- **M-a. Quality not checked against what was sent or what the fake was asked for.** (`:214-226`) Only the chosen radio button is asserted. Add `expect(options.quality).toBe("720p" | "ready-made")` from `start()`, and check the fake's `-f` arguments in `fakes.runs("yt-dlp")` for one video. Only one branch (ffmpeg installed or not) ever runs on a given machine. This one has `/usr/bin/ffmpeg`; I did not check which branch the catalogue chose.
- **M-b. Scenario 3 does not cover "a later capture of the same channel takes only what is missing".** (design §4 "Stop")
  - The service test `downloads-routes.test.ts` "stop ends the run; capturing the same channel later takes only what is missing" covers it. In the browser it would take about six lines: estimate the channel again, see "2 videos…", Start, and check that videos 1 and 2 are not asked for again.
  - Scenario 3 also runs without Transcribe, so "its transcriptions stay on their list" after a Stop is not shown.
- **M-c. Stale `held` markers after a restart.**
  - A held wrapper killed by `app.restart()` leaves its `held-yt-dlp-<pid>` file, so `fakes.held()` keeps counting it. The probe saw `held() === 1` after the restart with no live run.
  - No current scenario polls `held` after a restart with a hold still on, so nothing breaks today. A later scenario that does will pass vacuously.
  - **Fix:** in `held()`, count only markers whose pid is alive (`process.kill(pid, 0)`), or clear markers in `restart`.
- **M-d. Scenario 5 checks the sources' records, not their files on disk or the audit.** "Everything downloaded stays" would also hold if the files were removed. Copy scenario 3's on-disk and audit check (`:346-348`).
- **M-e. Scenario 1's "Show them" does not check that the address is shown or that the list can be copied** (design §6). The WorkLines unit tests cover both.
- **M-f. The Discard of an *interrupted* run is not exercised in the browser.** It uses the same route as "Remove from this list". It is covered by `downloads-routes.test.ts` "discard takes the run off the list; its sources stay" and by `WorkLines.test.tsx` "Discard removes the run and focus goes to the heading".

Clicks and layout: no fixed sleeps; every wait is for an exact sentence. The work lines sit above the search box and Sources table on the Library screen, and below the form on the Capture screen. The run lines come before the list line, so a changing list line never moves a run's buttons. The paragraph that ticking Transcribe adds above Start is already rendered when `check()` returns. I found no press made while content above it was still appearing.

## Contract check

- Compared against Task 10 and the dispatch: the scenario names, the fake channel (60/120/180/180 s, item 3 private), and every quoted sentence ("Capture channel: "Fake Channel"", "4 videos, about 9 minutes.", "These need Video tools.", "Ready-made file (lower quality)", "Up to 720p", the finished sentence, "Resume downloads (N did not complete)", "This video is private.", "Transcriptions finished: all 3 done.", the interrupted sentence with straight quotes, "Remove from this list" with curly quotes in the title).
- They match the product. The three differences the implementer reports are real and the product is right:
  - the box's name is "Transcribe each video on this Mac (speech model: medium)";
  - the audit records `action: "capture"` with `details.op: "capture.profile.resume"`;
  - while waiting, the run's title is the handle "@fake.dancer".
- The last one is worth the owner's look as a product question: the estimate had already shown "Fake Dancer".
- `AO_TEST_FREE_BYTES` (500 GB) is still set for every service the harness starts (`fixtures.ts:400`), restarts included.
- The changed fake is the **shared** one (`packages/library/tests/fixtures/fake-tools/yt-dlp`). With a single object it behaves exactly as before: the loop runs `profileRun` once, and that returns on a link it does not know.
- `hold()` without a match writes "" and still holds every run. The run log is written by the wrapper before the hold, so held runs are counted.

## Mutations (product broken locally, scenario run, restored)

| # | Break | Scenario | Result |
|---|---|---|---|
| M1 | `DownloadRunner.list` resumes every interrupted or paused run by itself in a fresh service | 2, 3 | Both FAILED, but only by the 480 s timeout on a later click. The steps named for the property passed (I1). A probe confirmed the unprompted download and audit. |
| M2 | The turn removed (`turn()` returns at once) | 4 | FAILED by assertion at `:372`: expected "…is waiting its turn…", received ""Fake Dancer": all 2 downloaded." Names the fault. |
| M3 | Discard writes nothing; only the screen event is sent | 5 | FAILED by assertion at `:409`: after the reload the line is back (count 1). Names the fault. |
| M4 | A failed (private) video written as done | 1 | FAILED at `:235` after the 180 s wait. The message names the fault: received ""Fake Channel": all 4 downloaded."). |

## Runs

| Run | Result |
|---|---|
| `whole-channel.spec.ts`, Chromium, `--repeat-each 3` | 15 passed (7.3 min) |
| `whole-channel.spec.ts`, WebKit, once | 5 passed (2.5 min) |
| `capture.spec.ts`, Chromium | 4 passed |
| `@ao/library` `profile-capture.test.ts` | 64 passed |
| `@ao/library` `link-capture.test.ts` | 66 passed |
| `@ao/library` `download-run.test.ts` | 36 passed |
| `@ao/library-service` `capture-queues.test.ts` | 31 passed |
| `@ao/library-service` `downloads-routes.test.ts` | 46 passed |

## What the scenarios do not cover, and what covers it instead

| Not covered in the browser | Covered by |
|---|---|
| The slow-down and its growing waits; pausing after 12 h | `packages/library/src/capture/waits.test.ts`, `download-run.test.ts` "a pause asked during a slow-down wait ends the wait at once", `downloads-routes.test.ts` (the slow-down sleep after a move) |
| The disk floor pausing a run | `download-run.test.ts` "the disk floor pauses before a download that would leave less than 10 GB" |
| "Start anyway" when the estimate is too big | `CaptureEstimate.test.tsx` |
| A lock stopping both lists; after the unlock, downloads wait for one click and transcriptions carry on | `downloads-routes.test.ts` "a lock stops the run at once…"; `transcription-list-routes.test.ts` "a lock stops the list at once… the unlock lets it carry on" |
| "Transcribe everything without a transcript" | `transcription-list-routes.test.ts` "transcribe everything says how many…" (and the Task 9 screen tests) |
| The project's automation switch and the keep-awake switch | `transcription-list-routes.test.ts` "the automation switch is read and saved", "background settings default…"; `downloads-routes.test.ts` "a run with transcribe left out follows the project's automation switch"; `keep-awake.test.ts` |
| Audio only, and each quality reaching yt-dlp | Task 2 worker tests and `downloads-routes.test.ts` quality tests; no browser scenario |
| A second project | Nothing in the browser; the service tests are per project |
| Pause, Continue and Stop of the transcription list | `transcription-list-routes.test.ts` (pause across a restart, continue, stop); `WorkLines.test.tsx` |
| A move during a run | `downloads-routes.test.ts` (several move tests) |
| Two presses of Resume | `downloads-routes.test.ts` "a run being resumed is held from the press…" |
| The measured time left, "measuring…" | Task 7 service tests and the WorkLines unit tests; nothing in the browser |

## Could not check here
- A real Mac or a real platform: real yt-dlp against YouTube, real speech, caffeinate, sleep and wake, the disk's name.
- Which quality branch the catalogue chose on this machine.

## Second look (R697)

Range 8371e56..7b08c80 (d4e598b, 53509ac, 7b08c80). `git diff --stat 540cee3..7b08c80` lists only `e2e/fixtures.ts`, `e2e/whole-channel.spec.ts`, the fake yt-dlp and the fake faster-whisper. No product file changed. No fixed sleep was added, and every new wait is for an exact sentence or state. The new run-log and audit checks are read only after a resting state that proves the new service's worker has served something: in scenario 2 the held transcription finishing, in scenario 3 an estimate the worker listed.

### Verdict: APPROVED WITH MINORS

### Mutation M1 applied again
M1: the service resumes every interrupted or paused run by itself after a restart. Both scenarios now fail at the run-log assertion, with messages that name the fault. Both failures together took 44 s, test set-up included.

| Scenario | Line | Message | Diff |
|---|---|---|---|
| 2 | `:334` | "no run of the fake yt-dlp since the restart (the downloads must wait for Resume downloads)" | +4 runs |
| 3 | `:378` | "no video of the paused run asked for since the restart (a paused run waits for Resume downloads)" | +3 runs |

The product was restored afterwards.

### I2: transcriptions carry on after a restart
- Scenario 2 holds video 1's transcription in the fake speech recognition and restarts the app. It then waits until the new worker takes that transcription up again by itself (`heldSpeech() === 1` after the restart), releases it, and reaches "Transcriptions finished: all 1 done." with nobody pressing anything.
- Break: the transcription lists no longer started at library open (`state.ts:1927` turned off). Scenario 2 FAILED at `:332`: expected "Transcriptions finished: all 1 done.", received "Transcribing: 0 of 1 — "Fake Channel video 1: …"". That came after the 180 s wait, but the message names the fault. Restored.
- The fake faster-whisper is shared only by the end-to-end tests: `capture.spec.ts` and `whole-channel.spec.ts` through `AO_WORKER_BIN`. No worker Python test imports it (grep). The hold is OFF unless a scenario calls `holdSpeech()`: the environment variable is set for every `fakeControl` test, but the fake waits only while the `hold-speech` file exists.

### B1–B4 and C, as built
- **B1:** each of the 3 downloaded videos has a machine transcript (json and vtt) through `/sources/:id/transcripts`, and the private video has no source.
- **B2:** the quality sent (`options.quality`) is checked, and so is video 1's `-f` / `-S` in the run log, with both branches written out.
- **B3:** after the Stop, the estimate counts 2 videos and says "2 more are already in this project…". Videos 1 and 2 are not asked for again, video 3 is retried, and video 4 is downloaded.
- **B4:** after "Remove from this list", the files are on disk, the audit has no deletion, and the line stays gone after two reloads.
- **C:** `held()` counts only markers of live processes. Scenario 2 asserts that the stale marker is on disk and is not counted.

### Minors (no change needed before verification)
- The fake's `_job_cancelled` finds the worker's `ctx` by walking the call stack. If the worker renames that local, the hold silently stops honouring a cancel. No current scenario depends on that: a restart kills the worker anyway.
- The I2 break, like M4, fails only after its 180 s wait for the sentence, though the message names the fault.

### Run
`whole-channel.spec.ts`, Chromium, `--repeat-each 2`: 10 passed (5.4 min). `git status --short` is empty.
