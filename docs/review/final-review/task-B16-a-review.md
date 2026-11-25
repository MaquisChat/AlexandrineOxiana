# Review: B16 batch A, lookups (`b16-a-lookups`, fe85aac..f2ce909)

**Verdict: Ready with fixes.** A2, A3 and A4 are correct, and each new test fails without its mend. A1 is correct for the work the ruling names: Bulk Import runs and attaches. One other kind of work still asks a service after a lock.

## Findings

**Important 1: "Look up again" (the button and the automatic pass) carries no lock stop.** At `import/look-again.ts:350` the lookup context has no `signal`. Probe (a temporary test, now removed): an encrypted project, an entry left out for Crossref and OpenAlex. Its first request was held before it left, then the project was locked and the request released. **One Crossref request went out after the lock**, then the act answered "locked". A queued request, a retry or a redirect hop can all still go after a lock. Outside A1's letter (imports and attaches), against its intent. Fix: add `signal: repo.lockStopOf(projectId)` at :350, with the probe as a test. The client then throws `ProjectLockedError`, which `lookUpAgain` already answers as "locked". Or the ruling accepts it as a residual.

**Minor 2: a fresh stop can be made while a lock is waiting for a write turn** (`repo/projects.ts:593–597`, found by reading, not triggered). While a lock waits for the running turn, the key is still visible inside that turn. A `lockStopOf` call from that turn would create a controller that is never aborted. Fix: also return an aborted signal when `core.pendingLocks.has(projectId)`.

**Minor 3: a 429 that does not lengthen a hold still counts as a new hold** (`lookup/http.ts:793`). A good answer to a request that left before that 429 then does not clear the hold. Conservative (it ends by time); no change.

## Questions 1–10
1. Covered: device import, Zotero Web import, its resume and Zotero sync (one `Run`, `bulk/run.ts:974`). The attach route and every watched-folder call site go through `createAttach`. Not covered: "Look up again" (Important 1). The settings' test only builds the rules. Find keeps its own `r.halted`, and the two signals never meet.
2. A request in the air or queued at the lock: no further lookups (service tests; the two FR-769 tests fail with the mend reverted). Waits for pacing, for a hold and before a retry are cut through `halt(caller)` and the check before each send (FR-765). Between two items: the next lookup throws at once, and nothing is sent.
3. The run ends "failed" with the existing note and `counts.failed` 0. Lock, unlock and resume through the routes: it asks again and ends "finished" (run).
4. The lock aborts the stop and deletes it, so the next one after an unlock is fresh. An unlock overtaken by a lock adds no key, so the stop is born aborted. Nothing piles up: one controller per project, and combined signals were already built per request. Exception: Minor 2.
5. Another project's attach goes on (test). The client is never halted. A project that is not encrypted gets a stop that never aborts. Close and move are unchanged.
6. The abort comes first, synchronously, before the purge and the key's removal. An answer read after its caller has stopped is not kept (`http.ts:411`). No window remains, except for "Look up again".
7. By reading: a turn begins only after the one before has settled, and the slot moves only when a request is sent. A stopped caller that is already sleeping finishes its sleep, and the next caller then waits from the unchanged slot. Ran the pacing tests and the FR-753 test 20 times with three busy loops: 20 of 20 passed.
8. Holds are counted, not timed, so two events in the same millisecond are safe. Redirects stay on the same origin. Answers from memory or disk never reach the clearing. Every hold still ends by its time.
9. Correct: only `lastTriedAt` is added (`laterTry`, never earlier), and only when this act sent.
10. Reverted each mend: A1 failed 2 of 3 tests, A2 3 of 4, A3 1, A4 1. The control tests rightly pass both ways. No test loosened or deleted; no sentence or route changed. Clean tree, HEAD f2ce909.

## What I could not check
Real network timing, including undici aborting a connected request. A Zotero import's own requests to Zotero after a lock (not lookups). The whole package suites.
