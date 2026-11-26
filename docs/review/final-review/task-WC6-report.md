# Task WC6 — the work lines on the Library and Capture screens: report

Worktree `.claude/worktrees/kg-7`, branch `wc-6-lines`, head **45b6aa7** ("feat(ui): one line each for downloads and transcriptions wherever the project is open"), one commit on top of the integration branch (5e6151e). Not pushed. `git status --short` is empty.

## What was built, per step

**Step 1 (tests first)** — `packages/ui/src/components/WorkLines.test.tsx` (25 tests) and the MSW fake `packages/ui/src/test/backgroundService.ts` (`exampleRun`, `idleList`, `backgroundDefaults(base)`, `mockBackground(o, base)`: records "METHOD path", `emit` on its own /events, `holdActions` + `release`, `setRuns`, `setList`; the /events requests are kept so their signals are read when asserting a cancel).
Every test named in the plan is there under its plan name, plus four more: `a discarded event removes its run` (and newest first), `a title line is told to a screen reader at most every five seconds (R658 M3)`, `nothing to show renders nothing: no run and an idle list with nothing on it (and no stream is opened)`, `a service that does not know the two routes (404) shows nothing and says no error`.
In `Library.test.tsx`: `the work lines are shown for the open project`. In `Capture.test.tsx`: `the work lines are shown for the open project` and `a profile capture started here shows its run in the work lines`.

**Step 2 (seen failing)** — WorkLines.test.tsx failed for the right reason (the module `./WorkLines` did not exist). The three screen tests were checked failing with the mount line taken out of `Library.tsx` / `Capture.tsx` (each timed out looking for the region), then the mount restored.

**Step 3 (built)**
- `packages/ui/src/api/background.ts`: `backgroundApi(client)` with exactly the plan's six methods (the three GETs take an optional extra `{ signal }`), and `backgroundProgress(e, projectId)` (type `background.progress`, this project only, parts shape-checked; a run or list naming another project is refused).
- `packages/ui/src/components/WorkLines.tsx` (`WorkLines` at :125) and `WorkLines.css` (tokens only):
  - section `aria-labelledby` its h2 `WORK_LINES_TEXT.heading`; one block per run, newest first (`startedAt`), all sentences from `runLines`; buttons per the plan (Pause+Stop for downloading/waiting; Stop only for queued; Show them when failed > 0; `resume` when defined; Discard in any other state) — except a finished run with nothing failed and nothing left, which has **no button** (see "found", 1). Buttons are `aria-describedby` their run's title.
  - the transcription line from `transcriptionLines`: running → Pause, Stop; paused → Continue, Stop; idle with a title → no button. After a successful Stop: the list's answer replaces the line (gone), `LIST_STOPPED_TEXT` as one `role="status"`, focus to the h2, the section stays rendered (R672).
  - titles inside the fixed sentences are their own `UserText` (the sentence is split around the title; :73 `Sentence`); problem rows: title / `(no title)`, address, reason and `platformSays(...)` each in `UserText`; an action's refusal is shown as `errorText(...)` in `UserText` in an alert.
  - R658 M3: each title line has a visually hidden `role="status"` that says the line's changes, at most every 5 s, the last state always in the end (`useSaid` :90, the MissingFiles pattern); the line as first read is shown, not told.
  - "Show them": inline h3 `PROBLEMS_TEXT.heading` that takes focus; "Copy the list" writes `problemLine` rows joined by "\n" with `navigator.clipboard.writeText`, then says `copied` or `copyFailed` (status).
  - a double press sends one request: a synchronous per-line guard (`act` :267), then the buttons are disabled; answers after the project changed or after unmount are dropped (a ref of the project shown; reads are cancelled through their signal).
  - reads: both lists at the opening and at every opening of the stream; runs merged by `updatedAt` so a late read cannot undo a newer event; `discarded` removes its run; events of other projects ignored.
  - the stream: exactly StepRun's loop — `client.events({ signal, onOpen, openWithinMs, quietWithinMs })`, 2 reconnects 300 ms apart, then `WORK_LINES_TEXT.lost` with `Reconnect`; the count starts again only on this project's `background.progress`, or when the stream was open and the client gave up at the silence limit (R658, R659).
  - **404 = nothing to show** (`unknownRoute` :54): either GET answered 404 sets that list to empty, says nothing. Other read failures say nothing either (the next opening reads again).
