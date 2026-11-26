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
