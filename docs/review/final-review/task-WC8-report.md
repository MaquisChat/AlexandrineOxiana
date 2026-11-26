# Task WC8 report: the estimate before a channel, playlist or profile is captured (Capture screen)

Branch `wc-8-estimate`, worktree `.claude/worktrees/kg-1`, head **573aebb** (one commit, on the integration branch holding Tasks 1, 2, 3, 4, 6).

## What was built, per step

**Step 1 (tests first), all seen failing for the right reason before the code existed:**
- `packages/ui/src/components/CaptureEstimate.test.tsx` (new, 12 tests). The whole file failed at first because `./CaptureEstimate` did not exist. The tests are: the 412 videos / 310 hours / "Roughly 150–250 GB … 380 GB are free on "Macintosh HD"." estimate, with the sketch's quality order and Up to 720p chosen; already-in and cut-short lines; `changing the quality changes the size` (Audio only gives "Roughly 13–22 GB at this quality. …"); `unknown lengths say size unknown and do not guess`; tooBig with "Start anyway — it will pause when the disk is nearly full" and no "Start"; without Video tools the four choices are disabled, each `aria-describedby` "These need Video tools.", the "Install Video tools" link goes to `PATHS.tools`, and Ready-made is chosen; with tools the ready-made choice is not shown (and `initialQuality` treats null as installed); metadata only hides Quality; the Transcribe box names the model; the time lines (the transcribing line only while ticked); `nothing new still offers Start, for the check of changes and removals`; busy disables the buttons.
- `packages/ui/src/screens/Capture.test.tsx`, new describe "the estimate before a profile is captured" (10 tests, each failed first because no estimate or Start existed). The tests are: the list is asked for first, with the status "Asking YouTube for the list of videos…", and the region then replaces the buttons, with nothing captured before Start; `the heading takes focus when the estimate appears` (`document.activeElement`); `the Transcribe box starts from the project's switch and names the speech model` (switch on gives ticked, with one `GET …/automation`; "Do not transcribe" gives unticked and "Transcribe" gives ticked, with no further read; the new hint is shown and the old one is gone); `Start sends the quality and the transcription choice once, however often it is pressed` (dblClick sends one body `{transcribe:true, transcribeModel:"medium", quality:"audio"}`, then the queue is added, the region closes and focus is on the emptied profile field); without Video tools Start sends `quality:"ready"`; `Cancel goes back with focus on the profile field`; `a refusal shows the service's sentence` (an estimate refused 403 with the rule's reason); a Start refusal (409 TOOL_NOT_INSTALLED ffmpeg) shows the service's sentence and keeps the estimate; `an answer after the project changed is dropped` (a held estimate, then a rerender to P2; mutation-checked: it fails without the project guard).
- `CaptureQueue.test.tsx`: 2 new tests (R677), and the "did not finish" one failed first. `MissingToolNotice.test.tsx`: 1 new test (R671), which failed first.

**Step 3 (implementation):**
- `packages/ui/src/components/CaptureEstimate.tsx` (new). It has the props exactly as the plan's Interfaces give them, plus the exported `initialQuality(e)`. The h3 takes focus on mount. Every sentence comes from `@ao/shared` (`estimateText.*`, `QUALITY_LABELS`, `DOWNLOAD_QUALITIES`, `QUALITIES_NEEDING_VIDEO_TOOLS`, `DEFAULT_QUALITY`, `FALLBACK_QUALITY`). The size is computed through `estimateText.disk`/`tooBig`, which call `estimateBytes`. The heading (which holds the title) and the disk sentence (which holds the disk's name) go through `UserText`. The Install link is `ToolsLink tool="ffmpeg"`, which gives `/settings/tools?tool=ffmpeg`.
- `packages/ui/src/screens/Capture.tsx`:
  - `captureProfile` (≈:805) validates as before, then shows the listing status and asks `estimate` together with `automation` (only for "Use the project's setting").
  - `startProfile` (≈:853) sends `capture-profile` with the estimated options, an explicit `transcribe`, `transcribeModel` only when ticked (the model the estimate was asked with), and `quality` unless the estimate is metadata-only. It then calls `addQueue`, empties the field and focuses it.
  - `cancelEstimate` closes the region and focuses the field.
  - The region replaces the form's actions (≈:1227).
  - A `projectNow` ref and a reset effect drop answers after a project change.
  - Typing in the profile field closes an estimate on show.
  - The changes stay away from the `WorkLines` mount and the event feed (R679).
