# FR-767 report (branch `fr-765-nothing-after-stop`, bb9e1b8..5fdd3fe)

Commits `9d442f9` (A+B), `5fdd3fe` (C). No sentence a person sees changed.

| Item | True? | What changed | Test (failed first?) |
|---|---|---|---|
| A, leftover timer | yes | `import/zotero-web.ts:369-382`: the stop clears the built-in wait's timer (`:376`). | `zotero-web.test.ts:2342` (fake timers, pending count 0). Failed first (1 left). |
| B, debug note | yes | `find/free-copy.ts:564-565`: no note when `ctx.signal` is aborted (one line). | `free-copy.test.ts:604`. Failed first (2 notes). |
| C, Bulk Import | yes | `import/bulk/run.ts:1118`, in `Run.run`'s `finally` | `lock-during-lookups.test.ts:191`. Failed first (1 sensitive entry left). |
| C, watched-folder bring-in | yes | `import/attach.ts:451-459`: `attachFiles` purges in a `finally` | `:204`. Failed first (1 left). |
| C, Zotero Web import | yes | `run.ts:1118` (a Bulk Import run) | `:228`. Failed first (2 left). |
| C, Zotero import resume (route; `resumeBatches` is the same call) | yes | `run.ts:1118` | `:240`. Failed first (2 left). |
| C, Zotero sync | yes | `run.ts:1118` (its batch is a Bulk Import run) | `:266`. Failed first (2 left). |

One helper, `forgetSensitiveIfLocked(repo, http, projectId)` (`lookup/context.ts:97-113`, exported from `@ao/library`), purges when the project is encrypted and no longer unlocked, or cannot be read. It is called in `attachFiles` (the attach route and all three watch call sites), in `Run.run`, and in "Look up again" (`state.ts:2293`, replacing its own copy). The attach route's FR-759 copy is removed (`routes/sources.ts:356-358`): `attachFiles` now does it. A probe confirmed this: without the `attachFiles` call, the FR-759 test fails again. The purge stays coarse, as accepted.

The Zotero tests use items with a DOI and no title: a titled item gets no lookup at all.

## NEEDS A RULING
1. **A Bulk Import or Zotero run keeps sending lookups after the lock.** After the late Crossref answer, the run asked OpenAlex for the same item of the already-locked project, then failed at the store. That is why 2 entries were left before the mend. Nothing stays in memory now, but the request is still sent. Find stops at the lock; Bulk Import does not. I recommend stopping a project's running batches' lookups at its lock, as FR-765 does for Find. Not built: outside this task.
2. **A narrow race in Find (by reading only).** The lock route runs `stopFind` and then the purge in one tick. A response already read, whose continuation is still queued, reaches `remember` in `http.ts` `get` after the purge: nothing checks `signal.aborted` before it. I recommend one line in `get`: remember no answer for a caller that has stopped. Not changed.

## What I could not show
Device import and dry runs (Bulk Import runs by reading; untested); the Find race above; a real network.

## Runs (single files, `nice -n 10`)
- `@ao/library`, all passed: zotero-web 95/95 · free-copy 81/81 · attach 69/69 · lookup 39/39 · bulk 103/103 · watch 143/143 · look-again 34/34.
- `@ao/library-service`: lock-during-lookups 5/5 · close-during-attach 14/14 · look-up-again 40/40 · zotero-web-resume 2/2 · watched-folders-routes 59/59 · zotero-sync-routes 43/43 · server 160 passed, 1 skipped.
- Repeated 20 times each, all passed: the Zotero timer tests (20/20), lock-during-lookups (20/20), FR-759 (20/20).
- Typecheck is clean for `@ao/library`, `@ao/library-service` and `@ao/cli`.
