# FR-749 (R546, R547) — adversarial review

Worktree `.claude/worktrees/kg-3b`, branch `fr-749-close-attach` at 19b05e7 (8 commits from 769e3e5). Read: the review briefs, R546, R547, R247, the implementer's report, the investigator's A6, and the whole diff (25 files).

**Verdict: NOT APPROVED.** The attach path, the engine's refusal and the lookup client's stop work as the report says. But:
- the Bulk Import claim is false: a close records every item still to look up as FAILED;
- a backup in flight is now RECORDED as failed in the library's folder, after the lock is released;
- the engine's central ordering guard (close() waits for the turn) has no test that fails without it.

## What I ran

**The new and changed tests, each alone. All pass:**
- `closed-library` 2/2
- `attach-closing` 4/4
- `watch-closing` 1/1
- `http-closing` 7/7
- `sources-confirm-bound` 6/6
- `rollback-rerun` 30/30
- service `close-during-attach` 5/5

**Planted faults** (each restored with `git checkout --`):
- **Fault 1:** remove the refusal at the start of a turn (`state.ts` enqueue). Caught: `closed-library` fails 1 test, `sources-confirm-bound` fails 1 test. `attach-closing` still passes, because it relies on attach's own `closingNow`.
- **Fault 2:** `close()` does not await the drains (`library.ts:460`, `await` → `void`). NOT caught: `closed-library.test.ts` passes 2/2 and `close-during-attach.test.ts` passes 5/5. See I3.

**Probes** (all deleted; `git status --short` is empty):
- `import/bulk/bulk-closing.probeFR749`
- `export/backup-closing.probeFR749`
- `repo/close-edges.probeFR749`
- `repo/drain.probeFR749`

## Findings

### Critical
None found.

### Important

**I1 — Bulk Import: a close records every item still to look up as FAILED, and the batch "finished". R546 (2), (3) and R547 are not met, and the report's claim is false.**
- `packages/library/src/import/bulk/run.ts:1155-1198`: `item()` catches every error and passes it to `itemError` (:1202-1221).
- `itemError` knows nothing of `LookupCancelledError`, so it falls to "anything else is unexpected" and journals the item `failed`.
- The new branch at :1078-1085 (`LookupCancelledError → paused`) is therefore never reached for an item's lookup.
- Because `stop()` is permanent, each later item's lookup fails at once. The loop journals them all as failed until the batch ends.

Probe:
1. A folder of 3 PDFs, a project with default lookups, every OpenAlex request answered 429 / Retry-After 60.
2. `bulk.startBatch`, wait for the first request, `http.stop()`, `await h.done`.

The batch ended `"state":"finished"` with `"failed":3`. `journal.jsonl` holds 3 lines like:

`{"key":"alpha.pdf","outcome":"failed","reason":"The item could not be imported: an unexpected error (LookupCancelledError).","cause":"LookupCancelledError"}`

What this means in the service:
- `closeLibrary` and the service's stop call `beginClosing` (which stops the client) BEFORE `suspendBatches`.
- So a large import that is running when the researcher closes, switches library or quits is recorded as finished, with every remaining lookup-needing item failed by "an unexpected error".
- It is not resumable, and the report says so to the researcher.
- Zotero Web sync batches go through the same run.

Direction: treat `LookupCancelledError` (and `LibraryClosedError`) in `itemError` and in the group store's fallback (:1882-1897) as conditions of the batch: rethrow, as `AbortError` and `RecoveryPendingError` are. Add the service-level test the report says was too costly; the probe above is about 60 lines.

**I2 — A backup in flight when the library closes is now RECORDED as failed in `Backups/backups-state.json`, written AFTER the lock is released.**
- `packages/library/src/export/backup.ts:892-900`: `recordFailure` excuses only `ProjectLockedError` and `ReadOnlyLibraryError`.
- `LibraryClosedError` is recorded through `withState`. That writes `<library>/Backups/backups-state.json` directly, outside the write queue.

Probe:
1. `backupSeams.afterSnapshot` held, then `kit.lib.close()`.
2. Snapshot the folder byte for byte.
3. Release the hold, let the backup settle, snapshot again.

