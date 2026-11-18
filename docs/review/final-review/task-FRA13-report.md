# Task FR-A13 report: a change being saved is never sealed under a wiped key (R379, WB2 C1)

Branch `fr-a13-key-ring`, worktree `.claude/worktrees/agent-a8f81b7c97773ed6a`. Head **3aa0561**. Four commits on top of 7b81976:
- ce51025: the all-zero guard, plus the race tests
- bed0bc6: KeyRing.add keeps the buffer when the same key is added again
- f949787: lock and repeat unlock go through the write queue (serialNext)
- 3aa0561: a test showing that a key wiped mid-write leaves no line under zeros

## Design chosen (point 1)
I did not use (a) "copies" or (b) "read at sealing" as written. I used **(b) by construction**: the ring's buffer is wiped only between turns of the write queue, and every governed seal happens inside a turn. Within a turn the key a change holds cannot be zeroed, so `tx.key()` captured before an `await` (in mutate.ts, watch-register.ts, import-ops, the find queue and others) is safe without per-site edits. Below that sits the all-zero guard.

Why this and not (a): `core.key()` has about 30 callers. Making each copy the key and wipe its copy at scope end would mean editing every one, while serialisation already covers every holder inside a turn.

Holders outside a turn:
- **Backup snapshot and worker jobs:** these already take their own copy (`export/backup.ts` snapshot, `worker-client.ts:421`) and zero it when done. They are unchanged.
- **link-capture:** it reads the key synchronously into `encryptBytes`, and `encryptStream` copies the key when the stream is created.
- **Legacy job-journal upgrade and index readers:** these use the ring buffer outside a turn. If a lock lands mid-way, reads fail to decrypt and seals now fail closed on the guard.

The accessors that hand out the key are `core.key` (state.ts), `tx.key` (mutate.ts:211), `projectDataKey` (repo.ts:945), `keyFromRing` (repo.ts:1448), the `ctx.key` of `withProjectQueue` (repo.ts:1428) and `projectKey` (index/changes.ts:51). All of them return the ring's buffer.

## Points
1. **All-zero guard.**
   - `assertSealingKey(key, keyId)` is added at `crypto/format.ts:80`. It throws `KeyNotAvailableError` when the key is all zeros.
   - It is called in `encryptStream` (format.ts:206), which covers `encryptBytes`, `copyFile` and every encrypted copy, and in `sealLine` (`repo/io.ts:218`), which covers every sealed line.
   - Tests: "sealing with an all-zero key is refused" in `repo/key-lock-race.test.ts`. They failed first.
2. **A lock waits its turn.**
   - `RepoCore` (`repo/state.ts:149-236`) replaces the promise chain with an explicit queue. `serial` behaves as before. The new `serialNext` runs a turn after the turn in progress and ahead of the turns already waiting. `queueIdle()` is also new.
   - `lockProject` (`repo/projects.ts:476-500`) now returns `Promise<void>`. **This changes the signature, as the ruling requires.** When the queue is idle it locks at once, so existing tests that do not await it still see the project locked immediately. Otherwise the lock runs through `serialNext`.
   - `Repo.lockProject` (repo.ts:236) changes to match.
   - The service lock route awaits it (`apps/library-service/src/routes/projects.ts:169-170`).
   - Wait time for long background work: the lock waits only for the one change in progress. A bulk import, a watched folder or Find is many turns, one per change, so the lock goes next and their later changes are refused with `ProjectLockedError` and write nothing.
   - I deliberately did not use `holdsTurn()` as a bypass. A timer started inside a turn inherits its context, which is exactly how probe 1 fires, so `holdsTurn()` would wrongly report the lock as running inside the turn.
   - Tests:
     - Probe 1, "a lock on the next macrotask…": failed first (the line opened with zeros).
     - "a lock waits only for the change in progress…": failed first.
     - "the lock zeroes the ring's buffer once the change in progress is done": failed first with ProjectLocked.
     - The interleaved loop of 50 (audit chain verifies; every sealed line of every purpose opens with the real key): failed first.
     - The service test `apps/library-service/src/lock-during-change.test.ts`: failed first ("lock answered" arrived before the change committed).
3. **Same key again keeps the buffer.** `KeyRing.add` (`crypto/keys.ts:269-277`) compares the keys with `timingSafeEqual`; a different key under the same id still replaces the old one. `unlockProject` (projects.ts:237-243) adds through `serialNext` when the key is already in the ring and a write is running.
   - Tests: the new KeyRing unit test in `crypto/crypto.test.ts` failed first. Probe 3, "the same key added again…", failed first.
   - "a second unlock while a change is being saved" passed before any fix: the unlock's scrypt finished after the commit. It began failing once the guard was in place, which showed the zero-filled buffer, and passes now.
4. **Same class.** The watch-register test "a lock asked as its write starts waits for it" failed first: the lock landed mid-write and the change was refused. "A key wiped outside the queue (the ring cleared) mid-write …, even when its rollback fails" forces `seams.failUndo = "append"`. Before the guard, 30 lines stayed on disk, some under zeros, so it failed first. Now the write fails closed at the next line and what remains opens with the real key only. **There is no longer a file encrypted under zeros for `txn.ts`'s `rm` to remove.**
5. **The key is still wiped at lock.** The ring's buffer is zeroed (tested). No other copies are handed out to turns.

## Existing test changed
`apps/library-service/src/find-routes.test.ts:787`: its stub of `lockProject` now `return`s the original's promise, which the new type needs. It is otherwise unchanged and its assertions are not loosened. That lock waits only for `core.serial` turns, not the per-project `serialStore` queue, so the test's order is the same.

## Not shown here / remarks
- No real Mac is needed; this is pure Node.
- `KeyRing.clear()` (session close / app exit) still wipes outside the queue. A change in flight then fails closed on the guard (tested) rather than waiting.
- A turn that awaited its own `lockProject` would deadlock. No code does this.

## Minor (deferred)
- `reasonMac` (the HMAC of an audited reason) has no all-zero guard. It is computed inside the turn, so it is safe under the new queue. I left the guard out to stay within scope.
- Locking is still not audited (WB2 M2).
- `holdsTurn()` reports true inside timers or callbacks started within a turn, even after the turn ends. Other callers rely on it, and I did not touch it.

## Runs (nice -n 10)
- `vitest run src/repo/key-lock-race.test.ts src/crypto/crypto.test.ts`: 63 passed
- service `src/lock-during-change.test.ts`: 1 passed
- `pnpm --filter @ao/library test`: Test Files 107 passed | 1 skipped; Tests 3729 passed | 5 skipped
- `vitest run src/repo src/crypto` ×2: 22 files, 449 passed, both times
- `pnpm --filter @ao/library-service test`: Test Files 41 passed; Tests 1026 passed | 1 skipped
- `pnpm -r typecheck`: all Done
- `git status --short` is empty.

## Round 2 (R386)

