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
