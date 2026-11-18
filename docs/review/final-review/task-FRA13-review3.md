# FR-A13: third review of the whole task (R379, R384, R386, R402, R404, R432)

Reviewer: a fresh adversarial reviewer. Worktree `.claude/worktrees/agent-a8f81b7c97773ed6a`, branch `fr-a13-key-ring`, head d3141b1 (base 7b81976, fourteen commits). I read the whole package (`review-FRA13-whole.diff`, all 3,312 lines), the briefs, the report, both earlier reviews and the rulings. The worktree is clean when I leave: every probe is deleted, `git status --short` is empty, no `git stash` was used and no tracked file was changed.

## Verdict: NOT APPROVED

**The Critical finding (C1) is closed.** I re-ran its probe: a lock lands 0 to 5 macrotasks after the change's function returns, and every change-log line opens with the real key and none opens with zeros. I found no way to seal anything under a wiped or all-zero key:
- Every seal is inside a turn of the write queue, or on a copy of the key, or it fails on the guard.
- `reasonMac` is checked again inside the turn before its sealed line, which is guarded.
- No other `createCipheriv` uses a data key.
- An export cut short leaves no decrypted file behind.

Three things are still wrong, and they are the kind R386 and R404 rule out:
- **A lock can still be put off without limit, with the project readable all the while.** Round 3's own "lock, unlock, lock" change causes this.
- **A whole way of reading an encrypted project is missing from the harness:** reading its sealed backups. When a lock lands there, the researcher is told the backup is "damaged", and a false refusal is written to the library's audit log.
- **A decrypted kept copy (the Find queue) can stay in memory behind a lock.**

A fourth problem is one the report already admits: damage is shown as "locked" in the export.

Counts: Critical 0, Important 4, Minor 4.

## What I ran (each alone, `nice -n 10`, machine loaded)

- **The harness and the task's race tests together:** `lock-mid-read.test.ts`, `key-lock-race.test.ts`, `key-read-race.test.ts`, `lock-guards.test.ts`. 4 files, **77 passed**, exit 0. The harness's 39 rows and its seam test all pass.
- **Probe `lock.probeFRA13c` (deleted):**
  - (a) C1 re-run.
  - (b) A lock asked while an unlock is in flight.
  - (c) A lock asked during the unlock's own index reload.
  - (d) A stored original sealed under another key id, and one with a flipped byte: export and the full integrity check.
  - (e) The Find queue with a lock landing just after its last opening.
- **Probe `export.probeFRA13c` (deleted):** an export with the lock at openings 1, 2, K/2, K-1 and K of 16. Each answered `KeyNotAvailableError` ("locked"). Nothing was left at the destination except the empty folder that had been asked for, and nothing in the library's `.tmp`. No new entry in the OS temp folder was mine.
- **Probe `restore.probeFRA13c` (deleted):** restoring a sealed backup while its project is unlocked, with a lock at each of its 7 openings.
- **Reading:**
  - every user of the opening primitives (`decryptStream`, `decryptBytes`, `openDecrypted`/`openDecryptedHandle`, `openSealedZip`, `openLine`) and of lazy key look-ups (`keyRing.get`, `keyFromRing`);
  - the service's lock and unlock routes and its error mapping;
  - the backup, restore and retention readers of `backup.create`.
- **Guards:** the coordinator's dispatch says not to modify tracked files, so I did not take the guards out to watch their tests fail. I judged each (d) test by reading (see "Guards and their tests").

## The two earlier reviews: finding by finding

| Finding | Status |
|---|---|
| R1 I1: a read outside a turn cut short by a lock; the short result cached | **Closed for the 39 readings the harness covers.** Open for readings of sealed backups (I2 below) and for one window of the Find queue's kept copy (I3). |
| R1 M1: a lock waits for the change in progress while the project still reads as unlocked | Closed by the "locking" mark (R386 b): reads are refused at once. **Re-opened in a new form by round 3 (I1).** |
| R1 M2: `KeyRing.clear()` at close, outside the queue | Left to FR-663 as ruled. A change in flight fails on the guard; nothing is sealed under zeros. |
| R1 M3: the repeat-unlock branch untested | Closed (the "different key under the same key id" test). |
| R1 M4: `lockProject` throws synchronously | Closed (it rejects, and this is tested). |
| R2 I1: protocol documents "damaged" plus a false integrity warning | Closed (harness row 24; `protocol-docs.ts:76-78`). |
| R2 I2: a full integrity check reports intact originals as "mismatched" | Closed (rows 35 and 36; `reconnect.ts:470-483`, `:529`). Damage is still damage: my probe of a foreign-key original gives `mismatched=1`. |
| R2 I3: a rebuild cut short leaves the project short of index rows | Closed (row 37; `index/rebuild.ts:89-99`). |
| R2 M1: "lock, unlock, lock" ends unlocked | Closed for the cases tested. **The way it was mended causes I1.** |
| R2 M2: six guards and the turn identity untested | Closed by reading: each has a test in `lock-guards.test.ts` or a harness row that would fail without it. Not checked by removing the guards (see above). |
| R2 M3: an unlock behind a stuck change | FR-679, as ruled. |