Commits on top of 3aa0561:
- 15eb1e5: (a) the opening primitives and the readers
- 08e0d18: (a) caches and the lock's purge, (b) the "locking" mark, (c) M3 and M4
- 53298c9: (b) the service route answers at once
- 57740a9: (a) viewing proxies, and a test that job rows are not rewritten

The tests are in `packages/library/src/repo/key-read-race.test.ts` (19, new) and `apps/library-service/src/lock-during-change.test.ts` (rewritten for R386 b).

### (a) I1: a read under a wiped key never leaves wrong state
1. **Opening primitives.**
   - `assertLiveKey(key, keyId)` (`crypto/format.ts:81`) replaces round 1's `assertSealingKey` and is now used by every primitive that opens or seals with a project key:
     - `encryptStream` (:207).
     - `decryptStream` (:342, once the header names the key; the stream copies the key at that point).
     - `openDecryptedHandle` (`crypto/random-access.ts:58`).
     - `sealLine` (`repo/io.ts:218`).
     - `openLine` (`repo/io.ts:228`; the keyId is read from the envelope).
   - `decryptBytes` and every `getKey` closure go through `decryptStream`.
   - A wiped key throws `KeyNotAvailableError`, which the service maps to 423. A wrong key that is still live remains `DecryptionError` (tested).
   - `keys.ts` unwrap uses the KEK and is unaffected.
   - Failed first: yes (wrong error type).
2. **Readers that tolerate lines they cannot open** now let `KeyNotAvailableError` through:
   - Watched-folders register `fold` and `readWatchRegister`: become `ProjectLockedError`; nothing is cached.
   - Find queue `parseLine` and `loadFolded`: become `ProjectLockedError`; the cache entry is deleted, never set.
   - Job journal `parseJobJournal`: so `readJobJournal`, `refreshJobRows`, `cancelPendingJob` and `compactJobJournal` stop before any row is written or any line rewritten. Tested: `refreshJobRows` refuses and never calls `db()`.
   - Review queue `parseReviewFile`.
   - Batch journal (`import/bulk/batch.ts`).
   - The change log's newest-id scan (`index/changes.ts`).
   - `readProjectReasons`. The audit screen's `withProjectReasons` (`repo/repo.ts`) turns such a refusal into `ProjectLockedError`, not "unreadable". After its reads it also refuses if the key it will check digests with was wiped meanwhile.
   - Not changed:
     - `openLibraryReason`: it is opened synchronously with a key read just before.
     - `restore.ts`: inside a turn, with the backup's own key.
     - `restore-record.ts`: already maps any failure to "locked".
     - Index loaders (`index/load.ts`): the index is rebuildable, purged at lock, and its sink re-checks `keyRing.has`. Listed as minor below.
   - Failed first: the register probe (n = 0, 1, 5, 39 gave sizes 0, 0, 0, 399 with no error), the Find queue probe (`FindQueueUnreadableError`, a false "damaged" for a lock), and the job-journal tests.
3. **Caches purged at lock.** Modules register a purge in `lockPurges` (`repo/state.ts:142`); `lockProject` runs every purge beside the index purge, both when the lock is asked and in the lock's own turn. The watched-folders register (`watch-register.ts:180`) and the Find queue (`find/queue-store.ts`) drop the project's entries. Test seams `watchCacheSize` and `findCacheSize` back the test, which failed first.
4. **"Locked", not "damaged".**
   - `exportProjectOpenFormats` lets `KeyNotAvailableError` and `ProjectLockedError` through instead of `ExportFailedError` (the export test, run at lock after 0 to 20 ticks, failed first with ExportFailedError).
   - The proxy runner (`import/proxies.ts`) treats `KeyNotAvailableError` like `ProjectLockedError`: the job stays PENDING.
   - The service maps `KeyNotAvailableError` to 423 already (`errors.ts:153`).

### (b) M1: locking is immediate for everyone but the change in progress
- **The mark.** `lockProject` (`repo/projects.ts`, about :476-526) calls `keyRing.markLocking(keyId, core.admitsOnlyRunningTurn())` synchronously, before it returns its promise (when the queue is idle it simply wipes at once, as before).
  - From then on `KeyRing.get` and `KeyRing.has` (`crypto/keys.ts`) answer as if the key were gone to every caller the test does not admit.
  - That covers every accessor: `core.key`, `tx.key`, `projectDataKey`, `keyFromRing`, `withProjectQueue`'s `ctx.key`, `projectKey` for the index, `isUnlocked`, and so the project list.
  - The key is wiped, and the mark cleared (`remove`), in the lock's `serialNext` turn when the turn in progress ends.
  - A second `lockProject` while one is pending returns the same promise.
- **How "the turn in progress" is told apart.**
  - The queue's AsyncLocalStorage store is now a per-turn object (`Turn`), not the core. `RepoCore.running` holds the turn running now.
  - `admitsOnlyRunningTurn()` captures that object when the lock is asked and admits only code whose store is that very object.
  - A later turn gets a new object, so it is not admitted. Code outside the queue has no store, so it is not admitted. If no turn has started yet, nothing is admitted.
  - A timer or callback started inside the running turn carries its store, so it is admitted until the key is wiped at the end of that turn. Tested: a timer inside the held change saw the project unlocked while every outside reader saw it locked.
  - `holdsTurn()` now compares `store.core`.
- **Unlock while a lock is pending.** `unlockProject` waits for every pending lock of the project, after the unwrap and before adding the key, then unlocks. Tested back to back: the project ends unlocked with the same key and every line readable.
- **Route: it answers AT ONCE (200 `{unlocked:false}`), not after the wipe.** R386 says the route answers at once, and with the mark the answer is already true for every reader. The project list reports `unlocked: false` immediately, and a key-reading route answers 423. The rest of the route (media revoke, purge, end captures, publishState) runs at once too. The test checks that the lock answers while the change is held, that the list says locked, that `GET /review` answers 423 (it answered 200 just before), and that the held change's lines open with the real key.
- **Tests:** the reviewer's probe (a read 300 ms later refused, `projectDataKey` refused, the held change committed under the real key, a new change refused); a stuck change (reads stay refused); the timer; lock then unlock back to back. They failed first except "back to back", which passed before as well.
- **Existing test changed:** `repo/key-lock-race.test.ts`, "a lock waits only for the change in progress". It asserted `isUnlocked === true` while the lock waited; R386 b inverts that, so it now asserts `false`.

### (c)
- **M3.** A replaced key file wraps another key under the same key id, an unlock lands while a change is held, and every line must open with the original key. With the `serialNext` branch of `unlockProject` removed, the test fails ("authentication failed at chunk 0"); with the branch it passes.
- **M4.** `lockProject` returns `Promise.reject(NotFoundError)` for an unknown project instead of throwing (tested; it failed first). Callers: the service route (`getProject` already 404s first) and the tests.

