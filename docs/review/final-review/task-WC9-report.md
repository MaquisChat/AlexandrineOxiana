# Task WC9 report: the project's switch, the keep-awake switch, and "Transcribe everything without a transcript"

Branch `wc-9-switches`, worktree `.claude/worktrees/kg-4`, one commit: **6d2627c** (on the integration branch's a210250). `git status --short` is empty. Nothing pushed.

## What was built (all in `packages/ui/src`)

**API (`api/background.ts:57-66`).** `backgroundApi` gains six functions. Each follows the Task 7 route table exactly:
- `automation(projectId, {signal?})`: GET `/projects/:id/automation`.
- `setAutomation(projectId, a)`: PUT, with body `{transcribeNewMedia}`.
- `untranscribed(projectId, {signal?})`: GET `/projects/:id/untranscribed`.
- `transcribeAll(projectId, model?)`: POST `/projects/:id/transcription-list`, with body `{}` or `{model}`.
- `settings({signal?})`: GET `/settings/background`.
- `setSettings(s)`: PUT, with body `{keepAwake}`.

Nothing that was already in the file changed. The header comment lists the new routes.

**A new shared component, `components/SavedSwitch.tsx`.** This file is not in the plan's file list. Both switches use it, so the save pattern is written once.
- It reads the saved value once. A new `read` reads again and drops anything still on its way.
- One request per change: a synchronous guard, then the box is disabled while it saves. If the box had focus, focus returns to it afterwards.
- A failed save puts the box back to the saved value and shows the failure as an alert, worded by `errorText` and passed through `UserText`.
- When `whyId` is given, the box is off and `aria-describedby` points at that element.
- Answers that arrive after unmount or after a new read are dropped.

**Governance (`screens/GovernanceSettings.tsx:98, 503, 549-559`).**
- New optional prop `background`.
- New section `AutomaticTranscription`: a `section` with the h2 `AUTOMATION_TEXT.heading`, the label and the hint. It is placed just above "Back up now".
- On a locked project or a read-only library the switch is off, described by the screen's existing `${rawId}-why` reason.
- It saves separately from governance.yaml: "Save changes" stays disabled.
- Wiring in `routes/governance.tsx`: the route's `ctx` gains `background?: BackgroundApi`, and `GovernanceRoutes` builds it with `useMemo(backgroundApi(client))`.

**Optional tools (`screens/ToolsSetup.tsx:87-101, 109-123`).**
- New optional prop `background`. `ToolsSetupRoute` passes `backgroundApi(client)`.
- New section `KeepAwake`: the h2 `KEEP_AWAKE_TEXT.heading`, then the switch. It comes after the tool groups.
- The "Video conversion" group hint follows R671 (`:38`).

**"Transcribe everything" (`components/TranscribeAll.tsx`, mounted at `screens/Library.tsx:1150`).** The component sits above the sources list, just before the sources error and the table. Nothing else in `Library.tsx` changed: WorkLines is not re-mounted or keyed.
- A press reads `untranscribed`, then shows `transcribeAllText.confirm(r)` with `Transcribe them` and `Cancel`. If there is nothing to transcribe it shows `none` alone. The sentence (`tabIndex=-1`) takes focus.
- `Transcribe them` sends one request (synchronous guard, then disabled), says `added(n)` in a status region, and returns focus to the button.
- `Cancel` sends nothing and returns focus to the button.
- A refusal shows the service's sentence in an alert. A missing speech model (409 `TOOL_NOT_INSTALLED` with reason `speech-<m>`) is named by rendering `SpeechModelNotice` with `installed={{[m]: false}}`, which gives "The speech model “m” is not installed on this computer. Install it from the Optional tools screen." with its link. Any other missing tool goes to `MissingToolNotice`. The raw tool id is never shown.
- Answers that arrive after the project changed or after unmount are dropped.
- The work line comes from the service's event on the screen's own stream (R679).

**Fakes.**
- `test/backgroundService.ts`: handlers and options added, nothing existing changed.
  - New options: `automation`, `automationAnswer`, `settings`, `settingsAnswer`, `untranscribed`, `transcribeAllAnswer`, `holdSwitches`.
  - New method: `bodies(key)`. New optional field: `BackgroundRecorded.body`.
  - The fake POST `…/transcription-list` puts the untranscribed count on the list and sends `background.progress {transcriptions}` before it answers, as Task 7 pins.
  - New export `switchDefaults(base)`: automation answers `{transcribeNewMedia:false}`, settings answer `{keepAwake:true}`.
- `switchDefaults` is added to the initial handlers of `test/service.ts`, `test/msw-governance.ts` and `test/msw-tools.ts`, so the existing route and app tests make no unhandled request.
- `test/msw-tools.ts`: the ffmpeg fixture now carries the catalogue's two sentences exactly.

## Tests (each seen failing first, for the right reason: a missing module, region, button or text)

- `components/TranscribeAll.test.tsx` (new, 7 tests): the plan's five, plus `a refusal by the project's rules shows the service's sentence` and `an answer after the project changed is dropped`.
- `screens/GovernanceSettings.test.tsx`: the plan's two, plus `the project's switch is off on a read-only library, with the screen's reason`.
- `screens/ToolsSetup.test.tsx`:
  - the plan's keep-awake test;
  - `a failed save of keeping awake puts the switch back and says so`;
  - `the Video tools group says they also join the best picture and sound when videos are downloaded (R671)`. This test also checks the fixture's two catalogue sentences.
- `screens/Library.test.tsx`: `Transcribe everything without a transcript is offered above the sources list, and its list reaches the work lines (Task 9)`. It checks document order against the Sources table and that the line "Transcribing: 0 of 12" comes from the event, with `GET /events` asked once.
- Wiring tests, seen failing with the prop taken out:
  - `routes/governance.test.tsx`: `the Governance screen of the app shows the project's automatic transcription switch, read for that project`.
  - `routes/tools.test.tsx`: `the tools screen of the app shows the keep-awake switch, on by default`.
- `components/FirstUseTools.test.tsx`: `say that the video tools also join the best picture and sound when videos are downloaded`, seen failing against the old hint.

## Researcher-visible sentences

Switch labels, hints and headings, and all of "Transcribe everything": exactly the shared texts (`AUTOMATION_TEXT`, `KEEP_AWAKE_TEXT`, `transcribeAllText`). The failure words reuse existing sentences:
- a save failure falls back to "That could not be done. Try again.";
- a refusal is otherwise worded by `errorText` from the service's sentence.

One new sentence: **"This setting could not be read."** It is the fallback when a switch's read fails and the service gives no sentence of its own (`SavedSwitch.tsx`, `SWITCH_READ_FAILED`).

R671 wording changes:
- **ToolsSetup group hint.** Old: "Makes viewing copies of videos, including copies that leave out or coarsen a recorded location." New: "Joins the best picture and sound when videos are downloaded, and makes viewing copies of videos, including copies that leave out or coarsen a recorded location."
- **FirstUseTools hint.** Old: "Transcribe interviews and other recordings with the app's default speech model. The video tools make viewing copies of videos, also copies that leave out a recorded location." New: "Transcribe interviews and other recordings with the app's default speech model. The video tools join the best picture and sound when videos are downloaded, and make viewing copies of videos, also copies that leave out a recorded location."
- **msw-tools fixture, ffmpeg `purpose`.** Old: "Makes viewing copies of videos, and copies that leave out or coarsen a recorded location." New, the catalogue's own: "Joins the best picture and sound when videos are downloaded, makes viewing copies of videos, and makes copies that leave out or coarsen a recorded location."
- **msw-tools fixture, ffmpeg `without`.** Old: 'Videos get no viewing copies. Media that carries a location stays "proxy pending" and is left out of exports until ffmpeg is installed.' New, the catalogue's own: 'Videos can be downloaded only as ready-made, lower-quality files, and get no viewing copies. Media that carries a location stays "proxy pending" and is left out of exports until ffmpeg is installed.'

## Existing tests changed

None changed in their assertions; tests were only added. The fixture change above alters what existing ToolsSetup and FirstUseTools tests read, and they all pass.

## NEEDS A RULING

None.

## Found that the plan did not expect

- `GovernanceSettings` takes a `GovernanceApi` and `ToolsSetup` takes a `ToolsApi`; neither has a client. Each therefore gets an optional `background` prop, passed by its route. Rendered directly without the prop, as the existing tests do, the section is not shown.
- In the Library, the button is not disabled on a read-only library. The existing attach reason ("…attaching waits…") does not fit transcription, so a press there gets the service's refusal through `errorText` ("This library is read-only, so nothing was changed."). The confirmation itself is still read.
- Existing defect, not mine and not fixed: each tool group on the Optional tools screen labels its section with `aria-labelledby` pointing at an id with a space in it (`ToolsSetup.tsx`, the groups map: `${ids}-g-${g.title}`). The group sections therefore have no accessible name. My test finds the group by its h2 instead.
- `routes/governance.test.tsx` already logs unhandled-request warnings for `/events`, `/libraries`, `…/attention` and similar. None of them are new routes.
- **Not run, as the dispatch directed:** the e2e step (`pnpm --filter @ao/ui build` and `e2e/library.spec.ts`), because the Task 7 routes do not exist in this worktree. The screens tolerate a missing route only through their existing failure pattern: a failed switch read shows an alert, and a failed press shows the refusal alert. The coordinator runs the browser scenarios after Task 7 is joined.

## Runs (last summary line of each, single files, `nice -n 10`)

- `src/components/TranscribeAll.test.tsx`: Tests 7 passed (7)
- `src/screens/GovernanceSettings.test.tsx`: Tests 74 passed (74)
- `src/screens/ToolsSetup.test.tsx`: Tests 37 passed (37)
- `src/screens/Library.test.tsx`: Tests 52 passed (52)
- `src/screens/GovernanceSettings.backup.test.tsx`: Tests 6 passed (6)
- `src/screens/governance.firstReads.test.tsx`: Tests 37 passed (37)
- `src/routes/governance.test.tsx`: Tests 25 passed (25)
- `src/routes/tools.test.tsx`: Tests 10 passed (10)
- `src/components/FirstUseTools.test.tsx`: Tests 24 passed (24)
- `src/App.test.tsx`: Tests 16 passed (16)
- `src/components/MissingToolNotice.hookups.test.tsx`: Tests 8 passed (8)
- `src/components/WorkLines.test.tsx`: Tests 51 passed (51)
- `src/dialogs.r145.test.tsx`: Tests 42 passed (42)
- `pnpm --filter @ao/ui typecheck`: clean
- `lint:css`: clean
- `lint:colours`: "ok: no hard-coded colours in src/**/*.ts(x)"