## Findings

### Important

**I1: A lock asked while an unlock is in flight does not take effect until that unlock ends. The project stays fully readable all that time, and the unlock can wait without limit.**
- **Where:** `packages/library/src/repo/projects.ts:509-513` (`if (unlocking) return unlocking.then(() => lockProject(core, projectId))`). `unlockProject` (`:216-232`) registers the pending unlock for the whole of `unlockNow`. That includes three steps after the key is already in the ring:
  - the `key.unlock` audit append, which goes to the **back** of the library-wide write queue (`core.serial`, `:262-266`);
  - the index reload (`core.index.projectUnlocked`, `:268`), which reads every source of the project;
  - for an already-unlocked project, the `serialNext` add behind the change in progress (`:258`).
- **Probe output:**
  - A change of *another* project is held on a gate. Then project A, locked, is unlocked, and A is locked again 300 ms later:
    `UNLOCK-PENDING: unlocked before lock=true; right after lock asked=true; 300ms later lockDone=false unlocked=true read title "Secret A"`.
    A locks only when the other project's change is released.
  - A lock asked at the first opening of the unlock's own index reload: `RELOAD: … isUnlocked right after the lock call=true`. It ends locked only after the reload.
- **Why it matters:**
  - R386 b says locking is immediate for everyone except the change in progress. Here nothing is marked locked. The service's lock route still answers `{unlocked:false}` (`apps/library-service/src/routes/projects.ts:184`), while every read route serves decrypted content.
  - A stuck or very long change of any project in the library (such as a several-GB copy) keeps the lock from landing, for ever in the stuck case.
  - The harness's row 38 calls `indexUnlockedProject` directly, so it never saw a lock asked during the reload that `unlockProject` itself runs.
  - The report names this side effect ("a lock asked while any unlock is in flight now waits for that unlock") but not its cost.
  - This is not FR-663 or FR-679: those are a clear at close, and an unlock behind a lock.
- **Reach:** the screen probably does not offer Lock while its own unlock is pending. A second tab or client, or a lock asked from a screen that already shows the project unlocked while the unlock's audit turn or reload is still running, reaches it.
- **Direction:**
  - Apply the "locking" mark at once even when an unlock is in flight, and still queue the real lock after the unlock so that the last request wins.
  - Or end an unlock's "pending" state when its key is added, not after the audit turn and the reload.
  - Add a test: a lock asked during the unlock's audit wait and during its reload must find `isUnlocked === false` at once.

**I2: Restoring a sealed backup while its project is locked mid-read says "damaged", and writes a false "not a backup" refusal to the library's audit log. Reading backups is not a row of the harness.**
- **Where:**
  - `crypto/random-access.ts:167-171` (`openSealedZip` → `openDecrypted`), used by `export/backup.ts:517` (`readEntry`), `:1590` (`openBackup`: `projectIdIn`, `restoreRequestOf`) and `:1791` (`restoreOpened`).
  - The key is looked up lazily from the ring (`keyFromRing`, `repo/repo.ts:1449`). After a lock, or under the "locking" mark, the look-up gives `undefined`, so the error is a plain `KeyNotAvailableError` and never `KeyWipedError`.
  - `restoreOpened` (`:1791-1793`) and `restoreRequestOf` (`:1623-1625`) catch every error as `UnreadableBackupError("This backup cannot be decrypted: it is damaged, or it was sealed with another key")`. `restoreLocked` (`:1726`) then audits it via `refuseUnreadableBackup` (R179).
- **Probe output** (7 openings; the lock asked at opening n):
  - Project locked from the start: `RestoreError: This backup is encrypted: unlock its project, or give the project's passphrase` (no audit entry).
  - `lock@1/7`: `UnreadableBackupError: This backup cannot be decrypted: it is damaged, or it was sealed with another key`, and 1 library audit entry `restore/deny/{"op":"project.restore","notABackup":true,"file":"… .zip.enc","backupSha256":"…"}`.
  - `lock@2/7`: the same "damaged" answer. Its entry was dropped as a repeat of the same day's.
  - `lock@3..7`: restored (those openings are inside the adopt turn, so the lock waits for it).
- **Why it matters:**
  - Real backups are reported as damaged, and a permanent false record says the file is not a readable backup. These are the brief's "intact file reported as damaged" and "false audit entry left behind by a lock".
  - The report's list of "every user of the opening primitives" does not name `openSealedZip` or these callers. The harness has no backup-reading row: only `backupProject`, which makes a backup.
