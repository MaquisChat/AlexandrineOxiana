# FR-D31 — scoped second look at rounds 3 and 4 (R436, R439)

Worktree `.claude/worktrees/fr-d31`, 5b556cf..fa7acdb (nine commits). I read the package `review-FRD31-round3.diff` in full, the report's sections "Round 3" and "Round 4", and R436 and R439 in full.

## Verdict: NOT APPROVED (one Important finding, with a one-line fix)

My five findings from round 1 (I1–I5) are closed. One new problem: the disk-full answer that R439 added is shown on the screens behind a false lead sentence.

## What I ran (nice 10, each file alone)
- **Library tests:**
  - `bulk/disk-full.test.ts`: 14 of 14. It now holds my P1 and P4 probes, plus the Zotero and Calibre database copies.
  - `bulk/space.test.ts`: 14 of 14. It now holds P2, the 30-minute window and the "no dry run" start.
  - `repo/io-append.test.ts`: 4 of 4.
- **Service tests:**
  - `import-disk-full-answer.test.ts`: 3 of 3.
  - `server.test.ts -t "R436 e"`: 1 of 1.
  - `import-disk-full.test.ts` (real tmpfs): 6 runs of 6 passed.
- **The I4 race against the new route:**
  - I ran round 2's version of the service test (`git show 5b556cf:…`) as a probe. That version resumes as soon as the listing says `failed`, while the ended run's handle is still kept.
  - It failed 7 runs of 19 before. Now it passed 8 runs of 8, so the route itself closes the window, not only the test's wait.
- **Probes:**
  - UI: `errorText` of the disk-full answer, both in the import screens' version and the library API's.
  - Library: rounding in `fitSentence`.
- All probes are deleted, `git status --short` is empty, and nothing is left mounted.
- Mutation testing (taking a guard out to see its test fail) was refused by the session's permission system, as in round 1. The guards below are judged by reading and by the report's "failed first" claims.

## Findings

### Important
**J1. On the screens, the disk-full answer reads "The library service could not be reached. The library's disk is full. Free some space and try again."**
- Where: `apps/library-service/src/errors.ts:198` answers `503` with code **`UNAVAILABLE`**. The UI's tables give that code its own lead sentence:
  - `packages/ui/src/screens/import/shared.tsx:59` (`CODE_TEXT.UNAVAILABLE`);
  - `packages/ui/src/api/library.ts:427` (`CODE_LEAD.UNAVAILABLE`).
- Both `errorText`s put the lead first. Probe output:
  - `IMPORT: The library service could not be reached. The library's disk is full. Free some space and try again.`
  - `LIBRARY: The library service could not be reached. The library's disk is full. Free some space and try again.`
- Who meets it: the import wizard's dry run (ImportWizard.tsx :195 and :227 use `errorText`), and every other screen that uses these helpers. The researcher is told the service is unreachable when it answered.
- This breaks R439 (1) ("said in plain words"). The test checks only the service's JSON body, so it does not catch this.
- Not a retry loop: `isStreamCutOff` only treats status 0 as a cut-off, and I found no 503 retry in the client.
- Smallest fix: give the answer its own code (e.g. `DISK_FULL`, still 503) that the UI tables do not prefix. Alternatively, suppress the lead when the service sent a message for `UNAVAILABLE`. Add one UI test of the rendered sentence.

### Minor
- **J2. A Resume can still be answered 200 for nothing in one window.** (`routes/import.ts:225-237`)
  - The new check catches a settled handle, and a run whose record already says it stopped.
  - The gap: the run's last phase, from the stop decision to the final `checkpoint`. That covers `watchdog.close`, `cleanup` and the final `flush`, which stores a queued group of up to 32 items with their files (run.ts about :1050–1080).
  - In that phase the record still says `running` and the handle has not settled. So the route calls `handle.resume()` in place, which only clears `paused`/`suspending`, and answers 200.
  - The screens show the batch as running then, so a researcher rarely has a Resume to press.
  - Smallest fix: have the run set a flag once it has decided to end, and let the route treat that like "settled" (wait for `done`, then resume from the record).
  - The route's "ending → wait for done" branch has no test of its own: the server test covers only the settled-handle branch.
- **J3. "The library's disk is full" can name the wrong disk.** (`errors.ts:198`)
  - The mapping applies to every route, including `POST /libraries/move`: its error goes through `ndjsonError` (`routes/libraries.ts:216-226`), and `executeMove` has no space check of its own.
  - So a destination disk that fills mid-move would be reported as "The library's disk is full", while the library's own disk is fine.
  - Smallest fix: a move-specific sentence ("The disk you are moving the library to is full…"), or a neutral wording. **Needs the coordinator's ruling:** R439's sentence is verbatim.
