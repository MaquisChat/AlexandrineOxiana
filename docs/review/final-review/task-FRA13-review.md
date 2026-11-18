# Review of Task FR-A13 (R379; WB2 C1): a change being saved is never sealed under a wiped key

Reviewer: fresh adversarial reviewer. Worktree `.claude/worktrees/agent-a8f81b7c97773ed6a`, branch `fr-a13-key-ring`, head 3aa0561 (base 7b81976). The worktree is clean at the end (`git status --short` empty; every probe deleted).

## Verdict

**APPROVED WITH SMALL POINTS.** The finding is closed for sealing. A lock or a repeat unlock can no longer zero a key while a change is sealing with it, and anything that would seal under an all-zero key now throws `KeyNotAvailableError`, which the service maps to 423 "locked". The rewritten write queue held up under a randomised stress test against a reference model, and it matches the old chain on order, errors and async context. One Important point remains. It existed before this task, the fix does not touch it, and the dispatch asks about it explicitly: readers outside a turn hold the ring's buffer across `await`s, and a lock that lands mid-read silently truncates the result and poisons a cache. The coordinator should decide whether it belongs to FR-A13. The ruling's option (a), handing out copies, would have closed it.

Counts: Critical 0, Important 1, Minor 4.

## What I ran (all at `nice -n 10`, single files)

- `src/repo/key-lock-race.test.ts` (11 tests) passes. The service's `src/lock-during-change.test.ts` passes.
- **Removing each guard** (each edit reverted with `git checkout` straight after the run):
  - A. No `assertSealingKey` in `sealLine`: 2 tests fail ("sealLine throws"; "a key wiped outside the queue … rollback fails").
  - B. `encryptStream` back to `assertKey`: "encryptBytes and encryptStream throw" fails.
  - C. `KeyRing.add` zeroes an identical key again: the KeyRing unit test and the "same key added again" race test fail.
  - D. `lockProject` always locks at once, the old behaviour: 5 race tests fail (probe 1, waits-only-for-the-change, watch register, buffer-zeroed, the loop of 50).
  - E. `unlockProject` always adds at once (its `serialNext` branch removed): **nothing fails** (M3).
  - F. `serialNext` queued as an ordinary `serial`: "a lock waits only for the change in progress" fails.
  - G. The service route's `await` replaced by `void`: the service test fails (`['lock answered']` before the change).
- **Queue probe** (`repo/queue.probeFRA13.test.ts`, deleted):
  - 5 rounds of about 1,500 or more turns, mixing `serial` and `serialNext` (20%), enqueued from outside and re-entrantly from inside running turns without being awaited. The turns throw synchronously (10%), reject (15%) or resolve after random microtask and macrotask ticks, each with an awaited `finally`.
  - At every start the started turn equaled the reference model's `urgent[0] ?? waiting[0]`. Never two turns ran at once. Each result or error reached its own caller. `holdsTurn()` was true inside every turn. `queueIdle()` was true at the end. No unhandled rejection.
  - Pure `serial`: the start order and the interleaving with callers' continuations are identical to a copy of the old chain (`start 0, cont 0, start 1, …, cont-err 2, …`).
  - Async context: each turn sees its own caller's `AsyncLocalStorage` store, before and after an await, and never the previous turn's. `holdsTurn()` is false in the caller afterwards.
  - 10,000 queued turns ran in order in about 230 ms, with no recursion and no stack growth: `startNext` runs from a `.finally` reaction.
  - A function that throws synchronously, or returns a plain value, works as before.
  - A turn that never settles blocks every later turn, `serialNext` included, as the old chain did.
  - A `serialNext` asked in the same tick as a `serial` call runs first, because `writing` is set before the start microtask. That is correct: the lock was asked before the turn began.
- **Repo probe** (`repo/lock.probeFRA13.test.ts`, deleted): the watch-register read under a lock (I1), and a read during a lock that waits for a stuck change (M1). The output is quoted below.

## Spec (brief and R379)

