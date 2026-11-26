# Task WC1 report: the shared contract and the lists' journal

Status: DONE. Branch `wc-1-contract`, one commit `0b7e336` on top of 04ec3bd ("feat: the shared words of whole-channel capture and the lists' records in the job journal"). `git status --short` is empty.

## What was built, step by step

**Steps 1 and 2: shared tests first.** `packages/shared/src/api/background.test.ts` has 19 `it`s, one per group of rows in the copy table, with every string the plan pins in step 1 (formatSize 150 660 000 000 → "150 GB", "150–250 GB", "412 videos, about 310 hours.", the interrupted, finished, queued and "before it began" runLines with their `resume`, "measuring…", formatSpeed(4), PRIVATE for YouTube and Instagram). First run: FAILED, "Failed to load url ./background.js … Does the file exist?" (the right reason).

**Step 3: `packages/shared/src/api/background.ts`.** Every pinned name and signature: qualities and sizes :24–137, the estimate :140–237, download runs :240–419 (`runLines` :307, `downloadProblemText` :377, `problemLine` :414), the transcription list :423–486, the switches, work lines and event :488–519. It uses no Node or DOM API. `export * from "./background.js";` is added at the end of `packages/shared/src/api/index.ts`.

**Step 4.** The shared test passes (19/19) and `@ao/shared` typechecks.

**Steps 5 and 6: library tests first.**
- `packages/library/src/job-journal.test.ts:702`, `describe("list kinds")` with three tests. The first, `list records are never pending, never resubmitted and never cached as job rows`, covers isPending, syncJobRows, upsertJobRow, refreshJobRows, resumePending and a rebuild. The other two are `compaction keeps a live run's items and drops a finished or discarded run's items` and `updateJobRecords appends in the file's turn` (encrypted project, two calls at once end at 2).
- `packages/library/src/lists/run-journal.test.ts` has the 9 tests the plan names, each under its name.
- `packages/library/src/lists/transcription-list.test.ts` has the 6 tests the plan names, each under its name.

First run: the three list-kinds tests failed (`LIST_KINDS` undefined, the finished and discarded items still kept, `updateJobRecords is not a function`). The two new files failed with "Cannot find module './run-journal.js'" and "./transcription-list.js". These are the right reasons.

**Step 7: implementation.**
- `packages/library/src/job-journal.ts`:
  - `JobRecord` gains `run`, `item`, `list` and `entry`.
  - New: `LIST_KINDS` :107, `isListKind` :110, the four data interfaces :119–164 and `DISCARDED_CODE` :167.
  - `updateJobRecords` :420. `fn` runs inside `serialize`. The function returns the map after the append, and nothing is appended if `fn` throws.
  - `appendNow` returns early when there is nothing to append.
  - `isPending` :449 is false for the list kinds.
  - `prunable` :460. A `capture.item` is dropped when its run is absent, done or DISCARDED, and age and count rules never apply to items. `transcription.list` is never dropped. Runs and entries follow the existing rules.
  - `upsertJobRow` :556 and `syncJobRows` :566 skip the list kinds, so the rebuild, which calls `upsertJobRow`, skips them too.
- `packages/library/src/lists/run-journal.ts`: every pinned function (:102–256). Writes check `library.mode` first (ReadOnlyLibraryError). The key comes from `projectDataKey` (ProjectLockedError). `assertNoSecrets(data.options)` runs before anything is written.
- `packages/library/src/lists/transcription-list.ts`: every pinned function (:29–212). `addToTranscriptionList` calls `authorizeProcessing` once with op `transcription.list.add`. A deny is audited and thrown. An allow is not audited, as in `transcriptionJob`.
- `packages/library/src/index.ts`: exports the public names of both modules, plus `LIST_KINDS`, `isListKind`, `DISCARDED_CODE`, the four data types and `JobStatus`.

**Step 8.** The three files pass. `job-journal-paths.test.ts` and `worker-client.test.ts` pass. `@ao/library` typechecks, and so do `@ao/library-service` and `@ao/ui`, which import `@ao/shared`.

## Researcher-visible sentences
They are exactly the plan's table. Where the table leaves a case open, I chose the following (all in `background.ts`):
- **Plurals.** The singular forms are "about 1 minute", "1 minute of sound per minute", "1 minute for each minute of sound", "not counting 1 recording of unknown length", "1 more is … and is not …", "1 source has … no transcript", "1 of them has no known length.", "1 source was put on the transcription list." and, in the partial disk sentence, "the 1 video of unknown length".
- **Instagram uses "post"** in every sentence that names one item: `listing`, `count`, `nothingNew`, the partial and unknown `disk` sentences ("the posts' lengths"), `transcribeTime` ("the first post on this Mac"), runLines "reading the list of posts…", and `downloadProblemText`. `transcribeLabel` stays "video" because it takes no platform.
- **The "N could not be downloaded" line** appears for every state except finished, whenever failed > 0.
- **The `disk` sentence:**
  - With `metadataOnly`, the metadata sentence stands alone, with no free-space part.
  - With `count` 0, it falls through to the general sentence ("Roughly less than 1 MB at this quality.") because the table has no row for it. Task 8 may prefer to hide the Disk line when nothing is new.
  - `tooBig` is undefined for `metadataOnly`.