- `packages/ui/src/api/capture.ts`: `estimate(projectId, url, options): Promise<CaptureEstimate>` and `automation(projectId): Promise<ProjectAutomation>`, which is my own small reader of `GET /projects/:id/automation`, as the dispatch asked. `quality` already sits on the shared `CaptureRequestOptions` (Task 1), so `captureProfile` needed no change.
- `packages/ui/src/test/captureService.ts`: `exampleEstimate()`, `estimateAnswer`, `estimateHold`, `profileDelayMs`, `automation`, and the handlers for `POST …/capture-estimate` and `GET …/automation`, placed ahead of `backgroundDefaults`.
- `packages/ui/src/screens/Capture.css`: the `.ao-capture-estimate*` rules, with tokens only.
- `MissingToolNotice.tsx:30-31` (R671) and `CaptureQueue.tsx:129-137` (R677).
- `e2e/capture.spec.ts` `captureIt` (≈:528) now presses Start in the estimate after "Capture profile", for both runs of scenario 10. It accepts "Start" or "Start anyway — …", because a test disk may have little free space. **Scenario 10 is changed and NOT run**: the route it needs is Task 5's.

## Researcher-visible sentences
- Estimate: exactly the plan's table, all from `@ao/shared`.
- Hint, old: `A profile capture transcribes only when “Transcribe” is chosen.` New: `“Use the project's setting” follows the project's switch “Transcribe captured audio and video automatically”, on the Governance screen.` (the label is taken from `AUTOMATION_TEXT.label`).
- ffmpeg notice (R671), old: `The video tools (ffmpeg) are not installed on this computer. Until they are, videos get no viewing copies, and media that carries a location stays “proxy pending” and is left out of exports.` New: `The video tools (ffmpeg) are not installed on this computer. Until they are, videos can be downloaded only as ready-made, lower-quality files and get no viewing copies, and media that carries a location stays “proxy pending” and is left out of exports.`
- Queue note (R677) for a report whose status is not `completed` and whose list is not complete: `Removed posts were not looked for in this run, because it did not finish.` The existing sentence stays for a completed run.
- A failed estimate falls back to the existing `The profile capture could not be started.`

## Existing tests changed (`Capture.test.tsx`, "Capture screen — profile")
Each of these now goes through the estimate and presses Start (helper `captureAndStart`):
- `sends the profile form; …`: it also asserts the estimate body. The capture body is now `{transcribe:false, since, until, maxItems, contentTypes, metadataOnly:true}`: an explicit transcribe, no `transcribeModel` when not transcribing, and no quality for metadata only.
- `never refuses an address on the preview's say-so`: the `user.clear` was dropped, because a successful Start empties the field, as before.
- `comments need a legal basis even with no rule asking for one`: it asserts that no estimate is asked without the legal basis. The body becomes `{transcribe:false, quality:"720p", includeComments, legalBasis}`.
- `a profile capture started here shows its run in the work lines…`.
- `a profile run's posts and summary appear as its events arrive`.

## NEEDS A RULING
None.

## Choices the plan left open (said here, not rulings)
- A platform that is not YouTube, Instagram or TikTok gets no listing status while the estimate is asked for, because `estimateText.listing` takes only those three. The button is still disabled.
- If `GET …/automation` fails, the Transcribe box starts unticked and the researcher sees it before Start.
- Metadata only sends no `quality`.
- A Start refusal keeps the estimate open, so another quality can be chosen.

## Found in the code that the plan did not expect
- `quality` was already in `@ao/shared` `CaptureRequestOptions` (Task 1), so the `captureProfile` change was typing only.
- The R677 note is triggered by `!report.listComplete`. I kept that trigger and changed only the wording by status.

## Runs (each at `nice -n 10`, one file at a time; last summary lines)
- `src/components/CaptureEstimate.test.tsx`: Tests 12 passed (12)
- `src/screens/Capture.test.tsx`: Tests 76 passed (76)
- `src/screens/Capture.firstReads.test.tsx`: Tests 15 passed (15)
- `src/components/MissingToolNotice.capture.test.tsx`: Tests 4 passed (4)
- `src/components/MissingToolNotice.test.tsx`: Tests 11 passed (11)
- `src/components/MissingToolNotice.hookups.test.tsx`: Tests 8 passed (8)
- `src/components/CaptureQueue.test.tsx`: Tests 24 passed (24)
- `pnpm --filter @ao/ui typecheck`: no errors. `lint:css`: clean. `lint:colours`: "ok: no hard-coded colours in src/**/*.ts(x)".
- Not run, on the dispatch's word: the UI build and `e2e/capture.spec.ts` (scenario 10 needs Task 5's routes).
- `git status --short`: empty.
