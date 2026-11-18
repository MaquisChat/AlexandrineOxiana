# FR-A13 round 2 (R386): scoped second look

Reviewer: the same reviewer as round 1. Worktree `agent-a8f81b7c97773ed6a`, head 57740a9, compared with 3aa0561. It is clean when I leave (`git status --short` is empty, all probes deleted, no `git stash`).

## Verdict: NOT APPROVED (small fixes)

Most of R386 is built and works:
- the opening primitives refuse a wiped key;
- the readers the round touched let the refusal through;
- the watched-folders register and the Find queue are emptied from memory at lock, and the reviewer's register probe is fixed;
- the "locking" mark makes a lock immediate for everyone except the change in progress;
- the service answers at once;
- M3 and M4 are done.

Three readers the round did not touch still turn a lock that lands mid-read into wrong state. That is exactly what R386 (a) rules out ("a wiped key is locked, never damaged … nothing read under a wiped key is cached or written back"). Two of them show the researcher a false corruption notice, and one leaves the index short. Each fix is a few lines.

Counts: Critical 0, Important 3, Minor 3.

All runs used `nice -n 10`, at load average 40 to 48. Every race was driven by event-loop ticks, gates and progress callbacks, never by wall-clock time.

## (a) I1: reads cut short by a lock

### The reviewer's register probe, re-run

Setup: 400 entries; read outside a turn; lock after n = 0…45 ticks (this covers 0, 1, 5 and 39); then unlock and read again.

Result:
- Every interrupted read either rejects with `ProjectLockedError` or completes with all entries. There is never a short map.
- `watchCacheSize` is 0 after every lock.
- The read after the unlock always returns every entry (401…446 of 401…446).
- The implementer's tests cover the same for the Find queue, the job journal (`refreshJobRows` never touches the rows) and the export ("locked", not `ExportFailedError`).

### Opening primitives

`assertLiveKey` is in `encryptStream`, `decryptStream` (format.ts:342), `openDecryptedHandle` (random-access.ts:58), `sealLine` and `openLine` (io.ts:218, 228). Every other way of opening goes through these: `decryptBytes`, the `getKey` closures, `openDecrypted`, and `copyFileAtomic` decode. A live but wrong key is still `DecryptionError`, and the tests check this.

### Taking each guard out (one at a time, reverted at once)

| Removed | Tests that failed |
|---|---|
| openLine guard | 10 |
| decryptStream guard | 1 |
| random-access guard | 1 |
| watch `fold` rethrow | 4 |
| Find `parseLine` rethrow | 4 |
| job-journal rethrow | 2 |
| watch purge | 1 |
| Find purge | 1 |
| export rethrow | 1 |
| review-queue rethrow | **0** |
| batch-journal rethrow | **0** |
| change-log scan rethrow | **0** |
| audit-reasons rethrow | **0** |
| `withProjectReasons` mapping | **0** |
| proxies `KeyNotAvailableError` → PENDING | **0** |

The last six have no test (M2).

### Tolerant readers outside the diff

