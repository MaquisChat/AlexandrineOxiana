# Task WC6 review: the work lines on the Library and Capture screens

Worktree `.claude/worktrees/kg-7`, branch `wc-6-lines`, range 5e6151e..45b6aa7 (one commit). Reviewed read-and-probe; every probe was removed and every mutation restored. `git status --short` is empty.

## Verdict: NOT READY

The parts that are built are sound: the sentences, the R659 loop, the double press, focus, and stale answers. The defect is the design under point (1). A screen that showed nothing when it opened stays silent while work runs, and a screen that was following can stop following for good. The spec promises "a screen line always says where the work is". With Task 9's "Transcribe everything" built against the plan as it stands, the Library screen would show no line after that button is pressed. This needs a ruling and a rework of the stream. The other findings are small.

## Findings

### Important

**I1. A screen that shows nothing never learns of new work, and a screen that stops showing something stops listening for good** (`WorkLines.tsx:194-199`, `:208-209`, `:331`). Probes P1 and P2 (removed after use) show it:
- P1: mount with no run and an idle list. Then the service gets a run and a running list and publishes `background.progress`. Result: `/events` asked 0 times, no region shown.
- P2: follow an interrupted run, then send a `discarded` event for it, as if another window discarded it. The stream closes (`streams()` goes to 0) and the section disappears. A new run's event then shows nothing, and `/events` is never asked again.

Ways work can start or change while the lines show nothing and nothing re-mounts them:
- **Library, "Transcribe everything" (Task 9).** The plan does not tell Task 9 to re-mount the lines, so the list runs while the screen is silent. This is the flow Task 9 exists for.
- **A run started from another window, by the command line, or as a second channel started on the Capture screen while the Library screen is open.** The Library screen stays silent.
- **The last run discarded, or the list stopped, from another window or the other screen.** The stream closes and never reopens (P2). The same happens when a reconnect read finds nothing.
- **Capture, Task 8.** Task 8 rewrites the start path at `Capture.tsx:779` (`Start` in the estimate). The `setLinesKey` line must move to `Start` when the branches are merged. If it does not, the Capture screen goes silent after every capture. Nothing in Task 8's plan says this.
- **Unlock.** Unlock re-mounts the lines on both screens (`!locked` gate), so this case is covered. The list records exist before `kick`, so the mount read sees `running`.
- **The service restarting under the screen.** Covered only while the lines follow something. Otherwise nothing changes, because nothing listens.

The reverse case: after a Discard pressed on this screen, `keep` stays true until the project changes. The stream then stays open and an empty section with only its heading stays on screen (M6). After a `discarded` event from elsewhere, everything closes (P2).

**The design I would rule: (c), one stream per screen.** Both screens already run their own `/events` consumer: `Library.tsx:356-418` retries every 2 s and never gives up, and `Capture.tsx:607-650` has 2 reconnects and its own notice. Give `WorkLines` one optional prop that carries the screen's stream: a subscription that delivers every event and every (re)open, for example `events?: { subscribe(onEvent: (e: ServiceEvent) => void, onOpen: () => void): () => void }`.
- With the prop, WorkLines opens no stream of its own. It is always subscribed, applies `background.progress` events of its project, and reads both lists again at every open.
- Without the prop, it keeps the loop as built, so the five stream tests keep testing that loop.
- Each screen forwards in about 10 lines, and the `key` re-mount goes away.
- What it costs in existing tests: nothing. The stream counts in `Capture.test.tsx` and `Capture.firstReads.test.tsx` stay at one, because there is still one stream.
- What it costs elsewhere: the pinned props gain one optional field (Tasks 9 and 10 do not consume them). The R659 notice for the lines becomes the screen's: Library never gives up, and Capture shows its own notice. Capture's consumer resets its count at `onOpen`, which is looser than R659. That behaviour is pre-existing and not this task's, but the coordinator should know it.