### Not done / minor (deferred)
- The index loaders (`index/load.ts`, rebuild) still treat a decryption failure the way they did. The index is purged at lock and rebuilt at unlock, so nothing wrong survives, but a rebuild a lock cuts short may record its errors as damaged rows until the next reload.
- M2 (`KeyRing.clear` at close) is left to FR-663, as ruled.

### Runs (nice -n 10; machine load average 30-39 throughout)
- `vitest run src/repo/key-read-race.test.ts`: 19 passed. `src/repo/key-lock-race.test.ts`: 11 passed. Service `src/lock-during-change.test.ts` with `src/find-routes.test.ts`: 44 passed.
- `pnpm --filter @ao/library test`: Test Files 4 failed | 104 passed | 1 skipped; Tests 9 failed | 3739 passed | 5 skipped. All 9 are time-limit tests. Re-run alone:
  - `find/runner.test.ts`: 286 passed.
  - `html-strip.test.ts` (2), `refman.test.ts` (5) and `annotations-cap.test.ts` (3): still over their time budgets at load 35-39. None touches the changed code (pure parsing and indexing timings).
- `src/repo src/crypto src/find src/import/watch.test.ts src/worker-client.test.ts`, twice:
  - Run 1: 1799 passed, 2 failed (watch "status coalesced… 2,000 files", 62 s; runner "F8 daily allowance… second works page").
  - Run 2: 1800 passed, 1 failed (the same watch test).
  - Alone, the watch test passed. The F8 test is flaky under load both on this head (2 of 3 alone) and at the base 7b81976 (3 of 4 alone), so it is not caused by this change.
- `pnpm -r typecheck`: all Done.
- `pnpm --filter @ao/library-service test`: Test Files 6 failed | 35 passed; Tests 7 failed | 1019 passed | 1 skipped, at load average about 50. Re-run alone:
  - Passed: `recovery-code.test.ts` (10 passed, among them "a success clears the count", which had timed out at 62 s) and `search-settings-routes.test.ts` (41 passed).
  - Still failing: `find-browser-routes.test.ts` "the pause after a hand-over…" fails on a wall-clock countdown, "Ready in 18 seconds" against the expected 20, because the loaded machine is slow.
  - Not re-run: `main.test.ts` (two services on one port), `scripts/launcher.test.mjs` and `zotero-test-switches.test.ts` all spawn processes and hit their 60 s / 120 s limits. None goes near the lock or the key ring.
- `git stash`: in round 1 I used `git stash push` and `git stash pop` once, on my own files, to see a test fail without the change; in round 2 I called `push` once more, but nothing was stashed. Since the coordinator's note I have not used it, and the round 2 checks instead took files from an older commit with `git checkout <commit> -- <path>` and restored them from HEAD. `git status --short` is empty.

## Round 3 (R404)

Branch `fr-a13-key-ring`, worktree `agent-a8f81b7c97773ed6a`. Commits on top of 57740a9:
- 487bdc2 (a): the opening seam and the harness, with the rows that already passed
- a9e336a (b): the eight readers the harness first caught, mended; all rows in the harness
- 3655e64 (b): two more rows (the record of deletions, a sealed retention file) and their two readers
- ea7b62c (c): "lock, unlock, lock" ends locked
- d134d96 (d): tests for the guards of R386 and the turn identity
- d3141b1 (b): only a WIPED key counts as a lock (`KeyWipedError`), found by the library suite

