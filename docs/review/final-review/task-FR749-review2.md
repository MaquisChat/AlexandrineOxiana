# FR-749 fix round (R551) — second look (adversarial)

Checkout `.claude/worktrees/kg-1-look`, detached at db8623b. Reviewed: the seven fix-round commits `19b05e7..db8623b` (34 files, read once in full). Also read: R546, R547, R551, R554 (its backups step is outside this review), R247, the first review, the fix report and the first build's report. All probes were deleted afterwards and `git status --short` is empty. No commits were made. Every product edit was a planted fault, put back at once with `git checkout --`.

**Verdict: APPROVE WITH SMALL POINTS.** All three Important findings of the first review are closed, and each is held by a test that fails without its guard (checked by planted faults). No Critical or Important finding. Six Minor points; none needs to be mended before the join. Points 1 and 2 are cheap and worth doing.

## What I ran

**The existing tests, each file alone, all passing:**
- `@ao/library` `repo/closed-library.test.ts` 6/6
- `export/backup-closing.test.ts` 5/5
- `import/bulk/bulk-closing.test.ts` 2/2
- `import/attach-closing.test.ts` 5/5
- `@ao/library-service` `close-during-attach.test.ts` 11/11

**Planted faults** (each restored):

| Fault | Result |
|---|---|
| `library.ts` `await Promise.allSettled(ctl.drains…)` changed to `void` (I3) | `closed-library` fails 2 tests: "the lock is still there while the change is in its turn: expected false to be true" |
| `backup.ts` `inFlight` no longer registers its drain with `onClose` (I2) | `backup-closing` fails 3 tests: the folder differs after `close()` resolved (25 entries vs 26) |
| `run.ts` `itemError` without `if (isClosingCut(err)) throw err` (I1) | `bulk-closing` fails: "expected 'finished' to be 'paused'" |
| `proxies.ts` without `outsideClosingScope` (M3) | `attach-closing` fails the M3 test (the proxy job stayed pending) |

**Probes, all deleted:**

`packages/library/src/export/close-edges.probeFR749b.test.ts`, six cases:
- **M2 with a stale turn context.**
- **M2 after M1.**
- **`beforeRelease` throws.**
- **`close()` from inside a backup's step:** no deadlock. The backup is cancelled and the close resolves.
- **Two backups in flight at a close:** one manual, one scheduled in an ENCRYPTED project. The manual one is cancelled, the scheduled one returns `null`, nothing is recorded, and the folder is byte-identical after `close()` and after everything settled.
- **Backups queued behind a held one on the maintenance lock** (one manual, one `backupIfDue`): both end cancelled or `null`, nothing is written after `close()`, and no backup is listed.

`apps/library-service/src/close-edges.probeFR749b.test.ts`:
- **Bulk Import of 8 PDFs, cut twice.**
  - The first 4 lookups answer 404, then every lookup answers 429 / Retry-After 60. `POST /libraries/close` came during item 5's lookup.
  - At the cut, the 4 queued items were stored by the closing checkpoint's flush (the library was still open). Their journal lines were written in the same change. The run sent nothing more (5 requests).
  - The whole folder was byte-identical right after the close and 300 ms later. `.tmp/` was empty: the work folder was gone before the release.
  - Reopened: the batch was `paused`. Resumed, then cut again after 2 more items: 6 sources, 6 lines. Reopened again: `paused`.
  - Resumed with the service answering: `finished`, 8 items, failed 0, **8 sources, 8 journal lines, each key once**. No unhandled rejection.
- **Encrypted project, backup held at its snapshot, `POST /libraries/close`.**
  - The key ring held its key while the close waited (needed by a change in its turn).
  - After the close resolved, the ring was empty and the old key buffers were all zeros.
  - The backup answered 409 `LIBRARY_CLOSED` with the ruled sentence. `Backups/` held only `backups-state.json`.