Option (b), an always-open second stream, costs about 60 Capture tests plus `Capture.firstReads.test.tsx:265,269`, which count streams. It also costs every Library test: the fake `/events` in `libraryHandlers` ends after `library.state`, so the lines would show the R659 notice in each test. And it leaves two streams per screen in production.

**I2. A real read failure is swallowed, and with nothing shown it is never retried** (`WorkLines.tsx:175-186`).
- Only a 404 is handled as "nothing to show". A 500, a network error or a read that does not answer in time (`readWithin`) is also ignored: no sentence, and `following` stays false.
- Probe P3 (removed after use): a 500 on both GETs with a run present gave 2 asks, no region, no alert and no `/events`, ever.
- A 423 cannot reach the lines, because they are unmounted while the project is locked.
- On a reconnect read, a 404 also wipes runs known from events (`setRuns([])`). The client cannot tell an unknown route from an unknown project.
- Smallest fix: a non-404 failure sets a flag that counts as "something to show" for following. The stream then opens and the next open reads again. This needs no new sentence, and it is moot under design (c), which re-reads at every open of the screen's stream.

**I3. Several runs and the transcription list give buttons with the same accessible name** (`WorkLines.tsx:410`, `:427-449`, `:489-509`).
- Probe P4 (removed after use): a downloading run, a queued run and a running list give three buttons named exactly "Stop". The run is only in `aria-describedby`, which is not the name and is not shown in VoiceOver's rotor list of buttons.
- The two Pause buttons and the Discard buttons have the same problem.
- Smallest fix, using no new text: `aria-labelledby={`${buttonId} ${titleId}`}`. The name then reads, for example, "Stop Downloading "Example Channel": 120 of 412". The tests' exact names become `getByRole("button", { name: /^Stop/ })` scoped by line, or similar.

**I4. Point (2): a completed run, and finished transcriptions, stay on screen for good** (`WorkLines.tsx:402`, `:424`, `:497`).
- Probe P5 (removed after use): `"Example Channel": all 412 downloaded.` and `Transcriptions finished: all 3 done.` are shown with 0 buttons. The run line goes only when the journal compacts (more than 2 000 lines), which in practice is never. The list line goes only when a new list replaces it.
- Every captured channel adds a permanent line on both screens.
- I agree with the coordinator: a completed run gets one button, "Remove from this list", that calls the same discard route. The code makes that easy. In `RunLine`, replace the `!allDone &&` wrapper with a branch that renders one button calling `onDiscard`. Focus already goes to the heading through `discard()`.
- The label must be added to `@ao/shared` (for example `RUN_BUTTONS.remove`). Task 1 is merged, so this is an addition to its file and needs the coordinator's word.
- Do the same for the idle list with total > 0, and for `"…": nothing new to download.` (already covered by `allDone`).
- For the list there is no discard route. `listAction("stop")` on an idle list empties it (R672, total 0) but must not then say `LIST_STOPPED_TEXT`, which would be false. This needs a ruling on Task 7's routes, or the list line stays as built.

### Minor

- **M1.** The synchronous double-press guard is untested. With mutation 2 (guard removed), all 25 tests still pass, because `disabled` lands between `user.dblClick`'s two clicks. A test should fire two clicks inside one `act` (for example `act(() => { b.click(); b.click(); })`) and assert one request.
- **M2.** `LIST_STOPPED_TEXT` is a `role="status"` inserted together with its text (`:338`). Many screen readers do not announce a live region that arrives already filled, and focus goes to the heading. Keep the status element always rendered and fill it.
- **M3.** The list has no `updatedAt`, so a read can overwrite a newer `transcriptions` event (`:182`, `:243`). For example, a read sent at an open answers after an event and puts the line back one step. After a Stop here, a late open-read can bring the stopped list back (and `setStopped(false)` if its total > 0). It settles at the next event.
- **M4.** `Sentence` (`:74-84`) wraps the first `indexOf(title)`. A title that also occurs in the fixed words ("load", "of", "Download") wraps the wrong span and leaves the real title outside `UserText`. Search for `"${title}"` / `'${title}'` with its quotes, or split where `runLines` puts the title.
- **M5.** A run that first appears through an event is never told to a screen reader (`useSaid` treats its first text as "as read"). Example: the second channel's queued line.
- **M6.** After a Discard here, `keep` is never reset. An empty section with only the heading `Downloads and transcriptions` stays until the project changes, and the stream stays open.
- **M7.** The Capture `key` re-mount (`Capture.tsx:785`) closes an open "Show them", drops a shown error, and opens a second stream when the lines were already following. This goes away under (c).
- **M8.** The "Show them" read has no time limit and no cancel (`:313`). If it hangs, an empty "Could not be downloaded" heading stays.
- **M9.** One action error is shown for the whole section (`:339`). With several runs, "Something changed in the meantime. …" does not say which run it was.
- **M10.** `WorkLines` returns `null` while the pinned signature says `JSX.Element` (TS infers `JSX.Element | null`). No consumer is affected.

