# FR-749 fix round (R551): what was mended, and how it is proved

Worktree `.claude/worktrees/kg-3b`, branch `fr-749-close-attach`, from 19b05e7. Not pushed.

Commits, in order:

| commit | finding(s) |
|---|---|
| c3d4c3a | I1: a Bulk Import cut by the library's closing is left paused, no item failed |
| def76de | I3, M1, M2, M3: the order of a close under test; one close; never from inside a change; the closing scope is its library's |
| 06c6381 | I2: a backup in flight when its library closes is cancelled, and the close waits for it |
| 507145f | M5, M8 (and I2's service tests): the ruled sentences, a code of its own for a closed library, the stop test's whole folder |
| 227b488 | M7: the index and the keys go after the close's wait |
| 45516d4 | M6: an export and a retention pass cut by a close end as cancelled, recording nothing |
| db8623b | M7 follow-up: the index is closed before the lock's release (`close({ beforeRelease })`) |

Every test named below failed before its mend, for the stated reason: for each I put the old code back (or planted
the fault) and ran the test alone; the failing line is quoted.

## I1 — Bulk Import (R551 I1)

**What was wrong.** `item()` caught every error and `itemError` journaled a `LookupCancelledError` (the client's stop)
and a `LibraryClosedError` (the closed library refusing a store) as the item's FAILURE ("an unexpected error
(LookupCancelledError)"); the group store's fallback did the same item by item. The batch then ran to "finished"
with every remaining item failed. The paused branch the first round added in `run()` was never reached.

**Mend.** `packages/library/src/import/bulk/run.ts`:
- `isClosingCut(err)` (:699): `LookupCancelledError` or `LibraryClosedError`.
- `itemError` rethrows it (:1225), as it does `AbortError` and `RecoveryPendingError`; nothing is journaled
  for the item in hand.
- The group store's fallback rethrows it too (:1895).
- `run()`'s catch (:1088–1092) leaves the batch paused exactly as a suspend does (`suspending`, checkpoint
  "paused"); when the library is already closed that save is refused and the batch stays "running" on disk, which is
  listed as "interrupted" and resumed the same way. No journal format changed.

**Tests (new).**
- `packages/library/src/import/bulk/bulk-closing.test.ts`:
  - "a lookup cut by the client's stop leaves the batch paused, nothing failed or journaled; a new client resumes it
    and imports each item once" — the reviewer's probe: 3 PDFs, every lookup answered 429 / Retry-After 3600 by a
    MockAgent, `startBatch`, first request, `http.stop()`; paused, `failed: 0`, journal empty, one request; then a
    new client and `resumeBatch`: finished, 3 imported, each key once, none failed.
    Before: `expected 'finished' to be 'paused'`.
  - "a write the closed library refused (the library closed while an item was looked up): nothing failed; after
    reopening, the batch resumes and imports each item once" — the Retry-After wait is held, the library is closed,
    the lookup then answers and the store is refused; paused, `failed: 0`; reopened, listed "interrupted", resumed:
    3 imported once. Before (group fallback not rethrowing): `expected 3 to be +0`.
- `apps/library-service/src/close-during-attach.test.ts`, "a Bulk Import running when the library closes":
  - "POST /libraries/close: the batch is left paused, no item failed; after reopening it resumes and imports each
    item once";
  - "the service's stop: the same, read back by a new service".
  Before: `expected [ { key: 'alpha.pdf', …(3) } ] to deeply equal []` (a failed line journaled), both.

**The order `beginClosing` → `suspendBatches`** (`closeLibrary`, `state.ts`; the service's stop calls
`beginClosing` at its start, then `closeLibrary`): it stays as it is, and is right. Stopping the client first cuts a
batch's lookup at once; with I1 mended the batch then leaves itself paused, and `suspendBatches` finds it so
(`suspend()` returns the same `done`). The other order would make the suspend wait for the item in hand, i.e. for
its lookup's Retry-After (up to a minute, several in a row), past `SUSPEND_TIMEOUT_MS`, and the batch would be
cancelled as stuck. A batch between items, or one whose items need no lookup, reaches the suspend's point after its
item; either way it ends paused.

**Zotero's web batches (c).** They are `Run`s with the Zotero adapter: `item()`, `itemError` and the group fallback
are the same code, so a sync cut this way is left resumable and records no item as failed. The sync maps a paused
result to stopped / app-closed (`zotero-sync.ts:543`) and keeps "paused" among the states it resumes
(`UNFINISHED`, :253). By reading; no separate test (the Zotero web import makes its lookups through the same client
only for items with identifiers, and a cheap discriminating test would duplicate `bulk-closing`). The existing
`zotero-sync.test.ts` "the library handle closed under the run without a suspend" still passes.

## I2 — backups (R551 I2)

**What was wrong.** A backup in flight at a close was recorded FAILED (`recordFailure` excused only locked /
read-only) in `Backups/backups-state.json`, written outside the write queue after the lock's release, and shown at
the next opening as "The backup could not be made (The library has been closed…)". Its zip temp file, manifest and
state writes could land after the release before FR-749 too. Nothing made the close wait for it.

**Mend.** `packages/library/src/export/backup.ts`:
- `BackupCancelledError` (:193), its message the ruled sentence (`backupClosedSentence`, `@ao/shared`).
- `inFlight` (:207), `cutByClose` (:224): each backup is registered with its library; the library's `close()` waits for them (a drain,
  as for a repository's write queue), so the cancelled backup's clean-up is done before the lock goes.
- `backupRun` (:1171; `step()` at :1179, 1194, 1209, 1219, 1271, 1292, and in the zip's sink :825): the backup stops once `isClosed(lib)` or its `signal` (the
  session's closing signal) is aborted — at its start, before its pending record, after the decision, after the
  snapshot, between two pieces of the zip, before naming, before the commit point. After
  the commit point it is not cut (it is made; the close waits for its last steps); prune is skipped when closing.
- The catch (:1349): its temp file and pending record are removed as for any uncommitted backup, and neither a
  success nor a failure is recorded; a `LibraryClosedError` from a refused step is turned into the cancel.
- `recordFailure` (:941), `backupIfDueLocked` (:1722) and `pruneLocked` (:1408) treat a closed library as "cannot
  run now", as they treat a read-only one.
- Service: the manual route passes `signal: s.closing.signal` (`routes/projects.ts:219`); the scheduler too
  (`state.ts`, `runScheduledBackups`). `errors.ts`: `BackupCancelledError` → 409 `LIBRARY_CLOSED` with its sentence.
- New test seam `backupSeams.zipChunk`.

**How long a close can wait; the zip's stream.** The zip IS cut between its pieces (each chunk yazl hands to the
sink, tens of KB), so a close no longer waits for a whole large zip. What it waits for after the cut is the shredding
of the partial temp file: `shredPath` overwrites the bytes written so far with zeros once, fsyncs, and removes the
file — time proportional to what was written (a few seconds per GB on an ordinary disk). The temp file may be a
plaintext zip, so it is not left unshredded. A step that is one uninterruptible call (the snapshot's reads, the
commit turn) runs to its end; none is long except the zip.

**The sentence** (`packages/shared/src/api/errors.ts`, `BACKUP_CLOSED_TEXT` / `backupClosedSentence`):
> The library was closed or went offline before the backup of {project} was finished, so no backup was made. Back it up again when the library is open.

**Where the manual backup's answer reaches the page.** Nowhere today: no screen calls `POST /projects/:id/backups`
(grep of `packages/ui`). The sentence is in `@ao/shared` with the other shared sentences, the service answers it, and
the page's error map (`errorText`) shows a `LIBRARY_CLOSED` answer's own sentence alone (tested).

**Tests (new).**
- `packages/library/src/export/backup-closing.test.ts`:
  - "the reviewer's probe: held after its snapshot, the close waits; nothing under the library changes after close()
    resolved; nothing recorded; no temp file" — byte-for-byte snapshot right after `close()` resolved and after
    everything settled: identical; `backupFailure()` undefined; no pending record; no `.tmp-*`; no zip.
    Before: `expected [ '.cache dir', '.tmp dir', …(25) ] to deeply equal [ …(26) ]` (the state file written after).
  - "cut in the middle of its zip: the zip's stream ends, the temp file is removed, nothing recorded" (the temp file
    was there while held). Before: timed out (no such cut).
  - "the scheduler's automatic backup is cut the same way: nothing made, nothing recorded". Before: as the first.
  - "the session's closing signal stops it the same way, the library still open". Before: `expected 'made' …`.
  - "a backup that finishes before the close begins is recorded as before" (passes before and after).
- `apps/library-service/src/close-during-attach.test.ts`, "a backup in flight when the library closes":
  - "POST /projects/:id/backups: cancelled, its own sentence; nothing under the library changes after the close; no
    backup-failed at the next opening". Before: `expected 503 to be 409` (the old mapping) and the folder changed.
  - "the scheduler's backup is cut the same way: nothing made, nothing recorded". Before:
    `expected [ { …(4) } ] to deeply equal [ { …(3) } ]` (an error recorded).

## I3 — the order is tested (R551 I3)

**What was wrong.** `close()` could stop awaiting its drain and every test passed (the order was read after one
`setImmediate`).

**Test (new).** `packages/library/src/repo/closed-library.test.ts`, "I3: the lock is released only after the change
in its turn has ended, and close() resolves after that": a change held in its turn; `close()` called; for 300 ms
(bounded) the lock file is polled and must stay, and nothing may be logged; then the turn is released and the ordered
log must read `["turn ended", "close resolved, lock gone"]`.

**The planted fault** (`library.ts`, `await Promise.allSettled(ctl.drains…)` → `void …`), the new test failing:

```
× the order of a close (FR-749, R551 I3, M1, M2) > I3: the lock is released only after the change in its turn has ended, and close() resolves after that 38ms
  → the lock is still there while the change is in its turn: expected false to be true // Object.is equality
```

(M1's test fails on the same fault, the same line.) The code was restored and the file passes 6 of 6.

## M1 — a second close (R551 M1)

`library.ts` `close()`: the first call keeps its promise (`ctl.closing`) and every later call returns it.
Test "M1: a second close() while the first waits is the first one: it never resolves before the lock is released"
(identity, and the ordered log with the lock polled while held). Before: `expected Promise{…} to be Promise{…}`.

## M2 — a change that closes its own library (R551 M2)

`close()` asks each registered drain whether the caller holds its turn (`CloseDrain.holdsTurn`, `library.ts`); if
so it rejects with `CloseInsideChangeError` (`repo/errors.ts`, exported) and the library stays open; the change's
turn ends normally. Test "M2: a change that closes its own library is refused with a named error; its turn ends
normally and the library stays open". Before: `Test timed out in 5000ms.`

## M3 — the closing scope is its library's (R551 M3)

`library.ts`: the scope holds `{ lib, signal }`; `whileOpen(lib, signal, fn)`; `closingSignal(lib)` answers only for
its own library; `closingSignalAt(root)` for the lookup client, which knows its library by its folder
(`lookup/http.ts`); `outsideClosingScope(fn)`. `repo/state.ts` consults `closingSignal(this.library)`. The
viewing-proxy queue runs every job outside the scope of whatever queued it (`proxies.ts`, `then()`). By grep, the
only work an attach starts that outlives it is `proxies.enqueue`; the attach's other work (its lookups, its one
change) is its own.
Tests:
- `closed-library.test.ts`, "under the aborted closing signal of ANOTHER library's session, this library's change
  goes through; under its own, it is refused" (two real libraries). Before: `The library has been closed; nothing more
  can be changed through it`.
- `import/attach-closing.test.ts`, "a viewing proxy the attach queued is made and recorded although the attach's
  session began to close after it" (an encrypted project, a located photo, a stub worker held until the session's
  signal is aborted; the library stays open). Before: `expected [ { …(5) } ] to deeply equal []` (the job stayed
  pending: its record was refused).

## M5 — the sentences (R551 M5)

All in `@ao/shared`, one place each, shared by service and page:
- `packages/shared/src/api/sources.ts` `ATTACH_CLOSED_TEXT` / `attachClosedSentence`:
  > The library was closed or went offline before {file} was attached, so nothing was changed. Attach it again when the library is open.
- `sources.ts` `WATCH_ACT_CLOSED_TEXT`:
  > The library was closed or went offline before this could be done, so nothing was changed. Try again when the library is open.
- `packages/shared/src/api/errors.ts` `LIBRARY_CLOSED_TEXT`, with the new code `LIBRARY_CLOSED` (409, in the style of
  `READ_ONLY`: the request conflicts with the library's state; not the offline code):
  > That library has been closed, so nothing was changed.

Where they are answered:
- The attach route: as before, the file's `reason` with outcome `cancelled`.
- Both watched-folder acts (`routes/watched-folders.ts`, the action route): "Bring in…" answers the act sentence when
  its attach is `cancelled` or the engine refuses with `LibraryClosedError`; "Keep…" when its register write is
  refused. `refuseUnwritable` (`import/watch.ts`) said a closed library was READ-ONLY; it now throws
  `LibraryClosedError`. These are the only routes that run an attach (grep of `createAttach`/`bringInNewVersion`).
- `errors.ts`: `LibraryClosedError` → 409 `LIBRARY_CLOSED` with its sentence. A request that finds no session keeps
  503 `LIBRARY_OFFLINE` "No library is open." (tested).
- The page: `packages/ui/src/api/library.ts` `CODE_LEAD.LIBRARY_CLOSED`, and `errorText` shows a `LIBRARY_CLOSED`
  answer's own message alone (the generic sentence, or a cancelled backup's or export's). `WatchOrigin` shows the
  service's message. Names: the attach line's file name through `UserText` (unchanged); the backup's project name is
  in the service's sentence only (no screen shows it today); nothing of an encrypted project is sent but its name,
  as its backup files are already named.

Tests:
- service: `close-during-attach.test.ts` — the attach sentence word for word (the close route); "a change that
  reaches the engine after its library was closed": "answers 409 LIBRARY_CLOSED … a request with no library open keeps
  its answer" (before: `expected 503 to be 409`); `watched-folders-routes.test.ts` "R551 M5: both acts cut by the
  library's closing answer the one sentence, and change nothing" (before: `{"code":"READ_ONLY",…}`).
- page: `Library.test.tsx` (the attach line, word for word, name isolated); `WatchOrigin.test.tsx` "R551 M5: "Keep…" /
  "Bring in…" cut by the library's closing shows the one sentence, and changes nothing"; `api/library-error-text.test.ts`
  (the closed library's sentence once; a cancelled backup's alone); `screens/import/shared.test.ts`.

Also by the same rule ("cannot run now" wherever read-only is): a watched folder's register flush no longer reports
"could not be written" for a closed library (`import/watch.ts`); a protocol document refused by a closed library is
said with `LIBRARY_CLOSED_TEXT` (`protocol-docs.ts`). By reading; no new test for these two.

## M6 — reads through a closed handle stay refused (R551 M6)

What each did, established by test before the mend:
- **Export** (`export/project-export.ts`): a refused read or record became `ExportFailedError` ("The export could
  not be completed", 500 at the service); an export begun on a closed library ran, wrote its work folder into the
  library's `.tmp`, and left a complete export folder whose audit entry was refused. Nothing is recorded as a failure
  anywhere (there is no export failure record). There is no route and no command-line command that calls this
  export today.
- **Retention** (`retention.ts`): `scan` → `auditEventsMentioning` refused at its turn; `resumeDestruction` rejected
  with `LibraryClosedError` before anything was written; the service logs "resuming a destruction failed" (a log
  line, no record). `listDestructions` answers the refusal (now 409 `LIBRARY_CLOSED`).

Mend (small):
- export: refused at its start when closed (:419); a `LibraryClosedError` ends it as `ExportCancelledError`
  (:408) with
  > The library was closed or went offline before the export of {project} was finished, so no export was made. Export it again when the library is open.

  (new, in the style of the ruled ones; `EXPORT_CLOSED_TEXT` in `@ao/shared`, 409 `LIBRARY_CLOSED` at the service);
  a finished folder whose audit entry a close refused is shredded (:678, by reading: the export's earlier
  governed steps already wait in the write queue, so a test could not reach that point deterministically).
- retention: `resumeLocked` and `recordOldCopyDeleted` end with nothing done when the library is closed, or when the
  scan is refused by the close (:967–973, :1686).

Tests: `packages/library/src/export/closed-reads.test.ts` — "of a library already closed: cancelled in its own
sentence; nothing in the chosen folder, nothing written into the library", "closed while the export waits in the write
queue: …", "a retention pass cut by the library's close … ends with nothing done and nothing recorded". Before:
`expected ExportFailedError … to be an instance of ExportCancelledError` (twice) and
`promise rejected "LibraryClosedError: …" instead of resolving`.

**STOPPED — retention's destruction step, needs a ruling.** A destruction's backups step (`settleBackups`,
`retention.ts:764–776`) makes a fresh backup with `backupProjectHeld` before removing the listed backups. If the
library closes there, the backup is now cancelled (`BackupCancelledError`), and `settleBackups` treats that as a
failed fresh backup (`freshFailed = backupFailureReason(...)`, i.e. "The backup could not be made (The library was
closed …)") and GOES ON: it removes the listed backups (`removeHoldingBackups`, plain file operations in `Backups/`,
not drained by the close) and tries to record an amendment, which the closed library refuses. So a destruction
cut by a close can be half-done (backups removed, the removal unrecorded until the next pass's settling) and those
removals can land after the lock's release. Before this round the same happened with the failure recorded. Mending
it means deciding what a destruction step does when its library closes in the middle (stop before removing anything,
and how the next pass picks it up; whether the destruction's maintenance section must be drained by the close as a
backup now is): more than a small change, and a choice the rulings do not make. Recommendation: treat a cut fresh
backup (and `LibraryClosedError` anywhere in the step) as "stop now": remove nothing, record nothing, leave the
retry record as it was, and register the destruction's maintenance section with the close's drain like a backup.

## M7 — the index after the wait (R551 M7)

`closeLibrary` (`apps/library-service/src/state.ts`) and the command line's `session.close`
(`apps/cli/src/session.ts`) closed the index, and wiped the key ring, BEFORE `lib.close()` waited for the change in
its turn: that change's index update failed (and in an encrypted project the change itself could not finish: its
key was wiped). Now the index is closed in `close({ beforeRelease })` — after the wait, before the lock's release
(its file and WAL are in the library; a close checkpoints the WAL) — and the keys are wiped once the close returns.
`library.ts` `close(opts?)` runs `beforeRelease` between the drain and the release.
Test: `close-during-attach.test.ts`, "the close waits: …" and "R551 M7: in an encrypted project too, the change
finishes with its key and its index update": `repo.indexErrors` empty, the lock present when the index is closed.
Before: `expected [ { op: 'source.create', …(1) }, …(1) ] to deeply equal []` and, encrypted,
`expected [ { …(3) } ] to deeply equal [ ObjectContaining{…} ]` (the attach failed).
The key-ring part is beyond the brief's text (same fault, same place); said here.

## M8 — the service's stop compares the whole folder

`close-during-attach.test.ts`, "the service's stop does not wait for the lookup; nothing is written": the whole
library folder byte for byte right after the stop and again after everything settled (was: filtered lines).

## M4 — left

`importChange` / `runImportChange` throwing synchronously when closed (`import-ops.ts:61`) is left as ruled; the
read-only case has the same shape, and no caller uses `void importChange(…).catch()`.

## Corrections to the first round's report

- **"Bulk Import … the batch is left paused exactly as a suspend leaves it"** was false: the cut lookup reached
  `itemError` and was journaled as the item's failure; the batch ended "finished" with every remaining item failed
  (I1). It is true now, and tested.
- **The write-path list left out the Backups family** (the zip temp file, the manifest, the state file), none of it
  behind the engine's guard; and it did not say that the project export writes into `.tmp`, nor that closing the
  index writes into the library. The complete list is below.

## Every write family under a library's root, and what stops it at a close

| family | where | what stops it at a close | proved by |
|---|---|---|---|
| governed changes: sources, originals, review queue, settings files (project.json, governance), annotations, collections/tags, batch records, journals and reports, protocol documents, profile captures, watch registers, recovery warnings, Find's queue | `runMutation`/`authorizeOnly`, `tx` | the engine: `assertWritable` and the turn's start refuse (`LibraryClosedError`); `close()` waits for the turn in progress | `repo/closed-library.test.ts` (each family; I3 order) |
| transaction markers, audit logs | inside the same turns | the same | `closed-library.test.ts` (`pendingMarkers` 0) |
| the lock file | `lock.ts` | released last by `close()` | `closed-library.test.ts` I3 |
| the index (SQLite file and WAL) | `index/db.ts` | closed in `close({ beforeRelease })`, after the wait, before the release | `close-during-attach.test.ts` M7 |
| the lookup cache `.cache/lookups` | `lookup/http.ts` | the client: `setDiskCache(false)` before the release, and `stop()` at `beginClosing` | `lookup/http-closing.test.ts`; `find-routes.test.ts` "FR-749 … sends nothing more" |
| Backups/: the zip's `.tmp-*`, `backups-manifest.json`, `backups-state.json`, the backup files | `export/backup.ts` | the backup's cancel (closed handle or the session's signal) and the close's drain | `export/backup-closing.test.ts`; `close-during-attach.test.ts` backups |
| Backups/: a destruction's removal of listed backups | `retention.ts` `settleBackups` | **not stopped** (see M6: needs a ruling) | — |
| Bulk Import's `.tmp/batch-*` work folder (made, removed at the run's end) | `import/bulk/run.ts` | the client's stop (the run pauses at once) and `suspendBatches` awaited (bounded by `SUSPEND_TIMEOUT_MS`, then cancel and a bounded wait) | `bulk-closing.test.ts`; `close-during-attach.test.ts` Bulk |
| Zotero sync/web work folders, the SQLite copy | `import/zotero-web.ts`, `import/sqlite-copy.ts` | `zoteroSync.stop()` awaited before the release (Z8) | `zotero-sync-routes.test.ts` "close during a run … nothing is written after the lock is released" |
| the worker job journal (`jobs/journal.jsonl`) and its `.tmp/worker-*` folders (OCR, proxies, transcription segments, browser capture) | `job-journal.ts`, `worker-client.ts`, `import/ocr.ts`, `transcript-segments.ts`, `capture/browser-capture.ts` | the service: STOPPED_AT_CLOSE work stopped and interrupted, then `workerClient.close()` ("no journal line after it returns") | `worker-client.test.ts` "close(): nothing is written to the journal after it returns…"; `transcription-jobs.test.ts` M7 |
| link capture's `.tmp/capture-*` | `capture/link-capture.ts` | the service ends captures (`endCaptures`) and its work is STOPPED_AT_CLOSE | by reading |
| Find and acquire's `.tmp/find-*` and its records | `find/fetch-file.ts`, `find/runner.ts` | `endFind` (`stopAll` awaited) at `beginClosing` | `find-routes.test.ts` "close awaits stopAll before the library's lock is released", "close during a held choose …" |
| the viewing-proxy and OCR queues | `import/proxies.ts`, `import/ocr.ts` | disposed by `closeLibrary`; their records refused by the engine once closed | `attach-closing.test.ts` M3 |
| the project export's `.tmp/worker-export-*` | `export/project-export.ts` | refused at its start when closed; **not drained** if a close comes while it runs (no product caller today) | `export/closed-reads.test.ts` |
| attach and watched folders | `import/attach.ts`, `import/watch.ts` | the session's closing signal (cancel before the turn), then the engine | `attach-closing.test.ts`, `watch-closing.test.ts`, `close-during-attach.test.ts` |

Writes to the app's configuration folder (outside the library) are not in this list.

## Runs

Each file alone (`nice -n 10 pnpm --filter <pkg> exec vitest run <file> --testTimeout 120000`), after the last
code change except where noted (the first batch ran before db8623b; of it, `closed-library` and `library.test` were
run again after it):

- @ao/library src/repo/closed-library.test.ts: 6 passed (6)
- @ao/library src/repo/rollback-rerun.test.ts: 30 passed (30)
- @ao/library src/repo/sources-confirm-bound.test.ts: 6 passed (6)
- @ao/library src/library.test.ts: 35 passed (35)
- @ao/library src/library-place.test.ts: 19 passed (19)
- @ao/library src/lookup/http-closing.test.ts: 7 passed (7)
- @ao/library src/lookup/http-keys.test.ts: 18 passed (18)
- @ao/library src/lookup/lookup.test.ts: 39 passed (39)
- @ao/library src/lookup/recorded.test.ts: 21 passed (21)
- @ao/library src/import/attach-closing.test.ts: 5 passed (5)
- @ao/library src/import/attach.test.ts: 69 passed (69)
- @ao/library src/import/watch-closing.test.ts: 1 passed (1)
- @ao/library src/import/watch-choices.test.ts: 9 passed (9)
- @ao/library src/import/watch-local.test.ts: 51 passed (51)
- @ao/library src/import/watch-settings.test.ts: 9 passed (9)
- @ao/library src/import/watch.test.ts: 143 passed (143)
- @ao/library src/repo/closed-library.test.ts: 6 passed (6)
- @ao/library src/library.test.ts: 35 passed (35)
- @ao/library src/import/bulk/bulk-closing.test.ts: 2 passed (2)
- @ao/library src/import/bulk/annotations-plan.test.ts: 9 passed (9)
- @ao/library src/import/bulk/bulk.test.ts: 103 passed (103)
- @ao/library src/import/bulk/disk-full.test.ts: 14 passed (14)
- @ao/library src/import/bulk/failure-cause.test.ts: 5 passed (5)
- @ao/library src/import/bulk/patterns.test.ts: 2 passed (2)
- @ao/library src/import/bulk/space.test.ts: 15 passed (15)
- @ao/library src/import/bulk/zotero-conflict.test.ts: 41 passed (41)
- @ao/library src/import/bulk/zotero-gone.test.ts: 26 passed (26)
- @ao/library src/export/backup-closing.test.ts: 5 passed (5)
- @ao/library src/export/backup-governed.test.ts: 22 passed (22)
- @ao/library src/export/backup-manifest-d15.test.ts: 13 passed (13)
- @ao/library src/export/backup-r138.test.ts: 20 passed (20)
- @ao/library src/export/backup-read-fails.test.ts: 1 passed (1)
- @ao/library src/export/backup.test.ts: 23 passed (23)
- @ao/library src/export/closed-reads.test.ts: 3 passed (3)
- @ao/library src/export/project-export-anchors-locked.test.ts: 2 passed (2)
- @ao/library src/export/project-export-read-fails.test.ts: 4 passed (4)
- @ao/library src/export/project-export.test.ts: 18 passed (18)
- @ao/library src/retention-confirm.test.ts: 3 passed (3)
- @ao/library src/retention-old-copies.test.ts: 40 passed (40)
- @ao/library src/retention.test.ts: 23 passed (23)
- @ao/library src/export/retention-r147.test.ts: 37 passed (37)
- @ao/library src/export/retention-restore.test.ts: 9 passed (9)
- @ao/library src/export/retention-check-unmade.test.ts: 1 passed (1)
- @ao/library src/export/restore-lock-state.test.ts: 15 passed (15)
- @ao/library src/export/restore-governed.test.ts: 72 passed (72)
- @ao/library src/import/zotero-web.test.ts: 92 passed (92)
- @ao/library src/import/zotero-sync.test.ts: 77 passed (77)
- @ao/library src/import/zotero-local.test.ts: 85 passed (85)
- @ao/library src/import/zotero-dry-run-journals.test.ts: 4 passed (4)
- @ao/library src/seams-inert.test.ts: 9 passed (9)
- @ao/library src/integrity-confirm.test.ts: 5 passed (5)
- @ao/library src/repo/lock-guards.test.ts: 7 passed (7)
- @ao/library src/repo/lock-mid-read.test.ts: 44 passed (44)
- @ao/library src/service-support.test.ts: 31 passed (31)
- @ao/library src/import/in-library.test.ts: 32 passed (32)
- @ao/library src/worker-client.test.ts: 31 passed (31)
- @ao/library src/repo/pending-writes-close.test.ts: 14 passed (14)
- @ao/library-service src/close-during-attach.test.ts: 11 passed (11)
- @ao/library-service src/open-library.test.ts: 25 passed (25)
- @ao/library-service src/lock-during-change.test.ts: 3 passed (3)
- @ao/library-service src/watched-folders-routes.test.ts: 59 passed (59)
- @ao/library-service src/device-notices.test.ts: 17 passed (17)
- @ao/library-service src/import-disk-full-answer.test.ts: 3 passed (3)
- @ao/library-service src/import-disk-full.test.ts: 2 passed (2)
- @ao/library-service src/import-log.test.ts: 1 passed (1)
- @ao/library-service src/import-setup.test.ts: 25 passed (25)
- @ao/library-service src/zotero-sync-routes.test.ts: 43 passed (43)
- @ao/library-service src/zotero-sync-scheduler.test.ts: 43 passed (43)
- @ao/library-service src/zotero-web-resume.test.ts: 2 passed (2)
- @ao/library-service src/server.test.ts: 160 passed | 1 skipped (161)
- @ao/library-service src/find-routes.test.ts: 47 passed (47)
- @ao/library-service src/fieldwork-governance.test.ts: 23 passed (23)
- @ao/library-service src/library-audit.test.ts: 11 passed (11)
- @ao/library-service src/your-library-routes.test.ts: 35 passed (35)
- @ao/library-service src/capture-queues.test.ts: 31 passed (31)
- @ao/library-service src/transcription-jobs.test.ts: 40 passed (40)
- @ao/library-service src/library-place-routes.test.ts: 8 passed (8)
- @ao/ui src/screens/Library.test.tsx: 47 passed (47)
- @ao/ui src/screens/Library.dismiss.test.tsx: 4 passed (4)
- @ao/ui src/screens/Library.notices.test.tsx: 4 passed (4)
- @ao/ui src/screens/Library.reader.test.tsx: 9 passed (9)
- @ao/ui src/screens/Library.recheck.test.tsx: 12 passed (12)
- @ao/ui src/screens/Library.zotero.test.tsx: 14 passed (14)
- @ao/ui src/screens/LibraryChooser.test.tsx: 24 passed (24)
- @ao/ui src/screens/LibraryChooser.notices.test.tsx: 5 passed (5)
- @ao/ui src/screens/LibraryChooser.shell.test.tsx: 3 passed (3)
- @ao/ui src/screens/LibraryChooser.lostCreate.test.tsx: 2 passed (2)
- @ao/ui src/screens/LibraryNotFound.test.tsx: 10 passed (10)
- @ao/ui src/components/WatchOrigin.test.tsx: 35 passed (35)
- @ao/ui src/api/library-error-text.test.ts: 3 passed (3)
- @ao/ui src/screens/import/shared.test.ts: 2 passed (2)
- @ao/shared src/api/boundary.test.ts: 19 passed (19)
- @ao/cli src/cli.test.ts: 40 passed (40)

Typecheck: `@ao/shared`, `@ao/library`, `@ao/library-service`, `@ao/ui`, `@ao/cli` — no errors. `lint:css` ok,
`lint:colours` ok. `git status --short` empty; no process left running.


## Not done, or uncertain

- Retention's destruction step cut by a close: STOPPED, needs a ruling (M6 above).
- The project export is refused at its start once closed, but an export running when a close comes is not drained:
  it could still write its `.tmp/worker-export-*` folder after the release. There is no route or command that runs it
  today; if one is added it should be registered like a backup.
- Bulk Import's `.tmp` work folder: the wait for a stuck batch is bounded (as before); a batch that does not pause in
  time is cancelled and then waited for a bounded time.
- Zotero web batches: by reading only (the same code path as the tested bulk run).
- The watched-folder register flush and the protocol document's closed-library wording: by reading.
- Not run: the end-to-end scenarios (no route address or button changed; one sentence and one code changed).
