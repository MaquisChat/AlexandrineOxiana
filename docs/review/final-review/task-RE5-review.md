# Review — batch RE-5 (the service: pairing, capture queue, transcription runs; the extension's wording)

Worktree `.claude/worktrees/re-5-service`, branch `re-5-service`, 567d98d..a307e02 (5 commits). Reviewer: fresh, adversarial. I did not review FR-335, FR-370/371 or FR-393, which were sent back (R464).

**Verdict: APPROVE WITH SMALL POINTS, with one Important point on FR-385 that the coordinator should rule on before merging.** FR-385 is closed only for a transcription started in this run of the service. A transcription that is itself being re-run still blocks a move and gets it refused after 60 s. That includes the run the first move carried on, so a second move hits it. There are no Critical findings. Nothing is written to the old copy after the copy starts. No probe showed a false "done", two runs or two versions.

## What I ran (each at `nice -n 10`, probes alone, all deleted; `git status --short` is empty)
- I re-ran the batch's own tests: `transcription-jobs.test.ts -t "R1-3|FR-385|N-5|M7"`, 6 passed.
- Service probe `src/transcription.probeRE5.test.ts`. It uses the real WorkerClient over a stand-in HTTP worker, as the batch's tests do.
  - P1: a second move while the carried-on run is going.
  - P3: a move that fails at the copy.
  - P5: the events the screen sees across a move.
  - P6: a split move that leaves the transcribing project behind.
  - P8: a move that starts between the transcript's two store writes.
  - P9: an encrypted project.
  - P10: FR-392, a lock and an unlock while the run goes on.
- UI probe `ExtensionPairing.probeRE5.test.tsx` (U1): the "could not be read" warning after a later successful read.

## Findings

### Important

**I1 — FR-385 is only partly closed: a transcription running as a re-run is not stopped by a move, so the move waits for it and is refused.** The change is at `apps/library-service/src/state.ts:1052`.
- **What happens.** `quiesce` interrupts only work of kind `transcription`. Every re-run of a pending transcription runs as `worker-resume` (`state.ts:1540-1555`). That covers the run a move carries on, a run re-run after an unlock or a launch, a run restarted when the media helper comes back, and the run `resumeStoppedTranscriptions` starts again after a refused move. A move therefore still waits `suspendTimeoutMs` for any of these and is then refused.
- **Probe P1.** A move during a transcription goes through and the run carries on as `worker-resume`. A second move then answers `409 "Some background work could not be paused in time, so the library was not moved; try again in a moment."` after the whole timeout (1,539 ms with `suspendTimeoutMs: 1500`; 60 s by default). The run goes on (`w2` not cancelled).
- **Why it matters.** This is the entry's rough edge, still met:
  - on the very run FR-385 carries on;
  - after a refused move, because the sentence says "try again in a moment" and the retry is refused by the transcription the first attempt restarted;
  - after any unlock or relaunch.
- **What the report says.** The report gives this as a deliberate narrowing to keep "a move started while the rerun is writing waits for it" (`server.test.ts:3179`). That test is about a write already in progress. The interrupt never cuts a write: `finish` and the `done` line are inside the worker client's guarded `write` (`worker-client.ts:556-575`), and probe P8 shows the move waiting for it.
- **Direction.** Interrupt a `worker-resume` whose job in hand is a transcription; the journal claim already keeps a re-run to one run. Or, if the owner accepts the narrower scope, say so in the entry and in the comment at `transcriptions.ts:5-9`, which now claims "A move stops it at once" for every transcription.

