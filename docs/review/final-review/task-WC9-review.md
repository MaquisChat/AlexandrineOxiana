# Task WC9 review: the switches and "Transcribe everything without a transcript"

Worktree `.claude/worktrees/kg-4`, branch `wc-9-switches`, range a210250..6d2627c (one commit). `git status --short` is empty at the end; every probe was removed and every file restored.

## Verdict: READY WITH FIXES

## Important

**I1. "Transcribe everything" is offered on a read-only library and relies on a refusal the Task 7 table does not promise.** `packages/ui/src/screens/Library.tsx:1150`, `components/TranscribeAll.tsx:11`.
- What happens: the button is enabled on a read-only library. A press reads the count and offers `Transcribe them`. The screen then expects the service to refuse.
- Why it matters (1): the Library screen's own rule (`Library.tsx:6`) is "While the library is read-only the drop zone and every edit button are off", and its other edit buttons (`:783-794`) are hidden or off.
- Why it matters (2): the Task 7 route table gives `requireWritable` only to `PUT …/automation`. For `POST …/transcription-list` it promises 403 `POLICY_DENIED` and 409 `TOOL_NOT_INSTALLED`, nothing for a read-only library. Task 7 may well append list records to the journal there.
- Smallest fix: pass the screen's `readOnly` to `<TranscribeAll>`. On a read-only library, turn the button off and tie it to a short reason with `aria-describedby`, or do not show it, as the neighbouring buttons do. A test for each. Also ask the coordinator to pin "POST `…/transcription-list`: `requireWritable` (409 `READ_ONLY`)" in Task 7's table.

