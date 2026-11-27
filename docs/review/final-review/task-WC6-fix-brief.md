# Task 6 (the work lines on the Library and Capture screens) — fix round after the review (Ruling R679)

You are a FRESH implementer (the first one is at its size limit). Read the common brief first, in full: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/wc-common.md` (your task is Task 6). Then the review in full: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-WC6-review.md` — the finding numbers below are its numbers — and the first implementer's report `task-WC6-report.md`.

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-7`, branch `wc-6-lines`, head 45b6aa7. Tests first for every point: each new or changed test must fail before its mend (say so per point). One commit per group A–E. Where this brief pins something it replaces or adds to the plan's Task 6 text (the plan has been updated to match).

## A. One stream per screen (I1, I2, M6, M7) — the design is ruled: the reviewer's (c)

A1. `WorkLinesProps` gains one optional prop: `events?: { subscribe(onEvent: (e: ServiceEvent) => void, onOpen: () => void): () => void }` (the function returned ends the subscription). 
- **With the prop** WorkLines opens NO stream of its own. From mount to unmount it is subscribed: it applies every `background.progress` event of its project (a run it did not know yet is added; a `discarded` one removed; the transcription list replaced), and it reads both lists at mount and again at every `onOpen`. It does not matter whether it currently shows something.
- **Without the prop** it keeps its own loop exactly as built (the five stream tests keep testing that loop), with one change: the loop runs from mount, not only "while it shows something" (the "follow only while showing" rule goes).
A2. `Library.tsx` and `Capture.tsx` each hand their OWN existing `/events` consumer to the lines through that prop (about ten lines each: keep a small set of subscribers beside the screen's loop; call each subscriber's `onEvent` for every event the screen's loop receives and `onOpen` at every open). The `key` re-mount in `Capture.tsx` goes. The screens' own stream counts stay at one: no existing test of the two screens may need its stream count changed. The screens' own first-read, focus and reconnect behaviour stays untouched.
A3. A read that fails with anything but 404 (a 500, a network error, a read given up after the first-read limit) is not swallowed: the section shows `WORK_LINES_TEXT.lost` with the `Reconnect` button (the existing sentence and button; no new words), and `Reconnect` reads again; a later successful read (also the one at the next `onOpen`) takes the notice away. A 404 still means "this service has no such route: nothing to show", and it does not wipe runs already learned from events.
A4. An answer that is OLDER than what is shown never overwrites it: a read's answer for a run is dropped when an event for that run arrived after the read was sent (compare `updatedAt` where the summaries carry it; for the transcription list, which has none, drop a read's answer when a `transcriptions` event arrived after that read was sent) (M3).
A5. The section renders nothing visible when there is no run, the list is idle with total 0, no notice and no status sentence is shown — also after a Discard here (M6).
Tests: P1 and P2 of the review become tests (a screen mounted with nothing to show gets a run and a running list by event → both lines appear; a run discarded by event, then a new run's event → the new line appears); with the prop no `/events` request is made by the lines; a re-read at `onOpen`; a 500 on the reads shows the notice and `Reconnect` reads again; a late read does not overwrite a newer event; in `Library.test.tsx` and `Capture.test.tsx` one test each that an event arriving on the SCREEN's stream shows the line (and the existing stream-count assertions untouched).

## B. Names for buttons, and what is told to a screen reader (I3, M2, M5, M9)
B1. Every button of a line is named by itself and its line: `aria-labelledby` = the button's own id followed by the id of that line's title (so: "Stop Downloading "Example Channel": 120 of 412"). Tests find buttons within their line.
B2. A status region exists BEFORE its text arrives: the region for `LIST_STOPPED_TEXT` (and any other status the section says) is rendered empty and then filled (M2).
B3. A run that first appears through an event is told to a screen reader once (M5).
B4. An action's error is shown inside the block of the run (or the list) it belongs to, not once for the section (M9).

## C. A finished line can be taken off the screen (I4) — ruled
C1. Add to `packages/shared/src/api/background.ts` (Task 1's file; this is an addition, with its test in `background.test.ts`): `RUN_BUTTONS.remove` and `LIST_BUTTONS.remove`, both exactly `Remove from this list`.
C2. A run that is `finished` with nothing left to do (also "nothing new to download") gets exactly ONE button, `RUN_BUTTONS.remove`, which calls the existing discard route; focus then goes to the section heading as after a Discard. Every other rule of the buttons stays (a finished run WITH failures keeps `Show them`, `Resume downloads (N did not complete)` and `Discard`).
C3. The transcription list when it is idle with total > 0 ("Transcriptions finished: …") gets exactly ONE button, `LIST_BUTTONS.remove`. It calls `listAction("stop")` — a stop of an idle list only sets its counters to zero — and the section does NOT say `LIST_STOPPED_TEXT` then (nothing was stopped); the line goes and focus goes to the heading.
Tests: each case; `LIST_STOPPED_TEXT` is said after a Stop of a RUNNING or PAUSED list and not after a removal of a finished one.

## D. Smaller points (M1, M4, M8)
D1. The synchronous double-press guard gets a test that fails without it (fire the two presses in the same tick — `fireEvent.click` twice — and assert one request) (M1), for each kind of button.
D2. The title inside a sentence is found WITH its quotation marks as the sentence has them (`"Title"` or `'Title'`), never by the bare title, so a title like `of` or `Download` cannot wrap the wrong words; if it cannot be found the whole sentence goes through `UserText` (M4). Test with the titles `of` and `Downloading`.
D3. "Show them" reads with the first-read time limit and is cancelled when the block closes or the component unmounts; a failure shows the screen's existing plain sentence with "Try again" inside that run's block, never an empty heading (M8).

## E. Anything else in the review you can settle without a choice
M10 needs nothing. Anything that needs a choice about what the researcher sees: "NEEDS A RULING".

## Runs and report
`src/components/WorkLines.test.tsx` (also 15 times under load: four busy loops, killed after), `src/screens/Library.test.tsx`, `Library.firstReads.test.tsx`, `Capture.test.tsx`, `Capture.firstReads.test.tsx`, `packages/shared` `src/api/background.test.ts`, each alone; typecheck `@ao/shared` and `@ao/ui`; `lint:css`, `lint:colours`; build the UI and run `e2e/capture.spec.ts` and `e2e/library.spec.ts` in Chromium (the real service still has no such routes: 404 → nothing shown, no scenario changed). `git status --short` empty. Append "Fix round (R679)" to `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-WC6-report.md`. Final message at most 150 words.