### (a) The harness — `packages/library/src/repo/lock-mid-read.test.ts`
- **Seam.** `openingSeam` / `noteOpening` (`crypto/format.ts:76-84`, reached via `repo/testing.ts`; honoured only when NODE_ENV=test, R47). It is called just before every opening with a project key: `decryptStream` (format.ts:344, before the key is asked for; so it also covers `decryptBytes`, `copyFileAtomic` decode and every `getKey` closure), `openDecryptedHandle` (random-access.ts:57, before the key is asked for) and `openLine` (io.ts:229, before the key is checked). The test counts openings and, at the Nth, calls `lockProject` without awaiting it.
- **The project.** One encrypted, pseudonymising project (PSEUDO_GOV): 3 PDFs (one identifiable, its creator pseudonymised), 2 annotations, a recording with a machine transcript, a source awaiting verification, a Zotero item deleted here (sealed record of deletions), a participant with details, a session with place and notes, two consents with signed forms (one detached with a reason), 2 protocol documents, sealed audit reasons (set-aside, detach, rules loosening), a Find queue of 3, a watched-folder register of 3, 3 job-journal records (2 pending), a BibTeX import batch (record, journal, report), a sealed file in `retention/`, a backup, and an index (IndexHandle + sink).
- **Per row.** First a cold run (lock + unlock first, so nothing is kept) gives the result and the count K of openings. Then for each N in 1…K (at most 40, evenly spread): lock + unlock; hash every file in the library (the index's database and the lock file left out); run with the lock at opening N; await the lock. The test asserts:
  - the outcome is the unlocked result, OR (only for rows marked `locked`) the result of the same reading with the project locked from the start, OR a rejection that is `ProjectLockedError` / `KeyNotAvailableError`;
  - `integrityWarnings` are unchanged;
  - no file changed. Rows marked `writes` are exempt only when they succeeded. The backup row also allows its `backup.create` decision entry, which is audited before any opening.
  - After `unlockProject`, the same reading gives the unlocked result, and the index's rows of the project (persistent and in memory) equal the baseline.
- **Time limit:** 30 min per row (`ROW_MS`). A whole run took 4-5 min at load ~30-40.
- **The table: 39 rows** (plus one test that checks the seam itself):

| # | Row | Where | Caught |
|---|---|---|---|
| 1 | getSource (every source) | repo/repo.ts:254 → repo/sources.ts:133 | |
| 2 | getSourceRecord (every source) | repo/repo.ts:258 → sources.ts:165 | |
| 3 | getSourceRecordWithAssets | repo/repo.ts:262 → sources.ts:632 | |
| 4 | listAnnotations | repo/repo.ts:290 → repo/annotations.ts | |
| 5 | readTranscript | transcript-segments.ts:305 | |
| 6 | readAssetText | source-actions.ts:122 (:132) | |
| 7 | openAssetContent (whole PDF) | asset-content.ts:58 (:100) | |
| 8 | getFieldwork | repo/repo.ts:475 → fieldwork.ts:159, projects.ts:548 (readSecrets) | |
| 9 | projectPseudonymMap | repo/repo.ts:1562 → pseudonyms.ts:22 | |
| 10 | projectReviewEntries | repo/repo.ts:1113 → review.ts:438 | |
| 11 | bulk.listProjectReview | import/bulk/review.ts:64 (withTitles :85) | **yes** |
| 12 | readFindQueueIn | repo/repo.ts:1321 → find/queue-store.ts:331 | |
| 13 | readFindQueueDetailedIn | repo/repo.ts:1326 | |
| 14 | heldWaitingCountIn | repo/repo.ts:1344 → review.ts:560 | |
| 15 | watchRegister | repo/repo.ts:423 → watch-register.ts:131 | |
| 16 | watchOrigins | repo/repo.ts:431 | |
| 17 | readJobJournal | job-journal.ts:172 (:157) | |
| 18 | refreshJobRows (resumePending's and the sink's read) | job-journal.ts:349; worker-client.ts:321; index/sink.ts:66 | |
| 19 | transcriptionRecords | transcription-jobs.ts:112 | |
| 20 | bulk.listBatches | import/bulk/run.ts:2418 (readProjectText batch.ts:206) | **yes** |
| 21 | bulk.listReview (batch) | import/bulk/review.ts | |
| 22 | bulk.batchReport | import/bulk/report.ts:171 → findBatch | **yes** |
| 23 | findBatch + readJournal | import/bulk/batch.ts:239, :273 (:282) | **yes** |
| 24 | listProtocolDocuments | protocol-docs.ts:139 (readManifest :68) | **yes** |
| 25 | deletedHere + deletedRecordsTrouble | repo/repo.ts:1140, :1151 → tombstones.ts:62 | **yes** |
| 26 | listCollectionsAndTags | repo/repo.ts:480 | |
| 27 | readAudit (sealed reasons) | repo/repo.ts:349 → withProjectReasons :1626 → audit-reasons.ts:108 | |
| 28 | readPlain (sealed retention file) | destruction-record.ts:145 (:157); retention.ts:457/465/558; restore-record.ts:71 | **yes** |
| 29 | buildExport (BibTeX) | export/refman-export.ts:301 | |
| 30 | exportRefman (RIS, audited) | refman-export.ts:356 | |
| 31 | exportBibliography | export/bibliography.ts:226 | |
| 32 | citeSources | bibliography.ts:159 | |
| 33 | exportProjectOpenFormats | export/project-export.ts:248 (:377, :412) | |
| 34 | backupProject (a backup made) | export/backup.ts:1038 | (see note) |
| 35 | checkIntegrity quick | reconnect.ts:469 (expectedFiles readSource :428) | **yes** |
| 36 | checkIntegrity full | reconnect.ts:469 (hashStream :512) | **yes** |
| 37 | rebuildIndex | index/rebuild.ts:83 (populate; computeStamps → changes.ts:80; load.ts) | **yes** |
| 38 | indexUnlockedProject | index/sink.ts:18 (load.ts:17/37/81) | **yes** |
| 39 | relinkMissing (an encrypted original) | reconnect.ts:823 (hashOf :857, verify :961) | **yes** |

- **Readings tried that make no opening in this project.** These were taken out of the table because K = 0, so there is nothing to lock at:
  - `attentionMarks`, `projectWarnings`, `verifyAudit`, `listBackups`, `listDestructions` / `retentionDue`: plain files only.
  - `readLibraryAuditPage`: the library log of this library holds no sealed reason.
- **Every user of the opening primitives, and the row that covers it:**
  - **Covered by a row:**
    - `sources.ts:133/165/206/632` → rows 1-3.
    - `pseudonyms.ts:22` → 9.
    - `projects.ts:548` → 8.
    - `tombstones.ts:62` → 25.
    - `review.ts:468` → 10, 11, 37.
    - `watch-register.ts:131` → 15, 16.
    - `find/queue-store.ts:331` → 12, 13.
    - `job-journal.ts:157` → 17-19, 37, 38.
    - `batch.ts:206/282` → 20-23.
    - `undo.ts:46`: same shape as `batch.ts:206`; no row.
    - `protocol-docs.ts:72` → 24.
    - `audit-reasons.ts:108` → 27, plus `lock-guards.test.ts`.
    - `destruction-record.ts:157` → 28.
    - `asset-content.ts:100` → 7.
    - `source-actions.ts:132` → 6.
    - `project-export.ts:377/412` → 33.
    - `reconnect.ts:88` → 35, 36, 39.
    - `index/load.ts` and `index/changes.ts:80` → 37, 38, plus `lock-guards.test.ts`.
    - `proxies.ts:332` → `lock-guards.test.ts` (proxy runner).
  - **Inside a turn, or on a copy of the key: no row.** A lock cannot wipe the key under these.
    - Inside a turn: `mutate.ts:273`, `import-ops.ts:167`, `fieldwork.ts:481`.
    - The backup's own key: `restore.ts:563/612/754`.
    - A copy of the key: `worker-client.ts:472`.
    - The library's capture flows: `capture/link-capture.ts:286` and `capture/profile-capture.ts:236`. I did not build a row for them (they need a capture or the fake platform).
    - `job-journal.ts:421` (the legacy upgrade): only for databases written before the journal existed.
    - `restore-record.ts:172`: already maps any failure to "locked".
    - `openLibraryReason` (`audit-reasons.ts:138`): opened synchronously with a key read just before.
  - **`core.key` / `projectDataKey` / `tx.key` users:** they reach the key through the primitives above. The key-taking side is held by the "locking" mark (round 2).

### (b) Readers caught and mended
Each failed in the harness first (logs fra13-h2, h3, h13, h14).
1. **`listProjectReview`'s titles** (row 11), `import/bulk/review.ts:85`. A source that could not be read was listed without its title (a shorter result). The locked refusal now goes through.
2. **`listBatches`** (row 20), `import/bulk/run.ts:2436`. The batch was not listed (empty list). Now rethrows.
3. **`findBatch`** (rows 22, 23), `import/bulk/batch.ts:245`. It returned "not found", so `batchReport` said "Import batch … not found". Now rethrows.
4. **`listProtocolDocuments` / `readManifest`** (row 24), `protocol-docs.ts:78`. It said "damaged" and left an integrity warning. Now it answers `ProjectLockedError` and notes no warning.
5. **`checkIntegrity`** (rows 35, 36), `reconnect.ts:444` and `:529`. Originals were reported "mismatched", or a source was reported in error. A locked refusal now leaves `checkOnce`, and `checkIntegrity` (`:470-483`) checks again with the project now locked (presence only, as for any locked project). Retries are bounded at 3, after which "locked" stands. The harness accepts the locked-project result.
6. **`rebuildIndex`** (row 37), `index/rebuild.ts:83-100`, `:275`, `:284`, `:309`. The project was left with part of its rows, and errors were recorded. A locked refusal while the new index is built drops it (the old index is untouched) and builds again, with the project now indexed as a locked project (manifest-level rows). A project locked during the final reload is reported in `lockedProjects` (`:141-145`).
7. **`indexUnlockedProject`** (row 38), `index/sink.ts:55` and `:71`. It returned a partial count plus "key not available" errors. When locked meanwhile, it now purges the project and returns what a locked project gets (`{ indexed: 0, errors: [] }`).
8. **`relinkMissing`** (row 39), `reconnect.ts:874`, `:982`, `:1024`. A candidate was quietly not matched, or "verify-failed", or a warning was left. A locked refusal now skips the file as `project-locked`, as a locked project's file is; the attention intent of a run with no copies is removed as before. When the lock lands in `expectedFiles`, the call rejects as locked before anything is written.
9. **`readTombstones`** (row 25), `repo/tombstones.ts:79`. It said "unreadable", so `deletedHere` returned null and `deletedRecordsTrouble` was true (a false project warning). Now rethrows.
10. **`readPlain`** (row 28), `destruction-record.ts:160`. A sealed certificate was reported "unreadable". Now `ProjectLockedError`.

- **New helper:** `isLockedRefusal(err)` in `repo/errors.ts` (`ProjectLockedError` or `KeyWipedError`).
- **`KeyWipedError` (d3141b1).** It is a subclass of `KeyNotAvailableError` that keeps the same name, so the service's 423 and the UI's name check still read it as "locked". `assertLiveKey` throws it (`crypto/format.ts`). It separates a key a lock wiped from a key that is unknown (a file sealed under another key id), and that difference matters: the first version admitted every `KeyNotAvailableError`. The library suite then showed `zotero-local.test.ts` "R74 I2: a sealed deletion record with the wrong key id fails closed" answering "locked" instead of "unreadable". With `KeyWipedError` that test passes again and holds the difference.
- **Left as round 2 built it:** round 2's guards in `export/project-export.ts` and `import/proxies.ts` still admit any `KeyNotAvailableError`. A foreign key id there reads as "locked" / PENDING. That is a minor point, deferred.
- **Every catch is still there for real damage:** each fix only puts the locked refusal ahead of the tolerant handling.
- **Readers I could not make right:** none. Every caught reader can tell a wiped key from damage locally.
- **Backup (row 34): a choice I made, for the coordinator to confirm.** A backup cut short by the lock leaves its audited `backup.create` allow decision. That decision is audited before any opening, as every governed decision is. Nothing read under the wiped key is written, and no failure or warning is recorded (`recordFailure` already ignores a lock). I accepted that entry in the harness rather than move the audit.

### (c) M1: lock, unlock, lock ends locked
- **What changed:** `unlockProject` (`repo/projects.ts:218-233`) now records itself as the project's pending unlock (`core.pendingUnlocks`, `state.ts:171-172`) while it runs. A `lockProject` asked meanwhile (`projects.ts:509-513`) is a new lock chained after that unlock, never the earlier lock's promise.
- **Tests:** `key-read-race.test.ts`, "(c) R404: lock, unlock, lock …", two cases: the unlock just asked, and the unlock already waiting for the first lock. In each, a change is held, then lock1, unlock and lock3 are asked, then the change is released. The test checks that lock3 settles after the unlock, the project is locked, the key is gone from the ring and a read is refused.
- **Failed first:** yes, in both cases (lock3 settled before the unlock).
- **Side effect:** a lock asked while any unlock is in flight (even with no lock pending) now waits for that unlock. Before, it locked at once and the unlock then re-added the key: the same "last one asked loses" fault.

### (d) M2: the guards have tests
- **`newestIn`'s rethrow** (`index/changes.ts:85`): `lock-guards.test.ts` "the change log's newest-id scan". Fails without the guard.
- **`readProjectReasons`'s rethrow** (`audit-reasons.ts:111`): "the store of sealed reasons". Fails without it. The harness's readAudit row does not catch it: the caller's own zero-key check backs it up.
- **The `withProjectReasons` mapping** (`repo.ts:1626`): "the audit screen …". A lock is asked at the first opening while a change is held, so the key is not wiped but the mark refuses `core.key`. Without the mapping the reasons show as "unreadable". Fails without it.
- **The proxy runner's `KeyNotAvailableError` → PENDING** (`import/proxies.ts:365`): "the viewing-proxy runner …". A fake worker returns a sealed proxy, and the lock lands at its check. Fails without it.
- **The turn identity** (`state.ts` `admitsOnlyRunningTurn`, `inTurn.getStore() === turn`): "the turn identity …". A continuation left by an earlier turn runs while a lock is pending and must be refused the key. With "any turn admitted" it fails.
- **The review-queue rethrow** (`review.ts:473`): removing it fails 2 harness rows (projectReviewEntries, listProjectReview).
- **The batch-journal rethrow** (`batch.ts:288`): removing it fails 1 harness row (findBatch and readJournal).
- Each guard was removed one at a time and restored with `git checkout`.

### Minor (deferred)
- Same shape as the mended batch readers, not reached by the harness (they need a Zotero library): `knownVersions` (`import/bulk/run.ts:2216`), `undoneBatchIds` (`undo.ts:113`), `webBatches` (`zotero-sync.ts:176`), and `zotero-sync.ts:429/465/520/529` (`.catch(() => undefined)` around `readBatchAt` / `findBatch`).
- The capture flows (`link-capture.ts:286`, `profile-capture.ts:236`) have no row.
- The library-scoped sealed reasons (`openLibraryReason`) have no row: this library holds none.
- M3 (an unlock behind a stuck change) is left to FR-679, as ruled.

### Runs (nice -n 10; load 20-45)
Long runs were started in the background and waited for, never two at once: the tool's foreground limit is 10 min.
- **Harness** `src/repo/lock-mid-read.test.ts`: 40 passed (39 rows + the seam's own test), 212 s, at the final head.
- **Guards and race tests** `lock-guards`, `key-read-race`, `key-lock-race`, `src/crypto`, `zotero-local`: 169 passed.
- **Targeted library run, once, after the last commit** (`src/repo src/crypto src/index src/find src/import/watch.test.ts src/reconnect.test.ts src/worker-client.test.ts src/import/in-library.test.ts src/import/zotero-local.test.ts src/import/bulk/bulk.test.ts src/retention.test.ts`): 48 files, 2182 passed.
- **`pnpm --filter @ao/library test`** (before d3141b1): 5 files failed, 105 passed, 1 skipped; 10 tests failed, 3785 passed, 5 skipped.
  - zotero-local "R74 I2": caused by this round, fixed in d3141b1 and passing since.
  - Time limits in files I did not touch (the suite run at load ~30-45):
    - `html-strip.test.ts` (1) and `refman.test.ts` (4): still fail when run alone at load ~20.
    - `custom-styles.test.ts` "a timeout is never remembered": passed alone.
    - `annotations-cap.test.ts` (3): the same failures as in round 2. They also failed in my earlier run of `src/index`. Not re-run alone.
- **`pnpm --filter @ao/library-service test`** (final head): 1 file failed, 40 passed; 1 test failed, 1025 passed, 1 skipped. The failure is `find-browser-routes.test.ts` "the pause after a hand-over…", a wall-clock countdown under load, as in round 2. That file is untouched.
- **`pnpm -r typecheck`** (final head): all Done, exit 0.
- **Clean-up:** `git status --short` is empty. No `git stash` was used.

## Round 4 (R435)

Branch `fr-a13-key-ring`, worktree `agent-a8f81b7c97773ed6a`. Five commits on top of d3141b1:
- f38bc81 (a)
- 4689dac (b)
- b2cc0de (c)
- cc012cf (d)
- 25bbe25 (e)

No `git stash` was used. To see the service test fail on the old code, I put back the old `projects.ts` from `git show HEAD:` for one run, then restored it.

### (a) A lock always takes effect at once (I1, M2)
**What changed**
- `repo/state.ts`: new `lockAsks`, a count of the locks asked, kept per project.
- `repo/projects.ts`:
  - `lockProject` now counts the lock and then locks at once (the new `lockAtOnce`). That is: the mark, or the key wiped, plus the purge, exactly as before. When an unlock is in flight, the returned promise settles after that unlock has ended; the lock itself does not wait for it.
  - `unlockNow` takes the count when it starts. A lock asked after that point has **overtaken** this unlock. In that case:
    - The key is not added. The check runs in the same step as the add, both for the direct add and inside the `serialNext` add.
    - The unlock no longer waits for the pending locks.
    - The index reload is skipped. A reload already cut short ends as round 3 made it end.
    - The unlock **rejects with `ProjectLockedError`**.
- **Why reject:** the ruling says the unlock "answers that the project is locked". Any caller that awaits the unlock then cannot go on as if the project were unlocked. The service maps the error to 423 PROJECT_LOCKED without further code. The CLI shows "locked".
- **Choice for the coordinator:** if the key did enter the ring before the lock (so the unlock took effect for a while), its `key.unlock` audit entry is still written. I judged this the honest record. It is plain and is written in its own turn after the lock. If the lock came before the add, nothing is audited.
- **Service:** the unlock route (`apps/library-service/src/routes/projects.ts:153`) only gained a comment. The rejection leaves the route before any resume, so no Find, proxies, OCR, worker jobs or scheduled backup start. The lock route's clean-up is therefore not undone.

**Tests** (`repo/key-read-race.test.ts`, "R435 (a)"), each seen to fail on the old code:
- The probe: another project's change is held, A is unlocked, then A is locked. A is locked at once and a read is refused before the release. The unlock rejects as locked, and an unlock asked afterwards wins. Old code: `isUnlocked` stayed true.
- A lock asked while the unlock is still unwrapping its key: the key never enters the ring. Old code: the unlock resolved.
- A lock at the first opening of the unlock's own index reload: `isUnlocked` is false at once, no in-memory index rows remain, and the unlock rejects. Old code: the unlock resolved.

Service test (`lock-during-change.test.ts`, "R435 a"): an unlock overtaken by a lock answers 423 PROJECT_LOCKED. Spies show `resumeProject`, `resumeFind` and `runScheduledBackups` are never called, and no "backup" work is started. On the old library code it failed: the project was still unlocked right after the lock.

**Expectation changed:** in round 3's two "(c) R404: lock, unlock, lock" tests, the overtaken unlock now must **reject with `ProjectLockedError`** instead of resolving. The rest still holds: lock3 settles after the unlock, the project ends locked, the key is gone and a read is refused. The rest of round 2 and round 3 passes unchanged, including "lock then unlock back to back ends unlocked".

### (b) A lock is told apart from damage on the way to a backup (I2, M4)
**What changed** in `export/backup.ts`:
- New `lockedMeanwhile`: the error is a `KeyNotAvailableError`, the backup's key id belongs to a project of this library, and the key is not available now (locked or being locked).
- New `lockedBackup()`: the existing locked answer.
- Where it applies:
  - the open in `restoreOpened`;
  - `restoreRequestOf`;
  - `projectIdIn`, which no longer swallows the refusal (M4).
- In each of these, the restore now answers `RestoreError` "This backup is encrypted: unlock its project, or give the project's passphrase". `RestoreError` is not `notABackup`, so no audit entry is written.
- Every other failure is still `UnreadableBackupError` and is audited.
- Listing, and `backupFilesNow`: see (e).

**Tests** (`export/restore-lock-state.test.ts`, "R435 b"):
- A lock at each opening of a restore (K openings counted). Each outcome is either "restored" or the exact locked answer with no library audit entry. Old code failed at @1 with `UnreadableBackupError` "damaged".
- A truncated backup and one with a flipped byte are still `UnreadableBackupError` and audited. This passed before and after.
- **Note:** a backup whose header names a key id that no project here has was already answered "unlock its project…" before this task (`restoreHashed` checks the ring before opening), and I left that as it was. So "damaged" is shown here by truncation and a flipped byte.

### (c) Nothing decrypted is kept past a lock (I3)
**What changed**
- `find/queue-store.ts` `loadFolded` and `repo/watch-register.ts` `readWatchRegister` now check, before `cache.set`, that the key is still non-zero and `keyRing.has(keyId)`.
- If the check fails, the cache entry is deleted and the read **rejects with `ProjectLockedError`**. So no decrypted content is handed out after the lock either.
- The turn in progress is still admitted by `has()`. What it stores is purged when its key is wiped, because the lock's `purge` runs again then.

**Tests** (`key-read-race.test.ts`, "R435 c"): for both caches, the lock is scheduled by a microtask, by `setImmediate` and by `setTimeout(0)` from the last opening. The register test uses a torn last line, which is its only window. While locked, the kept copies must be empty.
- Old code: 3 of 6 failed (kept copy = 1): the Find queue with a microtask and with `setImmediate`, and the register with a microtask.

### (d) Only a lock is "locked" (I4, M3)
**What changed:** `export/project-export.ts:254` and `import/proxies.ts:366` now use `isLockedRefusal(err)`. The now-unused imports were removed.

**Tests** (`repo/lock-guards.test.ts`, "R435 d"):
- One stored original rewritten under a foreign key: the export now fails with `ExportFailedError`. Old code: `KeyNotAvailableError`.
- A proxy check sealed under a foreign key: the job fails instead of staying PENDING. Old code: PENDING.
- Round 3's real-lock proxy test (PENDING) and the export-interrupted-by-a-lock test still pass.

### (e) The harness gains what it lacked (M1)
**What changed** in `repo/lock-mid-read.test.ts`:
- **Three new rows (42 in all):**
  - `listBackups` with the manifest rebuilt (prepare removes the manifest);
  - `backupFilesNow` with a backup the manifest does not know (prepare writes an empty manifest);
  - `restoreBackup` of a sealed backup copied outside the library.
- **Lock points for every row:**
  - every N as before, at most 40;
  - just **after** the last opening, the lock scheduled by a microtask from it;
  - the **mark path**: a change of another, unencrypted project held running, then the lock asked. **I limited the mark path to the first, a middle and the last opening, plus after the last, as the brief allows**: doubling every N would have about doubled the run.
- **How the mark path works:**
  - A reading that waits for a turn of its own would wait for the held change for ever. So the held change is let go after 500 ms with no opening, and another is held from the reading's next opening.
  - Each row must show at least one lock where the key was not wiped at once. For readings that run inside their own turn (`backupProject`), that is the mark admitting the reading itself.
- **After every lock:** `findCacheSize` + `watchCacheSize` must be 0.
- **Changes in the other project's folder** are left out of the "no file changed" check. That project is only the held change.
- **Two harness additions, which do not loosen anything:**
  - `lockedAnswer`: for restore, the exact locked-from-start `RestoreError` counts as "locked".
  - `lockedWrites`: for the listing, the files a locked-from-start reading itself writes (the manifest listing the backup as unresolved) are allowed only when the outcome equals that locked result.

**Readers the extended harness caught** (first run: 4 rows failed, log h1), each mended at its place:
1. **`getFieldwork`** (`repo/fieldwork.ts:159`), caught at "after 1/1" and on the mark path. It returned the decrypted participant details with `complete:false` after the lock. If the project was unlocked when the reading began and is locked when it ends, it now rejects with `ProjectLockedError`.
2. **`indexUnlockedProject`** (`index/sink.ts`, end), caught at "after 16/16" and on the mark path. A lock after its last read left `{indexed:11}`. It now checks `still()` once more after the job rows, purges, and returns a locked project's `{indexed:0, errors:[]}`.
3. **`rebuildManifest`, and the retry of unresolved files in `loadManifest`** (`export/backup.ts`), caught on 82 points of the listing row. A lock in the middle of the rebuild listed only some of the project's sealed backups (a shorter result). The rest were marked unresolved and the manifest written so. Now, after the loop, `asLockedNow` moves the entries of a project that is now locked or locking to unresolved. That is exactly the locked-from-start result, and they are read again at the next load, as every unresolved file is.
- **Not a reader fault:** `backupProject` failed only the harness's own "mark path taken" check. My first measure wrongly required `isUnlocked` to be false, and inside the backup's own turn the mark admits it. The measure was corrected.
- **Readers I could not make right:** none.

**Users of the opening primitives to add to the round 3 list:**
- `crypto/random-access.ts:171` `openSealedZip`, and its callers in `export/backup.ts`:
  - `readEntry`, reached from `rebuildManifest`, the unresolved retry and `backupFilesNow`: rows "listBackups (the manifest rebuilt)" and "backupFilesNow".
  - `openBackup`, reached from `projectIdIn` and `restoreRequestOf`: row "restoreBackup".
  - `restoreOpened`: row "restoreBackup".
- **The scheduled backup (`backupIfDue`):** I added no row of its own. Its reading of the project is `backupProject` (row 34); its reading of backups is through the manifest (the listing row).

### Runs (nice -n 10, machine loaded)
- **Harness `src/repo/lock-mid-read.test.ts`:**
  - before the mends (log h1): `Tests 4 failed | 39 passed (43)`;
  - after, at 25bbe25: `Test Files 1 passed (1)`, `Tests 43 passed (43)`, 390.57 s;
  - again inside the targeted run below, at 25bbe25.
- **Targeted library run** (`src/repo src/crypto src/find src/index src/export/backup.test.ts src/export/restore-lock-state.test.ts src/export/restore-governed.test.ts src/reconnect.test.ts`): `Test Files 45 passed (45)`, `Tests 1902 passed (1902)`. `src/import/proxies.test.ts` does not exist; the proxy tests are in `lock-guards.test.ts`.
- **`pnpm --filter @ao/library test`:** `Test Files 1 failed | 109 passed | 1 skipped (111)`, `Tests 1 failed | 3810 passed | 5 skipped (3816)`.
  - The one failure is `refman.test.ts` "adversarial inputs: linear parsing … Zotero RDF: many items", the known time limit. That file is untouched.
  - Re-run alone: `Tests 138 passed (138)`.
- **`pnpm --filter @ao/library-service test`:** `Test Files 41 passed (41)`, `Tests 1027 passed | 1 skipped (1028)`. It includes `lock-during-change.test.ts`.
- **`pnpm -r typecheck`:** exit 0, all Done.
- `git status --short` is empty.

### Unsure / for the coordinator
- Whether the overtaken unlock's `key.unlock` audit entry should be written when its key was briefly in the ring. I chose yes; dropping it is one line.
- `getFieldwork` now rejects as locked when a lock lands during its read. Before, it answered the decrypted details with `complete:false`.
- minor (deferred): a sealed backup whose header names a key id unknown to this library is answered "unlock its project…" rather than "damaged" (`restoreHashed`). This is older than the task; I left it.

## Round 5 (R443)

Branch `fr-a13-key-ring`, worktree `agent-a8f81b7c97773ed6a`. Four commits on 25bbe25, one per point: d8792ba (a), 1a50481 (b), d592171 (c), e1231af (d). No `git stash`; nothing pushed; `git status --short` empty.

### (a) C1 — an unlock is overtaken by every lock asked after its request arrived
**What changed**
- `packages/library/src/repo/projects.ts`:
  - `unlockProject(core, id, secret, lockAsksAtRequest?)` (:226) passes the count on to `unlockNow` (:239).
  - `unlockNow` uses `lockAsksAtRequest ?? core.lockAsks.get(id) ?? 0` as its starting count (:243). When no count is given, nothing changes.
  - New read-only `lockAsksOf(core, id)` (:575).
- `packages/library/src/repo/repo.ts`:
  - `Repo.unlockProject(id, secret, lockAsksAtRequest?)` (:226).
  - `Repo.lockAsksOf(id)` (:246).
- `apps/library-service/src/routes/projects.ts:154`: the unlock route reads `s.repo.lockAsksOf(id)` first, before `limit.guard`, and passes it to the unlock.

**Tests**
- **Service** (`lock-during-change.test.ts:146`, "R443 a"): U1, U2, then L.
  - Each request is sent one `setImmediate` after the previous one has *arrived*, meaning its handler has started. The test counts `requireSession` calls, two per unlock handler.
  - Why that wait is needed: a bare tick was not enough. Under `inject`, an unlock's JSON body is parsed over several ticks, so the body-less lock's handler ran first. U2 then truly arrived after the lock, and the test could not show the defect.
  - Asserts: U1 and U2 both answer 423 PROJECT_LOCKED, the project is locked, the key is not in the ring (`projectDataKey` throws), none of `resumeProject`/`resumeFind`/`runScheduledBackups` was called, no "backup" work was started, and reads answer 423.
  - Seen to fail with the route not passing the count (edited back for one run, then restored): `{"unlocked":true}: expected 200 to be 423` on U2, the reviewer's `U2=200`.
- **Library** (`key-read-race.test.ts:551`, "R443 a"): an unlock given a count older than a lock already asked rejects with `ProjectLockedError` and adds no key. Given the current count, it still wins.
  - First failure: `lockAsksOf is not a function` (the method did not exist yet).
- Round 4's library tests pass unchanged, so an unlock asked after a lock still wins and "lock, unlock, lock" still ends locked.

**Other `limit.guard` routes:** only `POST /projects/:id/recovery-code` (`issueRecoveryCode`). I left it as it is: it never adds a key to the ring.
- It requires the project already unlocked (`assertUnlocked`) and compares with the ring's key through `core.key(st)`.
- A lock asked while it waits makes it refuse as locked. The reviewer's probe confirms this: refused as locked at 6 spacings, nothing hung.
- What it writes is only the wrapped recovery file, through the governed path, which refuses once the project is locked.

### (b) M1 — the audit entry is timed when the key was added
**What changed** (`projects.ts:262-267, :284`): `add()` records `addedAt = core.clock().toISOString()` when it adds the key, and the `key.unlock` entry uses it in place of the time taken inside its own queue turn. Nothing else about the entry changed, and no lock entry was added.

**Test** (`key-read-race.test.ts:568`, "R443 b"): another project's change is held, so the unlock's entry waits.
- The clock is at T1 when the key enters, then moved to T2 before the lock.
- Expected: the unlock rejects as locked and writes exactly one new `key.unlock` entry, timed at T1.
- Seen to fail: `expected '…10:05…' to be '…10:00…'`.

**Note:** this applies to every unlock, not only an overtaken one. As a result an entry's `at` can now be earlier than an entry appended just before it (a change that ran while the unlock's entry waited). Audit segments are chosen by sequence number and the anchor's `at` is informational, so nothing checks that order.

### (c) M3 — the mark path is counted per mark point
**What changed** (`packages/library/src/repo/lock-mid-read.test.ts`):
- `marked` is now a flag per point.
- Each mark point (first, middle, last, after last; `markPointOf` :253) that did not lock through the mark is a problem, unless the explicit `MARK_EXEMPT` allow-list (:262) names it. The list is **empty**.
- The per-row check is gone.

**Seen to fail** (log `r5-h1.log`): 5 rows failed (`Tests 5 failed | 38 passed (43)`), at 10 mark points where the key was wiped at once:
- BibTeX @6, @12 and after 12;
- RIS @6, @12 and after 12;
- exportBibliography @2/4;
- citeSources @2/3;
- exportProjectOpenFormats @44 and after 44.

**Finding: the harness's stall logic.**
- After letting the held change go, it held another only "at the next opening if that opening < n". A stall just before the lock point, or before the after-last point, therefore left the queue idle at the lock.
- **Mended in the stall logic** (:322-328): after letting it go, another change is held at once. It queues behind the turn the reading waits for, so the reading proceeds and the lock still finds the queue busy.
- The `rehold` flag and its `onOpen` branch were removed. No assertion was loosened.
- After the mend all ten points take the mark path, so no point needs an exemption.

### (d) M2 — the backup reader's rethrow
Not testable in a few lines with the existing helpers.
- Without the rethrow, `projectIdIn` returns undefined. The restore then goes to `restoreLocked` without the maintenance lock, and `restoreHashed`'s ring check gives the identical `RestoreError` with no audit entry.
- Neither path takes the maintenance lock, and neither runs further openings.
- The only real difference is an unlock that lands between the two checks. That is a timing race, and a test of it would be flaky.
- So I added the one-line comment at `packages/library/src/export/backup.ts:1649`: defensive; without it an unlock before the restore's key check would restore without the maintenance lock.

### Runs (nice -n 10)
- Library targeted (`key-read-race`, `key-lock-race`, `lock-guards`, `src/crypto`, `restore-lock-state`): `Test Files 5 passed (5)`, `Tests 118 passed (118)`.
- Service `lock-during-change.test.ts` + `server.test.ts`: `Test Files 2 passed (2)`, `Tests 116 passed (116)`.
- Service whole suite: `Test Files 41 passed (41)`, `Tests 1028 passed | 1 skipped (1029)`.
- Harness `src/repo/lock-mid-read.test.ts` at e1231af: `Test Files 1 passed (1)`, `Tests 43 passed (43)`, 506.34 s.
- Library whole suite at e1231af: `Test Files 110 passed | 1 skipped (111)`, `Tests 3813 passed | 5 skipped (3818)`. There was no timing failure this time.
- `pnpm -r typecheck`: exit 0.

### Unsure / for the coordinator
- The service test defines "arrived" as the handler having started. Under real HTTP the body is read before the handler too, so a lock whose handler starts before an unlock's body has finished arriving counts as asked before that unlock (the unlock wins). I judged that consistent with R443's "when the request arrives".
- (b) changes the time of every `key.unlock` entry, not only an overtaken one's.
- minor (deferred): M4, as noted in R443.

## Round 6 (R445)

Two commits on e1231af: 8eb8a75 (m1) and 6ffe070 (m2). No `git stash`; nothing pushed; `git status --short` empty.

### m1 — the `key.unlock` entry is timed when it is written
**What changed** in `packages/library/src/repo/projects.ts` (`unlockNow`, the audit turn at about :282-287):
- The entry's `at` is again `core.clock()`, taken inside its turn, as before this task.
- When `overtaken()` is true at that point, the entry carries `details: { overtakenByLock: true, keyAddedAt: addedAt }`, where `addedAt` is still taken in `add()`. It carries nothing else.
- An ordinary unlock's entry is exactly as before the task, with no details.

**Checks**
- Neither key is in `RESERVED_DETAILS` (`attention.ts:62`: `txn`, `attentionId`, `recordedLate`).
- `sealEvent` only requires the details to be canonicalizable.
- The service passes details through unfiltered.
- The UI's `whatOf` and its renderers read only named details (`op`, `recordedLate`, `reason`, `mark`), so an unknown detail is ignored.

**Test** (`key-read-race.test.ts`, "R445 m1"; it replaces round 5's "R443 b"). With an injected clock:
- Overtaken unlock: the key is added at T1, the entry is written at T2. It writes one `key.unlock` entry with `at` = T2 and details exactly `{ overtakenByLock: true, keyAddedAt: T1 }`.
- Ordinary unlock, whose entry also waits behind a held change (key added at T3, written at T4): `at` = T4 and no details.
- Seen to fail first: `expected '…10:00…' to be '…10:05…'`.

### m2 — the service test tells "arrived" by the count's reading
**What changed:** `lock-during-change.test.ts` "R443 a" waits on a spy of `repo.lockAsksOf` (one call per unlock request) in place of counting `requireSession` calls. The assertions are unchanged.

**Check:** with the route edited back to not pass the count, the test still fails (`{"unlocked":true}: expected 200 to be 423`). Restored, it passes.

### Runs (nice -n 10)
- Library `src/repo/key-read-race.test.ts src/repo/key-lock-race.test.ts src/repo/lock-guards.test.ts src/export/restore-lock-state.test.ts src/repo/attention.test.ts`: the last three are the tests that list `key.unlock` entries. Result: `Test Files 5 passed (5)`, `Tests 99 passed (99)`.
- Service `src/lock-during-change.test.ts`: `Tests 3 passed (3)`.
- `pnpm -r typecheck`: exit 0, after each commit.