**I2. The test "an answer after the project changed is dropped" does not test what its name says.** `components/TranscribeAll.test.tsx:111-128`.
- Mutation: delete the `if (generation.current !== my) return;` that follows `await api.transcribeAll(projectId)` (`TranscribeAll.tsx:293`). All 7 tests still pass.
- Why: the test presses the button for p2 right after `m.release()`, and that press (`ask`) clears `added`. A late p1 answer is wiped before the assertion.
- My probe: change the project, release the request, wait, then assert that the status is empty without pressing again. It failed under the mutation and passed with the code as committed.
- Fix: assert `screen.getByRole("status").textContent === ""` and no alert after the p1 answer has arrived (await the request's end, e.g. via the fake), before pressing for p2.

**I3. A failed read of a switch leaves it dead, and the new sentence offers no way on.** `components/SavedSwitch.tsx:98, 122-128`.
- What happens on a failed read (or an error before Task 7 is joined): the box stays disabled. An alert reads "This setting could not be read.", or the service's sentence. There is no Try again, so the only way back is leaving the screen.
- A read that never answers has no time limit (FR-756, `readWithin`). The box stays disabled forever and nothing is said.
- The Global Constraints ask for a sentence that says "what happened and what to do next". Both screens already have the pattern: `TryAgain` (ToolsSetup `:571-578`; GovernanceSettings imports it).
- My probe: a `read` that rejects gives an alert and 0 buttons.
- Fix: put `TryAgain` in the read-failure alert to read again, with a test, and wrap the read in `readWithin(firstReadMs)`.
- Where the sentence lives: it is shown only by screens, not by the service, so the "lives once in `@ao/shared`" rule does not require moving it. Keeping it exported in `SavedSwitch.tsx` is fine.

## Minor

- **M1. The synchronous guards are not pinned by any test.** The guards are `busy` in `TranscribeAll.send` (`:287`) and `sending` in `SavedSwitch.change` (`:137`). Removing either one leaves every shipped test green: userEvent's `dblClick` waits between clicks, so React disables the control first.
  - My probes: two `fireEvent.click` calls in one `act`. Without the guard, TranscribeAll sent 2 POSTs and SavedSwitch sent `[true, false]`. With the guards, each sent one.
  - Fix: add those two probes as tests.
- **M2. A missing speech model is said twice in the refusal.** `TranscribeAll.tsx:356-361` shows the service's generic sentence ("A tool this needs is not installed… The Optional tools screen shows how to get it.") and then `SpeechModelNotice` ("The speech model “medium” is not installed… Install it from the Optional tools screen."). The same happens for another tool with `MissingToolNotice`. The app's existing pattern (`TranscriptViewer.tsx:1010`) shows only the tool sentence and the link. Fix: drop `err.message` when a tool is named.
- **M3. On a locked project, the Governance switch still sends `GET …/automation`.** The service answers 423, so a `role="alert"` appears on load under the screen's own "This project is locked…" reason. Fix: skip the read (or the section) when the project is locked.
- **M4. No test asserts where focus goes after a switch is saved.** The `refocus` effect (`SavedSwitch.tsx:161-165`) is untested.
- **M5. The fakes have no 423 mode for the new GETs**, so the locked-project case (M3) is untested.

## Checked and found right

**Governance and the switch do not interfere.**
- The governance PUT's `If-Match` is the sha256 of the raw `governance.yaml` (`apps/library-service/src/routes/governance.ts:141-163`; `packages/library/src/repo/governance-edit.ts:178`). `setGovernance` never writes `project.json`.
- `project.automation` lives in `project.json` (`packages/core/src/model/project.ts:33`), and `setBackupSettings` (`packages/library/src/repo/backup-settings.ts`) shows the pattern Task 7 will follow: `writeProjectData`.
- So saving the switch cannot make the next "Save changes" conflict, and "Save changes" cannot overwrite the switch.
- The switch is not part of the form's state: "Save changes" stays disabled, as the test asserts.

**The two switches.**
- Two quick changes: the second is ignored while the box is disabled, so the box never shows a value the service does not have.
- A failed save puts the box back to the saved value. My mutation that keeps the failed value made both "failed save" tests fail.
- On a read-only library or a locked project, `whyId` (`${rawId}-why`) turns the box off and describes it.
- Answers that come after unmount or after a new read are dropped (`generation`).

**"Transcribe everything".**
- The sentences come from `transcribeAllText`.
- `none` offers no buttons.
- The confirmation takes focus, and so does `none`.
- The status region exists before its text arrives.
- Focus returns to the button after `Transcribe them` and after `Cancel`.
- 403 and 409 show the service's sentence.
- Not offered on a locked project: it sits inside the `!locked` branch.
- A second press while the read is out: the button is disabled and `busy` holds it.

**Placement.**
- Only `<TranscribeAll>` was added to `Library.tsx`. WorkLines and the event feed are untouched.
- `GET /events` is asked once, as the new Library test asserts.
- Library.firstReads passes: no request is made on mount.

**Accessibility.**
- Each switch is a labelled checkbox, with its hint (and its error) tied by `aria-describedby`.
- Each section has an h2 that names it, through an id from `useId` with no spaces.
- The existing defect (tool groups with no accessible name, because the ids contain spaces) is not made worse: the new section names itself correctly.

**`SavedSwitch.tsx` outside the file list: justified.** Two screens share one save pattern, and the component is small and self-contained.

## Contract check

- **`backgroundApi`'s six functions:** names, paths, methods and bodies match the plan's Interfaces and the Task 7 table (`{transcribeNewMedia}`, `{keepAwake}`, `{}` or `{model}`).
- **Answer types:** `ProjectAutomation`, `BackgroundSettings`, `UntranscribedResponse` and `TranscribeAllResponse {added, list}` come from `@ao/shared` and match the plan.
- **Errors the fakes use:**
  - 403 `POLICY_DENIED`;
  - 409 `TOOL_NOT_INSTALLED` with reason `speech-medium`, worded as `routes/transcription.ts:45` does;
  - 409 `READ_ONLY` for a PUT, the code `requireWritable` gives.
- **Fake POST:** it publishes `background.progress {transcriptions}` before it answers (R679).
- **What the screens assume beyond the table:** only I1.
- **The sentences:** `AUTOMATION_TEXT`, `KEEP_AWAKE_TEXT` and `transcribeAllText` are used from `@ao/shared` and not retyped. The test strings match the plan's table character for character.
- **R671:** the `purpose` and `without` in `msw-tools.ts:122-123` match `services/media-worker/ao_worker/toolpins.py:252-256` exactly. The `ToolsSetup.tsx:42` and `FirstUseTools.tsx:70` hints are plain and true.
- **"viewing copies" elsewhere in `packages/ui`:** the old wording is left only in `MissingToolNotice.tsx:31`, which belongs to Task 8 under R671. The other hits are unrelated labels.

## Mutations and what the tests did

| Mutation | Shipped tests | Probe |
|---|---|---|
| `TranscribeAll.send` without the `busy` guard | 7/7 pass (survived) | a synchronous double fire sent 2 POSTs (M1) |
| `TranscribeAll.send` without the generation check on the answer | 7/7 pass (survived) | a late answer after the project changed was shown in the status (I2) |
| `SavedSwitch` keeps the failed value (`setSaved(on)` in `catch`) | both "failed save" tests fail (caught) | — |
| `SavedSwitch.change` without the `sending` guard | "saves it" tests pass (survived) | a synchronous double change sent `[true, false]` (M1) |

## Runs (single files, `nice -n 10`)

| File or command | Result |
|---|---|
| TranscribeAll | 7 passed |
| GovernanceSettings | 74 passed |
| GovernanceSettings.backup | 6 passed |
| ToolsSetup | 37 passed |
| Library | 52 passed |
| Library.firstReads | 18 passed |
| FirstUseTools | 24 passed |
| screens/governance.firstReads | 37 passed |
| routes/governance | 25 passed |
| routes/tools | 10 passed |
| typecheck `@ao/ui` | clean |
| `lint:css` | clean |
| `lint:colours` | clean |

## Not checked

- The e2e step, as directed.
- The behaviour against the real Task 7 routes, which do not exist in this worktree.
- WebKit:
  - whether focus on a box that is disabled while it saves falls to `body`, which the `refocus` effect depends on;
  - VoiceOver's reading of the empty status and of the confirmation group.
- Whether `caffeinate` actually keeps a real Mac awake; that is Task 7's.