- Mounts (one place each): `Library.tsx:1100` first in the project view (`project && !locked`), with `api.client`; `Capture.tsx:1153` above `<CaptureQueue>`, when the project is not locked, `key={linesKey}`; `Capture.tsx:380` the key and one line after a profile capture starts (`setLinesKey`) so the lines read again (see NEEDS A RULING).
- `packages/ui/src/api/library.ts:369`: `libraryApi` now also returns `client` (the Library screen has only the `LibraryApi`, and WorkLines takes a client as pinned).
- Fakes: `test/service.ts` `libraryHandlers()` and `test/captureService.ts` `mockCapture()` end with `...backgroundDefaults(BASE)` (GET …/downloads → `{ runs: [] }`, GET …/transcription-list → idle). They are not recorded in `mockCapture`'s `calls`, so no existing assertion on `calls` moves.

**Step 4 (runs)** — below. The real service answers 404 for the two GETs in both e2e specs; both passed with no change to any scenario (the component already treated 404 as "nothing to show", and with nothing to show it opens no stream).

## Researcher-visible sentences
No new sentence. Every one is `@ao/shared` as Task 1 wrote it (`runLines`, `transcriptionLines`, `RUN_BUTTONS`, `LIST_BUTTONS`, `LIST_STOPPED_TEXT`, `PROBLEMS_TEXT`, `platformSays`, `problemLine`, `WORK_LINES_TEXT`). Two fallbacks only reach the screen when a refusal carries no words of its own: `That could not be done. Try again.` (an action) and `The list could not be read. Try again.` (Show them).

## Existing tests changed
None changed. Added: the 25 in WorkLines.test.tsx, 1 in Library.test.tsx, 2 in Capture.test.tsx. The fakes `service.ts` and `captureService.ts` gained the default handlers only.

## NEEDS A RULING
1. **The stream is followed only while the section shows something** (plan: "Read both lists at opening and after every reconnect", stream always). Found: with an always-open stream, `Capture.test.tsx` failed 60+ of its 65 tests — its `setup` (`Capture.test.tsx:42`) and other tests assert `m.streams()` is exactly 1 on the shared `/events` fake (also `Capture.firstReads.test.tsx:265,269`, `Capture.test.tsx:478,568,606,658`), and the fake cannot tell the two consumers apart. Options: (a) as built: no run and an idle list = read once, render nothing, open no stream; once there is something to show (or after a Stop/Discard here), follow the stream as pinned; a screen that starts work here re-mounts the lines (`key`) — done for "Capture profile"; Task 8's `Start` keeps it, Task 9's "Transcribe them" should do the same on the Library screen; (b) always follow, and change every Capture test that counts streams or `/events` calls to count two (≈60 tests, with the two consumers racing on one fake); (c) let WorkLines take events from the screen's own stream (changes the pinned props). **Recommend (a)** (no existing test touched, every scenario passes; the gap is only work started from ANOTHER window while this screen shows nothing, seen at the next opening).
2. **"A run that completed everything says so and has no button"** (the spec's sketch; the plan's test name) vs the plan's bullet "any state but queued, downloading or waiting: Discard". Built the spec/test reading: `finished` with failed 0 and notCompleted 0 (also "nothing new to download", total 0) has no button at all, so such a line stays until the journal's compaction drops the finished run. Options: keep (spec), or add Discard to it. Recommend keep unless the owner wants it gone by hand.