Results:
- The backup rejects with `LibraryClosedError`.
- After `close()` had resolved, `Backups/backups-state.json` changed (digest 2b07… → 21ae…).
- `backupFailure()` is `{"reason":"The backup could not be made (The library has been closed; nothing more can be changed through it)."}`. This is shown as the `backup-failed` warning at the next open, in words that are not the house's.

How a researcher reaches it: `closeLibrary` does not wait for a manual backup in flight (`routes/projects.ts:218`). Press "Back up now" on a large project, then close the library or open another.

The report's write-path table also leaves out the Backups family:
- the zip's `.tmp-*` file;
- the manifest;
- the state file.

All of them are under the library root and outside the engine's guard. Before this change the backup's record went through after the release. That earlier writing after the release is older than this change, but it is the same property R546 / R247 c rule on.

Direction:
- treat `LibraryClosedError` as "cannot run now" in `recordFailure` and at :1646;
- make the backup's own writes stop with the close (the route counted, or the backup's work awaited by `closeLibrary`);
- say the family in the report.

**I3 — The engine's ordering guard is untested: `close()` can stop awaiting the drain and every test still passes.**
- `closed-library.test.ts:101-106` asserts the order after a single `setImmediate`.
- The lock's release (an unlink) is slower than that, so `closed === false` and `.lock` present hold even when `close()` does not wait.
- The service test passes for another reason: `closeLibrary` is held by other bounded waits.

Probe `drain.probeFR749`: hold a turn, call `close()`, wait 300 ms.
- With fault 2: `closed true, lock false`. The lock was released while the change was still in its turn, which is the very fault of FR-749.
- With the real code: `closed false, lock true`.

Direction: assert the order through held promises. For example:
- record the order of "turn released" against "close resolved" or "lock gone";
- or keep the turn held until the `release` seam is observed;
- not one tick.

### Minor

**M1 — `close()` called a second time resolves before the lock is released.**
- `library.ts:456`: `if (ctl.closed) return;`.
- Probe: with a turn held, a second `close()` resolved while `.lock` was still present.
- The window existed before this change, but it is now as long as the drain.
- Direction: keep and return the first close's promise.

**M2 — A turn that calls `close()` on its own library hangs for ever.**
- Probe: `importChange(…, async () => { await lib.close(); })` was still pending after 5 s.
- I found no caller doing this today (grep of every `close()` call in library, service and CLI).
- Direction: a cheap guard, `if (holdsTurn) throw`, or document it.

**M3 — The closing scope belongs to no library, and leaks into long-lived work started inside it.**
- `whileOpen` is a process-wide AsyncLocalStorage holding a bare signal. Probe: under an aborted signal of "another session", ANY repository's change is refused (`importChange` throws `LibraryClosedError` synchronously).
- The scope is inherited by work an attach starts: `ProxyQueue.enqueue` → `this.chain.then(runSource)` (`proxies.ts:217,241`) runs the viewing-proxy job in the attach's scope.
- Once the close begins, that job's record is refused. Its failure record is refused too, so it stays pending: no wrong record.
- I found no object shared across sessions that consults the scope, so open → attach → close → open → attach works (by reading).
- Direction: bind the scope to the Library (store `{lib, signal}` and compare), and run enqueued background work outside the scope.

**M4 — `importChange` / `runImportChange` throw SYNCHRONOUSLY when closed** (`import-ops.ts:61`). A `void importChange(…).catch()` caller would get an uncaught exception. I found no such caller; the read-only case already had the same shape.

**M5 — Wording.**
- "Bring in the new version" now answers 409 with "…attach it again after opening the library." The researcher's act there is not "attach".
- On reconnect, the library went away; it was not "closed".
- A change refused by the engine after a close answers 503 LIBRARY_OFFLINE "No library is open." That is false when ANOTHER library is already open (open-another), and the page's map shows its own LIBRARY_OFFLINE sentence for it ("The library is offline … It reconnects when its drive returns.", `ui/src/api/library.ts:458`).

**M6 — Reads through a closed handle are now refused.**
- `project-export.ts:462` (`verifyAudit`) and `retention.ts:486` (`auditEventsMentioning`) were never in the report's list of callers. An export running when the library closes now fails; before, it read after the release, which is legal.
- I did not judge what retention records when its scan is refused.

