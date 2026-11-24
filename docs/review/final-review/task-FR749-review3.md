# FR-749 — review 3: R554's piece and R555's mends (db8623b..e3ecd40), with the R558 c mend

Reviewer: adversarial, checkout `.claude/worktrees/kg-1-look` (detached at e3ecd40, then branch `fr-749-retry-stamp`).
Read: the review rules, R554, R555, R558, R138, R147, R247, the builder's report, and the whole diff (`retention.ts` with `-w`).

## Verdict on the six commits: APPROVED WITH SMALL POINTS, once the R558 c mend below (cabcce3) is in.

R554 holds wherever I cut it: no backup is reported as removed while its file is still there, no failure is recorded because of a close, and nothing under the library changes after `close()` resolved. R555 1, 2, 3, 4 and 6 hold, and each guard has a test that fails without it.

One Important finding is NOT in these six commits' lines: it is older code that point 1 (f) asked about (I2 below). It should be mended before the join, or ruled on.

## Findings

### Critical
None. I looked for the worst case, a backup certified gone while its file is still there. The only record of a removal is the amendment and its audit event. They are built from `r.removed`, and `removeHoldingBackups` adds a file to that list only after `shredPath` succeeded. A cut anywhere before the amendment's turn begins means no amendment at all. After the amendment is committed, nothing throws `StepCutByClose`: the refused report event is swallowed, so a committed amendment is never followed by a cut. `noLongerPresent` is written only for files found missing. I checked this by reading the code, and by probes P-b and P-f below and the five existing closing tests.

### Important

**I1 — R558 c confirmed (the known defect; now mended in cabcce3).**
- Where: `packages/library/src/retention.ts:750–767` at e3ecd40.
- What: the stamp of an attempt was written only when the attempt ended. An attempt that crashes the app leaves no stamp, so every next opening tries it again at once.
- Probe: a destruction whose listed backup could not be removed. One hour later, every attempt crashes at `before-removal-record`. The repository is reopened three times on the same clock, and each time a pass is run:
  - at e3ecd40: `[-1, -1, -1]` (it crashed at every opening);
  - with db8623b's `retention.ts`: `[-1, 0, 0]` (after the first crash, not due).
- What the stamp before the attempt protected: the back-off (`retryDue` reads `lastAttemptAt`), so an attempt that kills the process is not repeated at every opening. It does not protect the once-a-day fresh backup: `lastFreshAt` is written only when the attempt ends, at db8623b as now.