`apps/library-service/src/worker-close.probeFR749b.test.ts` (point 9), with the stub media worker of `transcription-jobs.test.ts`:
- A transcription was running and polled when `POST /libraries/close` came.
- The whole library folder, the job journal and `.tmp/` included, was byte-identical right after the close and 1.5 s after the stub was released.
- The client stopped polling (3 → 3), and the run was cancelled.

## Findings

### Critical
None.

### Important
None.

### Minor

**1. M2's guard is bypassed once a close is already waiting: a change in its turn that calls `close()` waits for itself for ever.**
- Where: `packages/library/src/library.ts:465` checks `if (ctl.closing) return ctl.closing` (M1) before the M2 test at `:468`.
- What happens: an outside `close()` is waiting for the turn. If the change in that turn then calls `lib.close()`, it is handed the first close's promise. That promise waits for the change's own turn, so the two wait on each other.
- Probe "M2 after M1": the inner `close()` had not settled after 2 s (cut by my race; without the race the change and both closes hang for ever). Once the race let the change end, the outer close resolved.
- No product caller does this today (the first review grepped; so did I: every `closeLibrary()` call is in a route or in shutdown).
- Direction: put the `holdsTurn` check before the M1 return, and add one test.

**2. M2's guard also misfires: `close()` from a callback registered INSIDE a change, run after that change ended, is refused with `CloseInsideChangeError`, and the library stays open.**
- Where: `repo/state.ts:339`. `holdsTurn()` reads the `inTurn` AsyncLocalStorage, which "a timer or callback started inside a turn carries … even after the turn has ended" (the file's own comment, :145).
- Probe: inside `importChange`, `gate.then(() => lib.close())`; the gate is released after the change resolved. The result was `CloseInsideChangeError`, closed `false`, `.lock` present.
- In the service, `closeLibrary` swallows the rejection (`.catch(() => {})`). It would then clear the keys and drop the session, but keep the lock and heartbeat until the process exits.
- No such caller today: every `closeLibrary()` call is in a route or in shutdown. By reading.
- Direction: either accept this and say it in the doc comment, or tell the running turn apart from a stale context (compare with `this.running`, as `admitsOnlyRunningTurn` does).

**3. A `LIBRARY_CLOSED` 409 reaches page code that reads every 409 as "changed elsewhere".** By reading.
- `packages/ui/src/screens/GovernanceSettings.tsx:240`: any 409 shows "These rules were changed elsewhere — reload to see them." This is false for a save the closing library refused.
- `YourLibrary.tsx:437` and `:520` drop the researcher's draft on any 409 ("a newer file meanwhile") and read again. The shown sentence there is the service's own (`sentenceOf`), so it is true; only the draft is lost.
- Others are harmless: `SearchSources.tsx:382`, `WatchedFolders.tsx:484/647` and `FindAcquire.tsx:1491/1997/2043` read again or relist on a 409. That read then answers 503 "No library is open." (handled), so no loop starts and none retries for ever.
- The window is narrow: the request must take the session before the close begins, and its change must reach the engine after it.
- Before this round the same race answered 503 LIBRARY_OFFLINE, which none of these branches caught.
- Direction: have these branches test `err.code === "CONFLICT"` (or exclude `LIBRARY_CLOSED`).
- No polling loop in the page, the extension or the CLI switches on 503 in a way that now stops or never stops. The extension special-cases only 503 LIBRARY_OFFLINE; a 409 falls to its general message, which is the service's sentence.

**4. A retention pass that outlasts the close's grace period can still write `Backups/backups-state.json` after the release.** By reading; adjacent to R554 and NOT its backups step.
- Where:
  - `resumeLocked` ends with `setDestructionNotes` (`retention.ts:1077`), which writes through `withState` (`backup.ts:1608`);
  - `syncOldCopies` ends with `setOldCopiesNotes` (`retention.ts:1668`).
  - Both are direct file writes, and neither is registered with the close's wait. Only backups are, through `inFlight`.
- In the service, the pass runs inside the scheduled-backups work, which `closeLibrary` waits for at most `CLOSE_GRACE_MS` (30 s). After that, `lib.close()` proceeds.
- A pass still running then has its reads refused (`LibraryClosedError` becomes `firstError`). It still reaches `setDestructionNotes` whenever its `notes` differ from what was found. A refused `logHolds()` stops that, but not every path calls it.
- The M6 mend (an early `isClosed` return, and the scan refusal caught) covers a pass that BEGINS after the close, not one already under way.
- Direction: for the coordinator, either fold it into R554's builder (register the whole retention maintenance section with the close's wait, not only the backups step) or leave it noted.

