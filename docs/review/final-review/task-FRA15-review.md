# Review — Task FR-A15: the job journal stores no absolute path (R379, WB2 I1)

Reviewer: fresh adversarial review. Worktree `.claude/worktrees/fr-a15`, branch `fr-a15-job-journal`, base 7537f63, head 61c2392. Package `review-FRA15.diff` read in full; R379 (bullet FR-A15), SPEC line 207, R26, R142 read.

## Verdict: NOT APPROVED (one Important regression, small to fix)

The finding itself is closed for every flow the brief names: after a proxy, a text recognition and a transcription, run to the end and left pending, in a plain and in an encrypted project, **no file anywhere in the library folder** holds the library root's path or the temporary folder's path (whole-folder byte scan, index and WAL included). Resolution against the current root, a move, linked inputs and old lines behave as the report says. But the fix refuses a caller it did not update: **`ao transcribe` (the command line) on a linked recording now fails** where it worked before.

## What I ran
- Probe file `packages/library/src/job-journal-paths.probeFRA15.test.ts` (deleted; `git status --short` empty at the end), run alone at `nice -n 10`:
  1. Whole-library byte scan for `tmp` and the root after ProxyQueue, OcrQueue and `transcriptionJob` jobs run to completion plus one left pending, plain and encrypted: **no hit** in either; the opened encrypted journal holds no absolute path.
  2. `createLinkCapture(...).transcribeSource` on a linked recording (the CLI's path): **TypeError**, worker never contacted (I1 below).
  3. An old-format line for a linked file in a library that was NOT moved: fails `INPUT_NOT_FOUND`, never sent (M1).
  4. Doctored stored paths (outputs `../outside/x.jpg`, `/etc/x.jpg`, `C:\x.jpg`, `a\..\..\x.jpg`, `a/<NUL>/x.jpg`, `.tmp/./x.jpg`, `library.json`, `<Project>/source-overwrite.json`, `escape/x.jpg` where `escape` is a symlink in the library to an outside folder; inputs `../outside/y.png`, `/etc/passwd`, `<path><NUL>`, `escape/y.png`) — results in M2–M4.
  5. Linked input whose source was deleted, and one whose file was removed, before the resume: both `INPUT_NOT_FOUND` "the input file does not exist", recorded once; a second resume does nothing; the deleted one is never sent.
  6. Library renamed with a linked-input job pending: the resume reads the linked file from the asset record and writes under the new root; a scan of the moved library for the old root: no hit.
  7. NUL in a stored output: settled once as `failed`/`FAILED`, not retried (M3).
- Mutations (each reverted, `git checkout`): remove `job: stored` from the resume claim → the "old line … written relative" test fails ✔; drop the `isLinkedFile` check → the refusal test fails ✔; drop `fromLibraryPath`'s relative-path validation → **no test fails** (M4); drop the `status !== "destroyed"` filter in `assetOf` → **no test fails** (M5).
- `job-journal-paths.test.ts`, `job-journal.test.ts`, `worker-client.test.ts`: 66 passed, 2 skipped (the two need the real Python worker; none here). `apps/library-service/src/transcription-jobs.test.ts`: 20/20. `pnpm --filter @ao/library typecheck`: clean. No speed-limit failures were met in the files I ran.

## Findings

### Important

**I1 — `ao transcribe` on a linked recording now fails (a caller the fix did not update).**
`packages/library/src/capture/link-capture.ts:381-399` (`runTranscription`, used by `transcribeSource` :417-432, which `apps/cli/src/commands/transcribe.ts:27` calls) submits `input: join(root, ...media.path.split("/"))` with no `inputAsset`. For a linked asset `media.path` is its `linked.libraryRelativePath` (`packages/core/src/model/asset.ts:34,80`), which starts with `..`: the input is outside the library, and `storedJob` (`worker-client.ts:1885-1893` in the package, `storedJob`) refuses it. Probe: `{"err":"TypeError: a worker job's input must be a file inside the library or a linked file of one of its assets"}`, 0 jobs sent. The CLI turns it into "The transcript could not be made." (exit failure) with that sentence as detail. On the base commit the job ran. The service route is not affected (it uses `transcriptionJob`, which was updated), so a researcher can still transcribe a linked recording from the app — but not from the command line. No test covers the CLI/link-capture path with a linked file, which is how it slipped through. The report's point 4 ("Callers now pass `inputAsset` …: proxies, ocr, transcription-jobs") misses this fourth caller.
Direction: pass `inputAsset: { sourceId: sf.source.id, assetId: media.id }` when `media.linked` in `runTranscription` (and, as the other callers do, consider using `linked.absolutePath`); add a test that transcribes a linked recording through `transcribeSource`.

### Minor

**M1 — Old lines and legacy rows for a linked file fail even when the library was not moved.** `fromLibraryPath`/`storedInput` (worker-client `storedInput`, job-journal `fromLibraryPath`) treat any absolute path outside the root as "the library was moved"; an old proxy/OCR line (or legacy row, `legacyJob` → `null` → `INPUT_NOT_FOUND`) whose input was a linked file — legitimately outside the library — now fails once with "the input file does not exist" though the file is there. Probe 3: `["INPUT_NOT_FOUND"]`, 0 sent. Impact is small (a one-time upgrade effect; ProxyQueue/OcrQueue re-run from their own pending lists in source.json), and the brief allowed failing "when it cannot be re-derived". Direction: the old line's `entity` names the asset; accept an absolute input that equals that asset's current `linked.absolutePath` (a lookup over the project's sources), or say in the report that such lines fail.

**M2 — Where a job may write: anywhere inside the library, and through a symlink outside it.** The output guard is lexical containment in the root (`toLibraryPath`, re-checked by `storedJob` at the run). Probe 4: a stored output `library.json` or `<Project>/source-overwrite.json` is published there (library.json overwritten by the job's output, outside governance and audit); `escape/x.jpg`, with `escape` a symlink in the library to an outside folder, wrote `x.jpg` outside the library; an input `escape/y.png` is read from outside. `..`, absolute, drive-letter and backslash forms are all refused (INPUT_NOT_FOUND, never sent). Only someone who can write the plain journal (and, for the symlink, plant one) can do this — in an encrypted project the lines are authenticated (AES-GCM with the project id as AAD), so they cannot be forged without the key — and before the fix such a line could name any absolute path, so the fix strictly narrows it. Direction (hardening, optional): every caller's output is under `.tmp/` (proxies, OCR, `outputFor`, capture `makeWork`); require stored outputs to be under `.tmp/` and check the output's parent with `realpath` inside the root before publishing.

**M3 — Control characters accepted in stored paths.** `LibraryRelativePath` does not reject NUL; `fromLibraryPath` accepts `a/<NUL>/x.jpg`. Probe 7: the worker IS contacted, then the publish throws Node's `ERR_INVALID_ARG_VALUE`, whose message (returned from `resumePending`, not stored) contains the absolute root path; the job is settled as `failed`/`FAILED` once (not retried). An input with a NUL is sent to the worker as is. Direction: reject control characters in `fromLibraryPath` so such a line fails as INPUT_NOT_FOUND before anything is sent.

**M4 — `fromLibraryPath`'s validation of stored relative paths has no test that fails without it.** With the check removed, all 66 tests pass. The run-time re-check in `storedJob` still stops the outside write (probe with the mutant: `../outside/x.jpg` → TypeError, nothing written outside), but such a line then throws before the claim and stays pending — retried at every launch. Direction: a test with hand-written relative lines holding `..`, a leading `/`, a drive letter and a backslash, asserting INPUT_NOT_FOUND, nothing sent, nothing written outside, settled once.

**M5 — The `status !== "destroyed"` filter in `assetOf` is untested.** Removing it fails nothing. It is what stops a pending job on a linked asset destroyed under retention from running on that file. Direction: a test that destroys the asset with a job pending and asserts INPUT_NOT_FOUND, not sent.

**M6 — Old absolute lines stay in the plain journal until compaction** (> 64 lines and half superseded); a small journal may keep them indefinitely (the report's own deferred point — confirmed). Legacy-data only; R379 asks only that they resume. Direction: on the first resume after the upgrade, or at open, compact once if any line holds an absolute path.

## Checked and sound
- I1 closed: whole-library scan after each job kind, plain and encrypted, run to the end and pending: no root, no temporary-folder path; index job rows hold only codes; audit details of the first submission carry only op/process; results and worker meta (absolute) are returned, never stored; failed lines carry an error code only.
- Resolution: relative paths joined to the current root; `..`, `.`, empty segments, leading `/`, drive letters, backslashes refused at the read and (lexically, after `resolve`) at the run; old absolute paths inside the root used and rewritten relative in the claim line (mutation-tested).
- Linked inputs: stored as `input: ""` + `inputAsset`; at run time the path comes from the asset record (relink honoured, a move honoured); source deleted / file missing → one clean `INPUT_NOT_FOUND` with the worker's sentence, not retried; an unlinked asset named with an outside path is refused (mutation-tested). Nothing new is copied into the library.
- Refusal: TypeError with no path, before policy evaluation, audit, journal or worker contact.
- Legacy rows: inside the root written relative, outside → failed `INPUT_NOT_FOUND`; idempotent by id; the crash-between-append-and-DB-update window is unchanged from the base (rows already in the journal are skipped next time).
- Mixed old/new lines for one id: the newest line wins; the claim writes the relative form.
- Base-commit code reading a new journal: it would hand the worker a relative or empty input, which fails as a missing input before any output is published; captures are never resumed. I found no path by which it writes outside the library, short of a service working directory that happens to contain the library's relative input path.
- Encrypted projects: lines still sealed; plain lines cannot be injected (authenticated).
- Existing test changes: only job paths moved into `<Library>/test-files`; the one changed assertion (`job.output` now `"test-files/e.jpg"`) is the intended behaviour; the protocol test's assertions are unchanged; the secret-parameter test still tests the secret check (its paths are inside the library, so the path refusal does not mask it).
- Service resume (`state.ts` resumeWorkerJobs with `transcriptions.rerun`, proxy/OCR queues) passes what the new code expects.

## Could not verify
- A real Python worker on a relative-path job after a move (no Python environment; the stub behaves like the worker for a missing input).
- macOS case-insensitive / NFD roots and a move across disks; on Linux, every path the callers build comes from the same root string, so containment is consistent there.
