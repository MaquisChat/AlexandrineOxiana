# Round RE-5c report — R486 A (a)–(d)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-5b`, branch `re-5b-service`, from d4396fc. Not pushed. `git status --short` is empty.

Commits, oldest first:
- f2daf0a fix(ui): the capture screen's lock reminder says the links were stopped from being captured (R480 c) — point (d)
- ada99e4 fix(ui): at a code's expiry the pairing screen asks the service once before it says 'expired' (FR-335, R486 a) — point (a)
- 3e85e75 fix(service): a move refused at its own plan leaves a running transcription untouched (R466 M1, R486 b) — point (b)
- f30e770 fix(library): a rerun that finds the job already running here leaves it to that run (R486 c) — point (c)

## (a) S1, FR-335: the screen asks the service once before it says "expired"

**What changed:** all in `packages/ui/src/screens/ExtensionPairing.tsx`.
- `shownCodeId` ref (:143). It is set when a code is shown (:455) and cleared in `clearCode` (:208).
- New `askAtExpiry(codeId)` (:225–259). It sends ONE `codeStatus` request, then:
  - `confirming`: sets "saving", exactly as the status poll does (R464 a). The countdown stops. The code stays shown, so the poll goes on and follows the pairing to `used`, `not-saved` or "taking long".
  - `used`: `clearCode(used)`. The existing list read after a use follows.
  - `invalidated`, `replaced`, `none`: said as the poll says them.
  - `active`, `expired`, a failed read, or an answer in the wrong shape: "expired", as today. A failed read keeps today's behaviour at the expiry: the screen says "expired". There is no other sentence for an unreadable status at that point, and no new sentence was added.
  - An answer about a code that has already left the page is dropped.
- The countdown effect (:262–297): at 0 it sets the clock to 0:00, stops the interval and calls `askAtExpiry` once. An `asked` flag means the page's "look again" events (`focus`, `visibilitychange`) start no second request.

**Tests** (`ExtensionPairing.test.tsx`), new block "at its expiry the screen asks the service once before it says 'expired' (FR-335, S1, R486 a)" (:789). Each new test failed first with "expected [] / 5 reads … to have a length of 1 / 6".
1. The reviewer's V1, built exactly: a 28 s code, a status read every 5 s, the service `confirming` from 26 s. At 29 s:
   - 6 reads (the 5 polls plus the one at the expiry);
   - no alert, and "expired" appears nowhere;
   - the status reads "The right code was typed. The pairing is being saved…";
   - the code is still shown and there is no "Valid for".
   - After that, `pairWith` gives "Pairing result" with the browser, and the list is read.
2. The pairing is saved (`used`) between the last read and the expiry: "used" is said at the expiry, the list is read, and there is no alert.
3. Not used at the expiry, with a status answer slowed to 500 ms and `focus` and `visibilitychange` fired while it is under way:
   - exactly 1 status read;
   - the alert reads exactly "The code expired and was removed from this page. Show a new code to pair.";
   - still 1 read 10 s later.
4. A status read that fails at the expiry: 1 read, the same "expired" alert, no more reads.

**Changed test:** "a sleeping machine or background tab: on return the expired code is removed at once" (item 4). It asserted synchronously after the event. It now waits one tick for the one status read and asserts that exactly 1 read was made. The outcome is the same.

## (b) S2, R466 M1: nothing is stopped until the move's plan is accepted

**The order of the steps, as built:**
1. The route sets `moving` (:268). From then on every change is refused, and `resumeWorkerJobs` and `attachWorker` start nothing.
2. The route waits for in-flight changes.
3. `quiesce` runs. It drains all other work, suspends imports, and stops watches, queues, backups and find. It **no longer** stops transcriptions: the interrupt and the second drain were removed from `state.ts` :1076–1120.
4. `executeMove` runs.
   - It plans: destination, residency rules, projects, walk.
   - It checks unknown excluded ids and policy denials, auditing a denial as before.
   - Then it calls the new `onPlanAccepted` (`packages/library/src/move.ts` :178 option, :569 call; also :534 before finishing an interrupted switch).
   - Then the second `preflight` runs (interrupted changes, destination), and then the copy.
5. The route's `onPlanAccepted` (`routes/libraries.ts` :305–312) calls `state.stopTranscriptionsForMove(s)` (`state.ts` :1125–1141). This is the old interrupt-and-drain-all, moved: it interrupts every transcribing work item and then waits for ALL registered work. On a time-out it calls `resumeStoppedTranscriptions` and throws the same 409 sentence. The route's existing failure path then runs `activate`, `resumeBatches` and `restartStoppedWork`, and writes the error line.

**Other changes in this commit:**
- With the hook given, the plan's own check for interrupted changes is left to the second `preflight`, which runs after the stop (`planFor(…, checkPending)`, :471–476; `preflight(…, checkPending = true)`, :326–330). A transcription's store step still being written during the plan is therefore never taken for an interrupted change. `planMove` (exported) is unchanged in signature and behaviour.
- The quiesce-refusal branch of the route no longer calls `resumeStoppedTranscriptions`: nothing was stopped there.
- New test seam `afterMoveStop` (`server.ts` :74, :338, :402). It runs after the stop, before the copy.

