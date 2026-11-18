# FR-A21 round 2 (R426): scoped second look

Worktree `.claude/worktrees/fr-a21`, branch `fr-a21-import-total`, head 2de382e (five commits on 3f81153). Package: `review-FRA21-round2.diff`.

## Verdict: APPROVED WITH SMALL POINTS

- **I1 is closed.** A resumed Zotero Web batch now counts the whole batch, and its record keeps the whole total. This holds for:
  - a full batch and an incremental ("changed since") sync;
  - a second resume;
  - a source that changed between the parts;
  - a listing that restarts inside the scan.
- **M1, M2, M3, M4 and M6 are done.** M5 and M7 are listed but not built, as R426 says.
- **Three Minor points remain.** None needs a ruling.

## What I ran (`nice -n 10`, each file alone)

Probe `packages/library/src/import/bulk/web-resume2.probeFRA21.test.ts` (now deleted). It runs the real engine against the FakeZotero stand-in. Each run below is a list of `[done, total]` progress events. My probe also checked every event for done above total and for done going down within a part: none in any run.

| Run | What happened | Events and result |
|---|---|---|
| **My I1 probe** | 6 items, cancelled at 3, resumed | part 2: `[0,6],[0,6],[3,6],[4,6],[4,6],[5,6],[5,6],[6,6]`; `rec.total` 6; 6 items; 6 sources |
| **Source changed between parts** (full run) | one journaled item deleted at Zotero, one not-yet-imported item deleted, one item added | `[0,6] … [6,6]`; `rec.total` 6; items 6 |
| **Two resumes** | cancel at 2, then at 4, then finish | part 2 `[0,6] … [4,6]`; part 3 `[0,6],[0,6],[4,6] … [6,6]`; `rec.total` 6 |
| **Incremental sync, paused and resumed** | between the parts: a journaled item edited, another binned, a new item added | part 1 ends `[2,4]`; part 2 `[0,4],[2,5] … [5,5]`; `rec.total` 5 (it grew by the new item, which is true); items 5 |
| **Incremental resume whose listing restarts** | 120 more items, plus an item added during the listing's back-off. There were 2 `start=0` listings, so it restarted. | `[0,4],[2,125] … [125,125]`; `rec.total` 125; items 125. The engine's `passedBy` is not cleared, the web scan's `passedTops` is, and the two keys passed by in both attempts were counted once. |
| **ZIPs in a folder** | `a.pdf`, an empty ZIP, an unreadable ZIP, and a ZIP holding a PDF plus a folder entry | count 3, dry run 3 (1 unreadable), run ends `[3,3]` |

Existing tests:
- `bulk.test.ts -t "R426|FR-A21|Zotero Web batches resumed"`: 24 passed.
- `apps/cli/src/commands/import.test.ts`: 3 passed.

At the end, `git status --short` is empty.

## Findings

### Critical / Important
None.

### Minor

**N1 — A resumed Web batch shows "0 of N" for the whole listing before it jumps to where it was** (`bulk/run.ts:842`, the engine's first `emit(progress())`; the counting only happens when the scan calls `skip`)

Every resumed part opens with done 0: in the probe, `[0,6],[0,6],[3,6]`. For other sources this lasts a moment, because they re-yield their journaled items at once. For Zotero Web, the `skip` calls (and so the counting) come only after the listing is read: about 35 requests for 3,400 items. So a batch that stood at "2,000 of 3,412" reads "0 of 3,412" for that time, then jumps back to 2,000.

x ≤ y holds and the end is right; it is only a transient step backwards across the pause. The new tests check that done never goes down within one part, so they do not see it.

Smallest fix: on a resume, leave `done` out of the first event (the screen keeps its last value), or start the first event at the size of the batch's journal. One more option, if the coordinator prefers: say "Resuming…" until the source tells its total.

**N2 — Two small guards are held by no test** (`bulk/run.ts:845`, `zotero-web.ts:970`)

- `!seenKeys.has(key)` in the engine's `skip` (a key yielded first and asked through `skip` afterwards): no adapter does this today. The web scan asks `skip` before it yields, and its gone keys are disjoint from its tree keys. So the guard is defensive only.
- `passedTops.clear()` on a restarted listing: taking it out barely changes anything. A stale key only counts if it is in the new tree's `byKey`, where it would be counted anyway.

Smallest fix: one synthetic test that yields `k0` and then calls `skip("k0")`, expecting done to stay at 1. Leaving these untested is acceptable.

**N3 — Pre-existing, now visible: a journaled item deleted or binned at Zotero between the parts is passed by, not marked gone** (`zotero-web.ts:1058`)

The skip filter on the gone keys was already there before this round (it is the same `skip` delete as before; only the counting is new). So such an item stays as it was here until the next sync, which marks it. It is counted correctly. Noted only because the probe met it; it is not a finding against this round.

## Checked and sound

- **(a) The engine:**
  - `skip` counts a key once: its `passedBy` guard holds even when `skip` is called twice, as in the test adapter, or once per listing attempt.
  - A key passed by and yielded anyway is not counted again (the `!passedBy.has` check at :876).
  - `done` cannot exceed the batch's items, because counting needs `latest.has(key)`.
  - `ctx.skip` is called only by zotero-web (I grepped all adapters), in three places:
    - `changedTree` calls it on each changed item's top, which `topOf` finds in `byKey`. The scan's total counts the top through `passedTops`.
    - The gone keys: `told = gone.size` is taken before the skip filter.
    - The main loop calls it after the child and `tops` checks. A journaled key is never a note or an annotation, so every key `skip` sees is one the total counts. Nothing is asked speculatively.
  - Before the total is told, `done` grows without an event; the next event carries both.
- **The other sources on a resume:** Zotero local, the reference files, Calibre, a device, folder and ZIP never call `skip`. Their journaled items are re-yielded and counted on the `latest.has` path as before (the `passedBy` set is empty for them).
- **A resume after a part that ended in a failure:** a failure in the listing told no total, so the record has none and part 2 tells the whole. A failure mid-loop left the total recorded and the journaled keys counted through `skip`. Traced by reading; no probe.
- **(b) The CLI:** `importProgressWrite` (`\r…\x1b[K`) is written only when `!out.json && process.stderr.isTTY` (`import.ts:167`). It never goes to a pipe, a file, or `--json` output. The test models the terminal and fails without `\x1b[K`.
- **(c) The bad totals:** tests for 2.5, NaN and −1. Each would fail without `Number.isSafeInteger(n) && n >= 0`: 2.5 and −1 would be stored and sent with the events; NaN gives a total that is not undefined.
- **(d) The comments:** `startAndRun`'s JSDoc is back on it; the wizard test's comment now follows R423.
- **(e) The ZIP count:**
  - A readable ZIP with no importable entry counts 0; an unreadable one counts 1 and yields its one item.
  - Inside a folder, the count, the dry run and the run agree (probe: 3/3/3).
  - Under R431, a ZIP alone that counts 0 has no total in the run; its dry run says 0.
  - The new tests fail with the old `Math.max(1, n)`.
- **What holds the new guards (by reading; I did not try edits of tracked files this time):**
  - Without the `skip` counting, "keys … passed by … count as done" ends at done 2, not 5.
  - Without `!passedBy.has` at the yield, "… not counted twice" ends at 8.
  - Without `passedTops` in the scan's total, the incremental resume test sees total 2.
  - Without counting skipped keys in the full total, the full resume test sees total 3.

## Could not verify
- Taking each guard out and watching its test fail: by reading only, as said above.
- A real Zotero library: how long a resumed listing lasts, which is how long N1 shows.
