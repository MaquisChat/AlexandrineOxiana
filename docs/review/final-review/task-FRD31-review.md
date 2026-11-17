# FR-D31 — review of the fix for defect D31 (R393, R413)

Worktree `.claude/worktrees/fr-d31`, branch `fr-d31-import-failures`, 7537f63..5b556cf (six commits). Package `review-FRD31.diff` read in full; briefs, report, R393 and R413 read in full.

## Verdict: NOT APPROVED

Part 1 (the kind of each failure, the grouped report, the notes above the failures, the log lines) and the torn-append fix are sound. The run-time stop for a full disk works for the four places the brief named. But four things are still wrong:
- One way in still loses items to a full disk and reports something false: unpacking a ZIP.
- The pre-flight check refuses imports that would fit.
- One stop sentence sends the researcher to a Resume that is refused.
- The task's own service test fails about one run in three.

## What I ran (all at nice 10, each file alone)
- The implementer's tests: `disk-full.test.ts` 8/8, `space.test.ts` 9/9, `failure-cause.test.ts` 5/5, `io-append.test.ts` 3/3 (prlimit present), `import-log.test.ts` 1/1, `StepReport.test.tsx` 24/24, `StepScan.test.tsx` 2/2.
- `apps/library-service/src/import-disk-full.test.ts`, on a real tmpfs (it can be mounted here). It failed in 2 of its first 2 runs: test 1 once, test 2 once. I then copied it into a probe with diagnostics and ran it 17 more times: 5 more failures (see I4).
- Probe `bulk/a.probeFRD31.test.ts`, using the same mock harness as `disk-full.test.ts`. P1: a ZIP whose unpacking hits ENOSPC. P2: a re-import of a folder already imported. P4: an item's change fails with ENOSPC and its rollback cannot write.
- Probe `apps/library-service/src/b.probeFRD31.test.ts`: the service test with the report, statfs, batch.json and the service log printed.
- Mutation testing (take a guard out, see its test fail) was **refused by the session's permission system** (editing a tracked file). See "could not verify".
- All probes are deleted. `git status --short` is empty, and no tmpfs is left mounted.

## Findings

### Critical
None found.

### Important

**I1. A ZIP whose unpacking hits a full disk is recorded as "could not be read". The item is lost to Resume and the batch says "finished".**
- Where: `packages/library/src/import/bulk/scan.ts:262-268` (`zipItems` catches every `extractArchive` error) and `run.ts:1097` (an `unreadable` item becomes a `failed` line).
- Probe P1 (extractArchive throws `code: "ENOSPC"`):
  `P1 state finished counts.failed 1 lines [{"key":"a.zip","outcome":"failed","reason":"The archive could not be read, so its files were not imported."}]` and `notes []`.
- So the whole archive is one failed line with a false reason. The batch is not resumable, and a resume would pass the archive by anyway.
- The unpack writes into the library's own `.tmp`, on the same disk. This is exactly the "write of the run" that R413 b says must stop the batch. The pre-flight counts a ZIP's declared bytes once, but at peak the disk holds the unpacked archive in `.tmp` plus the copies.
- Related (Minor, existed before this task): a real ENOSPC during the Zotero database copy, after the space check has passed, is reported as "its zotero.sqlite is missing or damaged" (`zotero-local.ts:121-128`).
- Direction: let a full-disk error from the unpack (and from the database copy) end the scan as the batch's condition (rethrow it, so the run's catch gives DISK_FULL_NOTE) instead of yielding an unreadable item. In the pre-flight, count the ZIP's unpack room as well.

**I2. The pre-flight check refuses imports that would fit: it counts files that will not be copied.**
- Where: `run.ts:2744-2763` (the dry run adds an item's bytes to `totalBytes` before the unsupported-type and already-imported tests); `space.ts:197-203` (`cheapEstimate` = every file under the folder, or under Zotero's `storage/`); `run.ts:620-632`.
- Probe P2: 3 files of about 2 MB are imported. One small new file is added, and the free room is set to 4 MB with a 1 MB margin.
  - Dry run: `totalBytes 6002820, copyBytes 6002820, alreadyImported 3`, `spaceWarning "This import would copy about 6 MB … only 4 MB free…"`.
  - The start is refused with the same sentence, although only a few kB would be copied.