### Minor
- **M1 — FR-385: a refused move now costs the transcription its progress.** In `quiesce` the interrupt (`state.ts:1052`) happens before the move knows whether other work will pause. When the move is then refused (an import or other work does not pause), the run starts again from 0. Before the change, the run carried on. The batch's own second test shows this (`worker.runs.length === 2`). An hour-long recording at 90 % is redone because of an unrelated refusal. Direction: accept and note it, or interrupt only once the rest has drained.
- **M2 — FR-385: the comment and the report say the run "runs again once the library is open at its new place". That is not true in two cases.**
  - Split move (P6). When the transcribing project is excluded, the run is stopped and stays pending in the old folder, which is now a separate library. In the library that stays open, its project answers 404, and the last event the screen got was "queued, waiting". It runs only when the left-behind library is opened.
  - Encrypted project (P9). After the move the project is locked. The run waits for the unlock, then completes once (2 runs at the worker, 1 of them cancelled; 2 files). This is right, but not what the text says.
  
  Direction: correct the comment (`transcriptions.ts:5-9`, `state.ts:1048-1051`) and the report.
- **M3 — FR-337: the new "could not be read" warning does not go away when a later read shows the browser.** At `packages/ui/src/screens/ExtensionPairing.tsx:552-555`, the `"missing"` warning hides once the list holds the paired browser (`:547`). The `"unread"` one has no such condition. Probe U1: every read fails after the use, so the warning shows. Then a revoke of another browser reads the list successfully, and the list now shows the paired `moz-extension://…` entry. The alert still says "…so the browser just paired is not shown." Direction: give it the same condition as `"missing"`. Also re-evaluate after any successful read, so that a later read that succeeds without the browser says "not in the list" instead.
- **M4 — FR-329: some device-only routes are still refused with the move's sentence, and one route gets the new sentence although it changes nothing.**
  - The new sentence goes only to `/settings/*`, `/secrets/*` and `/extension/*` (`apps/library-service/src/server.ts:303`).
  - `PUT /find/screen` ("remembered on this computer", `routes/find.ts:524`) and `/tools/*` (installing or updating the optional tools on this computer, `routes/tools.ts:154,181`, `routes/capture.ts:305`) still get "The library is being moved…".
  - `POST /settings/your-library/derive` (`routes/your-library.ts:188`) only works out an address from a link and writes nothing, yet now gets the new sentence. That sentence is true but beside the point.
  - The new sentence is true for every route that gets it, including the popup's `/extension/pair/confirm`. The extension shows the service's own words for a 503 (`api.ts:196`).
  
  Direction: add `/find/screen` and `/tools/` to the device-only set, or list the routes by name.