- **The running transcription line** "Transcribing: N of M" uses `done` for N, the same way as the download line.

## Existing tests changed
None were loosened or changed. One `describe` was added to `job-journal.test.ts`, and its import line now also brings in `LIST_KINDS`, `isListKind`, `isPending`, `syncJobRows` and `updateJobRecords`.

## NEEDS A RULING
None blocking. Decisions Tasks 4, 5 and 7 should know about:
1. **Counters are worked out from the items.** Every item write recounts total, done and failed from the run's items, so recording the same thing twice is counted once. `setRunState` and `discardRun` leave the counters as they are.
2. **Cancelled entries reduce `total`.** A cancelled transcription entry (a source gone before its turn, or the list stopped) takes 1 off `total`, so total = done + failed + pending. Without this, "Transcriptions finished: all N done." could never show after a skip.
3. **Stop resets the list to "running".** `stopTranscriptionList` cancels every pending entry with error `STOPPED`, returns the job ids of the running ones, and sets the list back to running, so a paused list that was stopped transcribes what is added next. Task 7 should say if a stopped list should stay paused.
4. **Order of runs and entries.** `createdAt` is made strictly increasing (at least 1 ms after the newest run or entry). `readRuns` (newest first) and the entries' pending order (oldest first) therefore hold within one millisecond and under a fixed test clock. Record times come from `repoClock(repo)`.
5. **Discarded and unknown runs.** `readRun` returns undefined for a discarded run. Writes to an unknown or discarded run throw `NotFoundError`. `createRun` throws a TypeError if the run id is already in the journal.
6. **Defaults and skips.**
   - With no list record yet, `readTranscriptionList` gives state "running" with zero counters.
   - `addToTranscriptionList` leaves out a source that is gone (NotFoundError), one with no recording, one already pending, and duplicates within the same call. Any other read failure is thrown.

## Found in the code that the plan did not expect
- The asset metadata schema (`packages/core/src/model/asset.ts:64`) has no `durationSec`, and zod drops unknown keys when it parses. `soundSecondsOf` reads `metadata.durationSec` anyway, as the plan asks, but a stored recording will not normally carry it. In practice the length comes from the platform's `duration` in `provenance.platformSnapshot`.
- `rebuild.ts:332` calls `upsertJobRow` directly, so the skip is in `upsertJobRow` itself as well as in `syncJobRows`.
- The repo has no ESLint config (`eslint` finds no `eslint.config.*`), so no lint run was possible.

## Runs (last summary line of each)
- `@ao/shared` vitest `src/api/background.test.ts`: Tests 19 passed (19). First run failed: module not found.
- `@ao/shared` vitest `src/api/boundary.test.ts src/shared.test.ts src/api/background.test.ts`: Tests 52 passed (52)
- `@ao/shared` typecheck: clean
- `@ao/library` vitest `src/job-journal.test.ts src/lists/run-journal.test.ts src/lists/transcription-list.test.ts`: Tests 41 passed (41). First run: 3 failed plus 2 files that could not load.
- `@ao/library` vitest `src/job-journal-paths.test.ts`: Tests 25 passed (25)
- `@ao/library` vitest `src/worker-client.test.ts`: Tests 31 passed (31)
- typecheck `@ao/library`, `@ao/library-service`, `@ao/ui`: clean

## Fix round (R672)

Branch `wc-1-contract`, three commits on 0b7e336: `774ceda` (A), `fac1d1e` (B), `e1f8ce9` (C). D needed no code change, so it has no commit. `git status --short` is empty. Every new or changed test below was run before its fix and FAILED for the right reason; the result is given per point.

### A. Sentences (`packages/shared/src/api/background.ts`); tests in `background.test.ts:331` `describe("fix round (R672)")`, 8 tests, all 8 failed first
- A1 (I2): `runLines` :326–369. With total 0: stopped gives `"T" was stopped before it began.`, paused gives `"T" is paused. The list of videos has not been read yet.`, and paused-disk, paused-rate-limited, paused-tool and failed give `"T": the list of videos has not been read yet.` (the `notRead` title, :328), each with its `why` unchanged. Instagram uses "posts". Failed first: "…was stopped: 0 of 0 downloaded."
- A2: `LIST_STOPPED_TEXT` :486, exactly as pinned. Failed first: not exported.
- A3: `transcribeAllText.confirm` :490–500. For 1 source the ending is `It is transcribed on this Mac, after anything already on the list.`, including the unknown-length case. Failed first: "They are transcribed one at a time…".
- A4: `estimateText.disk` :208 gives `Nothing new will be downloaded, so no disk space is needed.` when count is 0. `tooBig` is undefined when count is 0. Both checks come first, before `metadataOnly`; the brief's rule has no exception for metadata-only. Failed first: "Roughly less than 1 MB…".
- A5: `formatSizeRange` :103–111 gives `up to 1.2 MB` and `less than 1 MB`, so `disk` reads "Roughly up to 1.2 MB at this quality." Failed first: "less than 1 MB–1.2 MB".
- A6: `transcribeTime` :229–236 gives the unknown-lengths sentence, or the measured sentence followed by ` The N videos/posts of unknown length are not counted.` (singular "is"). Failed first.
- A7: `formatSoundLength` :114–117 (60 rounded minutes become "about 1 hour"). `formatTimeLeft` :132–139 (120 minutes become "about 2 hours", 48 hours become "about 2 days"). The boundaries are tested on both sides. Failed first: "about 60 minutes".
- A8: `problemLine` :434 uses `||`. Failed first.