## Contract check

- `backgroundApi` has the six methods with the pinned routes and answers. The three GETs take an extra optional `{ signal }`, which is compatible. `backgroundProgress(e, projectId)` matches the pin, and also refuses a run or list naming another project.
- `WorkLinesProps` matches the pin exactly.
- Default handlers were added to `service.ts` and `captureService.ts` (`{ runs: [] }`, idle list).
- `libraryApi` gains `client`, which is additive.
- Every on-screen sentence comes from `@ao/shared`: `runLines`, `transcriptionLines`, `RUN_BUTTONS`, `LIST_BUTTONS`, `LIST_STOPPED_TEXT`, `PROBLEMS_TEXT`, `platformSays`, `problemLine`, `WORK_LINES_TEXT`. The two fallbacks are app-wide existing sentences ("That could not be done. Try again." is used in six screens) or a new one ("The list could not be read. Try again."), shown only when a refusal has no words of its own.
- The buttons per state match the plan's list: queued has Stop only (R669); `Resume downloads` has no count when total is 0. The one exception is I4's completed run. `LIST_STOPPED_TEXT` and focus to the heading after Stop are as R672 says.
- Titles, addresses, reasons and `platformSays` go through `UserText`, with `dir=auto` asserted in the tests. A failed run's `why` goes through `UserText`.
- CSS uses tokens only. `lint:css` and `lint:colours` are clean, and typecheck is clean.

## The stream (R597, R649, R658, R659)

- The opening limit and the silence limit each have a test. Each test keeps its request and reads its `signal.aborted`.
- The count starts again only on a `background.progress` event of this project, or on the client's quiet-limit error after the stream had opened (`:249`).
- "The opening state then an end, repeated, ends in the notice" uses the real service's `library.state` as the only event. It reaches the notice after 3 connections, and Reconnect makes a 4th.
- No assertion relies on a real timer to prove that something has not happened yet: each "not shown" is asserted at a held resting state.
- Under load (four busy loops, killed afterwards): 15 of 15 runs passed (25/25 each).

## Mutations

1. Any event proves the connection (`proved = true` before the project filter): 2 tests failed. These were "the opening state then an end, repeated, ends in the notice" and "another project's background.progress then a drop ends in the notice". Caught.
2. Synchronous double-press guard removed: all 25 passed. Not caught (M1).
3. No focus to the heading after Discard: "Discard removes the run and focus goes to the heading" failed. Caught.

## What it does to the screens

Each file was run on its own:
- `Library.test.tsx`: 50/50
- `Capture.test.tsx`: 67/67
- `Capture.firstReads.test.tsx`: 15/15
- `Library.firstReads.test.tsx`: 18/18

No existing test was changed. The lines are outside `PageReads`, so the screens' first-read and focus rules are untouched.

## What I could not check

- Against the real Task 5 and Task 7 routes: they do not exist yet, and today the real service answers 404.
- Whether the unlock route has written the running list before the Library's mount read lands.
- VoiceOver on a real Mac: how `aria-describedby`, the 5-second hidden status, and an already-filled status are read.
- WebKit: I ran no end-to-end run. The implementer reports Chromium only.
