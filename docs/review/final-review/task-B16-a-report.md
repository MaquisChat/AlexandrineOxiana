# B16 batch A: lookups (branch `b16-a-lookups`, fe85aac..f2ce909)

Commits: `ab4fd8f` (A1), `3dba59a` (A2), `2fd68f6` (A3), `f2ce909` (A4). No route, shared type or screen changed.

| FR | Still present? | What changed | Test (failed first?) | Note |
|---|---|---|---|---|
| A1 FR-769 | yes: after the lock a Zotero import sent 3 more lookups, an attach 2. | `repo/projects.ts:593` `lockStopOf` and `:537` abort at the lock (encrypted projects only); `repo/state.ts:211` the map; `Repo.lockStopOf`. `import/bulk/run.ts:972` and `import/attach.ts:246` carry it as `LookupContext.signal`. Doc comment in `lookup/context.ts`. | `repo/lock-stop.test.ts` (3; failed first: no function). `lock-during-lookups.test.ts:291` (3 new). Zotero and attach failed first; "another project goes on" passes before and after. | Reason `ProjectLockedError`: the run ends as today at a lock ("failed", existing note, counts.failed 0); after the unlock its resume asks again and finishes (tested). The attach's file: "failed", locked reason, as today (checked with the mend out). Client never halted; Find and "Look up again" untouched. |
| A2 FR-768 + FR-753 (2) | yes, the probe reproduced: 6 s instead of 3 s | `lookup/http.ts:718` `throttle` now returns the slot's settling. The next slot moves only when a request leaves (`slot(true)`). A turn whose caller has stopped returns at once with no sleep. A caller that stops while waiting, or is left out or stopped at the last check (`:921`), gives the slot back. The next turn begins only once the one before is settled. Elicit's POST does the same. | `lookup/http-pacing.test.ts` (4). Three failed first (6 s, not 3 s). "Two live callers see the full gap" passes before and after. | Pacing is never skipped: every request that leaves still waits for the slot the last one set. |
| A3 FR-753 (1) | yes | `http.ts` `holdsSet` counts holds per host (in `holdHost` and `holdUntil`). Each request notes the count as it leaves (`holdsAtSend`). A 2xx clears the hold only if no hold was set since (`:859`). Header comment updated. | `http-leave-out.test.ts:428`. Failed first (hold cleared by the late answer). | |
| A4 FR-758 | yes | `import/look-again.ts:254`: when the entry was already settled by another handle, it is kept as is, plus `lastTriedAt: laterTry(cur, at)` when this act really sent. | `look-again.test.ts:722`. Failed first (no `lastTriedAt`). | Existing test (a): the later time is kept. |

No existing test changed or loosened (`Held` in `lock-during-lookups.test.ts` now also logs origins).

## Sentences a person sees
None new or changed.

## NEEDS A RULING
None.

## Points for the reviewer
- A1 aborts in the engine's `lockProject`, so every lock path stops the work. The stop exists for every project and aborts only if it is encrypted at the lock.
- undici aborts a request handed to the dispatcher once it connects: in the tests a held request is released first; on a real connection it aborts at once.
- A2: a sleep that never settled would block the host's line, as before.

## What only a real Mac or service can show
Real network timing. A real device import or Zotero sync stopped at a lock (checked by reading and through the fake Zotero). No end-to-end scenario was run: no route or screen changed.

## Runs (single files, `nice -n 10`, `NODE_OPTIONS=--use-openssl-ca`)
- `@ao/library`, all passed: lock-stop 3 · http-pacing 4 · http-leave-out 34 · http-caller-stop 14 · http-closing 7 · lookup 39 · http-keys 18 · recorded 21 · elicit 18 · runner 307 · free-copy 81 · search 120 · look-again 35 · attach 69 (+ asked-to-wait 12, closing 5) · bulk 103 (+ asked-to-wait 1, closing 2, failure-cause 5) · repo 61 · key-lock-race 11 · lock-guards 7 · zotero-web 95 · watch 143 · device 28.
- `@ao/library-service`, all passed: lock-during-lookups 8 · close-during-attach 14 · zotero-web-resume 2 · zotero-sync-routes 43 · watched-folders-routes 59 · look-up-again 40 · attach-asked-to-wait 1 · lock-during-change 3 · find-routes 47 · server 160 (1 skipped).
- 20/20 each: lock-during-lookups (whole file), http-pacing, FR-753, FR-758, lock-stop.
- Typecheck clean: `@ao/library`, `@ao/library-service`, `@ao/cli`.
