# FR-749 (R546): a library closed while an attach waits on its lookup is no longer written into

Worktree `.claude/worktrees/kg-3b`, branch `fr-749-close-attach`, from 769e3e5. Not pushed.

Commits, in order:

| commit | what |
|---|---|
| 2adec13 | the engine: a closed library refuses every write; `close()` waits for the change in its store turn (R546 1) |
| 83d4837 | the lookup client: sends nothing more once the library begins to close (R546 2, 3; the coordinator's addition) |
| 7af9b03 | attach and watched folders: cancelled, nothing written, one sentence (R546 2) |
| 9887566 | the service: every close and the service's stop begin with `beginClosing` (R546 2, 3) |
| b002420 | the page: the sentence in "Attached files" |
| 855c5f1 | test changed: `repo/sources-confirm-bound.test.ts` "a close of the library … ends it, recording nothing" asserted the OLD behaviour (close returned while a write was held in its turn: it now deadlocked); it now releases the write while the close waits, and the confirmation that was still waiting never begins (`runs` 0, was 1); nothing recorded either way |
| 805ccee | found by `zotero-sync.test.ts` "the library handle closed under the run without a suspend": with the engine refusing, a bulk run whose last record the closed library refused answered `finished` while its batch stayed `running` on disk; it now answers `paused` (the disk shows interrupted, resumable), so the sync records stopped / app-closed |
| 19b05e7 | found by `server.test.ts` "R491 C b": the integrity check ended by a close now meets `LibraryClosedError`; it is read as the close, as `ReadOnlyLibraryError` was, so its own sentence stands |

## The fault, reproduced

Each test below failed before the fix and passes after it. For each, I put the code before its fix back, ran the test, and saw it fail for the stated reason.

- `apps/library-service/src/close-during-attach.test.ts`:
  - "POST /libraries/close: answers promptly; …", "opening another library …", "the service's stop …": before the service change, the attach was not cut. The tests hit their time limit because the attach waited out the 60 s Retry-After.
  - "creating a library …": with the old code it failed once the earlier tests had left the service stuck.
- `packages/library/src/repo/closed-library.test.ts`:
  - before the engine change, `createSource` through a closed Library succeeded (it "resolved instead of rejecting");
  - a change asked for after `close()` queued behind the held turn, so the test hung.
- `packages/library/src/lookup/http-closing.test.ts`: before the change, the Retry-After wait, the back-off wait and the request in the air all ran to the time limit. A new call after closing was still sent.
- `packages/library/src/import/attach-closing.test.ts`: 3 of its 4 tests failed (time limits, and "failed" instead of "cancelled").
- `packages/library/src/import/watch-closing.test.ts`: the watch's stop waited the full minute.
- `apps/library-service/src/find-routes.test.ts`, test "FR-749 (R546): once the service is closed, the session's lookup client sends nothing more …":
  - without `http.stop()`, 2 more requests went out after `svc.close()` ("expected 4 to be 2");
  - this is the other agent's finding, reproduced.

## The mechanism

### 1. The engine (R546 1)

- **The closed handle.** `packages/library/src/library.ts`:
  - `close()` (:455-461) first sets `closed`;
  - then it awaits every registered drain, with no time limit (R247 d);
  - only then does it release the lock.
  - `onClose(lib, drain)` (:512) registers a drain.
- **The write queue.** Changes are serialised per library, by the repository's write queue (`RepoCore.serial`/`serialNext`, one queue per Repo, across all projects). The import store turn (`serialStore`, per project) is a different thing: it holds a whole file, lookups included (R247 M4). `close()` waits only for the write queue, never for an import's lookup.
- **What the repository does.** `packages/library/src/repo/state.ts`:
  - the constructor registers `whenIdle()` as a drain (:227-235);
  - `refusesNewChanges()` (:241) is true once the handle is closed, or once the closing signal of the asking work's session is aborted (`whileOpen`, below);
  - `assertWritable()` (:266) throws `LibraryClosedError` unless the caller is inside a turn that began before the close;
  - the start of every queued turn (:305) refuses with `LibraryClosedError` and runs nothing. So a change still waiting when `close()` is called never begins, and the queue empties without writing.
- **The error.** `LibraryClosedError` is in `repo/errors.ts`, exported from the package.
- **No format changed.** No change to the marker, the audit log or the transaction code. A refused change is refused before policy is decided, so nothing is audited for it: no change happened, and none was decided.
- **The closing scope.** `library.ts:525,530`: `whileOpen(signal, fn)` and `closingSignal()`, an AsyncLocalStorage holding the session's closing signal. The write queue and the lookup client honour it, for the work run inside it (attach, watched folders).

### 2. The lookup client (R546 2, 3, and the coordinator's addition)

All in `packages/library/src/lookup/http.ts`.

- **`HttpClient.stop()`** (:382). After it the client sends NOTHING, for every caller:
  - a wait for a place (`hold`, :630-645) leaves the line, and no place is ever handed to a caller that has gone;
  - a wait for a throttle slot (:616) ends;
  - Retry-After and back-off waits (:726) end;
  - no retry is made (:697);
  - a request in the air is aborted, through its signal (`halt()`, :387);
  - `postJson`, used by Find's Elicit search, is covered too (:597).
- **How a call ends.** Every such call settles at once with `LookupCancelledError`. It is not a `LookupHttpError`, so `firstAnswer` and `resolveItem` do not swallow it as "lookup failed"; it reaches the caller.
- **Politeness.** Cutting a wait never sends a request early (R411).
- **The same cut per piece of work.** A closing session's signal (`whileOpen`) cuts the same waits for the work run inside it.
- **One client per session.** The client belongs to one library session (`state.ts` adopt, :720), so stopping it affects no other session.

### 3. Attach and watched folders

`packages/library/src/import/attach.ts`:

- `AttachDeps.closing` (the session's signal) is new.
- Each file runs inside `whileOpen`.
- A file still waiting for its project's store turn is answered `cancelled` as soon as the signal aborts (`one`, :449-464). When its turn comes, `attachOne` finds the session closing and does nothing (:400).
- After `resolveItem`, a closing session gives `cancelled` (:331).
- `LibraryClosedError` and `LookupCancelledError` also map to `cancelled` (:473).
- New status `cancelled`, with reason `attachClosedSentence(basename(path))`.

`packages/library/src/import/watch.ts`:

- `WatchDeps.closing` is passed to the watch's attach.
- On `cancelled` (:2017) the job is put back in memory and the watch stops, as on its existing "library gone" path.
- Nothing is written in the register for that file: no "seen", no "failed", no problem entry.

### 4. The service

- **`beginClosing(s)`** (`state.ts:1621`). Three steps, in this order:
  1. it aborts the session's closing signal (attach and watched folders: cancelled at once);
  2. it stops Find and acquire (`endFind`), so the runner lets go of its own lookups and records nothing of them;
  3. it stops the session's lookup client (`s.http.stop()`).
- **Where it runs.** `closeLibrary` calls it in place of `endFind` (:1297). `closeLibrary` serves the close route, open, create, reconnect and shutdown.
- **The service's stop.** It calls `beginClosing` at its BEGINNING (`server.ts:395`), before it waits for requests in flight. So an attach in its lookup answers at once and no longer holds Quit. A change in its store turn is still waited for: by the in-flight wait, and by the engine's `close()`.
- **The attach route** passes `closing: s.closing.signal` (`routes/sources.ts:355`). The watched-folder dependencies pass it too (`state.ts:998`).
- **A new change after the close began.** `closeLibrary` drops the session at once (unchanged), so a new mutating request gets the existing **503 LIBRARY_OFFLINE "No library is open."** That is true from then on: the library is no longer open for changes. A request that already held the session and reaches the engine after the close is refused with `LibraryClosedError`, now mapped to the same answer (`errors.ts:126`).

### How it fits Find's own stop (R247)

- Find's `stopAll` (`FIND_STOP_SETTLE_MS`, its `guard`/`Abandoned`) stops the RUNNER waiting and recording. It did not stop the client's network work, so queued requests and retries still went out: the finding.
- `beginClosing` keeps Find's stop first, then stops the client. They complement each other; nothing is built twice. Stopping the client before Find's stop could have let a cut lookup be recorded as a failure.

## The sentence (new, word for word)

`packages/shared/src/api/sources.ts`, `ATTACH_CLOSED_TEXT` and `attachClosedSentence(name)`:

> The library was closed before tide-line-notes.pdf was attached, so nothing was changed; attach it again after opening the library.

- The service answers it as the file's `reason`, with outcome `cancelled`.
- The page (`packages/ui/src/screens/Library.tsx`, the "Attached files" list) builds it from the same two parts, with the name in `UserText`. The line is styled as not added (`ao-outcome--failed`).
- "No library is open." (an existing sentence) is now also the answer to a change refused by the engine after a close.

## Write paths and how each is covered

Every governed change and every marker write goes through `runMutation`/`authorizeOnly` (`repo/mutate.ts:454-485`). Both call `assertWritable` and run in `core.serial`. `TxnLog` (the marker) is made in one place only, `mutate.ts:503`, inside that turn (grep `new TxnLog`: one hit).

| family | path | covered by | test |
|---|---|---|---|
| imports / attach, captures | `createSource`, `addCapturedOriginal`, `importChange` → runMutation | assertWritable + turn start | closed-library "a new source…", "an import's own change"; attach-closing (closed library → `cancelled`) |
| records | `updateSource` | same | "a record's fields" |
| annotations | `createAnnotation` → importChange | same | "an annotation" |
| review queue | `appendReviewEntry`/`appendReviewUpdate` take a `tx` (only inside a change) | same | "a new source, with a review entry" |
| settings files | project.json (collections, tags, fieldwork), governance.yaml (`setGovernance`) | same | "a collection", "the project's rules" |
| audit on its own | `appendRefusalEvent`, `auditNow` callers (grep: repo.ts:743/755 and projects.ts:469 run at open; mutate.ts, restore.ts, attention.ts and pending-writes.ts inside `serial`) | turn start | "a refusal's audit entry" |
| watch registers | `recordWatchedFiles` (assertWritable + serial) | same | "a watched folder's register" |
| recovery warnings | `dismissKeptWarning` (assertWritable + serial); `keep` is written inside a turn | same | "a recovery warning's dismissal" |
| Find queue | `find/queue-store.ts` through `tx` | same | (by reading) |
| lookup cache | `HttpClient.writeCache`, R247 c `setDiskCache(false)`; now also nothing is fetched after `stop()` | client | http-closing |

**Writes into the library folder that do NOT pass the engine's guard** (by grep of `writeFileAtomic|mkdir|writeFile|rename|rm` in `packages/library/src`), and what keeps them safe:

- the job journal (`job-journal.ts`, by root);
- the worker jobs' scratch folders in `.tmp` (`capture/browser-capture.ts:142`, `import/ocr.ts:236`, `transcript-segments.ts:409`).

These were already guarded by the service: `closeLibrary` interrupts them (STOPPED_AT_CLOSE) and `workerClient.close()` ("no journal line after the lock is released"). The engine does not refuse them, because they take a root, not a Library. Making them do so is outside this task.

The following write to the app config folder, outside the library: `attention.ts` outbox, watch settings, `app-settings.ts`, `zotero-sync-settings.ts`.

## Other callers and the move

- **Bulk Import** (`import/bulk/run.ts`). Before: a close suspended the batch, bounded (`suspendTimeoutMs`), then cancelled it. A run still in a long lookup could go on writing after the lock was released (the same fault). Now:
  - the client stop cuts the lookup, `LookupCancelledError` reaches `run()`, and the batch is left paused exactly as a suspend leaves it (:1081): the item in hand is not stored, nothing of it is journaled, and it is brought in on resume;
  - any write that still came late is refused by the engine.
  - By reading; no new test (a bulk run held in a lookup is not cheap to set up). Bulk's own tests were run.
- **Zotero sync.** It is stopped with its record before the lock goes (Z8). Its Web batches are bulk runs, so they behave as above. The Zotero API calls do not use the lookup client.
- **Capture.** It makes no lookup. Its stores go through `createSource`, so the engine refuses them after a close. Its worker jobs are interrupted by the service (unchanged).
- **Find and acquire.** Already safe for writes (R247 c, d, `stopAll`). The network leak (the finding) is now closed by the client stop. Service test in `find-routes.test.ts`.
- **The move** (`routes/libraries.ts:288`). An attach in its lookup IS a mutating request in flight (counted in `preHandler` once its body is read):
  - the move waits up to 60 s for it, then refuses ("Some changes are still being made…");
  - new changes are refused by `state.moving`;
  - `quiesce` awaits the watches' stop.
  - So no write can land after the copy: the copy starts only when no mutating request is in flight. The same fault was NOT found there. A long attach makes the move refuse rather than corrupt anything. Unchanged, and so is `IN_FLIGHT_WAIT_MS`.

## The coordinator's addition: the client sends nothing after a close

- **Built as ruled:** `HttpClient.stop()` and `beginClosing`.
- **Client test** (`lookup/http-closing.test.ts`, "stop(): requests queued behind the throttle and one in a retry wait all settle at once, and nothing more is sent"):
  - one request in its Retry-After wait and three queued behind the throttle;
  - `stop()`: all four settle with `LookupCancelledError`, a later call too, and the MockAgent saw exactly 1 request.
  - A POST is covered too.
- **Service test** (`find-routes.test.ts`): Find's lookups are queued and in the air, the service is closed, the held requests are released. Nothing is dispatched within the following second (more than the first back-off), and a call on the old client afterwards is refused without a request.
- **No shared client.** The client is not shared across sessions, so nothing more than the abort was needed.
- **Tests and the network.** All my tests use a MockAgent with `disableNetConnect()`, or a loopback server. The service test restores the global dispatcher it found, after closing the service.

## Runs

- @ao/library src/library.test.ts: Tests 35 passed (35)
- @ao/library src/library-place.test.ts: Tests 19 passed (19)
- @ao/library src/repo/anchor-missing.test.ts: Tests 3 passed (3)
- @ao/library src/repo/annotations-shared.test.ts: Tests 2 passed (2)
- @ao/library src/repo/annotations.test.ts: Tests 42 passed (42)
- @ao/library src/repo/attention.test.ts: Tests 34 passed (34)
- @ao/library src/repo/audit-reasons.test.ts: Tests 32 passed (32)
- @ao/library src/repo/close-guard.test.ts: Tests 942 passed (942)
- @ao/library src/repo/closed-library.test.ts: Tests 2 passed (2)
- @ao/library src/repo/date-zone.test.ts: Tests 2 passed (2)
- @ao/library src/repo/fieldwork.test.ts: Tests 31 passed (31)
- @ao/library src/repo/import-settings.test.ts: Tests 7 passed (7)
- @ao/library src/repo/io-append.test.ts: Tests 4 passed (4)
- @ao/library src/repo/kept-warnings.test.ts: Tests 13 passed (13)
- @ao/library src/repo/key-lock-race.test.ts: Tests 11 passed (11)
- @ao/library src/repo/key-read-race.test.ts: Tests 32 passed (32)
- @ao/library src/repo/library-audit.test.ts: Tests 9 passed (9)
- @ao/library src/repo/linked-file.test.ts: Tests 9 passed (9)
- @ao/library src/repo/lock-guards.test.ts: Tests 7 passed (7)
- @ao/library src/repo/lock-mid-read.test.ts: Tests 44 passed (44)
- @ao/library src/repo/pending-writes-close.test.ts: Tests 14 passed (14)
- @ao/library src/repo/pending-writes.test.ts: Tests 22 passed (22)
- @ao/library src/repo/pseudonyms.test.ts: Tests 16 passed (16)
- @ao/library src/repo/recovery-code.test.ts: Tests 27 passed (27)
- @ao/library src/repo/refuse.test.ts: Tests 3 passed (3)
- @ao/library src/repo/repo.test.ts: Tests 61 passed (61)
- @ao/library src/repo/restore-sealed-purposes.test.ts: Tests 12 passed (12)
- @ao/library src/repo/review-held.linked.test.ts: Tests 6 passed (6)
- @ao/library src/repo/review-held.test.ts: Tests 67 passed (67)
- @ao/library src/repo/rollback-hand-put.test.ts: Tests 42 passed (42)
- @ao/library src/repo/rollback-own-writes.test.ts: Tests 14 passed (14)
- @ao/library src/repo/rollback-rerun.test.ts: Tests 30 passed (30)
- @ao/library src/repo/rollback-words.test.ts: Tests 20 passed (20)
- @ao/library src/repo/scrub.test.ts: Tests 4 passed (4)
- @ao/library src/repo/source-record.test.ts: Tests 5 passed (5)
- @ao/library src/repo/sources-confirm-bound.test.ts: Tests 1 failed | 5 passed (6)
- @ao/library src/repo/sources-read-race.test.ts: Tests 13 passed (13)
- @ao/library src/repo/trim-hold.test.ts: Tests 1 passed (1)
- @ao/library src/repo/txn-completion.test.ts: Tests 9 passed (9)
- @ao/library src/repo/watch-register.test.ts: Tests 30 passed (30)
- @ao/library src/repo/workspace-tags.test.ts: Tests 10 passed (10)
- @ao/library src/lookup/http-closing.test.ts: Tests 7 passed (7)
- @ao/library src/lookup/http-keys.test.ts: Tests 18 passed (18)
- @ao/library src/lookup/lookup.test.ts: Tests 39 passed (39)
- @ao/library src/lookup/recorded.test.ts: Tests 21 passed (21)
- @ao/library src/import/attach.test.ts: Tests 69 passed (69)
- @ao/library src/import/attach-closing.test.ts: Tests 4 passed (4)
- @ao/library src/import/watch.test.ts: Tests 143 passed (143)
- @ao/library src/import/watch-closing.test.ts: Tests 1 passed (1)
- @ao/library src/import/watch-local.test.ts: Tests 51 passed (51)
- @ao/library src/import/watch-settings.test.ts: Tests 9 passed (9)
- @ao/library src/import/watch-choices.test.ts: Tests 9 passed (9)
- @ao/library src/import/bulk/annotations-plan.test.ts: Tests 9 passed (9)
- @ao/library src/import/bulk/bulk.test.ts: Tests 103 passed (103)
- @ao/library src/import/bulk/disk-full.test.ts: Tests 14 passed (14)
- @ao/library src/import/bulk/failure-cause.test.ts: Tests 5 passed (5)
- @ao/library src/import/bulk/patterns.test.ts: Tests 2 passed (2)
- @ao/library src/import/bulk/space.test.ts: Tests 15 passed (15)
- @ao/library src/import/bulk/zotero-conflict.test.ts: Tests 41 passed (41)
- @ao/library src/import/bulk/zotero-gone.test.ts: Tests 26 passed (26)
- @ao/library src/import/zotero-web.test.ts: Tests 92 passed (92)
- @ao/library src/import/zotero-sync.test.ts: Tests 1 failed | 76 passed (77)
- @ao/library src/import/in-library.test.ts: Tests 32 passed (32)
- @ao/library src/import/refman.test.ts: Tests 142 passed (142)
- @ao/library src/find/runner.test.ts: Tests 301 passed (301)
- @ao/library src/find/search.test.ts: Tests 120 passed (120)
- @ao/library src/find/people.test.ts: Tests 40 passed (40)
- @ao/library src/find/free-copy.test.ts: Tests 80 passed (80)
- @ao/library src/find/elicit.test.ts: Tests 18 passed (18)
- @ao/library src/service-support.test.ts: Tests 31 passed (31)
- @ao/library-service src/close-during-attach.test.ts: Tests 5 passed (5)
- @ao/library-service src/open-library.test.ts: Tests 25 passed (25)
- @ao/library-service src/lock-during-change.test.ts: Tests 3 passed (3)
- @ao/library-service src/device-notices.test.ts: Tests 17 passed (17)
- @ao/library-service src/watched-folders-routes.test.ts: Tests 58 passed (58)
- @ao/library-service src/import-disk-full-answer.test.ts: Tests 3 passed (3)
- @ao/library-service src/import-disk-full.test.ts: Tests 2 passed (2)
- @ao/library-service src/import-log.test.ts: Tests 1 passed (1)
- @ao/library-service src/import-setup.test.ts: Tests 25 passed (25)
- @ao/library-service src/server.test.ts: Tests 1 failed | 159 passed | 1 skipped (161)
- @ao/library-service src/find-routes.test.ts: Tests 47 passed (47)
- @ao/library-service src/capture-queues.test.ts: Tests 31 passed (31)
- @ao/library-service src/capture-routes.test.ts: Tests 9 passed (9)
- @ao/library-service src/zotero-sync-routes.test.ts: Tests 43 passed (43)
- @ao/ui src/screens/Library.dismiss.test.tsx: Tests 4 passed (4)
- @ao/ui src/screens/Library.notices.test.tsx: Tests 4 passed (4)
- @ao/ui src/screens/Library.reader.test.tsx: Tests 9 passed (9)
- @ao/ui src/screens/Library.recheck.test.tsx: Tests 12 passed (12)
- @ao/ui src/screens/Library.test.tsx: Tests 47 passed (47)
- @ao/ui src/screens/Library.zotero.test.tsx: Tests 14 passed (14)
- @ao/ui src/screens/LibraryChooser.lostCreate.test.tsx: Tests 2 passed (2)
- @ao/ui src/screens/LibraryChooser.notices.test.tsx: Tests 5 passed (5)
- @ao/ui src/screens/LibraryChooser.shell.test.tsx: Tests 3 passed (3)
- @ao/ui src/screens/LibraryChooser.test.tsx: Tests 24 passed (24)
- @ao/ui src/screens/LibraryNotFound.test.tsx: Tests 10 passed (10)

The three failures in that pass were all fixed and the files re-run alone:
- `sources-confirm-bound.test.ts`: 6 passed.
- `zotero-sync.test.ts`: 77 passed.
- `server.test.ts`: 160 passed, 1 skipped.

Re-run after the bulk fix:
- `bulk/bulk.test.ts`: 103 passed.
- `bulk/zotero-gone.test.ts`: 26 passed.
- `zotero-web.test.ts`: 92 passed.

Further service files:
- `zotero-web-resume`: 2 passed.
- `zotero-sync-scheduler`: 43 passed.
- `transcription-jobs`: 40 passed.
- `library-place-routes`: 8 passed.
- `zotero-sync-routes`: 43 passed.

Typecheck: `@ao/shared`, `@ao/library`, `@ao/library-service` and `@ao/ui` all clean. `lint:css` ok, `lint:colours` ok.

Not run: the e2e scenario. No route address or button changed; the attach outcome is new, but no scenario closes a library during an attach.

## Not covered, or uncertain

- **A short window.** A request that took the session before the close began and has not yet asked its change goes on until it asks. If it asks before the lock is released, its change is made (before the release, so R247 c holds). If it asks after, it is refused. Only attach and watched folders refuse at the moment the close begins (their scope). Every other route relies on the session being dropped at once.
- **Quit stops Find early.** The service's stop now stops Find at its beginning, before the requests in flight have finished. A Find request in flight then sees Find stopped (as at a close). Judged right for Quit; say if not.
- **An existing route now meets the sentence.** "Bring in the new version" (watched folders) answers 409 with the sentence when a close cancels it. The sentence holds the file's name (a base name, never a path).
- **Not tested here.** Bulk Import cut mid-lookup: by reading only. The `.tmp` scratch writes and the job journal: service-guarded, not engine-refused.
- **The engine's choice for reads.** Turns of the write queue that only read (`verifyAudit`, `auditEventsMentioning`) are also refused once the handle is closed. Nothing in the library reads through a closed handle in the tests I ran.
- **Backups and a close.** `export/backup.ts` treats `ReadOnlyLibraryError` as "cannot run now", not a failure (:894, :1646). A `LibraryClosedError` there is treated as a failure. Its record is refused anyway once the library is closed, and the scheduler is stopped before the close. Not changed.
