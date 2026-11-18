# FR-A13 — a scoped review of round 4 (R435, R442)

Reviewer: a fresh adversarial reviewer. Worktree `.claude/worktrees/agent-a8f81b7c97773ed6a`, branch `fr-a13-key-ring`, head 25bbe25 (five commits on d3141b1). I read the whole package `review-FRA13-round4.diff`, the third review, R435, R442, R404 and R386, and the round-4 section of the report.

When I left, every probe was deleted and `git status --short` was empty. I used no `git stash` and changed no tracked file.

## Verdict: NOT APPROVED (one finding, narrow to fix)

Each clause (a) to (e) does what was ruled for every interleaving I could build inside the library, and the Critical finding of the earlier reviews (data sealed under a wiped key) stays closed. One way in was missed, through the service:

- Two unlock requests are in flight for the same project, then a lock is asked.
- The project ends **unlocked**, its key is back in the ring after the lock's promise has settled, and Find, proxies and the scheduled backup are resumed.

Counts: Critical 1 (see the note on its severity), Important 0, Minor 4.

## What I ran (each alone, `nice -n 10`)

- **The harness** `src/repo/lock-mid-read.test.ts`: 43 of 43 passed (349 s, exit 0).
- **What must still hold:** `key-read-race`, `key-lock-race`, `lock-guards`, `src/crypto` and `export/restore-lock-state` together: 5 files, 116 of 116 passed. The service's `lock-during-change.test.ts`: 2 of 2 passed.
- **Probe `repo/lock.probeFRA13d.test.ts` (deleted)**, library level:
  - **U then L.** The lock was asked 0 to 40 ticks after the unlock started, and 0 to 25 ticks after the key entered the ring (that is, during the audit append). Each case ran with the queue idle and with another project's change held: 132 cases.
    - In every case the project was locked at once (`isUnlocked` false right after the lock call) and ended locked.
    - The ring was empty when the lock's promise settled, the unlock answered locked, and nothing hung.
    - `key.unlock` was audited exactly when the key had entered the ring.
  - **More orders.** U1,U2,L; L,U,L,U; U,L,U; and an unlock with the wrong passphrase, then L. Each ran idle and busy, at 6 spacings.
    - The last request always won and nothing hung.
    - U1,U2,L: both unlocks answered locked and the ring was empty.
    - The wrong passphrase was answered `WrongPassphraseError` (truthful), and the project ended locked.
  - **The index reload.** A lock at reload opening 1, 2, 4 and 6, and after the last, with a new unlock asked in the same callback: the project ended unlocked with all 6 index rows. The old reload's purge did not wipe the new reload's rows.
  - **Repeat unlock of an unlocked project** (the `serialNext` add, queue busy), then L, at 7 spacings: locked at once, ended locked, the ring empty.
  - **`issueRecoveryCode` with a lock** at 6 spacings: it refused as locked, nothing hung, and the passphrase still unlocked afterwards.
- **Probe `library-service/src/unlock.probeFRA13d.test.ts` (deleted):** C1 below.
- **The third review's probes:**
  - I1 is the round's own test `key-read-race` "R435 (a)": the probe and the reload, re-checked by my probe above.
  - I2 is `restore-lock-state` "R435 b", where every opening gives "restored" or the locked answer with no audit entry; damage is still audited.
  - I3 is `key-read-race` "R435 c", run with a microtask, `setImmediate` and `setTimeout(0)`.
  - I4 is `lock-guards` "R435 d". All passed.
- **Guards were judged by reading** (see below). The dispatch forbids modifying tracked files, so I did not take any guard out.

## Findings

### Critical

**C1: With two unlock requests in flight, a lock asked after both ends UNLOCKED: the second unlock puts the key back after the lock has settled, and resumes everything.**

- **Where:**
  - `repo/projects.ts:240-241`: `asked` is taken when `unlockNow` starts.
  - `apps/library-service/src/routes/projects.ts:154` with `:73-80`: `WrongPassphraseLimit.guard` runs a project's unlocks one at a time. An unlock request queued behind another starts `unlockNow` only after the first ends, so a lock asked while it waited does not count as overtaking it.
- **Probe output** (service: POST unlock U1, then U2, then POST lock, each one tick apart):
  `PROBE U1=423 U2=200 L=200 lockedRightAfterLock=true endUnlocked=true resumeFindCalls=1`
  - The lock answered `{unlocked:false}` and the project was locked at that moment.
  - U1 was overtaken (423).
  - U2 then derived the key, added it, answered 200, and the route resumed Find, proxies, worker jobs and the scheduled backup.
  - The lock's promise had already settled: it waited only for U1, which was `pendingUnlocks` at the time.
- **Why it matters:**
  - R435 a says a lock asked at any moment ends locked, and that the last request wins. Here the last request was the lock.
  - The researcher sees "locked" and walks away, and the project silently unlocks moments later and stays unlocked.
  - The library itself is sound: at library level U1,U2,L ends locked. It is the service's per-project queue that breaks it.
