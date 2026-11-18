# Task FR-A15: the job journal stores no absolute path (R379)

Branch `fr-a15-job-journal`, worktree `.claude/worktrees/fr-a15`. It has two commits on 7537f63:
- `adb7d52` fix(library): the job journal stores library-relative paths and records a linked input as its asset (points 1 and 2; the code for the two is intertwined, so they share one commit)
- `61c2392` test(library-service): the service tests now submit worker jobs on paths inside the library

Head: **61c2392**. `git status --short` is empty.

## Point 1: library-relative paths, a linked input recorded as its asset, other paths refused
- `packages/library/src/job-journal.ts`
  - `StoredJob` (about :46–62) gains the optional `inputAsset: { sourceId, assetId }`.
  - New `toLibraryPath(root, abs)` (:110) gives the relative, "/"-separated path. It returns undefined for any path not strictly inside the root, and checks the result with core's `LibraryRelativePath`.
  - New `fromLibraryPath(root, stored)` (:125) joins a relative path to the current root. It refuses "..", "." and empty segments.
- `packages/library/src/worker-client.ts`
  - `WorkerJob` gains `inputAsset`, and `ResumeExtras` gains `inputAsset`.
  - `runClaimed` (:430) builds the stored job with the new `storedJob()` (:650) before policy evaluation and before any journal write.
    - The input is stored relative. A capture's input is its URL and is kept as it is.
    - For a linked file, `input` is `""` and `inputAsset` names the asset. `isLinkedFile` checks the path against the asset record's `linked.absolutePath` or its `libraryRelativePath`.
    - The output is stored relative.
    - Anything else is refused with a `TypeError` whose message holds no path. Nothing is recorded or audited and the worker is not contacted.
  - On resume, the run's claim line now carries the job as it runs now (`job: stored`), so all later lines are relative.
- Callers now pass `inputAsset` when the input file is linked:
  - `import/proxies.ts` (runJob)
  - `import/ocr.ts` (runJob)
  - `transcription-jobs.ts` (`transcriptionJob` and `transcriptionRerun`, for a linked recording)
- The worker still receives absolute paths. Its protocol is unchanged.
- Encrypted projects still seal every line, as before.

## Point 2: old lines still resume
In `resumePending` (worker-client.ts about :356–395), the effective input and output are worked out after `prepare` has run:
- What `prepare` worked out again (`extras`) is used first.
- Otherwise the job uses `storedInput()` (:695): for a linked asset, the path in its current record (so a relink is honoured); otherwise `fromLibraryPath` against the current root.
- Old absolute paths:
  - **Inside the current root:** used as they are. The next line written for the job is relative. That is the claim line at resume, so it is written at once. The old line itself stays in the file until the next compaction, which runs at a resume once the journal has more than 64 lines and half of them are superseded, and keeps only the newest line per job.
  - **Outside the current root, no `prepare` input:** the job is claimed as `failed` with `INPUT_NOT_FOUND`. The caller gets `WorkerJobError("INPUT_NOT_FOUND", "the input file does not exist")`, the worker's own sentence for a missing input. The job is never sent, so the old place is not read even if a copy of the library is still there. Nothing throws.
  - **Transcription:** re-derived from its source by `transcriptionRerun`, as before.
- Old proxy and OCR lines are not re-derived: their records have no source id. Their own queues (pending lists in source.json) run those jobs again anyway.
- Legacy job rows (from before the journal existed) are converted by `upgradeLegacyJobs`/`legacyJob` in job-journal.ts. Paths inside the library are written relative; a row with a path outside it is recorded `failed` with `INPUT_NOT_FOUND` (:529).

## Point 3: format
- Still one JSON line per record: the same fields, plus the optional `inputAsset`.
- **Readable by the base commit's code:** it parses these lines and nothing throws. But it cannot resume a new-format pending job. It would hand the worker a relative or empty path, and the job would fail; it would not run.