- The researcher's case: re-importing a Zotero library imported earlier (incremental, the way forward R393 d itself names), or any re-import of a folder.
  - A 20 GB library on a disk with 15 GB free is refused as "would copy about 20 GB" every time, even when it would copy almost nothing.
  - Without a dry run, `cheapEstimate` counts all of `storage/`, including attachments of items in the bin and HTML snapshots, which are never imported.
- Direction: leave out of the dry run's number what the run will not copy (already-imported shas, in-scan duplicates, unsupported types). For an incremental source, either do not use a cheap total that cannot tell, or skip the check and rely on the per-file check.

**I3. A full disk whose rollback also fails gets the disk-full sentence, and the Resume it advises is refused. The (c) sentence points to a place that does not exist.**
- Probe P4: an item's change fails with ENOSPC, and its undo cannot write (`seams.failUndo = "dir"`).
  - `P4 state failed failed 0 notes ["The import stopped because the disk is full. Free some space, then resume the import."]`.
  - Then `resumeBatch` → `RecoveryPendingError … Check the library's integrity warnings, then reopen the library`. The service maps this to 409 "…see the library's integrity warnings" (`apps/library-service/src/errors.ts:179`).
- But a rollback that fails during the session (`mutate.ts:524-531`) pushes no integrity warning and no project warning. I found no `integrityWarnings.push` on that path, and `projectWarnings` does not report `recoveryPending` alone.
- So nothing on screen matches either "Open the project's notices, settle it" (RECOVERY_NOTE, `space.ts:98`) or "see the library's integrity warnings". What actually settles it is reopening the library.
- The first agent's experiment H6 hit exactly this, a rollback that fails on a full disk, so it is not theoretical.
- After an app restart: the in-memory note is gone, and the batch shows "The import was interrupted." with no reason. Resume then works, because the open finishes the rollback. That outcome is acceptable, but nothing says so.
- Direction: when the run stops and the project is now `recoveryPending`, show the recovery sentence whatever the error was. Word that sentence by what exists ("Close and reopen the library, then resume the import"), or add the notice the sentence names. **Needs the coordinator's ruling**: the wording is from the round-2 brief.

**I4. The task's own service test fails intermittently, from a race in the service that predates this task: a Resume answered 200 that does nothing.**
- Where: `apps/library-service/src/import-disk-full.test.ts:183/191/197`. The cause is `routes/import.ts:134-138` together with `state.ts:939-951`.
- Failures: 2 of my first 2 runs of the file, then 5 of 17 runs of the probe copy.
- In a failing run, after `POST /imports/:id/resume` (status 200 `{"action":"resume"}`), batch.json still has the first run's `finishedAt` and `stopCause: ENOSPC`. The log has one "bulk import stopped" line, the first run's, and statfs shows 67–100 MB free.
- So the resumed run never started. The engine's listing already says `failed`, but `s.batches` still holds the finished run's handle until `followBatch`'s `finally` runs. The route then calls `handle.resume()` on a dead run and answers 200.
- A researcher would meet this only by pressing Resume in that short window. The test meets it often, because it resumes as soon as the listing says `failed`.
- Direction: in the route, treat a handle whose run has settled as not running. In the test, wait for the service to have let the batch go (its end event) before resuming.

**I5. The pre-flight sentence reads as false whenever X is under Y but X plus the margin is not, which is the usual case on a nearly full disk.**
- Where: `space.ts:90-93` and `run.ts:630`.
- With the real margins, a 50 MB import on a disk with 400 MB free is refused: "This import would copy about 50 MB of files into the library, but its disk has only 400 MB free." The implementer's own test asserts `fitSentence(3e6, 100e6)` in exactly this form.
- The Zotero database copy is also part of the need but not of X.
- The two numbers are true. The sentence reads as a contradiction, and a researcher has no way to learn that 500 MB is being kept free.
- Direction: say the room needed ("needs about X, including room the library keeps free"), or put the margin and the database into X. **Needs the coordinator's ruling**: the sentence is R413 a's verbatim. The 500 MB floor also refuses any copying import on a small external disk with less than about 0.5 GB free; the ruling may want that stated.

