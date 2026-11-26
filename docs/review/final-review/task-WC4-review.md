# Task WC4 review: download runs and the estimate (library)

Worktree `.claude/worktrees/kg-3b`, branch `wc-4-runs`, range 16c6f59..a57650f. The probes and mutations were reverted, and `git status --short` is empty.

## Verdict: READY WITH FIXES

Two Important findings and six Minor ones. The contract matches the plan.

## Important

**I1. A Resume that the rules refuse erases the run's failures.** `download-run.ts:269-271` runs `requeueFailedItems` before `captureProfile` (:362). The project's rules are asked only inside `captureProfile`, by `authorizeProcessing`. When the rules deny, the error propagates and the failed items are already back to `queued` with their errors gone. The journal says `downloading`, so the run is shown `interrupted`.
- Probe (added to `download-run.test.ts`, then reverted): a run paused with done 1, failed 1. After a denied Resume it reads `{state:"interrupted", done:1, failed:0}`, and `problems()` returns 0 entries. The "show them" list loses the reason the video failed.
- The same happens when the Resume's listing ends early. That covers a slow-down that gives up, 12 hours without a connection, a missing tool, the worker gone, and LEGAL_BASIS_REQUIRED.
- **Fix:** run `requeueFailedItems` inside `onListed` when `!readList`, which is after the decision and the listing. Or drop it: `onlyIds` already contains the failed items, and `recordRunItem(running)` clears each item's error when that item is retried.
- The existing test "resume after a quit … asks the rules again" has no failed item, so it misses this. Add one to it.

**I2. A video stored by a transcribing run can miss the transcription list for good.**
- `afterItem` writes `done` (:338), then calls `guard()` (:340), then `addToTranscriptionList` (:342).
- A lock, close or move that arrives during the `done` write makes `guard()` throw. The video is `done`, so no Resume takes it again, and it never reaches the list.
- A cut or crash between the store and the `done` write leaves the item `running`. The Resume then gets it as a `duplicate`, and :339 skips duplicates.
- Probe: cancel when `onChange` reports done 1, then Resume with transcribe. 3 videos stored, 2 put on the list, 2 told. The first video is never put on the list.
- This breaks "each newly stored video is put on the transcription list exactly once, also across a Resume." A lock in the middle of a run is the ordinary case.
- **Fix:**
  - (a) Call `addToTranscriptionList` before `recordRunItem(done)`, and drop the `guard()` between them. The add skips sources already pending, so a repeat adds nothing.
  - (b) At the segment's start, note the items that were `running`. A `duplicate` for one of those counts as new for the transcription list.

## Minor

1. **`setRunTitle` (`download-run.ts:196`), the implementer's point 1.**
   - What is right: it goes through `updateJobRecords`, so it is serialized with the other writers and sealed (`appendNow` with the project key). It writes only the run record, so no item write is undone.
   - What differs from `run-journal`: it works on the raw records, not `repaired`/`liveRun`. It copies the counters of the newest run record instead of recounting from the items, which `setRunState` does because of R672's torn appends.
   - The `setRunState("downloading")` that follows recounts, so the effect lasts one write. A failed write leaves the title unchanged, which does no harm.
   - It belongs in `run-journal.ts`, as `setRunTitle`, using `liveRun` and `recount`. That file is Task 1's, so move it when Task 1's file is next touched.