| Item | Status |
|---|---|
| 1. No holder can have its key wiped under it | Met for sealing, **with a different design from the ruling's literal text**. Neither "copies" nor "read at sealing" was built. Instead, every governed seal runs inside a turn, and the key is wiped only between turns. The report says so (its "(b) by construction"). I checked every sealing site (list below): each is inside a turn, uses a key copied at creation, or now fails closed on the guard. Readers are not covered (I1). |
| All-zero guard in the sealing primitive | Met: `assertSealingKey` in `encryptStream` (format.ts:83-85, 206), which also covers `encryptBytes`, `copyFile` with encryption, and `tx.writeFile`, and in `sealLine` (io.ts:218), which also covers `sealedReasonLine`, `libraryReasonLine`, the job journal, the watch register, the find queue, review entries and the batch journal. Tested (A, B). |
| 2. A lock waits its turn and answers promptly | Met. The lock runs as `serialNext`: after the change in progress, ahead of those waiting. The changes waiting behind it get `ProjectLockedError` and write nothing (tested). "Promptly" holds only as long as one change lasts, which is unbounded (M1). |
| Repeat unlock through the queue | Built (projects.ts:240) but untested (E; M3). It matters only for a different key under the same id, because an identical key is a no-op now. |
| 3. Same key keeps the buffer | Met (keys.ts:315-319); tested (C). |
| 4. Same class: watch-register and `tx.key()` captured before an `await` | Met for writers: they run inside turns, and the zero-ring test drives the watch register. Not met for readers (I1). |
| 5. The key is still wiped at lock | Met (the "buffer zeroed" test, D). |
| Tests the brief asks for | All present. Each fails without its guard, except the repeat-unlock-through-the-queue path (M3). |
| Service route awaits the lock | Met (routes/projects.ts:170). Tested (G). The UI marks the project locked only after the 200 (`Library.tsx:539-540`), so the screen never shows "locked" before it is true. |

## Findings

### Important

**I1: A reader outside a turn holds the ring's buffer across `await`s. A lock that lands mid-read truncates the read silently, and the truncated result is cached and served after the next unlock.** This existed before the task (the base lock was always synchronous) and the fix keeps it (`lockProject` still locks at once when the queue is idle, which is exactly when such readers run). It is the "read in flight" question of the dispatch, and the class the WB2 review called fragile.

- Where:
  - `repo/watch-register.ts:187`: `key` is captured before `await fsp.stat`, `open`, `lastByteIsNewline` and the `for await` over the lines. A line `fold` cannot open is skipped as "a line of another project", and the map is cached under the file's signature at :232.
  - Same shape:
    - `find/queue-store.ts:450-476`: cached unless *every* line is unreadable.
    - The job journal's `cancelPendingJob` (worker-client.ts:725-731) and `resumePending`→`refreshJobRows` (worker-client.ts:315-322). Both read with the zeroed buffer and then rewrite the index's job rows from what they saw.
    - `project-export.ts:347-348` and `proxies.ts:329-332`: a `getKey` closure over the buffer, so the failure surfaces as `DecryptionError` "authentication failed", which the service turns into 409 "damaged, or made with another key", a false corruption notice.
- Probe: 400 register entries are recorded, the register is read through `repo.watchRegister` (outside a turn), the project is locked after *n* event-loop ticks, then unlocked and read again:
  ```
  ticks 0: during-lock read size 0; after re-unlock 0 (expected 401)
  ticks 1: during-lock read size 1; after re-unlock 1 (expected 402)
  …
  ticks 39: during-lock read size 39; after re-unlock 39 (expected 440)
  ```
  The read returns a truncated map with no error. After the project is unlocked again, the register is still served truncated (an empty one at 0 ticks) until the file next changes.
- Effect:
  - A watched folder resuming after the unlock loads that map (`import/watch.ts:1013-1030`: `reg`, `regBySha` and `regBySource` are built from it) and sees files it already holds as unknown. Re-imports or wrong states are likely; I did not verify them end to end.
  - The watch-register cache also keeps decrypted entries in memory after the lock, because nothing purges it at `lockProject`.