- **Related, reasoned and not separately probed:**
  - `projectIdIn` (`:1598-1614`) swallows the same refusal. The restore then runs without the project's maintenance lock (see M4).
  - `readEntry` treats it as "unresolved". That matches the locked-from-start outcome and is retried at the next load, so it is acceptable.
- **Direction:**
  - In the restore path, put a lock refusal ahead of "damaged": a `KeyNotAvailableError` while the backup's key id is the project's and the project is now locked or locking means "locked", not `notABackup`.
  - Add rows to the harness for `restoreBackup` of a sealed backup, `listBackups` with the manifest rebuilt, and `backupFilesNow`.
  - Because the lazy look-up never produces `KeyWipedError`, the harness should also lock through the mark path: a lock asked while another turn is running.

**I3: The Find queue's decrypted copy can stay in memory behind a lock.**
- **Where:** `find/queue-store.ts:475-495`. `foldFile` keeps awaiting the line scanner after the last line is opened. A lock that lands then purges the (still empty) cache and wipes the key. `loadFolded` then `cache.set`s the fully decrypted queue.
- **Probe output** (3 entries; the lock scheduled by a microtask, `setImmediate` or `setTimeout(0)` from the last opening):
  `FINDCACHE micro: K=3 read=size 3 lockAsked=true unlocked=false keptQueues=1` (the same for `immediate` and `timeout`).
- **Why it matters:**
  - R386 a: "decrypted entries do not stay in memory behind a lock". It is not served while locked (`assertUnlocked` comes first) and its content is right after an unlock, so it is a kept copy, not wrong state.
  - The harness cannot see this. It only locks *at* an opening, never after the last one, and it never looks at `findCacheSize` or `watchCacheSize`.
  - The watched-folders register has the same window only when its last line has no newline: its last fold is otherwise synchronous with `cache.set`.
- **Direction:**
  - Before `cache.set` (both caches), check that the key is still live and not marked locking (`key.some(b => b)` and `core.keyRing.has`), and drop the result otherwise.
  - In the harness, add a lock point "after the last opening" and assert that the kept-copy sizes are 0 while locked.

**I4: Real damage is shown as "locked": an export whose original is sealed under another key id answers "locked" (423).**
- **Where:**
  - `export/project-export.ts:255` (`err instanceof KeyNotAvailableError` is rethrown as-is). The service maps any `KeyNotAvailableError` to 423 "This project is locked. Its passphrase is needed." (`apps/library-service/src/errors.ts:153`).
  - `import/proxies.ts:365` has the same broad test.
- **Probe output:**
  - Project unlocked, one stored original rewritten under a foreign key: `FOREIGN export: KeyNotAvailableError/KeyNotAvailableError: key … is not available (project locked or key unknown)`.
  - The integrity check correctly says `mismatched=1`.
  - A flipped byte still gives `ExportFailedError`.
  - Before this task the foreign-key case was `ExportFailedError` ("damaged").
- **Why it matters:**
  - The researcher of an unlocked project is told to unlock it, and the export never succeeds and never names the damage.
  - In the proxy runner, a foreign-key check is kept `PENDING` and retried at every resume, never failed.
  - The reach is low: a file replaced by hand or by a sync tool. The brief nonetheless counts "real damage hidden as locked" as Important.
  - The report lists it as a deferred minor point.
- **Direction:** use `isLockedRefusal` (which already exists) in both places, as round 3 did everywhere else.

### Minor

**M1: The report's "every user … and the row that covers it" is incomplete.**
- It misses `crypto/random-access.ts:171` (`openSealedZip`) and its three callers in `export/backup.ts` (I2).
- The harness's method has two blind spots, which explain I2 and I3:
  - It locks only at an opening, so nothing lands between openings or after the last one.
  - It always locks with the queue idle, so it never exercises the "locking" mark path, where readers that look the key up lazily get `undefined`.
- Also not covered, and admitted by the report:
  - `undo.ts:46`, `knownVersions`, `undoneBatchIds`, `webBatches` and `zotero-sync.ts` swallowing `readBatchAt`/`findBatch` errors;
  - the capture flows' `readAny` and `readProjectFile` (`link-capture.ts:280-290` swallows everything as `undefined`).
- Their writes are refused once the project is locked, so the effect is limited to what they return.

**M2: A deferred lock does not redo the lock route's clean-up (needs a ruling, not verified).**
- When a lock waits for an unlock (I1), the route's `stopFind`, media revoke, `purgeSensitive` and `endCaptures` run before the unlock finishes.
- The unlock route then `resumeFind`s, resumes proxies, OCR and worker jobs, and starts the scheduled backup. Depending on tick order, this runs just before or just after the real lock lands.
- Anything the resumed work looks up and keeps in the service's HTTP cache after `purgeSensitive` stays there behind the lock.
- Direction: the deferred lock should re-run the route's clean-up when it lands, or the route should wait for it.