### Minor
- **M1.** `space.ts:128` and `run.ts:1422`: a remembered dry run has no age limit and is preferred over a fresh cheap total, even one that says the files do not fit. The implementer's test pins this behaviour. A dry run of a near-empty folder yesterday lets a start of 50 GB through; the per-file check still stops it. Direction: use the larger of the two, or forget dry runs after a while or when the folder changed.
- **M2.** `run.ts:1422`: `cheapEstimate` runs inside the POST /import request, without a signal, before the policy refusal. Up to 1,000,000 `stat` calls (more on a network share) block the request and cannot be cancelled. A denied import walks the folder first.
- **M3.** `run.ts:1371`: the log keeps up to 20 stack frames with absolute program paths. On a Mac with the app in `~/Applications`, that path holds the user's account name. This is allowed by "the program's own stack" in R393 b, but worth one line in FR-686.
- **M4.** `io.ts:143`: the write loop would spin forever if `writeSync` ever returned 0 for a non-empty buffer. That is not expected on a regular file; a guard costs one line.
- **M5.** `failureGroups` is duplicated in `report.ts` and `StepReport.tsx`. The UI cannot import the library, so this is acceptable, but the two copies can drift.
- **M6.** `unsavedStops` entries are never removed except by a later run of the same batch, which is a small in-memory leak.
- **M7.** Zotero Web still checks downloads against a 64 MB floor and imports an item without its file ("not enough free disk space") rather than stopping. The 200 MB per-file check usually stops the batch first; items without files are the exception.

## Checked and sound
- Part 1 on the probes and the tests:
  - `causeOf` and `errorForLog` never repeat a message. A code or name that is not an identifier is dropped. Causes up to 4 levels deep are found.
  - The service logs only "bulk import …" notes. Other notes reaching the sink ("metadata lookup failed: <message>") are filtered out.
  - The report's counts add up.
  - Notes are placed above the failures in both `report.md` and the screen, through `UserText`. A group of more than 10 is collapsed in `<details>`.
- R413 b at the store, the journal inside the change, the checkpoint and the group commit: no failed line, and the change's own rollback leaves no source folder (the tests and my P4 harness agree). The per-file check runs before anything of the item is written, and a resume imports every item once. These hold when the resume actually starts (my service-probe runs that passed: 30 distinct keys, 0 failed, 30 files copied).
- R413 c: the first `RecoveryPendingError` stops the batch, with no item failed for it.
- The pre-flight is skipped for "link in place". It runs before `authorizeProcessing`, so nothing is written or audited on a refusal. A disk that cannot tell (Infinity) skips the check.
- R413 d: the database copy gets `reserveBytes`.
- The seams are honoured only with NODE_ENV=test, and only tests set them. The desktop shell starts the helper with a cleared, allow-listed environment.
- The torn-append fix: the remainder is written, or the append is undone by truncating, and its test fails for the right reason (EFBIG under `prlimit --fsize`).
- The new `deps.repo.getProject` before the space check keeps an unknown project a NotFoundError.

## Could not verify
- **That each guard is held by a test that fails without it.** Editing `run.ts`/`io.ts` in the worktree to remove a guard was refused by the session's permission system, so I relied on reading and on the implementer's "failed first" claims. By reading: removing `isDiskFull` from `itemError` or `flushInner` would fail `disk-full.test.ts`'s `counts.failed === 0` and no-retry assertions, and removing `roomFor` would fail the per-file test.
- Undo of a batch stopped by a full disk (not probed).
- APFS behaviour (purgeable space, cloud folders, statfs on a network quota). There is no Mac here.
- The owner's real cause: still not proven on their machine.