## Point 4: other absolute paths
- I grepped the library's run-time writers: txn, attention, the library audit, restore and destruction records, backups, retention and the index sink. Every `.root` use I found is a join or read at run time, not a stored value.
- The capture snapshot strips local prefixes (`stripSnapshot`'s `localPrefixes: [root]`).
- The transcript store keeps only asset paths.
- I found nothing new to report. I changed nothing outside the journal and its callers.

## Tests (new file `packages/library/src/job-journal-paths.test.ts`, 14 tests)
13 failed first, each for the right reason (absolute root path in the journal, no TypeError, the job sent to the old place, legacy rows absolute). The 14th, an old transcription line re-derived, passed before the change too: transcription already re-derived its input. It stays as a regression guard.
- **No absolute path in the journal**, for a proxy (through `ProxyQueue`), text recognition (`OcrQueue`) and a transcription (`transcriptionJob`):
  - plain project: the raw text
  - encrypted project: the opened lines
  - checks: no root, no temporary folder, no string starting with "/"
- **Library moved** (closed, renamed, reopened) with a job pending: the resume sends the input under the new root, and the job is done.
- **Linked file:**
  - no path in the journal, only `inputAsset`
  - a direct submit runs on the linked file
  - after `relinkLinkedAsset`, the resumed job uses the new place
- **Refusal:** each of these is a TypeError whose message contains no "/", nothing is recorded, and the worker is not contacted:
  - an outside input
  - an outside input naming an asset that is not linked
  - an outside output
  - a path that escapes the library through ".."
- **Old-format lines, written by hand:**
  - inside the root: runs, and its claim line is relative
  - outside the root: fails `INPUT_NOT_FOUND` with today's sentence, never sent, and a second resume does nothing
  - an old transcription line outside the root is re-derived
- **Legacy rows** are written relative, and one outside the root is recorded failed.

### Existing tests changed
- These tests submitted jobs on paths beside the library, which is now refused. Only their job paths moved, into a `test-files` folder inside the library; their assertions are unchanged:
  - `worker-client.test.ts`
  - `job-journal.test.ts`
  - `worker-tools.test.ts`
  - `apps/library-service/src/server.test.ts` (two tests)
  - `apps/library-service/src/transcription-jobs.test.ts` (two tests)
- **One assertion of the old behaviour was changed:** `job-journal.test.ts`, legacy upgrade, now expects `job.output` to be `"test-files/e.jpg"` instead of an absolute path.
- The worker protocol test (the first `worker-client.test.ts` test, which checks what the worker is sent) has unchanged assertions; only its input file moved into the library.

## Runs (machine load average 32–36 on 4 cores, shared with other agents)
- Touched files (`worker-client`, `job-journal`, `transcription-jobs`, `worker-tools`, `job-journal-paths`): **76 passed, 2 skipped**, plus 14/14 for the new file. The 2 skipped tests in `worker-client.test.ts` need the real Python worker; this worktree has no Python environment.
- **`pnpm --filter @ao/library test`:** 3701 passed, 13 failed, 22 skipped (108 files).
  - All 13 failures are speed or memory limits in files I did not touch: `html-strip`, `extract`, `refman`, `zotero-local`, `annotations-cap`.
  - Re-run alone: 17 failed / 304 passed in those 5 files, all speed limits.
  - The load explains it; none of these tests touch worker jobs.
- **`pnpm --filter @ao/library-service test`:** 1028 passed, 1 failed, 1 skipped.
  - The failure is `find-browser-routes.test.ts` "R348 d": it expected "Ready in 20 seconds." and got "Ready in 18 seconds.", a wall-clock countdown slowed by load.
  - It failed again when run alone, with the same 2-second gap.
  - It covers Find routes, which this change does not touch.
- **`pnpm -r typecheck`:** passes (0 errors).

## What only a real worker or a real Mac can show
- A real Python worker resuming a relative-path job after a move. The stub worker here behaves like the real one: it fails `INPUT_NOT_FOUND` for an input that does not exist.
- Moving a library to another disk on macOS. Here it was a rename within one temporary folder.

minor (deferred): a compaction keeps an old absolute line until it is superseded and the journal passes 64 lines; it does not rewrite pending lines in place.
minor (deferred): a pending `capture.download` line still stores its capture URL (not a path; captures are never resumed).

## Round 2 (R400)

Implementer: fresh round-2 agent. Worktree `.claude/worktrees/fr-a15`, branch `fr-a15-job-journal`, 61c2392 → **cac919c** (five commits, one per point). All new tests are in `packages/library/src/job-journal-paths.test.ts` (16 → 25 tests). Each point's test was run first and failed for the right reason, except (d), which only adds tests; those were mutation-checked instead.

### (a) I1: `ao transcribe` on a linked recording (46d30a5)
- `packages/library/src/capture/link-capture.ts` (`runTranscription`, about l.390): for a linked recording it now passes `linked.absolutePath` and `inputAsset: { sourceId, assetId }`, as proxies, ocr and transcription-jobs already do.
- Other callers checked:
  - `link-capture` `download` and `profile-capture` `enumerate` submit `capture.download`: the input is a URL and the output is `makeWork` = `.tmp/capture-*`.
  - The service's `transcriptions.ts` uses `transcriptionJob`.
  - `state.ts` resumes through `transcriptionRerun` and the proxy and OCR queues.
- Test "R400 (a)", run through `createLinkCapture().transcribeSource` for a linked and a stored recording. It checks: the worker gets the right input; two transcript assets are made; the journal holds neither the root nor `tmp`, and not the linked relative path; the job ends `done`. Before the fix it failed with the reviewer's TypeError.

### (b) M2: real paths, and outputs only in `.tmp` (4d07f22)
- `worker-client.ts`:
  - New `placesAllowed`. The input (any job but a capture) must be either the named linked asset's current file (`isLinkedFile`) or inside the library's real root (`insideLibrary` from `fs/inside-library.ts`).
  - New module function `outputInWork`. The folder the outputs are published into must lie strictly below `<realRoot>/.tmp` by real path (`realOrNearest`), and may not be `.tmp` itself. For a folder output that folder is the output; for a file output it is the output's parent.
- Where it runs:
  - At submit, in `runClaimed` after `storedJob`: a job that fails is refused with a TypeError that names no path. Nothing is recorded or sent.
  - At resume, in `resumePending` before the run: a line that fails is settled once as failed with `INPUT_NOT_FOUND` / "the input file does not exist". Nothing is sent.
  - Once more inside the publish write, just before `publish`, against a link planted while the job ran. A failure there throws `inputNotFound()` and is recorded failed.
- Every caller's output is under `.tmp`: proxies (`.tmp/worker-proxy-*`), OCR (`.tmp/worker-ocr-*`), transcriptions (`.tmp/worker-<id>/transcript`), captures (`.tmp/capture-*`).
- Tests "R400 (b)", resume and submit: the review's probe 4 (`library.json`, `<Project>/source-overwrite.json`, `escape/x.jpg` with `escape` → outside), plus `.tmp/esc/x.jpg` (a link inside `.tmp`) and an input `escape/y.png`. At submit, also `.tmp/x.jpg`. Each is refused; `library.json` and the project file are unchanged; nothing is written outside.
- **Existing tests changed (R400 changes their expectation):** the fixtures that put job outputs in `<Library>/test-files` now use `<Library>/.tmp/test-files`:
  - `worker-client.test.ts`, `job-journal.test.ts`, `worker-tools.test.ts` (the `files` variable).
  - `apps/library-service/src/server.test.ts` (2 outputs) and `transcription-jobs.test.ts` (2 outputs).
  - One assertion, `job-journal.test.ts` (about l.371): `output: "test-files/e.jpg"` → `".tmp/test-files/e.jpg"`.
  - No other assertion was touched.

### (c) M3: control characters; no path in returned errors (39336ad)
- `job-journal.ts`: `fromLibraryPath` and `toLibraryPath` refuse any C0, DEL or C1 character, NUL included.
- `worker-client.ts`: new `pathless`. Every error `resumePending` returns (per job and per project) goes through it. An error whose `path` property is set, or whose message holds the root or an absolute path, is replaced by `WorkerJobError(code or "FAILED", "the job failed")`.
- Tests:
  - NUL, \x01, \x1f, \x7f, \x85 and \x9f in relative inputs and outputs, and NUL in old absolute ones: each fails once as a missing input, nothing is sent, the error has no "/".
  - A Node `ENOENT` raised in `prepare` comes back without the root. This test failed before the change, with the root in the message.

### (d) M4, M5: tests only (5d065c4)
- Hand-written relative lines holding `..`, `.tmp/../..`, a leading `/`, `C:\`, `C:/`, backslashes or a `.` segment: each fails once with `INPUT_NOT_FOUND`, nothing is sent or written outside, and the next resume does nothing.
- A pending job on a linked asset marked destroyed is not run. Retention itself refuses to destroy a linked file (`retention.ts` l.318), so the test marks the record destroyed through `importChange`.
- Mutations, each reverted:
  - Removing `fromLibraryPath`'s relative-path validation fails the first test (an input `C:\y.png` is sent).
  - Removing `assetOf`'s `status !== "destroyed"` filter fails the second.

### (e) M6: old absolute lines rewritten at the first resume (cac919c)
- At resume, not at open, because R400 (e) says "at the first resume after the upgrade" and resume is already where the journal is compacted and its jobs are settled.
- `job-journal.ts`:
  - `ParsedJournal.absolutePaths` is set when any readable line, superseded ones included, holds an absolute input or output.
  - `compactJobJournal` then runs whatever the journal's size, and writes a newest line's paths inside the root relative (`relativeLine`; re-sealed in an encrypted project).
  - It is crash-safe the same way as before (`writeFileAtomic`).
- `resumePending` compacts before the jobs (as before) and once more after they are settled. That second pass drops the old lines superseded during the resume (claimed, or failed because they lie outside the root). If it rewrote the journal, it refreshes the index rows.
- Tests:
  - Plain and encrypted: two old absolute lines (one superseded by `done`, one pending, worker down). After one resume, no line holds the root (every line opened), `done` stays done, and the pending job stays queued with relative paths.
  - An old line outside the root is settled `INPUT_NOT_FOUND`, and `/Users/` has left the file.

### Kept
- Every round-1 test passes, apart from the fixture and assertion changes named under (b).
- The worker protocol is unchanged.

### Only a real Mac or the real worker can show
- The real Python worker.
- The real-path checks on macOS: firmlinks, letter case and Unicode form. `insideFolder` folds case there; `outputInWork` compares names only, not inode.

### minor (deferred)
- M1 (FR-675) is untouched.
- `pathless` does not scrub `WorkerJobError.detail`, which comes from the worker and may quote worker temp paths. The detail is not stored, only returned.
- A job refused by a real-path race between the resume check and `runClaimed` is recorded `UNRECOVERABLE`, not `INPUT_NOT_FOUND`.

### Runs (nice -n 10)
- `job-journal-paths` 25/25. Touched library files (worker-client, job-journal, worker-tools, job-journal-paths, transcription-jobs) 101 passed, 2 skipped. Capture and transcription files 120 passed, 1 skipped.
- `@ao/library` whole suite: 3708 passed, 17 failed, 22 skipped. All 17 are speed or wall-clock limits in files not touched: html-strip, extract, refman, zotero-local, annotations-cap.
- `@ao/library-service` whole suite: 1023 passed, 2 failed, 1 skipped.
  - `main.test.ts` R98 (14.5 s > 10 s limit) passes alone.
  - `find-browser-routes.test.ts` R348 d ("Ready in 19 seconds" vs 20, a countdown; `worker: null`) also fails alone.
  - Both are timing failures in files not touched.
- `@ao/cli`: 61 passed, 15 skipped.
- `pnpm -r typecheck`: clean.
- `git status --short`: empty.