**M7 — The index is closed before the drain.**
- `closeLibrary` (`state.ts:1334`) and the CLI's `session.close` close the index before `lib.close()` waits for the turn in progress.
- That change's index update then fails. The index is rebuildable and the change stands.
- Direction: close the index after the drain.

**M8 — The service test "the service's stop…" compares only filtered lines** (source.json, original, review), not the full byte snapshot that the close-route test uses.

## The eleven points

| # | property | verdict | note |
|---|---|---|---|
| 1 | nothing written after the lock is released, every family | **does not hold** | Governed changes, marker, audit, review, register, recovery warnings and settings: refused (`closed-library`, fault 1 caught). The lookup cache: client stopped, and `setDiskCache(false)` before release. The job journal and `.tmp`: service-guarded (`workerClient.close`, STOPPED_AT_CLOSE), by reading. **Backups:** zip tmp, manifest and state are written after the release, and now a failure record too (I2). Restore runs inside a turn (waited for). |
| 2 | close between the steps of one attach | holds | One attach is one governed turn (`createSourceRefusing`: original, source.json, review entry, audit, index). The policy turn writes nothing on an allow. Closed before the turn: refused → `cancelled`. Inside it: finishes (`attach-closing` test 3, service test "the close waits", reopened clean). The CollectionGone path is two turns, the first undone. The lookup cache may hold an answer from before the cut (not governed; before the release). |
| 3 | hangs | partly | `close()` has no limit, by ruling (R247 d). A turn that closes its own library hangs (M2). A second close returns early (M1). The service's stop is bounded by FORCE_EXIT_MS (90 s); the close route and open-another are not. The changed `sources-confirm-bound` test only releases its own hold, and the expectation is stricter (runs 0); it does not assert that `w.done` resolved. |
| 4 | the closing scope | partly | No refusal half-way through a turn (`holdsTurn`). Work after the close is refused at the turn's start. The scope is unbound to a library and leaks into the proxy queue (M3). No cross-session leak found. |
| 5 | `LookupCancelledError` for every caller | **does not hold** | Bulk records items failed (I1). Attach and watch: right. Find: `endFind` before the stop; the runner's guard drops late results (by reading, plus `find-routes` test). The search-settings Test uses its own client (unaffected). Zotero Web inherits I1. No unhandled rejection seen in the probes. |
| 6 | each sentence true where shown | partly | M5. The name is a base name, through `UserText` on the page. |
| 7 | watched folders | holds (by reading and `watch-closing`) | Cancelled → job put back, nothing registered, watch stopped with `libraryClosed`. A file in its turn finishes and is registered by `stopWatches`'s flush, before `lib.close`. Quit takes the same path. |
| 8 | bulk import | **does not hold** | Probe built (I1). |
| 9 | Quit | partly | The attach in its turn completes (in-flight wait, then the drain). Find stops earlier; acts in their turn still finish (stopAll), by reading. Limits unchanged (IN_FLIGHT_WAIT_MS 60 s, FORCE_EXIT_MS 90 s). Bulk on Quit: I1. |
| 10 | what else changed | partly | Backup: I2. Export and retention reads refused (M6). The integrity check: fixed by 19b05e7. The CLI and the browser extension never meet `cancelled` (no closing signal passed; CLI attach outcomes not mapped). |
| 11 | tests assert the order; planted faults | partly | Fault 1 caught. Fault 2 NOT caught (I3). The library tests compare byte snapshots; one service test filters (M8). |

## What I could not judge
- Retention's handling of a refused scan (M6).
- Find runner's every catch under a stopped client: by reading only, relying on `stopAll` and the guard.
- A hung network mount inside a turn (close and reconnect would wait without limit, by ruling).
- The end-to-end UI.

## To mend before a join
1. I1: bulk items must not be journaled failed. The batch must be left paused, with a test.
2. I2: a backup cut by a close must not be recorded as failed, and its writes after the release must be stopped or waited for.
3. I3: a test that fails when `close()` does not wait for the turn.

M1 and M3 are cheap and worth doing with them.