- **Reach:** a double-submitted unlock form, two tabs, or a client retry, followed by a lock within the time of the key derivations (about a second per unlock in production).
- **Severity:** the brief counts "a key left in the ring after a lock has settled" as Critical, so I report it there. The key was supplied legitimately by a request made before the lock, and the reach is narrow, so the coordinator may rule it Important.
- **Direction:**
  - Take the lock count when the request arrives, not when `unlockNow` starts. For example, `unlockProject` could accept the count observed by the route before `limit.guard`, or the repository could return a token at request time.
  - Alternatively, a lock could also reject the unlocks queued in the guard for that project.
  - Add a service test for U, U, L ending locked, with nothing resumed.

### Minor

**M1: R442's premise is not what the code does.** R442 accepts that an overtaken unlock writes `key.unlock` "then the lock writes its own". No `key.lock` action exists anywhere: `grep` finds none, and `packages/core/src/audit.ts:15` lists `key.unlock` only.
- The overtaken unlock's entry is appended in its own turn after the lock has wiped the key. Its `at` is taken inside that turn (`projects.ts:278-281`), so it is timestamped after the lock.
- Nothing is sealed in it: the entry has no sealed reason, and `auditNow` uses no data key. So the Critical finding stays closed.
- But the audit cannot show "unlocked, then locked". Its last word about the key is "unlocked".
- Direction: take the time before the turn (when the key was added), or rule whether locks should be audited at all. This needs the coordinator's ruling, not a fix in this round.

**M2: `projectIdIn`'s new rethrow (`export/backup.ts:1641-1643`, R435 b / M4) is held by no test.** Without it, a lock at opening 1 still reaches `restoreHashed`'s ring check and gives the same locked answer, so `restore-lock-state` "R435 b" @1 passes either way. What would go unseen is a restore that runs without the maintenance lock. Direction: assert that the maintenance lock is not taken, or that the refusal comes from `projectIdIn`.

**M3: The harness's "the mark path was taken" check is per row, not per mark point** (`lock-mid-read.test.ts`, `marked` and the `if (!marked)` after the loop).
- When the stall logic lets the held change go and does not hold it again (for example, at the "after last" point), that point locks by the wipe and still counts as a mark point.
- Direction: count marked points, and require each of the four to have taken the mark path (or say which cannot).

**M4: An overtaken unlock answers 423 "locked" even when its correct passphrase was verified.** The guard therefore keeps any earlier wrong-passphrase count, which a correct passphrase would normally clear (`routes/projects.ts:84-95`). This is harmless, and noted for completeness.

## Checked and sound

- **(a) The mechanism** (`lockAsks`, `overtaken()`, `lockAtOnce`):
  - The count is read synchronously at the start of `unlockNow`.
  - The check and the add are one synchronous step, both directly and inside the `serialNext` add.
  - The key buffer is zeroed in `finally` on every path after the unwrap. `KeyRing.add` copies the buffer, so the zeroing never touches the ring.
  - There is no wait cycle:
    - the lock's own promise does not depend on the unlock, and only its returned wrapper waits for the unlock's mark, which never rejects;
    - an overtaken unlock skips the pending-lock wait;
    - one that waits on `pendingLocks` waits on the lock's own promise, never on the wrapper.
  - In the service, the overtaken unlock leaves the route before any resume (service test, and my reading).
- **(b)** `lockedMeanwhile` requires all three:
  - a `KeyNotAvailableError`;
  - the backup's key id being a project of this library;
  - that key not available now.

  Truncation, a flipped byte and an unknown key id stay `UnreadableBackupError` and are audited. `asLockedNow` turns a partial listing into the locked-from-start listing, and the harness's listing row holds it. `openDecryptedHandle` copies the key at open, so the extraction is not cut by a lock.
- **(c)** Both cache guards check a non-zero buffer and `keyRing.has` before `cache.set`, so a relock-then-unlock is caught by the zeroed old buffer. The turn in progress is purged by the second `purge` at the wipe. `getFieldwork` (`was && !complete`) is sound.
- **A fourth reader:** I searched for kept copies (`cache.set`/`memo.set` across `src`) and for flags computed after a read (`isUnlocked` call sites). The only other kept copy of decrypted facts is the Find runner's `records`, which is dropped after a read finds the project locked (`runner.ts:2864-2865`) and at `stop`. I found no fourth.
- **(d)** The export and the proxy runner take the key eagerly, so on the mark path they still meet `KeyWipedError` at the wipe and answer "locked". A foreign key id is damage again.
- **(e)** The harness ran 43 of 43. The new rows, the after-last point and the kept-copies assertion are present, and their findings were mended (`getFieldwork`, the reload's final `still()`, `asLockedNow`).
- **Guards, judged by reading:**
  - Each of these is held by a test that would fail without it: the two `overtaken()` throws (the round's "probe" and "reload" tests expect a rejection), the add check ("while unwrapping"), the cache guards ("R435 c"), `isLockedRefusal` in the export and the proxy runner ("R435 d"), and `lockedMeanwhile` in `restoreOpened` and `restoreRequestOf` ("R435 b").
  - The exception is the `projectIdIn` rethrow (M2).

## Could not verify

- Each guard failing with the guard removed: tracked files may not be modified.
- The production timing of C1's window (real scrypt cost): the probe used the tests' fast KDF.
- FR-663, FR-679 and FR-700 were not re-examined; I saw nothing in this round that makes them worse.
