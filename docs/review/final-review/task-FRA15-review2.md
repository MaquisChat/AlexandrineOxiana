# Review, round 2 — Task FR-A15 (R400), scoped second look

Reviewer: the same one who did round 1 (`task-FRA15-review.md`). Worktree `.claude/worktrees/fr-a15`, branch `fr-a15-job-journal`, 61c2392 → cac919c (five commits). I read the package `review-FRA15-round2.diff`, the report's "Round 2 (R400)" section and Ruling R400.

## Verdict: APPROVED WITH SMALL POINTS

Clauses (a)–(e) are all built. Each guard R400 names is held by a test that fails when the guard is removed; the one exception is the extra check made just before publishing (M-A below). Every probe from round 1 now gives the right outcome. Nothing found is Critical or Important.

## What I ran (machine load 30–50; no time-limit failures in these files)
- Baseline `job-journal-paths.test.ts`: 25/25.
- **Mutations.** Each one was applied with an exact single-occurrence replacement, the file run alone, and the change reverted with `git checkout <file>`. `git status --short` was empty afterwards; I did not use `git stash`.

  | clause | what was removed | test result |
  |---|---|---|
  | (a) | the `inputAsset` line in `runTranscription` | the "linked in place" test fails ✔ |
  | (b) | the resume check (`placesAllowed` in `resumePending`) | the resume test fails ✔ |
  | (b) | the submit check in `runClaimed` | the submit test fails ✔ |
  | (b) | `real !== work` (`.tmp` itself allowed as the output folder) | the submit test fails ✔ |
  | (b) | the check just before publishing (`worker-client.ts:559`) | **25/25 pass** (M-A) |
  | (c) | `CONTROL` in `fromLibraryPath` | the control-character test fails ✔ |
  | (c) | the `pathless` replacement | the Node-error test fails ✔ |
  | (e) | compaction whatever the size (`absolutePaths` condition) | 3 tests fail ✔ |
  | (e) | the second compaction after the jobs | the "outside the root" test fails ✔ |
  | (d) | — | the implementer's two mutations stand: these are new tests, which I read; I did not mutate them again |

- **Probe** `packages/library/src/r2.probeFRA15.test.ts`, run alone at `nice -n 10`, then deleted. Its results:
  - **`.tmp` is itself a link to an outside folder.**
    - Resume: settled once as `INPUT_NOT_FOUND`, nothing sent, the outside folder stays empty.
    - Submit: TypeError with no path, nothing sent.
  - **The output is `.tmp` itself, or a file directly in `.tmp`:** both settled once as `INPUT_NOT_FOUND`, nothing sent.
  - **A link planted in place of the output folder while the worker runs:** refused by the check just before publishing. The job is recorded `failed`/`INPUT_NOT_FOUND`, and nothing is written outside the library.
  - **Probe 7 again (a NUL in a stored output, relative and under `.tmp`):** both `INPUT_NOT_FOUND`, nothing sent, and the returned errors name no path.
  - **The worker's failure quotes the root in its message and puts a path in its `code`:**
    - The journal holds neither: `errorCode` keeps only `[A-Z0-9_]`, so the stored code is `FAILED`.
    - The error `submit` hands back still quotes the root. This is the deferred point; see below.
  - **The input is swapped for a link to an outside file after the check, while the job waits at the worker:** the worker read the outside file, and its content was published into `.tmp` (M-B).
  - **M6 with the worker down:** after one resume, no line of a plain journal holds the root.
- Round-1 probe 4 is re-covered by the implementer's (b) tests; I read them and mutated their guards. The cases are `library.json`, `<Project>/source-overwrite.json`, `escape/x.jpg` (`escape` a link to outside), `.tmp/esc/x.jpg` (a link inside `.tmp` that leads out) and an input `escape/y.png`. Each is refused at resume and at submit; the files are unchanged and nothing appears outside.

## Per clause

**(a) I1 — closed.**
- `link-capture.ts:392-395` now passes `linked.absolutePath` and `inputAsset` for a linked recording. The test goes through `createLinkCapture().transcribeSource`, the command's own path, and was mutation-checked.
- I grepped every caller of `.submit(` again:

  | caller | input | output | fits the new code |
  |---|---|---|---|
  | `link-capture` `download` | URL | `makeWork()` = `.tmp/capture-*` | yes |
  | `profile-capture` `enumerate` | URL | `makeWork()` = `.tmp/capture-*` | yes |
  | `link-capture` `runTranscription` | linked or stored recording | `<work>/transcript` | yes |
  | `import/proxies.ts` | linked or stored file | `.tmp/worker-proxy-*` | yes |
  | `import/ocr.ts` | linked or stored file | `.tmp/worker-ocr-*` | yes |
  | `transcription-jobs.ts` (service route and `transcriptionRerun`) | linked or stored recording | `.tmp/worker-<id>/transcript` | yes |

  No product caller wrote anywhere other than `.tmp`. The five test files' fixtures lived in `test-files/` only because round 1 had moved them there, so moving them under `.tmp` hides no behaviour. One assertion changed to match: `".tmp/test-files/e.jpg"`.