## Found in the code that the plan did not expect
- `LibraryApi` carried no client; added `client` to `libraryApi()` (one line).
- The duplicate-text consequence of the R658 M3 telling (a visually hidden copy of a changed title line): tests here query what is shown with `ignore: ".ao-visually-hidden"` (as MissingFiles.test.tsx does). Task 10's Playwright locators should take the visible line (e.g. `getByRole("region", { name: "Downloads and transcriptions" })` plus `.ao-worklines__title`, or `.first()`), since after a change the hidden status holds the same sentence.
- An action's refusal is shown through `errorText` (so a 409 CONFLICT reads "Something changed in the meantime. These downloads are already running."; a 403 keeps the rule's reason).

## Runs (last summary line of each)
- `vitest run src/components/WorkLines.test.tsx` — Tests 25 passed (25)
- `vitest run src/screens/Library.test.tsx` — Tests 50 passed (50)
- `vitest run src/screens/Capture.test.tsx` — Tests 67 passed (67)
- `vitest run src/screens/Capture.firstReads.test.tsx` — Tests 15 passed (15)
- also, for the changed fakes and `libraryApi`: `Library.firstReads.test.tsx` 18 passed (18); `routes/library.test.tsx` 15 passed (15); `App.test.tsx` 16 passed (16); `MissingToolNotice.capture.test.tsx` 4 passed (4); `api/library.test.ts` 10 passed (10)
- `pnpm --filter @ao/ui typecheck` — clean (no output)
- `lint:css` — clean; `lint:colours` — "ok: no hard-coded colours in src/**/*.ts(x)"
- `pnpm --filter @ao/ui build` — ✓ built in 5.19s
- `playwright test capture.spec.ts --project=chromium --trace off` — 4 passed (46.0s)
- `playwright test library.spec.ts --project=chromium --trace off` — 6 passed (1.0m)

## Fix round (R679)

Branch `wc-6-lines`, commits on top of 45b6aa7: A 3542a3a, B bdd28a7, C 2926bf9, D a047cd2 (head). E needed no code. Not pushed. `git status --short` is empty.

**A. One stream per screen (I1, I2, M6, M7).** `WorkLinesProps.events?: WorkLinesEvents` (`subscribe(onEvent, onOpen) → unsubscribe`) and `useEventFeed()` in `components/WorkLines.tsx`. With the prop, the lines open no stream. From mount to unmount they apply every `background.progress` of their project, and they read both lists at mount and at every `onOpen`. Without the prop, the lines' own loop runs from mount. Library.tsx and Capture.tsx hand over their own `/events` consumer (`feed.event(e)` for every event, `feed.opened()` at every open). The Capture `key` re-mount is gone. No stream count in any screen test changed.
- A failed read other than 404 shows `WORK_LINES_TEXT.lost` with Reconnect. Reconnect reads again, and a successful read (also one at the next `onOpen`) clears the notice. A 404 is a no-op and keeps runs learned from events.
- A4: an arrival counter per run and for the list. A read's answer about something an event or an answer changed after the read was sent is dropped.
- A5: the section renders nothing without a run, list, notice or status.
- New tests, all seen failing first: P1, P2, re-read at onOpen, 500 + Reconnect, 404 keeps runs, a late read does not overwrite, after Discard nothing is left once focus leaves, unsubscribe at unmount. Library.test "an event on the screen's own stream shows its line…" also failed first. Capture.test's profile test now emits on the screen's stream and asserts one stream; it failed first.

**B (I3, M2, M5, M9).** Each button has `aria-labelledby="<own id> <line title id>"`. This covers Copy the list and Try again too. The stopped status is always rendered: empty, then filled. A run first seen through an event is told once (`useSaid(text, tellFirst)`). An action's refusal shows in its own run's or the list's block. Four new tests, each seen failing first.

**C (I4).** `RUN_BUTTONS.remove` and `LIST_BUTTONS.remove`, both `Remove from this list` (shared test updated, seen failing first). A finished run with nothing left, and "nothing new to download", gets that one button, which calls discard; focus goes to the heading. An idle list with total > 0 gets that one button, which sends `listAction("stop")` without `LIST_STOPPED_TEXT`; focus goes to the heading. Tests: run remove, nothing-new remove, list remove (all failed first). "paused list Stop says the stopped sentence" pins behaviour that already existed, so it passed from the start.

