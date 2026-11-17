# FR-A13 — a scoped look at round 5 (R443, R444)

Reviewer: the reviewer of round 4. Worktree `.claude/worktrees/agent-a8f81b7c97773ed6a`, branch `fr-a13-key-ring`, head e1231af (four commits on 25bbe25). I read the whole package `review-FRA13-round5.diff`, R443, R444 and the report's "## Round 5".

When I left, every probe was deleted and `git status --short` was empty. I used no `git stash` and changed no tracked file.

## Verdict: APPROVED WITH SMALL POINTS

C1 is closed: through the service, an unlock is now overtaken by every lock asked after its request arrived. M1, M2 and M3 are answered as ruled. I found no Critical or Important finding. Two Minor points follow; neither blocks.

## What I ran (each alone, `nice -n 10`)

- **The harness** `lock-mid-read.test.ts`: **43 of 43** (536 s, exit 0). Every mark point now has to take the mark path, and the exemption list is empty.
- **What must still hold:** `key-read-race`, `key-lock-race`, `lock-guards`, `src/crypto` and `restore-lock-state`: 5 files, **118 of 118**. The service's `lock-during-change.test.ts`: **3 of 3**.
- **Probe `library-service/src/order.probeFRA13e.test.ts` (deleted).** Real concurrent requests through `app.inject`. Each request was sent only once the one before had reached its handler, plus one tick. The answers are in the order the requests were sent.

| Order | Answers | Ends | Key in the ring | resumeFind |
|---|---|---|---|---|
| U1, U2, L (my C1 probe) | 423, 423, 200 | locked | no | 0 |
| U, U, U, L | 423 ×3, 200 | locked | no | 0 |
| W (wrong), U, L | 401, 423, 200 | locked | no | 0 |
| U, L | 423, 200 | locked | no | 0 |
| U, L, U | 423, 200, 200 | **unlocked** | yes | 1 |
| U1 (still deriving), L, U2 | 423, 200, 200 | **unlocked** | — | — |
| L, U | 200, 200 | unlocked | yes | 1 |
| U, U, L, U | 423, 423, 200, 200 | unlocked | yes | 1 |

- **Unlocking a project that is not encrypted:** 200 `{unlocked:true}`, as before.
- **An unknown project id:** 404 NOT_FOUND, as before. `projectParam` throws before the count is read, and `lockAsksOf` never throws anyway.

## Point by point

1. **C1 (R443 a): closed, every neighbour behaves.**
   - The last request always wins. A retry the screen sends after a 423 is a new request that reads a new count, and it wins (the "U, L, U" row).
   - **The window between reading the count and parsing the body does not exist.** In the handler, `lockAsksOf` and `str(bodyOf(req))` are synchronous and adjacent (`routes/projects.ts:155-156`), and Fastify has parsed the body before the handler runs. A lock whose handler starts while an unlock's body is still arriving counts as earlier, and that unlock wins. R444 accepted this.
   - **Two libraries:** the service holds one session at a time. The count is kept per repository (`RepoCore.lockAsks`), per project id.
2. **The new optional argument.**
   - Every other caller passes nothing and behaves exactly as in round 4: the CLI (`apps/cli/src/session.ts:185`), the e2e plant (`e2e/find.spec.ts:237`) and the tests' helpers. They use `asked = lockAsksAtRequest ?? current`, and `??` keeps a count of 0.
   - The count only grows. A count can be stale only within its own request, so no unlock can be refused for ever.
   - The only other route behind the passphrase limit is the new recovery code. It adds no key and refuses as locked; my round-4 probe confirmed this at 6 spacings.
3. **(b) The time of a `key.unlock` entry.**
   - `addedAt` is taken in the same synchronous step as the add (`projects.ts:269-271`), for an ordinary unlock and for an overtaken one. The round's test (T1 for the add, T2 for the lock) shows T1.
   - An unlock overtaken before its add writes no entry: `if (!added) throw` comes before the append. My round-4 probe saw `audit+0` in that case.
   - Nothing in the entry is sealed, so the Critical finding stays closed.
   - A time earlier than the entry before it breaks nothing. The chain is hashed and verified by seq, and `core/audit.ts:76-80` checks only the format of `at`. Segments are named by seq. `checkAnchor` does not compare times. The library audit's same-day de-duplication runs on the library log, not on project logs. The audit screen lists by seq. The destruction and retention readers take `at` from their own entries.
4. **(c) The mended stall logic** (`lock-mid-read.test.ts:316-326`).
   - It holds another change at once, synchronously after the release. The released change is still running when the new one queues, so the queue is never idle between them.
   - The new hold queues behind the turn the reading waits for, so a lock point finds either the reading's own turn or the new hold running. Either is a genuine mark.
   - `marked` is set only when the ring did not shrink at the ask. A point cannot pass by a wipe, so the check cannot be satisfied falsely.
   - After the lock nothing more is held, and every hold is released and awaited.
5. **(d)** The comment at `backup.ts:1649` is accurate.

## Findings

### Minor

**m1: `key.unlock` now departs from the audit log's own convention for an event recorded after the fact** (`repo/projects.ts:286`).
- Task 50 keeps `at` as the time of recording and puts the time of the event in `details.recordedLate.occurredAt`. The audit screen renders that as "Happened …; recorded late on …" (`packages/ui/src/screens/AuditLog.tsx:72-77`).
- Back-dating `at` instead lets the log's times go backwards with no sign of it. For example, an unlock of an already-unlocked project whose entry waited behind that project's other turns gets an earlier time than entries written before it.
- R443 b and R444 ruled the time; this is only the form.
- **Smallest fix:** keep `at` as the time of the append and add `details.keyAddedAt` (or `recordedLate`) when the two differ. If the ruling stands, there is nothing to do.

**m2: The service test's notion of "arrived" relies on `requireSession` being called twice per handler** (`lock-during-change.test.ts:42-45`). It is brittle: a refactor that calls it once makes `arrived()` spin until the test times out. It is not wrong.
- **Smallest fix:** spy on `repo.lockAsksOf` instead. That is the very moment the count is noted.

## Guards (judged by reading; tracked files may not be modified)

- **`lockAsksAtRequest` in `unlockNow`:** without it, the service test "R443 a" gets U2=200. The report saw exactly this, and it matches my round-4 probe. The library test "R443 a" (a stale count overtaken) would also fail.
- **`addedAt`:** without it, "R443 b" sees T2.
- **The per-point `marked` check:** without it, the harness would let a point locked by a wipe pass.

## Could not verify

- Real HTTP (not `inject`) under a slow body upload: by reading only, and R444 accepted it.