**5. `close({ beforeRelease })` swallows the step's error.**
- Where: `library.ts:474-478`.
- Probe: `beforeRelease` throws. Then `close()` resolves, the handle is closed and the lock is released, so the error never reaches the caller.
- This is documented in the comment, and both callers already wrap `index.close()` in try/catch. So nothing is lost today, but the brief's "error surfaced?" is answered no.
- Direction: return it as a rejection after the release, or log it.

**6. Several new tests wait with a sleep rather than for the true resting state.**
- `backup-closing.test.ts:94`: `setTimeout(50)` before the second snapshot.
- `close-during-attach.test.ts:190`: `setTimeout(100)` (the M8 stop test).
- `close-during-attach.test.ts:296`: a 50 ms polling loop (`settledBatch`).
- The I3 test polls the lock for a bounded 300 ms, but it asserts order through a held promise and an ordered log, as asked.
- The tests are still discriminating: each planted fault above failed them. But the second snapshot proves "nothing more after N ms", not "nothing more ever".
- Direction: await the work's own promise, or `svc.state.idle()`, where one exists.

### Checked by reading, and noted (not findings of this round)
- **A batch whose suspend times out** (`SUSPEND_TIMEOUT_MS`) is cancelled and waited for a bounded time, as before. A store it attempts after the release is now refused, and with I1 the batch ends paused, which is right. But its `cleanup()` (`run.ts:898`, `fsp.rm` of `.tmp/batch-*`) can still run after the release. This is older than FR-749 and was said in the report.
- **A service stop forced at `FORCE_EXIT_MS`** (90 s) while a cancelled backup shreds a very large partial temp file can leave that temp file. `sweepTemps` removes it at the next backup, not at opening. It is ciphertext for an encrypted project, so nothing of an encrypted project is left in the clear. Older behaviour; the window is the shred time.
- **A failed release.** `release()` can throw (`unlink` other than ENOENT). The first `close()` then rejects, and every later call returns that same rejection, so the release is never tried again. Acceptable.

## The points