**D (M1, M4, M8).**
- Five "two presses in one tick" tests (run action, Discard, run Remove, list action, list Remove). They passed with the guard; with the guard removed, all five failed.
- Titles are found with their quotes, and if not found the whole sentence goes through UserText. Test with the titles `of` and `Downloading`, seen failing first. The not-found case cannot be reached through `runLines` or `transcriptionLines` (they always quote), so it has no test.
- "Show them" reads with `readWithin(FIRST_READ_TIMEOUT_MS)`. The read is cancelled when the block closes, the project changes or the lines unmount. No heading is shown until the list or a failure arrives. A failure shows the no-answer sentence as the screens say it (`err.message`), otherwise `errorText(err, "The list could not be read.")`, which is an existing sentence. A `Try again` button reads again. Three tests, seen failing first. The sentence "The list could not be read. Try again." from the first round is gone.

**Researcher-visible words:** new: `Remove from this list` (C1, as ruled). Otherwise only existing words: `Try again`, "The list could not be read.", the no-answer sentences.

**Existing tests changed** (all in this task's own files except background.test.ts):
- WorkLines.test: "nothing to show…" (now follows the stream; renamed "…(the stream is followed all the same)") and "404 shows nothing" (the stream opens, 4 asks). Both changed because the loop runs from mount (A1).
- WorkLines.test: "answers after the project changed…" now counts 2 reads per mount and checks that both are cancelled.
- WorkLines.test: "a run that completed everything says so and has no button" became "…offers only Remove from this list…" (C2).
- WorkLines.test: every button lookup is now scoped to its line with the full name (B1).
- Library.test and Capture.test "the work lines are shown…": the button's full name (B1).
- Capture.test: the profile test is now the screen-stream test (the key re-mount is gone).
- shared background.test.ts: RUN_BUTTONS and LIST_BUTTONS now include `remove`.

**NEEDS A RULING**
1. A5 conflicts with "focus goes to the heading" after a Discard or Remove that leaves nothing on screen. Built: the section stays while focus is on its heading and disappears when focus leaves it (heading `onBlur`). So focus is never dropped to the page body, and no empty section stays (M6). Alternatives: move focus elsewhere (for example the screen's main heading), or keep the section until the next change. I recommend keeping what is built.

**Runs**
- WorkLines.test 49/49, and 15/15 under four busy loops (killed after)
- Library.test 51/51; Library.firstReads 18/18; Capture.test 67/67; Capture.firstReads 15/15
- shared background.test 27/27
- typecheck @ao/shared and @ao/ui clean; lint:css clean; lint:colours ok
- UI build ✓
- e2e Chromium: capture.spec 4 passed, library.spec 6 passed (no scenario changed)

## Last fix (R681)

Commit 3fbfb33 on `wc-6-lines`. Not pushed. `git status --short` is empty. The open point about focus is ruled AS BUILT.

- **S1.** The event feed now calls each subscriber in its own try/catch (`each()` in `WorkLines.tsx`), so a subscriber that throws no longer breaks the screen's stream loop or skips the subscribers after it. The error is dropped, because the components have no pattern for reporting errors in development.
  - New test: "a subscriber that throws does not stop the ones after it…" (`renderHook(useEventFeed)`). It failed first: the throw reached the caller.
- **S2.** The heading's `onBlur` now clears the hold only when `document.hasFocus()` is true, i.e. when focus moved within the page. When the whole window loses focus, the empty section and its heading stay.
  - New test: "after a Remove of the last line, the window losing focus keeps the heading; …". It failed first: the heading was gone.
  - Changed test: "after a Discard here, once focus leaves the heading, nothing is left on screen (M6)". It now stubs `document.hasFocus()` to true, because jsdom returns false there.
- **Runs:**
  - `WorkLines.test.tsx`: 51/51, and 15/15 under four busy loops (killed afterwards).
  - `Library.test.tsx`: 51/51.
  - `Capture.test.tsx`: 67/67.
  - `typecheck @ao/ui`: clean.
