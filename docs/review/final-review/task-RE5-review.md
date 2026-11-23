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

## Second look (R464, R466)

Worktree `.claude/worktrees/re-5b`, branch `re-5b-service`, a307e02..d4396fc (10 commits; no commit was added while I looked). Rulings read: R464, R466 and R480 (c, d). The machine restarted part-way through. I re-ran what was needed with nothing else running. All probes are deleted and `git status --short` is empty.

**Verdict for this round: APPROVE WITH SMALL POINTS.** There are no Critical or Important findings. R464 (a)–(c) and R466 I1, M1–M6 are built, and each holds against probes. Three Minor points are below.

### What I ran
- The implementer's tests:
  - `transcript-store.test.ts`: 6 passed.
  - `capture-queues.test.ts -t lock`: 19 passed, including the two FR-370/371 tests.
  - `Capture.test.tsx -t "lock cut"`: 4 passed.
  - `transcription-jobs.test.ts -t "R466|FR-385"`: 5 passed.
  - `server.test.ts -t FR-329`: 2 passed.
- Probe `transcript-store.probeRE5.test.ts`:
  - a crash at `between-audit` and at `torn-audit`;
  - two transcripts of one source in a row.
- Probe `transcription.probeRE5.test.ts`:
  - Q1: three moves in a row while a run goes on (this is my old P1, extended);
  - Q2: a move that the move itself refuses at its plan (the destination is not empty);
  - Q3: a close, then a reopen whose re-run is itself moved.
- Probe `ExtensionPairing.probeRE5.test.tsx`:
  - V1: the service starts saving between the last poll and the code's expiry;
  - V2: the screen is left while the code is being saved.

### Findings

**Minor**
- **S1 — FR-335: the screen still says "expired" in the last poll interval of a code.**
  - Where: `packages/ui/src/screens/ExtensionPairing.tsx:223-228`. When the countdown reaches 0, it clears the code as "expired" without asking the service.
  - The gap: the screen only learns that the code is being saved (`confirming`) from its next status poll, every 3 s by default.
  - Probe V1: a 28 s code, with polls every 5 s; the service turns `confirming` at 26 s. At 29 s the alert reads "The code expired and was removed from this page. Show a new code to pair."
  - After that the pairing is saved but the screen does not learn it: the poll has stopped, and there is no result.
  - The window is small (the last few seconds of a 5-minute code), but it breaks "never expired while saving".
  - Direction: at 0, ask the service for the code's status once before saying "expired".
- **S2 — FR-385 / R466 M1: a move refused at its own plan still stops the transcription, and the run then starts again from the beginning.**
  - Probe Q2: a destination that is not empty. `executeMove` refuses it with "The library cannot be moved there." after `quiesce` has stopped the run. The worker shows `w1` cancelled, then `w2` started from scratch; the result is still stored once.
  - R466 M1 says the stop happens when the move "actually begins (its plan accepted and confirmed)". The plan checks inside `executeMove` (destination, residency, read-only library, pending changes) run after the stop.
  - This is rare in practice: the move screen's plan step catches most of these refusals first.
  - Direction: run `executeMove`'s plan checks before the transcriptions are stopped, or accept this case as built.
- **S3 — a race left in `worker-client.ts:415-418`: two re-runs of the same pending job at once.**
  - What happens: both pass the `claimed.has` check before their own `prepare` finishes. The second then gets `ALREADY_RUNNING` from `run`, which counts as "claimed". `tell(extras, {claimed:true, error})` then marks the screen's entry for that job (the second `track` replaced the first) as **failed** while the first run is still going.
  - The implementer found this and removed the trigger it found (the carried-on re-run, `state.ts:1596-1600`). The root cause stays.
  - None of my probes reached it again (Q1, Q3: one uncancelled run each time, stored once). I could not prove that no other overlap of two `resumeWorkerJobs` calls exists. For example, a move refused at the second drain both restarts the stopped work and calls `resumeStoppedTranscriptions`.
  - Direction: in `resumePending`, treat `ALREADY_RUNNING` like `NotClaimed`.

### Checked and sound
- **FR-393 — one governed change for both files.**
  - One `store` entry with `files: [{asset, ext}]` (ids and extensions only), `changes: 2`, and its entity is the first asset. The chain verifies.
  - The one-file entry is unchanged: `auditDetails` is added only when there are 2 or more inputs. The one-file callers (`link-capture.ts:596`, `profile-capture.ts:842`, `transcript-segments.ts:415`, and the proxy and OCR completions `repo.ts:1027,1063`) go through the same body with one input.
  - Names: each name is added to `taken` within the change. A second transcript gets ` (2)` on both files, giving 4 versions.
  - A crash at `between-audit` does not occur, because there is one audit event: the store completes and verifies. `torn-audit` leaves neither file. The implementer's tests cover a lock at 16 points, a failed second copy, and crashes at `before-changes`, `before-audit` and `before-marker-delete`. All of these use encrypted projects.
  - A policy refusal is the same single policy request as before (`storeRequest`), evaluated before anything is copied; judged by reading.