- Rule: R25 and R30's intent (a locked key must never produce wrong state); the "same class" paragraph of C1; R379's option (a), "the key ring hands out copies", which would have closed it.
- Direction (for the coordinator's ruling: this task or a follow-up):
  - Readers outside a turn take a copy for the length of the read, or re-read the key from the ring at each decrypt and throw `ProjectLockedError` when it is gone.
  - Never cache a fold made with a key that was wiped meanwhile (check `key.some(b => b)` or the ring before `cache.set`).
  - Purge the watch-register and find-queue caches at lock.
  - Map a decryption failure under a wiped key to "locked", not "damaged".

### Minor

**M1: The lock has no bound. While it waits, the project stays unlocked and read routes serve decrypted content.** Probe: a change held on a gate inside its turn, then `lockProject`, then 300 ms later `repo.getSource`. The result: `lock landed: false isUnlocked: true read title: 'Secret title Jane Doe'`. A stuck turn means the lock never lands and the screen stays in "Locking the project" for good. A large original copied and encrypted inside one change (`tx.copyFile`, mutate.ts:278; for example a several-GB interview video) keeps the lock waiting for the whole copy. Before this task the lock was immediate. The ruling asks for the wait, so this is a consequence, not a defect. Direction: a "locking" state that refuses reads and new turns at once, and perhaps a time limit after which the route answers and the wipe still happens at the turn boundary. **Needs the coordinator's ruling.**

**M2: `KeyRing.clear()` at library close and quit still wipes outside the queue.** `apps/library-service/src/state.ts:1144` runs after bounded grace waits (`withTimeout(…, closeGraceMs)`), not after the repo's queue has drained. A turn still running then fails closed on the guard: it is refused and rolled back, never sealed under zeros (tested with `failUndo`). This is safe. But the change is lost as a 423 or 500-class error rather than waited for. The report states this.

**M3: The repeat-unlock-through-the-queue branch (`projects.ts:240`) has no test that fails without it** (E). It only matters for a different key under the same key id, which needs a tampered or replaced key file.

**M4: `lockProject` reads `keyId` at call time but wipes at turn time.** It also throws synchronously (`core.state` NotFound) instead of returning a rejected promise. Both are harmless today: a project's key id never changes, and the only product caller awaits inside an async handler.

## Every seal or encryption with a project key: inside a turn?

- **Inside a `core.serial` turn**, so a lock cannot land:
  - `runMutation` (change log, sealed reasons, `tx.writeFile` and `tx.copyFile`).
  - Watch register, find queue, review entries, batch journal (`appendJournal`), import-ops, profile-capture's journal, protocol documents.
  - Restore (`restore.ts:509` onward).
  - The backup snapshot, which then copies the key (`backup.ts:674`).
  - `withProjectQueue` and `authorizeOnly`.
  - Set-aside in the library audit (`repo.ts:1698` onward).
- **Outside a turn, but on a copy made at creation**:
  - Worker jobs: R142's copy at worker-client.ts:421 is used for publish (:759) and for `transition`.
  - `encryptStream` and `encryptBytes`, which read the key synchronously (`collect` → `end(data)` → `_transform` in the same tick). This covers link-capture's `writeSnapshot` (:337-338) and profile-capture's `writeJson`.
- **Outside a turn, on the ring's buffer, now failing closed on the guard**:
  - The job journal in `cancelPendingJob` → `claimJobRecord`, and in `upgradeLegacyJobs` → `appendJobRecords`. The latter, before this task, could also have written a false "failed UNRECOVERABLE" record under zeros. Now it throws and the rows wait.
  - `compactJobJournal` keeps unreadable lines verbatim and never re-seals, so it is safe.
- `reasonMac` has no guard, but every caller reads `core.key(st)` freshly inside the turn, and it throws `ProjectLockedError` once the key is cleared. I found no captured buffer reaching it.
- **A half-zeroed key is impossible:** `fill(0)` is synchronous and every cipher copies its key schedule at creation.
- **A stale reference after a new key under the same id** holds zeros, so the guard rejects it.
- No other `createCipheriv` on a data key exists in the library or in `apps/`; `keys.ts:102` wraps with the KEK. No fixture uses an all-zero data key.

## Checked and sound

- The write queue as described above: FIFO among `serial`; `serialNext` first and FIFO among its own turns; errors reach the right caller; the next turn starts only after the previous one has fully settled; no recursion; no new unhandled rejections; the caller's context bound through `AsyncResource.bind`.
- Re-entrancy is unchanged from the old chain:
  - A nested `serial` that is awaited inside a turn deadlocks, as before. `sources.ts:151` still guards with `holdsTurn()`.
  - The only product caller of `lockProject` is the service route, outside any turn. `unlockProject` is called only by the route and the CLI.
  - Auto-lock, idle lock and "lock all" do not exist. Close, quit and the CLI use `ring.clear()` (M2).
  - So no turn awaits its own lock.
- Changes waiting behind a lock get `ProjectLockedError` at `assertUnlocked`, exactly as a lock that came before them did previously. Bulk import pauses (`run.ts:526/893/993`), attach reports "locked", watched folders `pauseForLock`, and Find is stopped before the lock (route :167). The refusal is unaudited, as before.
- `KeyNotAvailableError` maps to 423 "This project is locked. Its passphrase is needed." (`errors.ts:153`, find.ts:249, documents.ts:77, media.ts:411).
- The service route's order is unchanged: stop Find, await the lock, then revoke media, purge, end captures. Only the `find-routes.test.ts` stub changed (it returns the promise), and its assertions are as before.
- The race tests interleave as claimed: D makes 5 of them fail deterministically (3 runs gave the same failures).

## Could not verify

- That I1's truncated register actually leads a watched folder to re-import or mis-state files after an unlock (it needs a running watch).
- A service-level lock during a real bulk import or attach of many files. The library-level loop of 50 and the waits-only-for-the-change test cover the mechanism.