**How the window stays closed:** no new work can start between the plan's check and the stop:
- `moving` is set before the plan and held to the end, so every change request (a new transcription included) gets 503, and every rerun entry point returns.
- `quiesce` has drained every other registered work item before the plan.
- The hook runs in the same `executeMove` call, right after the plan is accepted, and before anything is copied or written or the interrupted-changes check runs. The only step between them is the denial audit, and that runs only on a refusal.
- The hook's drain waits for ALL registered work, not only transcriptions. A rerun that went on to its next job during the plan is therefore also waited for before the copy.

**Tests** (`apps/library-service/src/transcription-jobs.test.ts`):
- New test "R466 M1 (R486 b): a move refused at its own plan (a destination that is not empty) does not stop the transcription: one run, stored once" (:615). It failed first with "expected true to be false" (`cancelled`). It now checks:
  - the answer contains `"code":"POLICY_DENIED"` and "The library cannot be moved there.", and no `"done":true`;
  - `runs[0].cancelled === false`, and 1 run;
  - status `done`, and 2 versions (one store).
- Changed test "FR-385 (R466 M1): a move that fails after it stopped the transcription …". `beforeExecuteMove` now runs BEFORE the stop, so it no longer exercises "after the stop". The test now throws from the new `afterMoveStop` seam. Its assertions are unchanged.

## (c) S3: "already running" is not a failure

**What changed:** `packages/library/src/worker-client.ts`, `resumePending`'s catch (:416–424). A `WorkerJobError` with code `ALREADY_RUNNING` from `run()` is the claim check `claimed.has(id)`: another rerun of this process holds the job. It is now treated like `NotClaimed`:
- `onEnd({ claimed: false })`, with no error;
- it is not reported in the returned list;
- nothing is written to the journal (`run()` throws before `runClaimed`).

`onEnd`'s doc comment is updated (:110). In the service, `Transcriptions.rerun`'s `onEnd` with `claimed:false` only drops its own registry entry. The holding run goes on:
- its progress and its end are still published;
- GET answers `running` through `jobRunningHere`;
- the journal reaches `done`.

**Test:** `packages/library/src/transcription-jobs.test.ts` :100, "S3 (R486 c): two reruns of one pending job at once …". It failed first: the second `onEnd` had `claimed: true` with `WorkerJobError ALREADY_RUNNING`. The test sets up a pending transcription (the worker was down). Two `resumePending` calls start together, each `prepare` waiting until both have entered it, so both have passed the `claimed.has` check. It then checks:
- one `onEnd` `{claimed:true}` and one `{claimed:false}`, with no error;
- the combined out list holds only the job's result;
- the worker submitted once;
- the journal reads `["done"]`, with 2 versions;
- no unhandled rejection (Vitest would fail the run).

## (d) R480 c: the reworded sentences

**What changed:** `packages/ui/src/screens/Capture.tsx` :88–92 (`cutByLockText`; its comment now says the link in flight at the lock is counted, R480 c). The sentences, word for word:
- "A lock stopped N links in this project from being captured. The links were not kept while the project was locked: add them again to capture them."
- "A lock stopped 1 link in this project from being captured. The link was not kept while the project was locked: add it again to capture it."

**Tests:** `Capture.test.tsx` :872–873, the two constants of "Capture screen — what a lock cut", were changed to the new words. Three tests failed first; all 65 pass after the change. `grep -rn "before they were tried\|before it was tried\|stopped the capture of" packages apps e2e` now finds nothing.

## Uncertain / for the coordinator
- **(a), a failed read at the expiry:** I read the brief's parenthesis as "keep today's behaviour at the expiry", which is "expired". The only "cannot be read" sentence is the 4xx one ("…The code stays here until it expires…"), and it does not fit after the expiry. If the coordinator meant that sentence, it is a one-line change.
- **(b), two side effects:**
  - The plan inside `executeMove` now runs while a transcription may still be going. Its walk could in principle meet a temporary file that vanishes, and fail that move with an error. The screen's plan route already plans a live library the same way.
  - When the stop times out, the 409 now arrives as the stream's error line (after the "plan" progress line), not as a 409 status before the stream. The sentence is the same. Before this change that refusal came from `quiesce`, before the stream.
- **(b), an API addition:** `MoveOptions.onPlanAccepted` is a new optional field on an exported interface of `@ao/library`. No exported function's signature changed.
- **(c):** I found no other path that turns `ALREADY_RUNNING` into a failure for a rerun. On a first submission (`submit`, chosen id), `ALREADY_RUNNING` still means a duplicate id and stays an error.

## Runs (each at `nice -n 10`, single files only)
- `@ao/library`: `transcription-jobs.test.ts`, `worker-client.test.ts`, `move.test.ts`: 3 files passed, 114 passed | 2 skipped.
- `@ao/library-service`: `transcription-jobs.test.ts`: 26 passed. Also `server.test.ts` and `find-routes.test.ts` with `-t "move|Move"` (the move route changed): 40 passed | 153 skipped.
- `@ao/ui`: `ExtensionPairing.test.tsx` and `Capture.test.tsx`: 131 passed (66 + 65).
- Typecheck: `@ao/library`, `@ao/library-service` and `@ao/ui` each exited 0.
- No time-limit failures were seen.
