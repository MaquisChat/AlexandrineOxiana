# Task 8 (the estimate before a capture, Capture screen) — fix round after the review (Ruling R683)

You are a FRESH implementer (the first one is at its size limit). Read the common brief first, in full: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/wc-common.md` (your task is Task 8). Then the review in full: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-WC8-review.md` — the finding numbers below are its numbers — and the first implementer's report `task-WC8-report.md`.

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1`, branch `wc-8-estimate`, head 573aebb. Tests first for every point: each new or changed test must fail before its mend (say so per point). One commit per group A–E. Where this brief pins something it replaces or adds to the plan's Task 8 text. The service routes this screen calls still do not exist in your worktree: MSW fakes only; do NOT run the e2e step.
Files you must NOT touch (another task edits them): `Library.tsx`, `GovernanceSettings.tsx`, `ToolsSetup.tsx`, `FirstUseTools.tsx`, `packages/ui/src/api/background.ts`, `packages/ui/src/test/backgroundService.ts`, `msw-tools.ts`, `msw-governance.ts`, `WorkLines.tsx`. You MAY add to `packages/shared/src/api/background.ts` exactly what section A names (with its tests in `background.test.ts`).

## A. Three new sentences in `estimateText` (`packages/shared/src/api/background.ts`)
- `settingsChanged: string` = `The settings changed, so the estimate was closed. Press “Capture profile” to see it again.`
- `switchNotRead: string` = `The project's switch for automatic transcription could not be read. This capture follows the switch as it stands, unless you tick the box.`
- `listingSlow(p: CapturePlatform): string` = `Still asking YouTube for the list. A long list can take a few minutes.` (the platform's name as in `listing`)

## B. An estimate is only ever started for what the screen shows (I1, I2)
B1. The estimate (open or still being read) belongs to a snapshot: the address and every option of the profile form as they were when "Capture profile" was pressed. Whenever ANY of them differs from the snapshot — the address, metadata only, dates, the maximum, content types, comments, the legal basis, the browser session, the Transcription choice above, the model — the estimate is closed: a request still out is cancelled (its signal aborted) and its answer dropped; an open estimate goes away, the form's buttons come back, and the screen says `estimateText.settingsChanged` once as a status (the status region exists before its text). Do it in ONE place by comparing the form's current values with the snapshot, not by hooking each control. The address typed while a request is out is never wiped.
B2. `Start` can therefore only ever send the snapshot that the form still shows.
Tests: the reviewer's two probes (type `@old`, press, type `@new` while the estimate is held, release → no estimate of `@old` is shown, nothing is sent, the field still says `@new`; open the estimate, tick "Metadata only" → the estimate closes with the sentence, and a new "Capture profile" then "Start" sends `metadataOnly: true` and no `quality`); one test per kind of control is not needed — one for the address, one for an option, one for the Transcription choice.

## C. The project's switch is never overridden by a failed read (I3, M1, M2)
C1. What `Start` sends for transcription: an explicit `transcribe: true` / `false` ONLY when the researcher chose "Transcribe" or "Do not transcribe" above, or changed the box in the estimate. With "Use the project's setting" chosen and the box untouched, `transcribe` is LEFT OUT of the request (the service then applies the project's switch as it stands at that moment — Task 5's rule).
C2. The read of the project's switch (for showing the box's starting state) has the first-read time limit and never holds back the estimate: the estimate shows as soon as ITS answer is there. If the switch could be read, the box starts as it says. If the read failed or ran out of time: the box starts unticked, and `estimateText.switchNotRead` is shown beside it (tied to the box with `aria-describedby`); untouched → `transcribe` left out; ticked → `true`.
C3. (M1) When transcription is sent as `true`, the model sent is the one the estimate names (`estimate.speechModel`). (M2) For a metadata-only estimate the Transcribe box is not shown and `transcribe` is never sent as `true`.
Tests: the reviewer's probe (switch ON, the read answers 500, "Use the project's setting", Start → the request has NO `transcribe` key, and the sentence is shown); the read slower than the estimate → the estimate shows first; "Do not transcribe" above → `transcribe: false`; the box changed → explicit; the model sent equals the model named; metadata only → no box.

## D. The listing can be given up, and locks nothing else (I4, I5, M5)
D1. While the estimate is being read the screen shows the listing status and a `Cancel` button (`estimateText.cancel`) beside it: it aborts the request, drops its answer, and puts focus back on the profile field. There is no hard time limit on the listing (a large channel takes minutes), but once the first-read limit has passed without an answer the status changes to `estimateText.listingSlow(platform)`. The status region is mounted before its text (M5). A platform the form accepts always gets a status.
D2. The estimate's "busy" is its own: while an estimate is being read or open, "Capture links" and the links form stay fully usable (a single link is captured at once). Only the profile form's own "Capture profile" is held.
D3. (I5) An estimate refused with 409 `TOOL_NOT_INSTALLED` names the tool: the screen shows the existing `MissingToolNotice` for the tool id in the answer's `reason` (as the capture queue does for a run that lacks a tool), with its link to the Optional tools screen — not the generic sentence. Keep `reason` when the error is rebuilt.
Tests: Cancel during the listing (the request's signal aborted — keep the mock `request` and read `request.signal.aborted` when asserting; focus on the profile field; a late answer shows nothing); the slow sentence after the limit (fake clock); "Capture links" works while an estimate is out and while one is open; a 409 with reason `video-downloader` shows the notice naming that tool with its link.

## E. Tests that prove what they say (I6, M4)
E1. "Start sends … once, however often it is pressed": two presses in the same tick (`fireEvent.click` twice inside one `act`), and it must FAIL with the synchronous guard removed — check by removing it locally, then restore.
E2. "an answer after the project changed is dropped" no longer waits on a real timer: wait for the held answer to have been delivered, then assert.

## Accepted as they are
M3 (`videoToolsInstalled: null` is treated as installed) and M6 (focus after a refusal follows the form's existing pattern).

## Runs and report
`src/components/CaptureEstimate.test.tsx`, `src/screens/Capture.test.tsx`, `Capture.firstReads.test.tsx`, `src/components/CaptureQueue.test.tsx`, `MissingToolNotice.test.tsx`, `packages/shared` `src/api/background.test.ts`, each alone; typecheck `@ao/shared` and `@ao/ui`; `lint:css`, `lint:colours`; `git status --short` empty. Append "Fix round (R683)" to `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-WC8-report.md`. Final message at most 150 words.
