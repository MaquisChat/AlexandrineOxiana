# Task WC4 report: download runs and the estimate (library)

Worktree `.claude/worktrees/kg-3b`, branch `wc-4-runs`, one commit: **a57650f** `feat(library): download runs written to the job journal, with the disk floor, the gap and the estimate`.

## What was built (per step)

**Step 1, tests first.** Three new test files. All three failed first because their modules did not exist ("Failed to load url ./estimate.js", and the same for the other two). That is the right reason, but no single assertion was seen failing on its own before the code was written.
- `packages/library/src/capture/download-run.test.ts`: the 18 tests the plan names, under its names (:214–:584), plus four more:
  - `a run that loses its connection for 12 hours ends failed with its reason and offers Resume downloads` (:609, R674's NETWORK_LOST line);
  - `stopNotRunning ends a paused run stopped and leaves a finished one as it is` (:621);
  - `estimate lists once, counts what is new and asks the project's rules first` (:633, R674 PolicyDeniedError, audited, nothing listed).
  The R678 test `a Resume whose listing came back cut short leaves the videos past the cut to do and says why` is at :584. The tests use the stand-in worker and the fake yt-dlp, an injected sleep (every wait: the gap, the slow-down and connection waits) and an injected `freeBytes`. Promises a test holds back are released in `onTestFinished`.
- `estimate.test.ts`: the three tests the plan names.
- `disk.test.ts`: the three tests the plan names, plus `freeBytes reads the free space and is null when it cannot tell`. The 2 s limit is execFile's own `timeout: 2000`, which the test asserts. The injected execFile answers with the kill error, so no real timer is waited on.

**Step 3, the code.**
- `packages/library/src/capture/disk.ts`:
  - `freeBytes` (:10) uses `statfsFree`; `Infinity` becomes null.
  - `diskName` (:29) reads `/Volumes/<name>`. Otherwise, on darwin only, it reads `VolumeName` from `/usr/sbin/diskutil info -plist <dir>`, with `timeout: 2000` and XML entities decoded. Otherwise it gives null.
- `packages/library/src/capture/estimate.ts`: `estimateCapture` (:18). It counts only entries that are not known. `soundSeconds` is the sum of the known lengths; `unknownLengths` is counted, never guessed. `videoToolsInstalled` is null. `speechModel` is `transcribeModel ?? DEFAULT_SPEECH_MODEL`. Listings that did not succeed:
  - `rate-limited` throws `WorkerJobError("RATE_LIMITED")`;
  - `failed` throws `WorkerToolError` when a tool is named, otherwise `WorkerJobError(code)`;
  - `WORKER_UNAVAILABLE` throws `WorkerUnavailableError`, which the service already answers as 503.
- `packages/library/src/capture/download-run.ts`:
  - `DOWNLOAD_GAP_MS` (:62), `RunOptions`, `RunControl` (with `turn`), `DownloadRunsDeps`, `DownloadRuns` and `createDownloadRuns`, exactly as pinned.
  - **The turn**, `awaitTurn` (:217): raced with `requestedSignal` and `signal`. A Stop ends the run `stopped` with nothing asked of the platform. A Pause is ignored. A cancel rejects with `CaptureCancelledError` and nothing more is written.
  - **`segment`** (:247):
    - `onListed` (:290) calls `setRunItems` (skipped on a Resume unless total is 0), then the title, then `downloading`.
    - `beforeItem` (:303) checks `halt`, then requested, then the disk-pause flag, then the gap through `sleep(ms, AbortSignal.any([requestedSignal, signal]))` (none before the first video or after a duplicate), then the floor check with `BYTES_PER_SECOND[quality ?? "720p"].high` (0 for metadata only; an unknown length counts 0; null free space never pauses), then `recordRunItem(running)`.
    - `afterItem` (:322): a failure that leaves less than the floor free puts the item back to `queued` and sets the flag. Otherwise the item is recorded done or failed with `platformReason`. Then come the transcription list and `onQueuedForTranscription`.
    - `wait` (:351) writes `waiting` with `{ms, why}`, sleeps woken by Pause, Stop or cancel, then answers, or writes `downloading` and "go".
    - **The end** (:370): the item in hand goes back to `queued`. A `completed` segment becomes `finished` only when every item is done or failed. If the floor flag is set, it becomes `paused-disk`. Otherwise it becomes `failed` with `errorCode LIST_INCOMPLETE` and the `LIST_INCOMPLETE` reason (R678). The other statuses map one to one, carrying `tool`, `errorCode` and `reason`. Then `onReport`, then `onChange`.
    - Every journal write is followed by `onChange`. Nothing is written once `ctl.cancelled()`.
  - `start` (:413) calls `createRun` (state `queued`, title = the link key, options stored without `onlyIds`/`resume`), then `onChange`, then the segment.
  - `resume` (:422) refuses a finished run with no failure. Otherwise it writes `queued`, then waits the turn, then `downloading`, then `requeueFailedItems`, then `onlyIds` = the items not done, in index order, with `resume: how`. A run with total 0 is resumed as a start, with the decision still the resume's.
  - `list` and `get` mark a queued, downloading or waiting run as `interrupted` when it is not `held`. `notCompleted = total − done`.
  - `problems` (:440) lists failed items in index order, using `downloadProblemText` and the journal item's own `url` and `title`.
  - `stopNotRunning` (:458), `discard`, and `estimate` (:405). `estimate` calls `listProfile`; a deny comes out as `PolicyDeniedError`, already audited by Task 3. Then it calls `freeBytes`/`diskName` on the library root and `estimateCapture`.
- `packages/library/src/capture/errors.ts:69`: new reason `LIST_INCOMPLETE`.
- `packages/library/src/index.ts`: exports `DOWNLOAD_GAP_MS`, `createDownloadRuns`, the types `DownloadRuns`, `DownloadRunsDeps`, `RunControl` and `RunOptions`, and `diskName`, `freeBytes` and `estimateCapture`.

## Researcher-visible sentences, new or changed
- `LIST_INCOMPLETE`: "The platform's list came back incomplete, so some videos could not be looked for." This is exactly the plan's sentence.
- New, mine: `resume` of a finished run with no failure throws `InvalidInputError("Every video of these downloads is already in the project, so there is nothing to resume.")`. The plan names no sentence or error type for this refusal; Task 5 would answer it as 400.
- All other text comes from the existing reasons (`RUN_PAUSED`, `RUN_STOPPED`, `DISK_NEARLY_FULL`, …) and the shared `downloadProblemText`.

## Existing tests changed
None.

## NEEDS A RULING
None blocking. One point for the coordinator to confirm:
- **The run's title once the list is read.** The plan says "title = the listing's title once known, else the link key". At `start` the listing is not known yet, and Task 1's `run-journal.ts` has no way to change the title (`setRunState` keeps it). I did not touch Task 1's file. Instead, `download-run.ts:196` `setRunTitle` writes the run's record again with the title through `updateJobRecords`, in the journal's own turn. It skips a discarded run and keeps any older-build claim fields as they are. So the line shows "@fake.dancer" while it waits its turn and "Fake Dancer" once listed.
  - Option (a): keep it as is.
  - Option (b): move a `setRunTitle` into `run-journal.ts` later.
  - Recommendation: (a) now, (b) when someone next touches run-journal.

## Found in the code that the plan did not expect (one line each)
- A classified link's `handle` keeps its "@", so the link key, and the title before listing, is "@fake.dancer".
- The worker client writes its own `capture.download` records to the same journal, so "nothing more written after a cancel" is asserted on the run's own `capture.run`/`capture.item` lines only.
- `addToTranscriptionList` evaluates the rules on every call. If a deny comes (audited by Task 1's code), the run goes on downloading and does not ask again in that segment. `onQueuedForTranscription` is told only when the source was actually added (a source with no recording is not).
- If `captureProfile` throws something other than a cancel (for example `PolicyDeniedError` at a Resume after the rules changed), nothing more is written. The run stays "downloading" in the journal and shows `interrupted` with "Resume downloads". This is pinned in the resume-after-a-quit test.
- `start` with a link that is not a profile, channel or playlist throws `InvalidInputError` with the existing `UNSUPPORTED_URL` sentence, before anything is written (`CaptureRunData.platform` cannot hold "other").
- The turn listens to `requestedSignal`'s single abort. A Stop asked after a Pause (which the service refuses on a queued run) would only be seen when the turn comes.
- The code matches the plan's Interfaces block; no detail differed.

## Runs (last summary line of each)
- `vitest run src/capture/download-run.test.ts`: Tests 22 passed (22)
- `vitest run src/capture/estimate.test.ts src/capture/disk.test.ts`: Tests 7 passed (7)
- `vitest run src/capture/profile-capture.test.ts`: Tests 64 passed (64)
- `pnpm --filter @ao/library typecheck`: clean (tsc, no output)
- `pnpm --filter @ao/library-service typecheck`: clean (tsc, no output)
- `git status --short`: empty

## Fix round (R680)

Worktree `.claude/worktrees/kg-3b`, branch `wc-4-runs`. There is one commit per group on top of a57650f: A `cfd97c5`, B `316bc72`, C `d22b2bb`, D (see the last line). Every new or changed test was seen failing before its mend unless it is named a guard below.

### A. A Resume never loses what the run knows (I1, Minor 3)
- **A1.** The wholesale `requeueFailedItems` at the start of a Resume is gone (`download-run.ts`, `segment`). `onlyIds` is still the items that are not done. A failed item goes back to work only in `beforeItem` → `recordRunItem(running)`, which clears its error. The segment's start also notes the items that were `running` (used by B2).
  - **A consequence I had to handle:** the failed items are no longer queued at the end of the segment, so a Resume whose cut listing never reached a failed item would have read "every item done or failed" and written `finished`. The run now ends `finished` only when every `onlyIds` item was also told an outcome in this segment (the `told` set in `afterItem`). Otherwise it ends as before: `paused-disk` if the floor flag is set, or else `failed`/`LIST_INCOMPLETE` (R678's intent). This is not a new rule, but the coordinator may want to confirm it.
  - Tests:
    - `resume after a quit audits capture.profile.resume and asks the rules again`, changed (see below): it now has a failed item, and after the denied Resume it is still `failed 1` and `problems` lists it. It failed first (failed 0).
    - New, `a Resume whose listing fails keeps the failures the run knew` (enumnetwork). It failed first.
    - New, `a Resume whose listing came back cut short before a failed video keeps its failure and says why`. It failed first, because it gave `finished`.
- **A2.** The `captureProfile` call is wrapped. On a `PolicyDeniedError` (and not cancelled), the item in hand is put back, and the run is written `failed` with `errorCode: "POLICY_DENIED"` and `reason: err.reason`. That is the rule's own reason, the same one `link-capture.ts:724`/`profile-capture.ts:941` give a person. Then `onChange` is told, and the error is rethrown.
  - Tests:
    - The changed resume-after-a-quit test asserts state `failed`, the reason, the journal's `errorCode`, `runLines().why` = the reason, and "Resume downloads (3 did not complete)".
    - New, `a start the project's rules refuse ends failed with the rule's reason and still offers Resume downloads`. It failed first against a57650f's code.

### B. A stored video is never left off the transcription list (I2)
- **B1.** In `afterItem`, a stored video goes to `addToTranscriptionList` first, then `recordRunItem(done)`, then `onQueuedForTranscription`. No `guard()` sits between the add and the done write. Any throw from the add (the rules, a read-only library) sets `transcribeRefused`, and the outcome is still written `done`.
- **B2.** A duplicate for an item that was `running` at the segment's start counts as this run's own.
- Tests:
  - `a video stored just before a cut reaches the transcription list at the Resume` failed first: 2 listed of 3. The cut is made by `cancelled()` turning true once the first post source exists.
  - `a lock during a video's done write still leaves it on the transcription list` failed first: 0 listed after the lock.
  - `a video another capture stored is not put on the transcription list at a Resume` is a guard for B2.
  - `a refused transcription keeps the run going` is a guard. It asserts exactly one deny.

### C. Waking up, and where the disk floor applies (Minors 4, 5)
- **C1.** `RunControl.haltSignal: AbortSignal` was added (the interface in `download-run.ts`).
  - The gap and every wait sleep on `AbortSignal.any([requestedSignal, signal, haltSignal])`. After each one, `awake()` checks `cancelled` and then `halt()`, and throws `CaptureCancelledError` before anything more is written or asked.
  - The turn is also raced with `haltSignal`, and a halt there rejects with `CaptureCancelledError`. This is my reading of "every wait".
  - Tests:
    - `a move during the gap wakes it and nothing more is downloaded or written` failed first: the sleep's signal was not aborted.
    - `a move during a slow-down wait wakes it and nothing more is asked of the platform` failed first: the run went on.
    - Both check `signal.aborted` at once inside the controlled sleep, so they fail fast.
- **C2.** A `metadataOnly` run reads no free space. It never pauses before a video and never puts a failure back for the disk. Test `a run that keeps only the details never pauses on the disk` failed first (`paused-disk`). The brief called this a guard test.

### D. Smaller points (Minors 1, 2, 6)
- **D1.** `setRunTitle(repo, projectId, runId, title): Promise<RunView>` is now in `lists/run-journal.ts`. It goes through `writable` (read-only and locked are refused), `repaired`, `liveRun` (a discarded run gives NotFoundError) and `recount`, and it is sealed. It is exported from `index.ts`. The local copy in `download-run.ts` is gone. The test `setRunTitle writes the run's title sealed, keeps its state and recounts it; refused read-only, locked or discarded` in `run-journal.test.ts` failed first: not a function.
- **D2.** New reason `RUN_FINISHED` in `capture/errors.ts`, thrown as `InvalidInputError(plainReason("RUN_FINISHED"))`. `a run finished with no failure cannot be resumed` now asserts the sentence, and it failed first.
- **D3.**
  - The three turn tests race the wait for the turn with the run itself (`turnAsked`). A mutation that never calls `turn` now fails all three in about 2 s, not at the 120 s limit. These are guards.
  - New guard `Pause and Stop wake the gap at once`. A mutation where the gap sleeps on `haltSignal` only made it fail at once.
  - The estimate test now asserts exactly one deny (`capture.profile.list`). This is a guard.

### Researcher-visible sentences, new or changed
- `RUN_FINISHED`: "These downloads have finished, so there is nothing to resume." It replaces my earlier sentence.
- A run refused by the rules now shows the rule's own reason as its `reason`/`why`. No new sentence.

### Existing tests changed
- `resume after a quit audits capture.profile.resume and asks the rules again`: it pinned "stays downloading / interrupted" after the denied Resume. It now pins `failed` with the rule's reason, and it has a failed item.
- `a run finished with no failure cannot be resumed`: it now also asserts the sentence.
- The three turn tests: the wait is now raced, and nothing in them was loosened.
- `estimate lists once…`: exactly one deny, instead of the last capture event.
- The test helper `control()` gains `haltSignal` and `halt()`.

### NEEDS A RULING
None blocking. Two points to confirm:
- **The `told` check in A1.** A Resume that never reached a failed video ends `LIST_INCOMPLETE`, not `finished`.
- **The turn woken by a halt (C1).**

### Runs (fix round)
- `vitest run src/capture/download-run.test.ts`: Tests 33 passed (33)
- `vitest run src/capture/estimate.test.ts`: Tests 3 passed (3)
- `vitest run src/capture/disk.test.ts`: Tests 4 passed (4)
- `vitest run src/lists/run-journal.test.ts`: Tests 14 passed (14)
- `vitest run src/capture/profile-capture.test.ts`: Tests 64 passed (64)
- `pnpm --filter @ao/library typecheck` and `@ao/library-service typecheck`: clean
- `git status --short`: empty. Group D commit: `318f1b4` (head).