### B. Transcription list
- B1 (I1): `markTranscriptionEntry` (`transcription-list.ts:194–227`) returns `Promise<boolean>`. It refuses ended → running or queued, writes nothing and returns false. Test: `transcription-list.test.ts:160` (the reviewer's probe, plus true for every other move). Failed first: the call returned undefined.
- B2 (I3): `stopTranscriptionList` :245–260 sets total, done and failed to 0, and the state to running. Test :180 ("stop after 3 of 10 done"). Failed first: total 3. **Existing test changed:** "stopTranscriptionList cancels every pending entry…" (:155) asserted `done 1, total 1` after Stop. It now asserts `{state:"running",total:0,done:0,failed:0,pending:[]}`, as B2 requires.
- B3 (Minor 9): `prunable` in `job-journal.ts` (:477, :494–497) always drops a cancelled `transcription.entry` and leaves it out of the MAX_FAILED_KEPT list. Test: `job-journal.test.ts:766`, with 120 failed worker jobs and 400 cancelled entries. Failed first: 100 of 120 were kept.
- B4 (Minor 10): seam is `vi.mock("../repo/repo.js")`, which wraps the real `authorizeProcessing` in `vi.fn` (`transcription-list.test.ts:17–23`); product code unchanged. The test asserts 1 call for the deny case and 1 for the four items. Mutation check: an extra call per item made it FAIL ("expected 4 to be 1"). It passed before the fix because the product code was already right.

### C. Run journal and journal file
- C1 (Minor 6): `run-journal.ts:181` now throws `NotFoundError("Item of download run", runId)`. **Not as written:** an item that is not found has no index (it is looked up by post id), so the message names the run only. Test `run-journal.test.ts:205`. Failed first.
- C2 (Minor 8): `setRunState` (:244) recounts through `recount`. Test :215, which writes item records directly. Failed first: the counters were stale.
- C3 (Minor 7): `updateJobRecords` (:436–457) compacts in its own turn when the file has more than `UPDATE_COMPACT_LINES` (2 000, :460) lines and more than half of them are superseded. The compaction body is factored out as `compactNow` (:535), and `compactJobJournal` calls it. Records that are dropped leave the returned map. Test `job-journal.test.ts:788`: 3 000 writes to 500 items. The file never goes over 2 000 lines and ends under 2 000, and every record reads back equal. Limit 120 s; it takes about 16 s. Failed first: 6000 lines.
- C4 (I4): `OLDER_BUILD_CLAIM_CODE` and `claimedByOlderBuild` are in `job-journal.ts:169–179`. `repaired()` in `run-journal.ts:64` handles runs (status from `run.state`) and items (queued unless `item.errorCode`). `repaired()` in `transcription-list.ts:89` reads entries and the list record as queued. Both apply to every read and every write callback. `prunable` never drops a run that is neither finished nor discarded (:478). **Beyond the brief:** it also never drops an entry an older build claimed, because the cap would otherwise lose a pending entry. Tests: `run-journal.test.ts:236` and `transcription-list.test.ts:193`. Each simulates the older build exactly (`next()` plus `attempt`) and adds 600 newer failed worker jobs before compaction. Both failed first: the run and the entries were dropped or read as not pending.

### D.
Nothing else needed mending. Stale cached rows that an older build leaves for list records are already deleted by `syncJobRows`.

### NEEDS A RULING
1. C4 ambiguity: an entry that this build marks failed with error `UNRECOVERABLE` would be read as pending. This happens if Task 7 copies a worker job's `UNRECOVERABLE` (`worker-client.ts:475`) into the entry. Recommendation: Task 7 marks such an entry with its own code, for example `TRANSCRIPTION_FAILED`.
2. The transcription list's counters are still kept as deltas (Minor 8, first half). They cannot be recounted, because nothing records where the current list began. One option is to store a `since` time on the list record. My recommendation is to leave them as they are.

### Runs
@ao/shared `background.test.ts`, `boundary.test.ts` and `shared.test.ts`: 60 passed. @ao/library: `job-journal.test.ts` 28, `lists/run-journal.test.ts` 12, `lists/transcription-list.test.ts` 9, `job-journal-paths.test.ts` 25, `worker-client.test.ts` 31, all passed. Typecheck: @ao/shared, @ao/library, @ao/library-service and @ao/ui are clean.
