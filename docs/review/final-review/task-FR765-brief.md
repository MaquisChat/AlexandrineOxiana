# Task "nothing is asked after a stop" — FR-765, FR-764, and a check of FR-759

You are the implementer of ONE small piece, in your own git worktree, on your own branch. The coordinator has none of your context and you have none of theirs: everything you need is here or in the files named here.

## Where you work
- Worktree: `/home/user/AlexandrineOxiana/.claude/worktrees/kg-3b` (dependencies installed). It is detached at an older commit. Start with:
  `cd /home/user/AlexandrineOxiana/.claude/worktrees/kg-3b && git status --short && git checkout -b fr-765-nothing-after-stop 815c80a`
  (815c80a is the join branch `kg-join`'s head. `git status --short` must be empty before and after.)
- Touch no other worktree or branch. Do not push. NEVER `git stash`.

## Read first
1. `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/kg-common.md` — the sections "For each item", "Verify" and "Report" hold for you (tests first, the smallest change, single test files only, the commit trailers named in `task54-fix-common.md`, how to report). Where it speaks of "your batch", read "this task"; its "Read first" list is replaced by this one, except `task54-fix-common.md` and `impl-common-reader.md` (the house rules), which you read in full.
2. What was just mended, and its review — the model for this task:
   - `git show 8789787 e2b98d2 -- packages/library/src/find/fetch-file.ts` (FR-757: `fetchFile` checks its signal right before each request).
   - `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-FR757-review.md`, answers **C** and **D**: they are this task's findings.
   - Why it matters (proved by a probe): given a request whose signal is already aborted, undici dispatches it all the same and the agent opens a connection to the host (name lookup, TCP, TLS) before it notices the abort. No request line is written, but the host is reached.
3. The list entries, in full: `grep -n "FR-765\b\|FR-764\b\|FR-759\b" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-3000`.
4. Rulings the code's comments name are in `/home/user/AlexandrineOxiana/docs/handoff/LEDGER.md` (`grep -n "Ruling R546\b" … | cut -c1-6000`; likewise R411, R600, R247). Read the ones you meet.

## The rule to make true
**After a run of Find is stopped — by "Stop", by a project's lock, by a library move, by a close — and after a Zotero sync is stopped, the app hands NOTHING more to the network for that work: no retry, no redirect hop, no new request, no new connection.** Work of other projects that shares the same lookup client is not disturbed.

## A. FR-765 (Important) — Find's lookups go on after a lock or a move
- `apps/library-service/src/state.ts`: `stopFind` (≈ :1775) calls `find.stop(projectId)` at a project's lock; the move (≈ :1365) calls `endFind(s)` → `stopAll()`. Neither halts the session's lookup client; only a close does (`beginClosing`, ≈ :1786).
- `packages/library/src/find/runner.ts`: `guard()` (≈ :1144) races a lookup against the run's stop and then simply stops listening; the lookup itself goes on. The lookups: `fetchWork`, `worksOf`, `searchWorks`, `searchPeople` (≈ :1796–1906) and `findFreeCopies` (≈ :2187), all through a `LookupContext` (`lookupContextFor`, ≈ :1720 and :2138) over the shared client in `packages/library/src/lookup/http.ts`.
- **Wanted:** when the run stops, each of its lookups in the air ends at once: a pacing wait, a hold, a Retry-After wait and a retry back-off are cut short, and no further attempt, redirect hop or request is made for it.
- **The coordinator's suggested design — check it against the code, and say so if another is better:** the run owns an `AbortSignal` that is aborted when the run stops (one already exists for downloads, ≈ :2220, `stop.abort(new Abandoned())`); the lookup context carries it; the client honours a caller's signal on every request path (it already takes `opts.signal` on one, ≈ :604) — checked right before each attempt and each redirect hop, and ending each wait. Do NOT halt the whole client at a lock: other projects use it.
- **Keep:** what a service already told the client stays told (a hold learned from a "too many requests" answer is not lost because the caller stopped); an aborted request caches nothing; a lookup made for an attach, for "Look up again" or for another project behaves exactly as before; `findFreeCopies` "never rejects" today (free-copy.ts ≈ :46) — keep whatever its callers rely on, and say how an abort now surfaces.
- **Tests (first, each failing without the mend):** at least — a lookup held in the air, the project locked (or the run stopped): no request after the stop, counted at the mock; a lookup waiting to retry when the run stops: the wait ends and no retry is sent; a redirect answered after the stop: the hop is not followed; a second project's lookup on the same client, in the air at the same time, completes untouched. Use the patterns of `packages/library/src/find/runner.test.ts` and `packages/library/src/lookup/*.test.ts` (undici `MockAgent`, held answers). The test run's network guard (`tests/net-guard.ts`) fails any test that reaches the real network: that is a failure to mend, never to silence.

## B. FR-764 (Minor) — the same fault in three more places
1. `packages/library/src/import/zotero-web.ts` ≈ :567 (after the `dump` at ≈ :553), and the retry sleeps at ≈ :422/:431 when `withKey=false`: the storage-redirect `get` skips `waitTurn`'s `throwIfAborted`, and the sleep cannot be aborted. Wanted: a stopped sync ends its wait at once and makes no further request.
2. `packages/library/src/lookup/http.ts` ≈ :852 and ≈ :623 (`postJson`): the signal is put together after a wait with no check before the request. Wanted: the check right before the request, as in FR-757's mend. (A.'s work may already cover these: then say so and add the test only.)
3. `packages/library/src/find/fetch-file.ts`: an abort during a `privateFolder` that FAILS gives `write-failed`, not the abort's reason. Wanted: the reason.
Each with a test that fails first.

## C. FR-759 — CHECK, and mend only if it is small
Locking an encrypted project while an ATTACH's metadata lookup is in the air: by reading, the lookup client keeps the late answer in memory after the lock. For "Look up again" this was proved and mended (Ruling R600, point I2 — find that mend in `apps/library-service/src` and read it). Reproduce it for an attach with a held answer. If it is true and the same mend fits in about 40 lines of product code, make it, with its test. If it is not true, say so with the evidence. If it is true but larger, do not build it: put it under NEEDS A RULING with what you found.

## Limits
- One commit per FR number. Plain messages that say what is now so.
- No sentence a person sees should need to change. If one does, stop that point and put it under NEEDS A RULING with the exact words.
- No new dependency. No change to a route's shape. If the client's public shape must change by more than an optional signal, stop and say why.
- If any part is plainly much larger than it looks here, stop that part and report; build the rest.

## Runs (single files, `nice -n 10`, one at a time; the machine sets a NODE_OPTIONS to replace: prefix runs with `NODE_OPTIONS="--use-openssl-ca"`)
Every test file you added or touched; every test file in `packages/library/src/find/`, `packages/library/src/lookup/` and `packages/library/src/import/zotero*`, each by path; the service's test files that lock a project or move a library (find them by `grep -l "stopFind\|moveLibrary\|/lock" apps/library-service/src/**/*.test.ts` or by reading); the new timing-sensitive tests 20 times each; typecheck of `@ao/library`, `@ao/library-service` and every package that imports what you changed.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-FR765-report.md`, at most 600 words, as `kg-common.md` says: the table (one row for A, three for B, one for C), the design you chose for A and why, every changed sentence a person sees (expected: none), NEEDS A RULING, what you could not show, the runs. Final message: at most 180 words — status, head commit, the runs in one line, anything uncertain. If an action is refused by a permission check, do not work around it: say so.