- **FR-370/371 — the count of links a lock cut.**
  - It is counted from the queue's counters only (`total - done`, the in-flight link included, as R480 c accepted), and only for a lock. A queue already ended is not counted twice. It is kept per project and in memory only.
  - No address is added anywhere: the count's record is a number, and the end event carries a fixed text. The implementer's test searches the record, the list, the events and the logs, after the lock and again after the in-flight download returns. The in-flight download still holds its own address until it returns; that was already so before and is said in the report.
  - The read and the acknowledgement both answer 423 while the project is locked. The acknowledgement is not open to the extension (403) and is safe to call twice (a second call deletes nothing and answers 200).
  - A second lock before "Got it" adds to the count. That is right: both sets of links are lost. When the wording is redone under R480 c, note that "A lock" then covers two locks.
  - A restart of the service loses the count without saying so, as R464 b rules ("until acknowledged or the app is closed").
  - The screen: the sentence is built in `Capture.tsx:88-92` (to be reworded under R480 c). Its status region is always mounted. "Got it" sends one request (a guard against a double click), then moves focus to the links field. A failure is said in a `role="alert"`, and the reminder stays.
- **FR-335 (apart from S1):**
  - once a poll sees `confirming`, the countdown and "Valid for" stop;
  - at 60 s the slow sentence appears and the list is read exactly once, and again when the status changes;
  - a later failure (`not-saved`) clears the status and gives the alert; a later `used` clears it too;
  - the status region is always mounted;
  - leaving the screen leaves no timers and makes no reads (V2: 0 reads, 0 timers).
- **R466 I1:** every running transcription is stopped by a move, whatever started it. In Q1, three moves in a row all go through; the run is carried on each time, and in the end one uncancelled run is stored once (2 files), with no false "done". In Q3 a re-run after a close and reopen is stopped by the move and carried on.
- **The re-run race fix (R466 I1):** a re-run that was abandoned part-way gives no continuation, and a pending job is still never left without a re-run:
  - after a move that goes through, `adopt` → `attachWorker` re-runs everything;
  - after a move that fails at the copy, `activate` → `attachWorker` re-runs it;
  - after a move refused at the second drain, `resumeStoppedTranscriptions` re-runs it;
  - after a close, the next open's `attachWorker` re-runs it, or `ensureWorker` once the media helper is back;
  - an encrypted project's job waits for that project's unlock, as before.
- **R466 M1:** a move refused at the first drain or at the imports does not stop the transcription (test: one run, stored once). The case the plan refuses is S2.
- **R466 M2:** the comment at `transcriptions.ts:5-14` is true in each case it names: probes P6 and P9 of the first review, Q2 above, and the failed-copy test. R480 d accepts the split-move case as a comment only.
- **R466 M3:** a successful read turns "unread" into "missing", which then hides once the list holds the browser. Two tests, both failing first; this closes my U1.
- **R466 M4:**
  - `/tools/*` get their own true sentence. `PUT /find/screen` gets the device sentence.
  - The three routes that write nothing go through during a move. They are `your-library/derive` and `your-library/test` (both only read settings and work out an address), and `search-sources/.../test` (a fresh lookup client whose requests stay in memory; its folder is never created).
  - Because they skip the change gate, they are not counted as changes in flight either, which is harmless.
  - Left as before: `POST /cite` and `POST /export/refman` without `outputPath` are reads of the library and still get the move's sentence, which is true of them.
- **R466 M5:** the extension's sentence now names what to do next ("Open the PDF in a tab again and press “Send this tab's PDF” again, or download the PDF and add it to the record in the app."). It is true for each path that gives it.
- **R466 M6:** GET answers `running` through `jobRunningHere`. The run is taken back into the registry at its next progress, but only while its project is unlocked and in the same library, so nothing is held while it is locked. The test failed first.
- **What I approved before still holds:** move during the store write, the encrypted move, the split move, the failed copy, and the pairing and extension items. FR-386 and FR-392 are untouched apart from M6.

### Could only judge by reading
- That each guard's test fails without it (from the implementer's report and the code).
- How quickly the real media helper stops a job when cancelled.
- Screen readers announcing the two new status regions.
- Whether any overlap of two re-runs other than the one removed is still reachable (S3).