- **J4. Approving outside files on the scan step switches the start's room check off.** (`space.ts:1277-1287`, `ImportWizard.tsx:190/205/210`)
  - The remembered dry run is keyed by approvals as well. The wizard's dry run carries none, and approvals are chosen afterwards on the scan step.
  - So any start that has approvals finds no dry run, and its start is not checked.
  - This is safe (R436 b: no number, no refusal; the per-item check protects), but the warning the scan step showed is then not enforced. No test covers the approvals key.
  - Direction: key without approvals and let the start add or subtract the approved files' bytes, or accept this as ruled and say so.
- **J5. Rounding can make the sentence read "needs about 9.9 GB … but only 9.9 GB is free".** (`space.ts:58-61`)
  - This happens when need and free round to the same figure, e.g. 9.04 GB of files needs 9.94 GB with a free 9.86 GB.
  - Smallest fix: when the rounded figures are equal, show one more decimal, or round the need up.

## The other side of each (asked)
- **(a)**
  - An unpack cut short leaves nothing under `.tmp`: `zipItems` removes `dest` before it rethrows (tested with a partial file written). A resume unpacks again and imports each file once (tested: 3 keys, 3 sources).
  - A dry run's unpack hitting a full disk: `dryRun`'s `finally` removes its folder, and the service answers 503 with the sentence and no path or system text (tested). The screen text has the J1 lead.
  - A truly damaged archive is still one failed line.
- **(b)**
  - A first import: the dry run counts what the run copies (equal in the tests).
  - A re-import: only new files are counted (P2: 5000 bytes).
  - In-scan duplicates and kinds that are not imported are left out.
  - "Leave the files where they are" skips the check.
  - Zotero linked files: `linkedBytes` is subtracted only when they stay links, and the wizard's "copy linked" choice makes them count.
  - A dry run of another project or another source is not used (the key holds project, kind, location and approvals).
  - A dry run 29 minutes old after the folder grew is used, and the start passes. The per-item check stops it cleanly, at most one item's files plus 200 MB short.
  - Under-count: new attachments of an item whose first file is already imported (an incremental update). This is bounded by those files, and the per-item check stops cleanly.
- **(c)** The figures add up (N = files + database copy + margin, and the refusal uses the same sum). 50 MB of files with 400 MB free gives "needs about 550 MB … (50 MB of files to copy, and room the library keeps free to work), but only 400 MB is free." The scan step shows the service's same sentence. See J5 for the rounding edge.
- **(d)**
  - The sentence follows `recoveryPendingProjects`, whatever the error: `DISK_FULL_UNDONE_NOTE` after a full disk, `RECOVERY_NOTE` otherwise.
  - After closing and reopening the library, a resume imports every item once (both tests).
  - Nothing says "the project's notices" any more (grep is empty).
  - After an app restart the in-memory note is lost and the batch shows "interrupted". That restart is itself the advised reopen, so Resume then works.
- **(e)**
  - Two Resumes at once: both reach `resumeBatch`, whose synchronous `active` check refuses the second (409).
  - Resume while truly running: the record says `running`, so the run is resumed in place and no second run starts.
  - Resume of a finished batch: 409, also when the finished run's handle is still kept, since the route waits and then reads `finished`.
  - The wait ends when the run's `done` settles, which every path of the run reaches. A hung final save would hold the request, the same as the run.

## Still sound (spot-checks from round 1)
- `causeOf`/`errorForLog` and the service log filter are not touched by these rounds.
- The test seams are still honoured only with NODE_ENV=test.
- The pre-flight still runs before `authorizeProcessing`, so a refusal writes nothing (`nothingWritten` passes in the changed tests).
- A full disk at the store, the journal, the checkpoint and the group commit: all still pass.

## The new guards and their tests (judged by reading; mutation refused)
Each of these has a test that would fail without it:
- the rethrow in `zipItems`, `scanZotero` and `scanCalibre`;
- the dry run's counting (P2, kinds and copies);
- the 30-minute window;
- `fitSentence`;
- the `refusing` branch, with both sentences;
- the route's settled-handle branch;
- `io.ts`'s `n <= 0`;
- `toApiError`'s `isDiskFull`;
- the "Size of the new files" label.

Not held by any test:
- the route's "ending → wait" branch (J2);
- the approvals part of the scan key (J4);
- the screens' rendering of the disk-full answer (J1).