2. **The new sentence (the implementer's point 2)** is "Every video of these downloads is already in the project, so there is nothing to resume." (`download-run.ts:111`).
   - When it is false: when the researcher has deleted a stored video since, and for a metadata-only run.
   - When it reads oddly: for a run whose listing had nothing (total 0). The screen says "nothing new to download." for that case.
   - Who sees it: no screen offers Resume for such a run, because `runLines` gives no `resume` when `notCompleted` is 0 and the run is finished. It surfaces only as Task 5's 400 answer to a stale screen or a press that crosses the finish.
   - It is not in `background.ts`.
   - Suggested wording: "These downloads have finished, so there is nothing to resume."
3. **A denied or failed Resume leaves the run `downloading`.** It is then shown "interrupted … Resume downloads", and pressing Resume is refused again by the same rule. This is the case when `captureProfile` throws something other than a cut (PolicyDeniedError, or a journal append failing with ENOSPC). A test pins this, and the plan is silent. Ending the run `failed` with the rule's reason would tell the researcher why. This needs a coordinator ruling, not a change now.
4. **`halt()` (a move or a close) does not wake the waits.** The gap (:309) and the slow-down waits (:353) are woken only by `requestedSignal` and `signal`, so a move can sit behind a wait of up to 2 hours. After a wait, `wait` does not check `halt()`, so one more video is downloaded before `beforeItem` halts. The pinned `RunControl` has no halt signal, so this needs Task 5 to abort `signal`, or a ruling.
5. **Smaller points:**
   - The disk check runs before a duplicate too, so a duplicate needing no download can pause the run on the disk.
   - Metadata-only counts 0 bytes per second, but still pauses below 10 GB free.
   - A failure put back for the disk is still counted `failed` in the `ProfileCaptureReport` that goes to `onReport` and the capture queue, while the journal records it as `queued`.
   - A `turn` that rejects leaves the run `queued`, shown interrupted, with nothing asked of the platform. That is acceptable.
6. **Tests:**
   - A wrong turn implementation fails the three turn tests only by the 120 s timeout, because `await waitingTurn` never resolves. They do fail, but slowly. Race the wait with a bounded check.
   - No test shows the gap being woken by Pause or Stop. My probe showed it works: a pause during the gap gives `paused`, done 1.
   - No test asserts that a refused transcription keeps the run going.
   - The estimate test checks only the last audit event for the deny. My probe found exactly one deny (`capture.profile.list`).

## Contract check

I compared `RunOptions`, `RunControl` (with `turn`), `DownloadRunsDeps`, `DownloadRuns`, `createDownloadRuns`, `DOWNLOAD_GAP_MS = 10_000`, `freeBytes`, `diskName`, `estimateCapture` and the `index.ts` exports with the plan's Interfaces block. They are identical; `estimateCapture` is exported as an extra.

- **`LIST_INCOMPLETE`** matches the plan character for character.
- **`summarize`:** `notCompleted = max(0, total − done)`. `interrupted` is derived for queued, downloading or waiting runs that are not held. `wait` appears only while waiting. `tool` and `reason` are carried.
- **`problems`:** uses the journal item's own `url` and `title`, `downloadProblemText(code, platform)`, and `platformReason`.
- **`estimate`:** counts what is not known, sums the known lengths, counts unknown lengths, maps RATE_LIMITED and tool errors, and writes nothing to the journal.
- **`diskName`:** returns only a volume name. It is shown in the estimate and not stored. No path leaves the function.

## Mutations (download-run.test.ts, 22 tests)

| Mutation | Result |
|---|---|
| R678 check removed (always `finished`) | 2 failed: the cut-listing test, and Review Focus 2 (c) |
| Review Focus 2 removed (a failure below the floor recorded as failed) | 1 failed: the lack-of-space test |
| Item in hand not put back to `queued` | 3 failed: the slow-down pause, the lack of space, the missing tool |
| Turn not awaited | 3 failed: all three turn tests, by the 120 s timeout |

## Existing behaviour

These pass:

| File | Tests |
|---|---|
| `download-run.test.ts` | 22 |
| `estimate.test.ts` | 3 |
| `disk.test.ts` | 4 |
| `profile-capture.test.ts` | 64 |
| `link-capture.test.ts` | 66 |
| `job-journal.test.ts` | 28 |
| `lists/run-journal.test.ts` | 13 |
| `lists/transcription-list.test.ts` | 11 |

`@ao/library` and `@ao/library-service` both typecheck clean. No existing test was changed.

## Not checked (needs a real Mac or platform)

- What `diskutil info -plist` gives as `VolumeName` for a library in the home folder on current macOS. It is probably "Macintosh HD - Data" or "Data", not "Macintosh HD", and that is the name the estimate would show.
- `statfs` on APFS (purgeable space).
- Real yt-dlp behaviour for DISK_FULL in the middle of a download.
- Crashes at the process level, beyond the cuts I simulated.
