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

## Fix round (R684)

Three commits on `wc-9-switches`, on top of 6d2627c: **535a675** (A), **f9712a6** (B), **04bb184** (C). Nothing pushed, the e2e step was not run, and `git status --short` is empty. No file on the do-not-touch list was edited.

### A. "Transcribe everything" (535a675)
- **A1 (I1).** `TranscribeAll` has a new `readOnly` prop (`components/TranscribeAll.tsx`), and `Library.tsx:1150` passes the screen's `readOnly`.
  - On a read-only library the button is off and nothing is asked.
  - This follows the Library screen's own rule. Its other edit buttons (New project, New collection, New tag, rename and delete) are only disabled, and the read-only banner (`role=status`) says why. No new sentence and no `aria-describedby`.
  - Tests:
    - `on a read-only library the button is off, as the screen's other edit buttons are, and asks nothing` (TranscribeAll).
    - `a read-only library offers Transcribe everything … switched off … (R684)` (Library).
  - Both failed before the mend.
- **A2 (I2).**
  - `an answer after the project changed is dropped` is rewritten. Existing test changed: it used to press for p2, which hid the late answer.
  - New: `an answer of the count after the project changed is dropped`.
  - Both use a watched client. Its `settled()` resolves after the component's own continuation, with no timer. Each test asserts that the status is empty and there is no alert (POST test), or that there is no confirmation (count test).
  - Mutation check: deleting each generation check (`:97`, `:76`) fails its test.
- **A3.** New test: `two presses of Transcribe them in the same moment send one request`, using two `fireEvent.click` calls in one `act`. It fails with the `busy` guard removed.
- **A4 (M2).** A missing tool is said once: `SpeechModelNotice` alone for a speech model, `MissingToolNotice` alone for another tool. `err.message` is dropped.
  - Existing test changed: `a refusal for a missing speech model names it` now asserts the alert's exact text, without the general sentence.
  - New test: `a refusal for another missing tool says it once …`.
  - Both failed before the mend.
- **Fake.** `backgroundService.ts` gains:
  - `holdReads`, which holds the switch GETs and the untranscribed GET;
  - `locked: string[]`, which makes the automation routes answer 423;
  - `projectLocked()` and `automationLocked(base)`.

### B. The switches (f9712a6)
- **B1 (I3).** `SavedSwitch` reads through `readWithin(read, firstReadMs)`. The screens pass their own `firstReadMs`.
  - A read that fails or runs out shows an alert: "This setting could not be read." followed by the screens' `TryAgain`. Pressing it reads again, and focus goes to the section's h2 (now `tabIndex=-1`, passed as the new `focusTo` prop).
  - New tests, all failing before the mend:
    - on ToolsSetup: a failed first read, then Try again, then the switch is shown; and a read given up at a limit of 300 ms, then Try again;
    - the same two on GovernanceSettings.
- **B2.** Two changes in one tick send one request, tested on each switch. Both tests pass on the existing code and fail with the `sending` guard removed.
- **B3 (M3, M5).** While locked, the Governance screen's other sections still read (retention, documents), so the brief's two directions do not agree. I followed the explicit one: on a locked project the switch is not read and shows no alert.
  - `GovernanceSettings` gains `projectLocked`. The route passes `isLocked(project)` through `ctx.projectLocked`, and `SavedSwitch`'s `read` may be left out.
  - `msw-governance.ts` gains `lockedAutomation()` (423).
  - Tests, failing before the mend:
    - GovernanceSettings: `on a locked project the switch is not read …`;
    - routes/governance: `on a locked project the Governance screen of the app does not read … (R684)`.
- **B4 (M4).** New test: `focus stays on the switch after a save, and after a failed one`. jsdom keeps focus on a disabled box, so the test drops it as WebKit would. It fails with the `refocus` effect removed.

### C. (04bb184)
- The review's existing defect is fixed: the Optional tools screen's group sections are now named by their headings. The id carries the group's index, not its title with spaces.
- New test: `each group of tools is a region named by its heading`. It failed first.

