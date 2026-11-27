# Task 9 (the switches and "Transcribe everything without a transcript") — fix round after the review (Ruling R684)

You are a FRESH implementer (the first one is at its size limit). Read the common brief first, in full: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/wc-common.md` (your task is Task 9). Then the review in full: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-WC9-review.md` — the finding numbers below are its numbers — and the first implementer's report `task-WC9-report.md`.

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-4`, branch `wc-9-switches`, head 6d2627c. Tests first for every point: each new or changed test must fail before its mend (say so per point). One commit per group A–C. The service routes these screens call still do not exist in your worktree: MSW fakes only; do NOT run the e2e step.
Files you must NOT touch (another task edits them): `Capture.tsx`, `Capture.css`, `CaptureQueue.tsx`, `CaptureEstimate.tsx`, `MissingToolNotice.tsx`, `packages/ui/src/api/capture.ts`, `packages/ui/src/test/captureService.ts`, `e2e/capture.spec.ts`, `packages/shared/src/api/background.ts`, `WorkLines.tsx`.

## A. "Transcribe everything without a transcript" (I1, I2, Minors)
A1. (I1) On a read-only library the button follows the Library screen's own rule for controls that change the library: it is switched off, with the screen's read-only reason given the way the screen's other switched-off controls give it (read how `Library.tsx` does this for its existing controls and do the same; no new sentence). (The service will refuse too: the plan's Task 7 now pins `requireWritable` for `POST /projects/:id/transcription-list`.)
A2. (I2) The test "an answer after the project changed is dropped" must FAIL when the stale-answer check (`TranscribeAll.tsx` ≈ line 293) is deleted: hold the answer, change the project, release, wait for the answer to have been delivered (no real timer), then assert nothing of it is shown. Do the same check-by-mutation for the same kind of test on the `untranscribed` read.
A3. (Minor) The synchronous guard of `Transcribe them` is pinned: two presses in the same tick (`fireEvent.click` twice inside one `act`) send one request, and the test fails with the guard removed.
A4. (Minor) A missing speech model is said ONCE (the reviewer found it said twice): the existing `SpeechModelNotice` alone.

## B. The two switches (`SavedSwitch`) (I3, Minors)
B1. (I3) The first read of a switch has the first-read time limit (the same limit and helper the screens' other first reads use). When it fails or runs out: the sentence "This setting could not be read." with a "Try again" button on the screens' existing pattern (read how the Governance screen and the Optional tools screen offer "Try again" after a failed first read and follow it; the sentence stays in the UI); "Try again" reads again and, on success, shows the switch. The switch is never left disabled for good with no way on.
B2. (Minor) The synchronous guard of each switch is pinned the same way as A3 (two changes in the same tick → one request; fails without the guard).
B3. (Minor) While the project is locked, the Governance screen's "Automatic transcription" section does not read and shows no alert of its own: it follows what the Governance screen already does for its other sections while locked (read it; if the screen is not shown at all while locked, a guard test is enough). The fakes (`backgroundService.ts`, `msw-governance.ts`) gain a way to answer 423 for the automation routes so the test can show it.
B4. (Minor) A test for where focus is after a successful save and after a failed one (it stays on the switch; asserted through `document.activeElement`).

## C. Anything else in the review you can settle without a choice
Anything that needs a choice about what the researcher sees: "NEEDS A RULING".

## Runs and report
`src/components/TranscribeAll.test.tsx`, the test file of `SavedSwitch` if it has one, `src/screens/GovernanceSettings.test.tsx`, `GovernanceSettings.backup.test.tsx`, `ToolsSetup.test.tsx`, `Library.test.tsx`, `Library.firstReads.test.tsx`, `src/governance.firstReads.test.tsx`, each alone; typecheck `@ao/ui`; `lint:css`, `lint:colours`; `git status --short` empty. Append "Fix round (R684)" to `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-WC9-report.md`. Final message at most 150 words.
