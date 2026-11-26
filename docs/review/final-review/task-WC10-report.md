# Task WC10 report — the end-to-end scenarios (whole channels)

Branch `wc-10-e2e`, worktree `.claude/worktrees/kg-7`, head commit **8371e56** (one commit, as Step 4 names it).

## What was built
- `e2e/whole-channel.spec.ts` (new). It has five scenarios under `test.use({ fakeControl: true })`:
  1. `a channel pasted, estimated, downloaded past a private video, and every video transcribed`: Capture profile, then the estimate (`Capture channel: "Fake Channel"`, `4 videos, about 9 minutes.`). The quality is checked against `GET /tools`: with ffmpeg installed `Up to 720p` is chosen; without it the test checks `These need Video tools.` and `Ready-made file (lower quality)`. It ticks Transcribe and presses Start. The line reaches `"Fake Channel": 3 of 4 downloaded. 1 could not be downloaded.` and shows `Resume downloads (1 did not complete)`. Show them gives `This video is private.` and focus is on its heading. The list reaches `Transcriptions finished: all 3 done.`, and the Library screen shows both lines. Resume asks the fake for the private video a second time, the run ends finished again, the button is still there, and no other video is downloaded again.
  2. `a quit in the middle: downloads wait for one click, transcriptions carry on by themselves`: video 2 is held, then the app restarts. The line says `The capture of 'Fake Channel' was interrupted: 1 of 4 done.` with `Resume downloads (3 did not complete)`. The list says `Transcriptions finished: all 1 done.`. The fake gets no new run before the click and there is no resume decision. After the click the run finishes, the list reaches `all 3 done.`, and exactly one audited `capture.profile.resume` decision exists.
  3. `Pause stays paused across a restart; Stop keeps what was downloaded`: Pause is pressed while video 2 is held, and the run ends `"Fake Channel" is paused: 2 of 4 downloaded.`. After a restart it reads the same (not interrupted) and the fake gets no new run. Resume is pressed with video 3 held, then Stop. The run ends `"Fake Channel" was stopped: 2 of 4 downloaded.` plus `1 could not be downloaded`. Video 4 is never asked for, videos 1 and 2 and their files stay, and the audit log has no deletion.
  4. `a second channel started while one downloads waits its turn and begins by itself when the first has finished`: the first channel's first video is held. The second channel shows the "is waiting its turn" line and the fake gets no run of its address after its estimate. After the release both finish (`all 2 downloaded.`), and the run log shows the second address asked for only after the first channel's last video.
  5. `a finished line is taken off the screen with “Remove from this list”, and everything downloaded stays in the library`: the run reaches `all 2 downloaded.` and has exactly one button. After pressing it the line is gone, also after a reload. `GET /downloads` is empty, both videos are listed in the Sources table and stored.
- `e2e/fixtures.ts` was changed: `hold(tool, match?)`. With `match`, only a run whose arguments contain it waits. **Why:** the scenarios must catch a run at one particular video. Holding every run would also hold the listing. Holding "after video 1" would race the 10 s gap. Without `match` it works as before.
- `packages/library/tests/fixtures/fake-tools/yt-dlp` was changed: `FAKE_PROFILE_FILE` may hold a list of profiles. **Why:** scenario 4 needs two channels at once, and the fake read only one profile. A single object works as before (capture.spec and profile-capture.test pass).

These are tests, so the "test fails first" rule applies differently: each scenario was run against the product as it is. The real failures on the way are below.