- **M5 — FR-584: the new sentence names no next step.** `apps/browser-extension/src/find.ts:69` explains why ("did not let it in here in time, or the tab was closed or changed page meanwhile") but not what to do. The README adds "open the PDF again and press again" and "download the PDF instead"; the popup shows only the sentence. "Let it in here in time" also reads awkwardly when the refusal is immediate (Firefox's own PDF viewer). Direction: end with what to do, e.g. "Open the PDF in the tab again and press again, or download it and add it to the record in the app."
- **M6 — FR-392 (as the implementer noted).** P10 confirms the run is not lost. A run still going after a lock and an unlock ends `done`, with one worker run and 2 files, and does not wait for another unlock. While it goes on, GET reads it as "waiting" and the jobs indicator does not follow it.

## Checked and sound
- **FR-385 — the move's other paths.**
  - Normal move (batch test, P5). The run is stopped, the move goes through, and the run is carried on: one uncancelled run, 2 files. The events the screen sees are `queued running queued(waiting, finished) queued running … done`: never "done" before the transcript is stored, and never two runs.
  - Move refused at quiesce (batch test). The run starts again in the library still open.
  - Move that fails at the copy or plan (P3, `beforeExecuteMove` throws). `activate` → `attachWorker` re-runs it at once: the same event sequence, done, 2 files. The plan's own refusals are inside `executeMove` and take the same `catch` path.
  - A move that starts between the two store writes (P8). The guarded write finishes before `drainWork` lets the move go on. Result: one run, done, 2 files, and the move succeeds. No write lands in the old copy after the copy begins: everything the run writes is inside `drainWork`'s wait, and an interrupted run writes no final journal line.
  - Stopping. The run is stopped at the next poll (200 ms) plus the worker's confirmation. The real media worker kills the child process group and reports `cancelled` (`jobs.py:cancel`, `cancel_after_return`); I judged this by reading.
  - Memory. The interrupted run's entry is deleted at the interrupt, and `closeLibrary` (old session) calls `transcriptions.forget`. `resumeStoppedTranscriptions` does nothing if the library changed meanwhile (`this.session === s && !this.moving`).
  - Crash. The pending "running" record is copied. The old copy opens read-only (`MOVED.json`), and the destination opens read-only while the move journal exists, so nothing re-runs in the wrong place.
  - Locks during a move. A lock is a change, so it is refused with 503 during a move. An encrypted project locked during the move therefore cannot happen through the routes.
- **FR-385's tests** fail without the guard: the first returns 409 without the interrupt, and the implementer showed both failing first. Judged by reading. They wait for real states, with no sleeps.
- **FR-329.** The test pins the new sentence for all three prefixes. Behaviour is unchanged (still 503, as R102 N2 requires). No other sentence changed.
- **FR-338.** A revoke clears the warning only for the used browser, and the warning also hides once the list holds that browser. The test fails on the old unconditional `setPairedMissing(false)`; judged by reading.
- **FR-337.** The main case (every read fails after a use) now gives the new sentence and does not suggest pairing again. Its test fails first.
- **FR-342.** The wording in `docs/owner-checklist.md` 10.12 and 10.15 matches the code:
  - the message is `Captured: saved to your library.` followed by any notes (`background.ts:136-153`);
  - the box is remembered (`Popup.tsx:45-127`), and D18 is gone;
  - removing "untick" at 10.15 is right, because unticking a box that is already not ticked would tick it.
- **FR-588.** Every case that gives the sentence is covered by it: a page answered the second time, the mark not at byte 0, a file under 5 bytes. The old sentence does not appear in the code, the README or the e2e spec; only the historical plan still has it. There is a new test for the byte-0 case.
- **FR-584.** The new sentence is true for each path that gives it: `tabs.get` failing or timing out, an empty address, the injection failing or taking more than 15 s, the port or its first word timing out.
- **FR-244** is closed. The popup sends the researcher to "Browser extension" → "Show a pairing code" (`Popup.tsx:395`, `api.ts:65,197-200`), and the screen quotes the popup's field names and its refusal (`ExtensionPairing.tsx:447-450,494`).
- **FR-386** is closed. The R1-3 test passes at this head.
- **FR-392** is closed as stated (P10).

## Table

| FR | Implementer's claim | Verdict | Note |
|---|---|---|---|
| FR-244 | already closed | holds | popup and screen words match |
| FR-329 | fixed | partly | M4: `/find/screen` and `/tools/*` keep the old sentence; derive gets the new one |
| FR-337 | fixed | holds, with M3 | the "unread" warning stays after a read that shows the browser |
| FR-338 | fixed | holds | — |
| FR-342 | fixed | holds | — |
| FR-385 | fixed (the larger version) | partly | I1: re-runs, including the carried-on run, still block a second move. M1: a refused move costs the run's progress. M2: split and encrypted cases |
| FR-386 | already closed | holds | R1-3 test passes |
| FR-392 | closed as stated | holds | M6: viewer and indicator while it runs |
| FR-584 | fixed | holds, with M5 | no next step in the sentence |
| FR-588 | fixed | holds | — |

## Could only judge by reading
- That each new test fails without its guard. I did not edit tracked files; the code paths make it clear.
- How fast the real faster-whisper worker answers a cancel. A slow cancel makes the move wait, up to `suspendTimeoutMs`, and then refuses it; the run then starts again.
- The extension's sentences in a real browser. The e2e spec was not run.
- That a crash during the switch never re-runs the job in the old copy (it is read-only: `move.ts` header, `MOVED.json`).