### Researcher-visible sentences
- None new.
- On a failed or given-up switch read, the alert now says "This setting could not be read." in every case. The service's own sentence is no longer shown there, as the brief directs.
- A missing tool's refusal no longer repeats the service's general sentence.

### NEEDS A RULING
1. **The switch on a locked project.** It is shown unchecked and disabled, without having been read, so the unchecked box may not be the project's real value. Options: (a) keep this; (b) do not show the section while locked. I recommend (b) if the owner prefers no box that could mislead.
2. **The locked rule.** The brief's "as the screen's other sections do while locked" does not match the code: Retention and Approval documents still read on a locked project. I built "not read, no alert", as the brief says.

### Runs (single files, `nice -n 10`)
TranscribeAll 11 passed; GovernanceSettings 78; GovernanceSettings.backup 6; ToolsSetup 42; Library 53; Library.firstReads 18; screens/governance.firstReads 37; routes/governance 26; routes/tools 10; FirstUseTools 24; App 16. Typecheck `@ao/ui` clean; `lint:css` clean; `lint:colours` ok.

## Last fix (R686)

One commit on top of 04bb184. Nothing pushed; `git status --short` is empty.

**What changed**
- While the project is locked, the Governance screen does not show the "Automatic transcription" section at all (`background && !projectLocked`), and nothing is read for it.
- Once the project is unlocked, the section appears and reads as usual.
- `SavedSwitch`'s `read` prop is required again: the "leave out the read" path is gone.

**Tests changed** (both replace the R684 locked tests, and both failed at 04bb184)
- GovernanceSettings, `on a locked project the section is not shown and nothing is read for it; unlocked, it appears with the read value (R686)`:
  - while locked: no heading, no checkbox, no automation GET and no alert;
  - after a rerender as unlocked: the section shows the value it read.
- routes/governance, `on a locked project the Governance screen of the app does not show or read the automatic transcription switch (R686)`.

**Runs** (single files, `nice -n 10`): GovernanceSettings 78 passed; screens/governance.firstReads 37 passed; routes/governance 26 passed; typecheck `@ao/ui` clean.

## Last fix (R689)

One commit on top of aa65328: **9d8fb7d**. Nothing pushed; `git status --short` is empty.

### Code
- `SavedSwitch` puts focus back on the box in a `useLayoutEffect`. It runs in the same commit that enables the box again, so there is no moment when the box is enabled and focus is elsewhere.
- `TranscribeAll` moves focus to the sentence or the button the same way.

### Tests
The tests that assert focus after a request now wait for the focus itself, with `waitFor(() => expect(document.activeElement).toBe(...))`, instead of waiting for "enabled" and then checking focus.
- **ToolsSetup:** "focus stays on the switch…", after both the successful and the failed save.
- **TranscribeAll:** three tests:
  - the confirmation takes focus;
  - the "nothing to do" sentence takes focus;
  - focus returns to the button after "Transcribe them".
- **GovernanceSettings:** no test of this kind.

### Load runs
Each run: `NODE_OPTIONS="--use-openssl-ca" nice -n 10 pnpm --filter @ao/ui exec vitest run <path> --testTimeout 120000`, with four busy loops running.

| File | Result |
|---|---|
| ToolsSetup | 30/30 passed |
| GovernanceSettings | 30/30 passed (22 + 8) |
| TranscribeAll | 30/30 passed |

- **Why GovernanceSettings is 22 + 8:** each of its runs takes about 5 minutes under load. The first background batch reached the 2-hour limit after 22 runs, all passed, and was stopped. A second batch ran the last 8 runs.
- **A first attempt was thrown away:** its pass check was wrong, because it matched the word "failed" inside test names. No result is taken from it.
- **Nothing is left running:** the busy loops were killed by the script's exit trap.

Typecheck `@ao/ui` is clean.