| # | point | verdict | note |
|---|---|---|---|
| 1 | I1, Bulk Import | **holds** | Items are processed one at a time; there is no concurrency in the run, so "3 lookups in flight" does not arise. Cut in the lookup: paused, nothing journaled. Queued items at the cut are flushed while the library is still open (probe: 4 stored, journaled once). Cut after the engine closed: refused, paused or interrupted, reprocessed on resume (`bulk-closing` test 2). Cut twice: 8 sources, 8 lines, each once. A new client after the old one's `stop()`: the resumed run uses the new session's client (`deps.http` per session); probed. `.tmp/batch-*` is empty after close (byte snapshot). Order `beginClosing` → `suspendBatches` is right. A stuck batch: see "noted". Zotero web: by reading only. |
| 2 | I2, backups | **holds** | Cut at each `step()` and inside the zip's sink. After the commit point, the remaining steps (temp removal, manifest, state) run inside `inFlight`, so before the release. A cut before the commit turn starts is refused and treated as a cancel: the renamed file is discarded and the pending record removed. Two backups, a queued one, `backupIfDue`, a manual one in an encrypted project: all probed clean. Prune: only inside `backupRun`, so drained; no product caller of `pruneBackups`. Restore: no product caller. Keys: probed wiped and zeroed after `close()`. Shred timing: see "noted". |
| 3 | I3, M1, M2 | **partly** | I3 planted fault caught. M1 holds. M2 holds for the plain case only; finding 1 (with a close pending) and finding 2 (stale context). `close()` inside a read turn (`writeQueueTurn`) is refused with M2's error, by reading, which is reasonable. |
| 4 | M3 | **holds** | The two-library test; `closingSignalAt` compares `lib.root` (the service builds its client with `libraryRoot: lib.root`). The proxy queue runs outside the scope (planted fault caught). After the close, `disposeProxyQueue` runs, and records are refused by the engine; by reading plus the first review's probe. |
| 5 | M5, sentences | **partly** | All four sentences are word for word as R551 rules them (checked in `@ao/shared` and in the tests). A request with no session keeps 503 "No library is open." (tested). `errorText` shows a `LIBRARY_CLOSED` message alone. Names pass through `UserText`; base names only. The project name in the backup sentence is the one already in its backup's file name. Finding 3 (409 handlers). |
| 6 | M6 | **partly** | Export: cancelled and recorded nothing (tested); no product caller. Retention: a pass that begins closed does nothing (tested). The retry record and the app-config record are untouched, so the next opening's pass picks the destruction up (`recordOldCopyDeleted`'s doc says so; by reading). Finding 4 (a pass already running). |
| 7 | M7 | **holds** | The index is closed in `beforeRelease`, after the drain and while the lock is held (service test asserts `lockAtIndexClose`). An index write after the release fails in memory (the handle is closed), never on disk. `beforeRelease` throwing: lock released and handle closed, but the error is not surfaced (finding 5). |
| 8 | beyond the brief | **holds** | The key-ring wipe moved after the close: probed. `refuseUnwritable` checks closed first, so a read-only library that is then closed says "closed". Project export `.tmp`: no caller in the service routes, the CLI or the page (grep of `exportProjectOpenFormats`, `restoreBackup`, `backupProject`: only `routes/projects.ts` → `backupProject`). |
| 9 | the whole property | **holds** for what was probed | Bulk (`.tmp/batch-*`, journal), backups, and the worker job journal with `.tmp` (transcription with the stub worker): byte-identical after `close()` and after settling. Link capture's `.tmp/capture-*`: not probed (needs a capture fixture); by reading only. |
| 10 | the tests | **holds** | I3 order through held promises and an ordered log; I2 and bulk compare whole-folder bytes. Existing tests changed: sentence updates (`Library.test.tsx`), the `whileOpen` signature (`http-closing`), one added case (`shared.test.ts`), and M8's stop test (now the whole folder, a stricter expectation). No expectation was loosened; the encrypted variant of `closeWaitsForTheTurn` skips a plaintext grep of the audit log, as it must. Sleeps: finding 6. |

## The first review's findings

| finding | status |
|---|---|
| I1 Bulk Import | **closed** (tested, plus my two-cut probe) |
| I2 backups | **closed** (tested, plus my probes) |
| I3 order untested | **closed** (planted fault caught) |
| M1 second close | **closed** (but see finding 1 for its interaction with M2) |
| M2 self-close | **partly**: the plain case is closed; findings 1 and 2 |
| M3 closing scope | **closed** |
| M4 synchronous throw | left, as ruled |
| M5 wording | **closed** for the sentences; finding 3 for 409 handling on the page |
| M6 reads refused | **closed** for export and for a pass that begins closed; finding 4 for a pass under way |
| M7 index after the wait | **closed** |
| M8 the stop test | **closed** (whole folder; it settles with a 100 ms sleep, finding 6) |

## What I could not judge
- **Zotero web batches cut by a close:** by reading only. It is the same `Run` code, and `zotero-sync` maps paused to stopped and resumes "paused".
- **Link capture's `.tmp/capture-*` at a close:** by reading only.
- **A real media worker** writing into `.tmp/worker-*` after a cancel, out of its own process. The stub stops when it is not polled.
- **The R554 backups step:** outside this review.
- **End-to-end scenarios:** not run.

## Verdict
**APPROVE WITH SMALL POINTS.**
- Nothing must be mended before the join.
- Cheap and recommended: finding 1 (reorder the M1 and M2 checks, plus a test) and finding 3 (the GovernanceSettings and YourLibrary 409 branches).
- Finding 4 is for the coordinator: give it to R554's builder, or leave it noted.