## Sentences: where the product differs from the plan's text (the product is right)
- The Transcribe box is named `Transcribe each video on this Mac (speech model: medium)`; "Transcribe" is its legend.
- The audited Resume decision has `action: "capture"` with `details.op: "capture.profile.resume"`. It is not an action named `capture.profile.resume`.
- Scenario 4: while the second run waits its turn, it is titled by the address's handle: `"@fake.dancer" is waiting its turn. It starts by itself when the downloads before it have finished, paused or stopped.` The estimate had already shown "Fake Dancer". The title becomes "Fake Dancer" once its list is read. I asserted the product's sentence. It is not a defect, but it may be worth a look (the run could keep the estimate's name).

## Interpretations (no ruling strictly needed)
- In scenario 4, "the run log has no line of the second address" cannot hold literally: the estimate itself lists the second address with yt-dlp. The test therefore checks that no run of that address happens **after its estimate** while it waits.
- The second channel is a TikTok profile. Its estimate needs that platform's lane (R116, per listing), so a second YouTube channel's estimate would wait for the held YouTube video. A held video therefore cannot sit beside a second YouTube estimate.
- Scenario 2, "transcriptions carry on by themselves": in practice the fake speech has already transcribed video 1 before the quit (I checked once: the list was idle 1/1). After the restart the test can only check the resting state, with no click. No harness control exists to hold a transcription. Adding one would mean a hold in the fake faster-whisper; that is the coordinator's call.

## NEEDS A RULING
None (no product defect found).

## Existing tests changed
None. (The fixture and fake-tool changes keep their old behaviour.)

## Runs
- `pnpm --filter @ao/ui build`: ✓ built.
- `whole-channel.spec.ts --project=chromium --repeat-each 5`: **25 passed (12.7m)**.
- `whole-channel.spec.ts --project=webkit`: **5 passed (2.8m)**.
- `capture.spec.ts --project=chromium`: 4 passed (53.6s).
- `@ao/library vitest src/capture/profile-capture.test.ts`: 64 passed.
- `e2e tsc --noEmit`: clean. `git status --short`: empty.

## Fix round (R697)

Commits on `wc-10-e2e`: d4e598b (A), 53509ac (B), 7b08c80 (C). Only test files and test fixtures changed; product code was changed only for the mutations and restored with `git checkout --`.

### A. Restarts (I1, I2)
- **A1.** The fake faster-whisper the e2e worker uses (`packages/library/tests/fixtures/fake-speech/faster_whisper/__init__.py`, a test fixture) now has a hold. While the file `hold-speech` exists in the folder named by `AO_FAKE_SPEECH_CONTROL`, `WhisperModel.transcribe` waits and writes a marker `held-speech-<worker pid>-<thread>`. The worker passes `AO_*` variables on to its own process. A held transcription stops waiting once its job is cancelled; it finds the job's `JobContext` up the stack. Without that, the service did not stop within 30 s of SIGTERM, because it waits for the transcription job to end on a quit. The real model stops between segments. `e2e/fixtures.ts`: `fakeControlFor` sets the variable, and FakeControl gains `holdSpeech()`, `releaseSpeech()` and `heldSpeech()`, which counts only markers of live workers. No `services/media-worker` change was needed.
- **A2.** Scenario 2 holds speech, then holds yt-dlp at video 2, and starts. It waits until both holds are taken: `held("yt-dlp") == 1` and `heldSpeech() == 1`. Then it restarts and reopens the project. With no click, it waits for `heldSpeech() == 1` in the new worker, releases the hold, and waits for `Transcriptions finished: all 1 done.`. Only then does it check two things: no fake yt-dlp run since the restart (`asked(app).slice(before)` equals `[]`), and no audited resume. After that it checks the interrupted sentence and the Resume button. The click and what follows are unchanged.
- **A3.** Scenario 3, after the restart: it opens Capture and estimates the same channel. The estimate is listed by the new worker; the scenario waits for `2 videos, about 6 minutes.`. Then it checks that no video of the channel was asked for since the restart (the listing itself is allowed) and that there was no audited resume. It checks that the line still reads paused with its Resume button, then presses Cancel.
- **A4. M1.** The mutation: in `DownloadRunner.list` of a fresh service, every interrupted or paused run is resumed. Both scenarios failed in about 20 s, at the run-log assertion, with these messages:
  - Scenario 2: `Error: no run of the fake yt-dlp since the restart (the downloads must wait for Resume downloads)`. Received `["https://www.youtube.com/@fakechannel/videos", "https://www.youtube.com/watch?v=fakeChan002"]` at `whole-channel.spec.ts:333`.
  - Scenario 3: `Error: no video of the paused run asked for since the restart (a paused run waits for Resume downloads)`. Received `["https://www.youtube.com/watch?v=fakeChan003"]` at `:377`.

  The product was restored; `git status --short` was clean.

### B. Titles asserted
- **B1 (I3).** Scenario 1, after `all 3 done.`: the stored videos are exactly fakeChan001, 002 and 004, and the private video has no source. For each of them, `GET /projects/:id/sources/:sid/transcripts` lists machine versions `["json","vtt"]`.
- **B2 (M-a).** `options.quality` from the `capture-profile` request equals the branch the catalogue reports (`GET /tools` ffmpeg installed: `720p`, else `ready`). The fake yt-dlp's run for video 1 is checked per branch. For 720p it has `-f bv*+ba/b` and `-S res:720,fps,vcodec:h264,acodec:m4a`. For ready it has `-f b` and no `-S`. The branch is recorded as a test annotation ("quality"). On this machine ffmpeg is installed, so the 720p branch runs.
- **B3 (M-b).** Scenario 3, after the Stop: the same channel is estimated again and shows `2 videos, about 6 minutes.` and `2 more are already in this project and are not downloaded again.`. After Start the new line reads `"Fake Channel": 1 of 2 downloaded. 1 could not be downloaded.`. Videos 1 and 2 were still asked for only once, video 3 was tried again (twice in all), video 4 was downloaded once, and the stored videos are 1, 2 and 4.
- **B4 (M-d).** Scenario 5, after "Remove from this list": each video has files, and every file is on disk. No delete, remove or trash entry is in the audit. After another reload the sources are still listed and the line is still gone.

### C. Stale hold markers (M-c)
- `held()` and `heldSpeech()` count only markers whose process is alive (`liveMarkers`, using `running(pid)`). Scenario 2 checks this after the restart: the stopped run's `held-yt-dlp-*` marker is still on disk, and `held("yt-dlp")` is 0. With the old `held()` put back temporarily, scenario 2 failed with `Error: a marker of a stopped run is not counted as held`, `Expected: 0 Received: 1`.

### NEEDS A RULING
None.

### Runs (fix round)
- `pnpm --filter @ao/ui build`: built (the dist was older than the head).
- `whole-channel.spec.ts --project=chromium --repeat-each 5`: **25 passed (13.8m)**.
- `whole-channel.spec.ts --project=webkit`: **5 passed (2.8m)**.
- `capture.spec.ts --project=chromium`: the first run had 3 passed and 1 failed, scenario 9, and took 2.8 min. I kept only the tail of its output, so I do not know the failure message.
  - Scenario 9 alone then passed (9.0 s), and two full runs then passed (4 passed, 53.6 s and 53.8 s).
  - The speech hold acts only while `hold-speech` exists, and capture.spec never writes that file, so the change should have no effect there.
- The shared fake downloader was not changed, so the library and service tests that use it were not run.
- `e2e tsc --noEmit` is clean, and `git status --short` is empty.