**I2 — a close during the destruction's own change is answered "nothing was changed", although the raw data was destroyed and certified.**
- Where: `retention.ts:433` (older than db8623b, but this is R554's case (f)); `apps/library-service/src/errors.ts:129`; `routes/governance.ts:234–237`; `GovernanceSettings.tsx:1110`.
- Probe P-f:
  - The destruction's change was held at the `retention` folder's mkdir (`seams.beforeMkdir`), the library closed from outside, then the change released.
  - The change committed: one `retention.destroy` audit event.
  - The report event that follows it (`appendLibraryEvent(... "retention.destroyed" ...)`, a second turn) was refused, so `destroyRaw` rejected with `LibraryClosedError`.
  - The folder after `close()` resolved was byte-identical to the folder once everything had settled.
  - The next opening's pass completed the step.
- The route maps the error to 409 `LIBRARY_CLOSED`, "That library has been closed, so nothing was changed." (by reading). The page shows that sentence for a destruction that happened. The route also calls `forgetDestroyed(ended)`, so the players are told the files were not destroyed.
- This breaks R554's "nothing is reported … because of the close", in the opposite direction.
- Direction: after `destroyProjectAssets` has committed, a refusal of the report event because of the close (`cutByClose`) is not an error. The change's own audit event is the authority (R147). Return the destruction as it stands, with status `pending`, as is already done for a cut step.

### Minor

**M1 — writes under `Backups/` after the lock's release, outside the one state writer.** Older code, by probe. R555 4 covers only the state file; R247 c covers everything.
- Where: `export/backup.ts:350–373` (`loadManifest` rebuilds and writes the manifest) and `:1086` (`settlePending` → `discardArchive`).
- Probes, after `close()` resolved, `listBackups(repo, …)` on the closed library:
  - with the manifest missing, it wrote `Backups/backups-manifest.json`;
  - with a pending record of an interrupted backup, it removed that backup's `.tmp-…` archive. Its own state write was refused, so the pending record stays while the file is gone.
- When this can happen: only through a caller still holding the old repository after the close, such as a request that was still in flight.
- Direction: refuse the manifest's writes and `settlePending` on a closed library, as `editStateNow` does.

**M2 — a guard with no test of its own.** `retention.ts:821`: `if (cutByClose(err) || cut()) throw new StepCutByClose()` at the fresh backup. With it taken out, all five closing tests still pass: the `stopIfCut()` right after that block stops the step before `freshFailed` can be recorded. This is harmless, since that guard is redundant, but the line is not held by a test.

**M3 — a test that now proves nothing more.** `apps/library-service/src/close-during-attach.test.ts:190`: with the 100 ms wait removed, the second snapshot is taken straight after the first. The report says so, and no idle signal remains after the service's stop. It is not a loosened expectation, only a check of the same state.

**M4 — "put back byte for byte" has one edge case** (mend; by reading). When a retry pass runs with no state file at all, the stamp creates the file, and putting the record back leaves a file holding empty records. A cancelled backup's take-back of its pending record behaves the same way. This needs a state file removed by hand, because any backup creates the file.

**Seen, older, out of scope.** `writeQueueTurn` (`repo/repo.ts:1551`) and `assertWritable` (`repo/state.ts:266`) still use `holdsTurn()`, under which a stale callback counts as inside a turn. R555 2 changed only the close check, as ruled.

## Points 1–6

| point | verdict | note |
|---|---|---|
| 1 the step at a close (R554) | partly | (a) The folder is byte-identical after `close()` at every cut the tests and my probes reach: fresh backup, between removals, last removal, retry, inherited list, and the destruction's own change. (b) The next opening completes the step with one amendment. An unlisted backup of the same project, one of another project, and the cut pass's fresh backup are untouched; nothing is removed twice; a backup removed before the cut is recorded as "no longer present" with nothing left outstanding (probe P-b, three listed backups). (c) Nothing is certified gone while still there. (d) R138 e's own test in `retention.test.ts` is unchanged and passes. (e) `StepCutByClose` is caught at all three call sites; the CLI does not call these. (f) Does not hold for a close during the destruction's own change: see I2. |
| 2 the retry stamp (R558 c) | did not hold → mended | I1; commit cabcce3 |
| 3 the state file (R555 4, R558 a) | holds (for the state file) | A write queued behind a held write is refused when its turn comes, and the close resolves after the first write. A stale callback of a waited backup is refused after the close. The two tests with a held pass pass. Callers swallow the refusal and record nothing. Other writes under `Backups/` (the manifest, `settlePending`) are not gated: see M1. |
| 4 the close checks (R555 1, 2) | holds | The two earlier probes pass. Also refused: a nested turn (`writeQueueTurn` inside a change), a second change queued by the first when it runs, and a timer that fires while the change runs. Goes through: a stale callback while another change B runs (it waits for B), and a change of library A closing library B. |
| 5 the page (R555 3) | holds | Both branches are tested: `LIBRARY_CLOSED` shows its own sentence and keeps the draft or the edits; the old 409 tests pass unchanged (65 and 53 tests). The sentence is service text, rendered as a text node. |
| 6 the tests | holds | Planted faults, each restored: the per-removal cut taken out → the "between two removals" test fails; the state writer's refusal taken out → all three state-closing tests fail; the two close checks swapped back → test 1 fails; `inRunningTurn` → `holdsTurn` → test 2 fails. See M2 and M3. |

## What I could not judge
- A close that lands while the amendment's change is in its turn. I found no seam to hold that turn, so I read it: the amendment commits; the notes and retry-record writes are allowed (waited work); the report event is refused and swallowed; the amendment is returned. That is true.
- The service-level answer for I2 (route and page) is by reading only. The engine side is by probe.
- No end-to-end run.

## The mend (R558 c) — branch `fr-749-retry-stamp`, commit cabcce3 (from e3ecd40)

**Tests first** (`packages/library/src/retention-closing.test.ts`, a new describe, "the retry record's stamp of an attempt (FR-749, R558 c)"):

(i) "an attempt that crashes the app leaves its stamp on disk …". At e3ecd40 it failed: `expected undefined to be '2026-12-02T11:15:00.000Z'` (the `lastAttemptAt` of the crashed attempt was not on disk). It then checks:
- two more openings a minute apart return `[]`, so the attempt is not made again;
- after the hour, the step completes (`deleted`) and the retry record is gone.

(ii) "a retry pass whose fresh backup is cut by the close …". The destruction's fresh backup is made to fail, so a retry a day later makes one; that retry's fresh backup is held, then the library closed. It checks:
- the state file is byte-for-byte as it was;
- the folder is identical after `close()` and after the pass;
- no step event is written;
- the next opening, one minute later, is due at once and completes the step.

At e3ecd40, (ii) passed, since that code never stamped. With the mend, it fails when the put-back line is removed (checked), as do the existing tests 4 and 5.

On my first draft of (ii): its "no new audit event" assertion was wrong, because the cancelled fresh backup's own decision is audited (R551 I2). It now counts step events only.

**Changed** in `packages/library/src/retention.ts`:
- `:749–761` — the stamp is written before the attempt again, as at db8623b.
- `:762–769` — on `StepCutByClose`, the record is put back to `before` (`setRetentionRetry(repo, key, before)`). This runs inside the step's `inFlight` work, so the close waits for it (R558 a).
- A crash (`SimulatedCrash`) or any other error leaves the stamp. The e3ecd40 "write the stamp on failure" path is removed.
- `:862, :883` — `noted` is restored in the "changed nothing" path.

No existing assertion needed to change. Test 4's `stateFile()` equality and test 5's still hold, through the put-back.

**Run** (each file alone):
- retention-closing 7/7;
- retention 23; retention-confirm 3; retention-old-copies 40;
- export/retention-r147 37 (the R147 crash tests, unchanged); retention-restore 9; retention-check-unmade 1;
- backup-state-closing 3; backup-closing 5;
- `pnpm --filter @ao/library typecheck` clean;
- probe P-stamp after the mend: `[-1, 0, 0]`.

`git status --short` is empty; all probe files are deleted. Not pushed.

## Fix round (R560): STOPPED at the first probe; nothing mended

As the coordinator instructed, the round stops here because a write landed after the lock's release. I2, M1 and M4 are not built. The branch `fr-749-retry-stamp` is still at cabcce3, and `git status --short` is empty.

The probe is kept outside the worktree at `.superpowers/sdd/PLAN/probe-FR749c-stale-callback.test.ts.txt`. To run it, copy it to `packages/library/src/repo/<name>.test.ts`.

### Stale callbacks: every write was refused
Setup: inside a change, callbacks were registered on an unawaited promise chain and on a timer. The change ended, `close()` was awaited, and then the callbacks fired. The folder was byte-identical after `close()` and after the callbacks settled.

| attempt | result | refused by |
|---|---|---|
| (a) a governed change (`importChange`) | `LibraryClosedError` | the turn start in `repo/state.ts:305` (`enqueue` → `refusesNewChanges()`), which is checked whatever context the caller carries |
| (a) `writeQueueTurn(repo)(fn)` | `fn` RAN INLINE, without a turn; the append inside `fn` was refused | the inline run comes from `repo/repo.ts:1551`, which checks `holdsTurn()`; the append is refused at the same turn start. The product's only `fn` (`retention.ts` `strayInTurn`) only reads. |
| (b) `appendLibraryEvent` | `assertWritable` let it through (stale `holdsTurn`); `LibraryClosedError` | `core.serial` → the turn start, `state.ts:305` |
| a timer firing `importChange` | `LibraryClosedError` | `state.ts:305` |

### Viewing-proxy queue: a write lands after the lock's release (Critical, a hole in R546 (1) and R247 c)
Probe: a `ProxyQueue` that was not disposed, with a stub worker, and a source with a pending `image.proxy` job. A stale callback calls `q.enqueue(...)` after `close()` resolved.

What the probe saw:
- At the time of `submit`, with the lock file gone, the library had a new folder `.tmp/worker-proxy-<uuid>`, made by `import/proxies.ts:315` (`fsp.mkdir(work)`), and the worker's output `proxy.jpg` in it. The real media worker writes there too.
- The job's record was refused, and `pendingProxies` was unchanged.
- The folder was removed again by the `finally` (`proxies.ts:380`), so the end snapshot equals the one taken after `close()`. The write is transient, but it happened after the release.

Why the queue does not stop it:
- `ProxyQueue.enqueue` (`:215–216`) checks only `this.worker`.
- `runJob` checks neither `isClosed` nor the closing signal before it writes.

The stale context plays no part: any enqueue or `resumePending` on an undisposed queue after the close does the same.

In the service the path is narrower, by reading only:
- `closeLibrary` disposes the queue before `lib.close()` (`apps/library-service/src/state.ts:1323`), which sets `worker = null`. A fresh `proxyQueueFor` queue has no worker, so `enqueue` does nothing.
- For the service, the hole therefore needs a queue that still has a worker after the close: a caller holding the old queue, or a late `setWorker` on a new queue. I did not prove such a caller.
- The engine itself does not refuse it, and R546 (1) is a rule of the engine.

Direction, for the coordinator to rule:
- `runJob` and `runSource` stop before any write once the library is closed or its session closing; the job stays pending.
- The work folder is made only inside work counted in the close's wait, or the queue is registered with `onClose`.

### Fix round (R560, R562): continued after R562 — built

Branch `fr-749-retry-stamp`, not pushed. Commits on top of cabcce3:
- a6fb92a (P);
- bacba58 (I2);
- b0433c7 (M1);
- c7332f1 (M4).

`git status --short` is empty. The probe copy at `.superpowers/sdd/PLAN/probe-FR749c-stale-callback.test.ts.txt` is superseded by the permanent test.

**Stale-callback probe, kept as a test.**
- File: `packages/library/src/repo/closed-library-stale.test.ts`.
- The callbacks fire after `close()`, from a promise chain and from a timer. Each attempt is refused with `LibraryClosedError` at the turn start (`repo/state.ts:305`):
  - a governed change;
  - `appendLibraryEvent`;
  - `writeQueueTurn`, which runs its function inline; the write inside is refused there.
- The folder is byte-identical. It passes as it stands; there is nothing to mend.

**P — media queues.**
- Test: `packages/library/src/import/queues-closed.test.ts`. An undisposed `ProxyQueue` and an undisposed `OcrQueue`, and a job enqueued, resumed or retried after `close()` resolved. It checks:
  - `.tmp` is watched with `fs.watch` DURING the job, and no `worker-…` entry may appear;
  - the worker stub is never called;
  - the folder is byte-identical, the job stays pending, and nothing rejects unhandled.
- Before the mend: `expected 9 to be +0` (proxy: the worker was asked) and `expected 3 to be +0` (OCR).
- Mend:
  - `import/proxies.ts:217`: `enqueue` refuses once the library is closed;
  - `:304` and `:313`: the job's start returns `PENDING`. The check is made again after the location read, in the same tick as the `mkdir`. `PENDING` is final and never recorded.
  - `import/ocr.ts:114`: `enqueueMany` queues no run once the library is closed;
  - `:234`: the job's start returns `PENDING`.

**I2 — a destruction cut between its change and its report line.**
- Tests:
  - `retention-closing.test.ts`, "a close between a destruction's own change and its report line". The change is held at its `retention` mkdir and the library closed from outside. `destroyRaw` resolves `pending` with no amendments; the folder is byte-identical; the next opening completes the step (`deleted`, verified). Before the mend: `expected { …(1) } to have property "ok"`. A second test: a close before the change began is still `LibraryClosedError`, with nothing written.
  - `apps/library-service/src/close-during-attach.test.ts`, the "R560 I2" describe. The route answers 200 with the true state (`pending`), never `LIBRARY_CLOSED` or its sentence; the folder is byte-identical; after reopening, the scheduled pass lists the certificate `deleted`. A close before the change began still answers 409 with "That library has been closed, so nothing was changed." Before the mend: `expected 409 to be 200`.
- Mend: `retention.ts:438–447`. The report event's refusal with `LibraryClosedError` is caught after the committed change; any other error still throws. The following settle step is cut as before.
- The route needs no change. `forgetDestroyed` runs only when `destroyRaw` throws, which it no longer does here. The page shows the success path.

**What reads `retention.destroyed`.**
- `destruction-record.ts:137`: `auditedDestructions` adds its `certificateSha256` to `certificateHashes`.
- That set is used by `retention.ts` (`scan`, a certificate's `verified`) and by `restore-record.ts:216, 312` (the "earliest form" certificates, those with no `retention.destroy` entry).
- The change's own `delete`/`retention.destroy` entry adds the same hash (`destruction-record.ts:140`) and is the only thing that creates the destruction's record.
- Nothing in the UI, the service or core reads the action.
- **Decided:** the report line stays skipped and is not written later, as for `retention.backups`. The I2 test shows the destruction listed, verified and completed without it.

**M1 — writes under `Backups/` on a closed library.**
- Tests in `export/backup-state-closing.test.ts`, "the manifest and an interrupted backup once the library is closed":
  - with the manifest missing, `listBackups` on the closed library lists the backup from memory and writes nothing; the next opening writes the manifest;
  - with a pending interrupted backup, the temporary file is left and nothing changes; the next opening removes it, clears the record and records `backup-failed`, as before.
- Before the mend: the folder changed (`…(15)` vs `…(14)`; `…(13)` vs `…(14)`).
- Mend in `export/backup.ts`:
  - `:343` `whileOpenOrWaited`: work the close already waits for writes directly; a closed library writes nothing; otherwise the write runs inside `inFlight`, checked and registered in the same tick;
  - used for every manifest write and the unreadable-manifest rename (`:327`, `:371`, `:386`, `:416`);
  - and for the whole of `settlePending` (`:1115`).

**M4 — the state file's absence after a cut.**
- Tests:
  - `backup-state-closing.test.ts`, "no state file before a cut": a first backup cancelled by the close. The file is absent before and after, and the folder is byte-identical after `close()`.
  - `retention-closing.test.ts`, "no state file before a cut retry attempt": the state file removed by hand, a retry's fresh backup cut by the close. The file is absent afterwards.
- Before the mend: `expected true to be false`, twice.
- Mend:
  - `export/backup.ts:580`: `writeState` with `dropIfEmpty` removes the file when nothing is left in it. `isEmptyState` and `backupStateExists` are at `:596`.
  - `withState`, `editStateNow` and `setRetentionRetry` take that option.
  - The backup notes `stateWasAbsent` before its pending record (`:1267`) and passes it on a cut take-back (`:1430`).
  - `retention.ts:756` and `:777`: the step notes the absence before its stamp and passes it on the put-back.
  - A file that existed before, even with empty records, is never removed.

**Not done (as ruled):** M2, M3.

**Runs** (each file alone, `nice -n 10`).

`@ao/library`:

| file | tests |
|---|---|
| repo/lock-mid-read | 44 (650 s) |
| export/backup-closing | 5 |
| export/backup-governed | 22 |
| export/backup-manifest-d15 | 13 |
| export/backup-r138 | 20 |
| export/backup-read-fails | 1 |
| export/backup-state-closing | 6 |
| export/backup | 23 |
| export/restore-governed | 72 |
| export/restore-lock-state | 15 |
| export/retention-check-unmade | 1 |
| export/retention-r147 | 37 |
| export/retention-restore | 9 |
| export/closed-reads | 3 |
| import/in-library | 32 |
| index/index | 58 |
| repo/audit-reasons | 32 |
| repo/recovery-code | 27 |
| repo/restore-sealed-purposes | 12 |
| repo/review-held | 67 |
| retention-closing | 10 |
| retention-old-copies | 40 |
| retention | 23 |
| retention-confirm | 3 |
| repo/closed-library | 6 |
| repo/closed-library-stale | 1 |
| import/queues-closed | 2 |
| repo/close-inside-change | 3 |
| library | 35 |
| repo/lock-guards | 7 |
| export/project-export | 18 |
| service-support | 31 |
| job-journal-paths | 25 |
| import/attach | 69 |
| import/bulk/bulk | 103 |
| import/watch | 143 |
| import/attach-closing | 5 |
| import/zotero-local | 85 |
| import/device | 28 |

`@ao/library-service`:

| file | tests |
|---|---|
| close-during-attach | 13 |
| fieldwork-governance | 23 |
| media | 34 |
| server | 160 (+1 skipped) |

All passed. Typechecks of `@ao/library` and `@ao/library-service` are clean. The UI is unchanged.
