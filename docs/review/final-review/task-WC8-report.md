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

## Fix round (R683)

Fresh implementer. Branch `wc-8-estimate`, five commits on 573aebb, head **d697397**: A a1236d0, B e98f272, C 687c04e, D 7a4ac08, E d697397.

### A. Three sentences (`packages/shared/src/api/background.ts`, in `estimateText`)
`settingsChanged`, `switchNotRead` and `listingSlow(p)`, word for word as the brief gives them. Test: `background.test.ts` "the settings changed, the switch not read, and a slow listing (R683)". It failed first because the keys were undefined.

### B. An estimate only of what the screen shows (I1, I2), in `Capture.tsx`
- `profileForm` is a JSON of the trimmed address, since, until, maxItems, types, metadataOnly, comments, the trimmed legal basis, useSession, browser, the Transcription choice, model and refresh. `estimateOf` (a ref) holds `{form, ac}` from the moment "Capture profile" is pressed until the estimate is closed. One effect on `profileForm` handles every change: `dropEstimate()` aborts the request, drops the answer, closes the estimate and puts the buttons back, and then the status says `settingsChanged`.
- The status `<span role="status">` is always mounted in the profile form's actions (M5).
- The field's old `if (!busy.current) setShown(null)` is removed.
- After a successful Start, the field is emptied only if it still holds the address that was sent.
- Tests: "an address changed while the list is asked for…", "an option changed under an open estimate…", "the Transcription choice changed…". All three failed first (no abort, no status region, the estimate stayed open).
- `captureService.ts`:
  - `estimateRequests()` keeps the Request objects, so a test can read `signal.aborted`.
  - `settled(key)` comes from a wrapped `client.request` and counts answers that have reached the screen.
  - New options `automationAnswer` and `automationHold`.
- `api/capture.ts`: `estimate` and `automation` take `{signal}`.

### C. The project's switch is never overridden (I3, M1, M2)
- Start sends `transcribe` explicitly in two cases: the Transcription choice above is "Transcribe" or "Do not transcribe", or the box now differs from how it started. Otherwise `transcribe` is left out. In that case `transcribeModel` (if it was asked) becomes `estimate.speechModel`.
- When transcription is sent as true, the model sent is `estimate.speechModel`.
- Metadata only: there is no box and no transcribing time (`CaptureEstimate.tsx`). `transcribeModel` is dropped, and an explicit choice is sent as `false`.
- The switch is read with `readWithin(firstReadMs)`, aborted together with the estimate, and never awaited with it. If the read fails, `switchNotRead` is shown beside the box through the new prop `transcribeNote`, with `aria-describedby`. If the switch answers before the box is touched, the box follows it.
- Tests:
  - Six new tests in Capture.test, under the describe "(R683 C)". "“Do not transcribe” above…" and "the box changed from the switch…" passed before the change: they pin behaviour that was already right. The other four failed first.
  - Two new tests in CaptureEstimate.test (metadata only shows no box; the note describes the box). Both failed first.

### D. The listing (I4, I5, M5)
- The profile form has its own guard and busy (`profileBusy`, `profileSubmitting`, `startProfileWork`), so "Capture links" is never held.
- While the list is being asked for, a `Cancel` (`estimateText.cancel`) sits beside the status. It aborts the request, drops the answer and focuses the profile field.
- There is no hard limit. After `firstReadMs` the status changes to `listingSlow(platform)`.
- For an estimate refusal, `refused(…, namesTool)` keeps the original `ApiClientError`, reason included. The alert renders `MissingToolNotice` around the usual text.
- Tests (all four failed first): Cancel during the listing (keeps the `request` and reads `signal.aborted`, checks focus, a late answer shows nothing); the slow sentence (fake clock with `shouldAdvanceTime`, `firstReadMs` 10 000); "Capture links" while the estimate is being asked for and while it is open; a 409 for `video-downloader` names the tool and links to `/settings/tools?tool=video-downloader`.

### E. Tests
- E1: the double press is now two `fireEvent.click` calls inside one `act`. I removed the guard locally and the test failed with 2 requests; the guard is restored.
- E2: the test now waits for `settled(capture-estimate) === 1`. Mutation check: with both the project effect's drop and the `projectNow` guard removed, it fails.