I grepped every `catch` around an open or a decrypt in the library. The three below are wrong. The rest re-read the key right before a synchronous decrypt (so a lock cannot slip in between), or already map the failure to "locked" (`restore-record`, `readPlain`, the index sink's `still()`).

### Other caches

- The index's in-memory rows are purged at lock, both when the lock is asked and in the lock's turn.
- The batch journal, review entries and audit reasons are read again on each use; I found no in-process cache of them.
- The service's media tickets, http cache, captures and transcriptions are dropped by the lock route at once.
- I found no other cache of decrypted content in the library.

## (b) M1: the lock is immediate for everyone but the change in progress

### Implementer's tests

These pass and fail without the mark (4 tests fail when the mark is removed):
- the 300 ms read is refused while the change is held;
- the held change commits under the real key;
- a new change asked meanwhile is refused;
- a stuck change keeps reads refused;
- a timer inside the held change is admitted.

### My probes (`r2.probeFRA13`)

| Case | Result |
|---|---|
| A timer started in an earlier turn fires while a lock is pending | `ProjectLockedError` (not admitted) |
| A nested `serial` asked from the held turn | Runs after the lock's turn; refused |
| Lock asked between `serial(A)` and A's start | The lock goes first; A refused |
| Two locks in a row | The same promise |
| Wrong passphrase while a lock is pending | `WrongPassphraseError`; the lock goes ahead |
| Unlock while a lock is pending and the change is stuck | Waits; the project reads as locked meanwhile |
| Lock, unlock, lock | M1 below |

### Write-queue stress probe, with marks

About 16,600 turns over 5 rounds: `serial` and `serialNext` mixed, synchronous and asynchronous throws, turns queued from inside running turns. Each turn took an `admitsOnlyRunningTurn()` mark 20% of the time, and the probe checked every mark inside every turn, after its awaits, and outside the queue.

Result:
- 0 order errors against the reference model;
- never two turns at once;
- every result and error reached its own caller;
- every mark admitted only its own turn, never a later turn and never code outside the queue;
- no unhandled rejection.

A separate run checked context: each turn ran in its caller's async context. 10,000 queued turns ran in order.

Taking out the turn identity (any turn admitted) fails **no** test (M2). The sound behaviour I saw for earlier-turn timers is untested.

### Service

- `POST /projects/:id/lock` returns `{unlocked:false}` at once.
- `publishState` runs in the same handler.
- The list reports `unlocked:false`.
- `GET /review` answers 423.

The test held this when I ran it (it fails if the mark is removed, since the mark is what makes the list and the read routes agree).

## (c) M3 and M4

- **M3:** removing the `serialNext` branch of `unlockProject` makes the "different key under the same key id" test fail ("authentication failed").
- **M4:** removing the `Promise.reject` makes "rejects, never throws" fail.
- Removing "unlock waits for a pending lock" makes the back-to-back test fail.

## The point the implementer left: an index rebuild cut short

Probe: 8 sources in an encrypted project; `rebuildIndex`; lock at the second progress callback.

Result:
- The rebuild returns 6 errors, each "key … is not available (project locked or key unknown)". These are only logged as a count (state.ts:701).
- No integrity warning, no audit event, nothing marked "needs attention".
- But the new index holds **2 of the 8 sources** for the project. The rest have no row at all, not even the manifest-level row a locked project normally gets.
- The stamps were taken before the cut, so the index is not seen as stale.
- While the project stays locked, the library lists 2 sources for it. After an unlock with its reload (`indexUnlockedProject`) it is back to 8.

So the implementer's account undersells it. There is no false "damaged" notice, but the index keeps rows missing from a read the lock cut short until the next unlock (I3).

## Findings

### Important

**I1: Listing protocol documents while a lock lands gives a false "damaged" message and a lasting false integrity warning.**
- Where: `protocol-docs.ts:68-79`. The key is captured by `listProtocolDocuments` (:139), then `await readMaybe`, then a decrypt under a zeroed key. The bare `catch {}` records `noteIntegrityWarning("protocol-manifest-unreadable")` and throws `InvalidInputError("…their sealed list is damaged…")`.
- Probe, lock after n = 0…5 ticks: every one answers "The names of the protocol documents cannot be read (their sealed list is damaged)…". `repo.integrityWarnings` then holds `protocol-manifest-unreadable`. At n = 6 the list completes ("ok 1").
- Fix: in `readManifest`'s `catch`, rethrow `KeyNotAvailableError` as `ProjectLockedError` before noting the warning. Add a test that locks after n ticks.

**I2: An integrity check that a lock cuts short reports intact encrypted originals as "mismatched".**
- Where: `reconnect.ts:512-516`. The key comes from `projectKey`, which hands out the ring's buffer, and is captured before the walk. `hashStream` then gets `KeyNotAvailableError`, and `catch → report.mismatched.push(entry) // unreadable or fails to decrypt`. The same tolerance is in `relinkMissing` (:857, :961: `.catch(() => null)`, so the candidate is quietly not matched).
- Probe: 6 intact 3 MB encrypted PDFs; `checkIntegrity(lib, "full", {keyRing})`; lock after n ticks. Baseline: 0 mismatched. With the lock:
  - n = 260: `mismatched=6 hashed=6`;
  - n = 220: `mismatched=5 hashed=6`;
  - n = 300: `mismatched=3 errors=3`.
- The service returns this report from `GET /libraries/integrity` (routes/libraries.ts:295). The researcher is told their originals do not match.
- Fix: in the `catch`, a `KeyNotAvailableError` goes to `report.errors` as "locked" (or the project is dropped from the report), never to `mismatched`. Add a test.

**I3: An index rebuild cut short by a lock leaves the locked project short of index rows until the next unlock.**
- Where: `index/rebuild.ts:274-285`. `readSource` runs with the captured `k`; a `KeyNotAvailableError` is caught per source and the source gets no row. The stamps were computed beforehand (:209), so the index is not stale afterwards.
- Probe: 8 rows before the rebuild, 2 after the cut, 2 after an unlock without a reload, 8 after `indexUnlockedProject`.
- This breaks R386 (a): "nothing read under a wiped key is … written back".
- Fix: when an encrypted project's read hits `KeyNotAvailableError` during `populate`, index that project as locked (manifest-level rows from `manifest.json`, as at :222-240), or abort the rebuild / mark it stale. Add a test.

### Minor

**M1: The last of "lock, unlock, lock" is lost.**
- Where: `projects.ts:494-495` (a second lock returns the pending one) together with `unlockProject` waiting for that same pending lock (:239).
- Probe: a change is held; `lock1`; `unlockProject(PASS)` (waits); `lock3` returns lock1's promise; release. The project ends **unlocked** with the key in the ring, although the last thing asked was a lock, and the route answered `{unlocked:false}` to it.
- The UI does not offer Lock while an unlock is pending, so a researcher reaches this only from a second client.
- Fix: a lock asked while an unlock is waiting is a new lock queued after that unlock (for example, a per-project generation number), not the earlier lock's promise.

**M2: Six guards and the turn identity have no test that fails without them.**
- The guards: the review-queue, batch-journal, change-log-scan and audit-reasons rethrows; the `withProjectReasons` mapping (repo.ts:1626); the proxy runner's `KeyNotAvailableError` → PENDING (proxies.ts:365).
- The turn identity: admitting any turn instead of only the running one (state.ts:238) fails nothing.
- Fix: one lock-after-n-ticks test each, and the earlier-turn-timer case from my probe.

**M3: With a stuck change, an unlock asked after a lock never answers.** It waits for the pending lock, which waits for the stuck turn. Reads stay refused, which is safe, but the unlock route hangs. This follows from the design and is no worse than the stuck turn itself. It is noted for the record; no change asked.

## Checked and sound

- The register probe and the caches emptied at lock.
- The opening primitives.
- The mark and how it tells the turn in progress apart. A later turn has a new `Turn` object; code outside the queue has no store; an earlier turn's timers carry an old store and are refused; nested `serial` calls queue behind the lock.
- The write-queue order, errors, re-entrancy, async context and 10,000 turns, unchanged by the mark.
- The service answers at once, and the list and read routes agree.
- M3 and M4.

## Could not verify

- The live-event stream as the browser sees it. I checked only that `publishState` runs in the same handler.
- The implementer's whole-suite runs. I ran only the single test files and probes named above.