**M3: A proxy whose check is sealed under a foreign key id stays PENDING for ever** (`import/proxies.ts:365`). This is the proxy half of I4, kept separate because its reach is very low: the worker seals with the project's own key copy.

**M4: `restoreBackup` → `projectIdIn` swallows a lock** (`export/backup.ts:1611`). The restore then proceeds without the source project's maintenance lock (`:1709`). Harmless in practice, because the restore fails or is decided again inside its turn, but it is the same tolerant shape.

## Checked and sound

- **C1 and every way of sealing:**
  - `sealLine` and `encryptStream` (and so `encryptBytes`, `tx.writeFile`/`copyFile`, sealed reasons, journals, registers, queues and review entries) refuse an all-zero key with `KeyWipedError`.
  - All governed seals run inside a turn, and the key is wiped only between turns.
  - Worker jobs and backups use their own copies.
  - `reasonMac` is re-verified inside the turn before a guarded seal (`mutate.ts:513-516`; `library-audit.ts:78-82`).
  - The only other `createCipheriv` (`keys.ts:102`) uses the KEK.
  - A lock, a second unlock, "lock–unlock–lock" and the loop of 50 leave no line under zeros. No path writes a temporary file encrypted under zeros.
- **Opening primitives:** `assertLiveKey` is in `decryptStream`, `openDecryptedHandle` and `openLine`, so a wiped key is "locked". A foreign key id or a flipped byte stays `KeyNotAvailableError`/`DecryptionError`, which is damage, in every reader round 3 mended (`isLockedRefusal` takes only `KeyWipedError` or `ProjectLockedError`). Line readers only ever see `KeyWipedError` from `openLine`, so their broader `instanceof KeyNotAvailableError` is equivalent.
- **The write queue and the mark:**
  - `admitsOnlyRunningTurn` captures the turn object. A later turn, code outside the queue and a continuation of an earlier turn are refused; `lock-guards.test.ts` holds the last of these.
  - Between `writing = true` and the start microtask, `running` is undefined, so nothing is admitted and the lock goes first.
  - Errors reach their own callers, and `startNext` runs from `.finally`, so there is no recursion. I re-ran nothing beyond the task's tests; the earlier reviews' 16,600-turn stress probe stands.
- **"No trace" for the 39 rows:**
  - The harness hashes the whole library (`.tmp` included) and compares integrity warnings, audit entries, the index's persistent and in-memory rows, and the result after an unlock.
  - An export cut short leaves nothing at its destination or in `.tmp` (my probe).
  - Retries in `checkIntegrity` and `rebuildIndex` are bounded at 3.
- **R432:**
  - The decision of a backup cut short is audited with `action: "backup"` and `details.op: "backup.create"`.
  - `hasEvent` (`backup.ts:833-837`) and retention's `auditedDestructions` (`destruction-record.ts:135`) look only at `action === "backup.create"`, the latter also needing `details.file`.
  - So the entry is never read as "a backup exists". Its pending record is discarded and `recordFailure` ignores the lock.
- **What an honest researcher loses:** an export, an integrity check or a backup cut short ends with "locked" (or, for the integrity check, the locked-project report) and gives the full result after an unlock (harness rows 33-36). The exception is restore (I2).
- **The service:** the lock route answers at once and the list agrees (`lock-during-change.test.ts`, passed in the run above). The error mapping is unchanged.
- **Guards and their tests (by reading):**
  - `newestIn` returns `""` without its rethrow; the test expects a rejection.
  - `readProjectReasons` returns an empty map; the test expects a rejection.
  - Without the `withProjectReasons` mapping, the states read "unreadable" and the test expects `ProjectLockedError`.
  - Without `KeyNotAvailableError` in its catch, the proxy runner falls to `fail` and the test expects `PENDING`.
  - With any turn admitted, the turn-identity test's earlier continuation gets the key and the test expects `ProjectLockedError`.
  - The review-queue and batch-journal rethrows are held by harness rows 10, 11 and 23.
  - The `KeyWipedError` distinction is held by `zotero-local` "R74 I2", according to the report.

## Could not verify

- Each guard's test failing with the guard removed: the dispatch forbids modifying tracked files, so these were judged by reading.
- What the Find runner, proxies and the scheduled backup actually do when the unlock route resumes them just before a deferred lock lands (M2). This needs the service and a slow unlock.
- The capture flows under a lock mid-read (no fake platform here).
- I ran the harness once, as allowed. I did not run whole suites.