### Existing tests changed
- "sends the profile form…": no `transcribe` key ("Use the project's setting", untouched; metadata only).
- "comments need a legal basis…" and "without Video tools…": `transcribe:false` becomes left out, with `transcribeModel:"medium"`.
- "the Transcribe box starts from the project's switch…": the ticked check is now a `waitFor`, because the switch arrives beside the estimate.
- The double-press test and the project-change test, as E says.

### NEEDS A RULING
- D1 says "a platform the form accepts always gets a status". The form accepts any web address. For an address the preview cannot place (platform "other"), no fixed sentence exists, because `listing` and `listingSlow` take only YouTube, Instagram or TikTok. Such an address now gets an empty status but still gets Cancel. Options: (a) leave it like this; (b) add a platform-free sentence to `estimateText`. I recommend (b).
- The refusal of Start for TOOL_NOT_INSTALLED still shows the service's sentence, not `MissingToolNotice`: D3 names only the estimate. Should Start be treated the same way?

### Runs (each alone, `nice -n 10`)
CaptureEstimate 14/14 · Capture 90/90 · Capture.firstReads 15/15 · CaptureQueue 24/24 · MissingToolNotice 11/11 (also .capture 4/4, .hookups 8/8) · shared background 28/28 · typecheck @ao/shared and @ao/ui clean · lint:css clean · lint:colours ok · `git status --short` empty. The e2e step was not run.

## Last fix (R685)

Commit **942ca42**.
1. Added `estimateText.listingAny` ("Asking the platform for the list…") and `listingSlowAny` ("Still asking the platform for the list. A long list can take a few minutes."), word for word, to `packages/shared/src/api/background.ts` and tested them in `background.test.ts`. The screen now uses them whenever the preview has no platform, and the slow timer runs for every address. Test: "an address the preview cannot place still gets words and Cancel, and the slow words after the limit (R685)", run with a fake clock.
2. A `Start` refused with 409 `TOOL_NOT_INSTALLED` now goes through `refused(…, true)`, so `MissingToolNotice` names the tool and gives its link, and the estimate stays open. The existing test "a refusal of Start shows the service's sentence and keeps the estimate" is changed: it now expects the ffmpeg notice (the R671 sentence) and the link `/settings/tools?tool=ffmpeg`. A new test covers `video-downloader`.
All three tests, and the shared test, failed before the change.
Runs, each file alone: Capture 92/92 · CaptureEstimate 14/14 · shared background 28/28 · typecheck of @ao/shared and @ao/ui clean · `git status --short` empty.

## Last fix (R688)

Commit **7f57d56**.
- **N1:** once the researcher has touched the box, Start always sends `transcribe` as the box shows it (`explicit = chosen above || estTouched`). The `estInitial` ref is gone. Test: "the box ticked then unticked before a slow switch arrives… (R688 N1)" (switch ON, read held, tick, untick, release, Start). It failed first: the request had no `transcribe` key.
- **N2:** test "a switch read that arrives after the box was touched never changes it (R688 N2)". It passed before the fix, because the code was already right. To prove it, I removed `|| estTouched.current` from the read's handler: the N2 and N1 tests then fail. The check is restored.
- **N3:** a new state, `startOut`, holds the comparison effect while a Start is out. A refused Start then closes an estimate the form no longer matches and says the sentence once. A successful Start had already cleared the snapshot. Tests: "a form changed while Start is on its way… (R688 N3)" (no sentence, one capture) and "…refused Start… closes the estimate once the refusal is in (R688 N3)". Both failed first. The fake gained `profileHold`.
- **N4:** one `it.each` over all thirteen values: the address, posts from, posts until, the maximum, content types, metadata only, comments, legal basis, the browser session, the browser (the session is ticked before the press, because the picker is disabled without it), the Transcription choice, the model, and Refresh existing. Every control could be driven. These cases passed before, because the code was right. To prove they guard it, I dropped `types` from `profileForm`: the "content types" case then fails. Restored.
- **Runs, each file alone:** Capture 109/109 · CaptureEstimate 14/14 · typecheck @ao/ui clean · `git status --short` empty.