**(b) M2 — closed, with two small points.**
- The input check follows links: `insideLibrary`, i.e. realpath plus device/inode, or the named linked asset's current file. The output check requires the publish folder, by real path, to lie strictly below `<realRoot>/.tmp`.
- The check is made at submit and at resume. Both are tested and mutation-held.
- It is made once more inside the publish write (M-A).
- **Another project's part of `.tmp`** does not apply: `.tmp` is one shared work folder, not split by project. A job of project A can name an output in another job's `worker-*` folder there, but that stays inside the library's work folder, which is what R400 asks.
- **The path checked is not the path used** (M-B).
  - The worker is handed `job.input` as written, not its real path.
  - `publish` writes to `finalBase` as written.
  - So a link swapped in after the check is followed. For the output the gap is small: the check runs inside the same guarded write, immediately before `publish`. For the input the gap lasts as long as the job waits at the worker.

**(c) M3 — closed.**
- `fromLibraryPath` and `toLibraryPath` refuse C0, DEL and C1 characters. A line holding one is settled before anything is sent.
- `pathless` scrubs every error `resumePending` returns, per job and per project.
- Both guards are mutation-held.

**(d) M4, M5 — closed.**
- Both tests fail without their guard.
- **The destroyed-asset rule cannot be reached in the product today.** `retention.ts:318` refuses to destroy a linked file, and `repo/destroy.ts:113` skips linked assets. Only linked assets get `inputAsset`. I would still keep the rule: it costs nothing, it is right for any future path that marks a linked record destroyed (or a record synced from elsewhere), and failing closed is the house rule. It should not be counted as protection that is active today.

**(e) M6 — closed as the ruling words it.**
- **What it does:** a journal holding any absolute line is compacted whatever its size, newest lines inside the root are rewritten relative (re-sealed when encrypted), and the rewrite goes through `writeFileAtomic`, so it is crash-safe as compaction already was. A second pass after the jobs drops superseded old lines. Job states do not change: tested plain and encrypted, and my probe agrees.
- **When a resume happens:** in the service, at `attachWorker` once the worker is ready (at service start, or when a library is opened with the worker running), and at each unlock (`resumeProject` with `workerJobs`). Only in read-write mode and not during a move.
- **When it never happens:**
  - for a library opened read-only;
  - for a library opened only from the command line (the CLI never calls `resumePending`);
  - while the media worker cannot start (no Python).

  In those cases old lines stay until such a resume. That matches R400 (e) ("at the first resume"). If the coordinator wants the owner's trial journal cleaned without the worker, the rewrite would also have to run at open; that is a ruling question, not a defect.

## Findings

### Minor

**M-A — The check just before publishing has no test that fails without it.** `packages/library/src/worker-client.ts:559`.
- Removing it leaves 25/25 passing.
- It does work: my probe planted `.tmp/late` → outside while the worker ran, and the job ended `failed`/`INPUT_NOT_FOUND` with nothing written outside.
- Smallest fix: add that probe as a test. A stub worker plants the link during the job; assert the job is failed once and the outside folder stays empty.

**M-B — The checked path is not the path used (TOCTOU on links).** `worker-client.ts:697-701` (input), `:559` and `publish` (output).
- The real path is resolved for the check, but the worker gets `job.input` and `publish` writes to `finalBase`, both as written.
- Probe: the input was replaced by a link to an outside file after the check, while the job waited at the worker. The worker read it ("SECRET"), and the result was published into `.tmp`.
- Who could do this: only someone who can write in the library folder at the right moment. In an encrypted project the journal cannot be forged, but the input file can still be swapped.
- Smallest fix: hand the worker the real path that was checked, as `realInsideLibrary`'s own doc recommends ("resolves the real path ONCE, checks that, and reads through it"), and publish into the real `finalBase` computed by the last check. A full guarantee would need `openat`-style handling, which is beyond this task.

**M-C — Doc comments out of order.** `worker-client.ts:877-895`.
- `publish`'s comment ("Moves (or encrypts) …") now sits above `outputInWork`'s comment.
- `outputInWork` and `publish` themselves have no comment directly above them.
- Smallest fix: move each comment to its own function.

## The two deferred points
1. **The worker's `detail` and message are not scrubbed.**
   - **Not stored:** journal lines keep only `errorCode(...)`, which allows `[A-Z0-9_]{1,64}` and otherwise gives `FAILED`. A worker code that is a path is stored as `FAILED` (probe).
   - **Not shown:** the service's transcription screen maps codes to fixed sentences (`transcriptions.ts` 36-86), and nothing reads `WorkerJobError.detail` (grep).
   - **Still quotes paths:** the error that `submit` itself returns (not only `resumePending`'s) still carries the worker's message.
   - **Deferring is fine.** No path reaches the library or a screen. A later pass could run `submit`'s errors through `pathless` as well.
2. **A race between the resume's check and the run is recorded `UNRECOVERABLE`.**
   - **How:** the line passes the resume check, then the same check in `runClaimed` fails (a link swapped in between). It throws a TypeError, and `runClaimed`'s catch claims the resumed record as `failed`/`UNRECOVERABLE`.
   - **What is lost:** nothing. The job is settled once, nothing is sent, nothing is written. Only the code differs from `INPUT_NOT_FOUND`, and the original file is untouched.
   - **Deferring is fine.**

## Could not verify
- The real Python worker.
- macOS firmlinks, letter case and Unicode form for the real-path checks: `insideFolder` folds case and form on darwin; I could only run on Linux.
