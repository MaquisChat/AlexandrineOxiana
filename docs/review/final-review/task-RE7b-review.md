# RE-7b — adversarial review (FR-504, FR-527; Ruling R470 a)

Worktree `.claude/worktrees/re-7b`, branch `re-7b-find`, 7a8f5ee..2db7dd9 (five commits), read in full.

**Verdict: APPROVE WITH SMALL POINTS.** The two standing rules (R301, R303) hold on every path I tried. One Important point needs the coordinator to decide its scope (I1).

## What I ran
- `runner.linked-missing.test.ts` + `review-held.linked.test.ts`: 14 passed.
- `find-routes.test.ts -t R470`: 2 passed. `FindAcquire.test.tsx -t "linked file"`: 3 passed.
- A probe file, `packages/library/src/find/runner.probeRE7b.test.ts` (6 probes, P1–P10 below). It is now deleted.
- Mutations. I edited `runner.ts`, ran the tests, then restored it with `git checkout -- <file>` (no stash). I removed both `copyDespiteLink` drops on the way to "in-library" (in `copyOn` and in `copyEnded`). All 8 runner tests still passed (see M2).
- `git status --short` is empty at the end.

## Findings

### Critical
None.

### Important
**I1 — An entry already resting "in-library" is never judged again, so FR-504 stays for every existing entry.** `packages/library/src/find/runner.ts:2083-2095` judges reachability only when the copy part runs. That happens for `record-complete`, `looking-for-copy` and `fetching`. `resume` (:2619 ff.) never wakes an `in-library` entry.

Probe P4: an entry rests "in-library" while its linked file is there. The file is then removed and the queue reopened. Result: `in-library`, no reason. The same holds for every entry the owner's current queue (Mac build) already rested "in your library" with a link whose drive is now unplugged — and those are exactly the entries FR-504 is about. It also holds when the drive is unplugged after the entry rested.

The fix as built covers only entries that pass through the copy part after this change. R470 a describes the check "in the copy step", so this may be the intended scope. But the researcher still meets "in your library" with nothing to read.

Direction, which needs your ruling: at opening/unlock, re-judge `in-library` entries whose source has only linked originals. Move them to `record-complete`/`linked-file-missing` only, with nothing fetched. Or accept the scope and note it in the list.

### Minor
- **M1 — After "Not this file", the entry can never ask again, and the pick stays on its line.**
  - Probe P1 result: `no-open-copy` / `not-this-file`, `copyDespiteLink: true`. Both `getCopy` and `retry` are refused (FindEntryStateError).
  - After the drive comes back and the queue is reopened, it still says "You said the file found was not this work." and not "in your library".
  - This matches the existing `not-this-file` behaviour for any record. The lingering flag is inert today: nothing takes `no-open-copy` back into the copy part without a press. "Get through my library" is still offered there (`restsForLibrary`), and that is a press of the researcher's.
  - Source: `review.ts:769` keeps the flag on discard.
  - Direction: drop the flag on discard, and decide whether a `not-this-file` entry whose source has a link is re-judged.
- **M2 — Two of the three "pick is not kept once in the library" guards have no test.**
  - Untested: `runner.ts:2089` (copyOn's in-library) and `runner.ts:2333` (copyEnded's in-library). With both removed, all 8 runner tests pass. Only `review.ts:737` (attach) is pinned.
  - The handed-over path's in-library write at `runner.ts:3284` does not drop the flag at all.
  - This is harmless today because nothing re-runs `in-library`. It would become a fetch without a press if I1 were fixed by re-running `in-library` entries.
  - Direction: drop the flag at 3284 too, and add a test for each drop.
- **M3 — A link that is a dangling symbolic link, or that points to a folder, rests "in your library".**
  - Probe P2: `in-library`. The Missing files check reports it as `mismatched`, not missing.
  - A permission error (EACCES) is likewise "reachable" in Find (`linked-file.ts:41`, `.catch(() => false)`), while the Missing files check files it under `errors`. I judged this by reading only: the probes run as root, so `chmod` has no effect.
  - This is consistent with the rule the brief prescribes (ENOENT/ENOTDIR only). Still, "in your library" with nothing readable is the same symptom as FR-504.
  - Direction: note it, or count a non-file at the path as not reachable for Find.
- **M4 — If the link comes back between the press and "Use this file", the copy is still added, and nothing says so** (probe P5: `in-library`, 2 originals). This is acceptable: the researcher decided explicitly, and R470 a says both are kept. It is noted only because the brief asked.

## Checked and sound
- **R301 / R303:**
  - Without the press, nothing is asked or fetched. This holds at resume, at re-runs, at wakes (`wakeSettings`, `wakeHeldFull`, rules save), and at `retry` (refused: not in `STOPPED_BY_RULES`). `restsForLibrary` does not include the new reason, so no library or browser fetch is offered before the press.
  - The flag is set only in `getCopy` (`runner.ts:2498`). `sanitizeEntry` accepts only `true`. `entryView` never sends it. An import of the same reference makes a new entry without it.
  - The found file only goes to the hold (`needs-check`). Attaching it needs `resolveHeld("attach")`. Two presses at once (P9): one succeeds and the other gets FindEntryStateError; there is one lookup, one download and one held file.
  - Continuation after a press (rules refusal then a rules save, held-full, allowance, `Try again` on `copy-some-unreachable`) is the researcher's request carried on. It is not a new fetch.
- **Route:** `POST …/get-copy` goes through `addressed` (UI caller only: the extension gets 403, tested), `runnerOf` (read-only gives 409, a move is refused), and `pressed` (locked gives 423). It takes no body (400). Another state gives 409 `entry-state`. It is in `ui-only-routes.test.ts`.
- **The hold:** `review.ts:626` refuses for a stored original or a reachable link, and accepts a missing link (tested). Attach goes through the unchanged governed `addOriginalInTx`. The link asset is deep-equal before and after, and the audit names the added asset (tests). The Missing files check still lists the link.
- **Deleted source:** a press followed by deletion of the source (P10) ends at `record-removed`, with nothing held. The lookup and download still happen after the deletion, but that is the pre-existing copy-part order (the source is read first) and not this diff.
- **`reconnect.ts`:** `isGone` and `absIn` moved verbatim; no change in behaviour.
- **Queue file:** an older build reading this queue file ignores the unknown `copyDespiteLink` field (only known fields are copied). The reason is read as a free string (`reasonOf`), so the entry is not dropped. An old runner then rests the entry "in-library", as before.
- **Wording:** the sentence is R470 a's own. It is in line with Missing files ("cannot be found where the library expects them") and contains no path.
- **UI:** the button's accessible name names the source. The busy text, a single request, focus kept in the row and the live region are tested. The button is disabled in a read-only library.
- **Line written once:** the copyOn guard at :2093.

## Could only judge by reading
- That the implementer's tests failed first.
- The behaviour of an older Mac build's service and UI with an unknown reason code (does any older view validate reason codes against an enum?).
- EACCES, as noted under M3.
- A duplicate found file (same bytes as a file the library holds) and an encrypted project's attach. Both go through existing, unchanged code.

## Notes for the reader work (R480 e)
- **Which PDF opens:**
  - `packages/ui/src/routes/reader.tsx:186` builds `files` from `file.assets.filter(isReadablePdf)`.
  - `:374` picks the asked asset, else the located one, else `pdfs[0]`. That first PDF is the missing link.
  - `ReaderLink.tsx:19` shows "Read the PDF" if any asset passes `isReadablePdfAsset` (`packages/shared/src/api/documents.ts:31`: original, not destroyed, PDF mime). It links with no `assetId` (`readerHref`, reader.tsx:44).
- **What the service tells the interface today about reachability:**
  - Nothing per file with the source record. `assets[].linked` carries only `libraryRelativePath` (shared `sources.ts:58`), and `status` is only ever `"destroyed"`.
  - Live reachability exists only in `GET /libraries/integrity` (`apps/library-service/src/routes/libraries.ts:378`, `checkIntegrity`: `missing`, `mismatched`, `errors` by asset id). The new `originalsReach` / `missingAt` (`packages/library/src/repo/linked-file.ts`) is the per-source rule to reuse.

## Second look (R483, R480 e)

Commits 2db7dd9..e864fcb (four), read in full: `runner.ts`, `review.ts`, `routes/sources.ts`, `reader.tsx`, the shared type, and the tests.

**Verdict for this round: APPROVE WITH SMALL POINTS.** The standing rules hold at the new opening pass. M2 and M1 are closed, each held by a test that fails without its guard. R480 e is built as ruled. Two Minor points remain (N1, N2), and nothing is Critical or Important.

### What I ran
- `runner.linked-missing.test.ts`: 21 passed.
- Service `records.test.ts`: 7 passed. `find-routes.test.ts -t "R483|R470"`: 3 passed.
- UI `reader.test.tsx`: 13 passed.
- **Mutations**: I edited the file, ran the one describe, then restored it with `git checkout -- <file>` (no stash).
  - Removing the pick drop in `copyOn` (`runner.ts:2089`) fails only the "copy part" test of R483 b.
  - Removing the drop at the copy's end (:2333) fails only the "copy's end" test.
  - Removing the drop on the hand-over path (:3338) fails only the "hand-over" test.
  - Removing the drop on "Not this file" (`review.ts:756`) fails the R483 c test.
- **Probes**: `runner.probeRE7b.test.ts`, probes A and B. It is deleted now, and `git status --short` is empty.

### 1. I1, the opening pass (`judgeResting`, `runner.ts:2634`; called from `resume` at :2719)
- **It cannot fetch.** Its only writes are `evolve` and `write(…, "update")` in one `inTurn`. The moves are:
  - `in-library` → `record-complete` / `linked-file-missing`
  - `record-complete` / `linked-file-missing` (no pick) → `in-library`

  `write` puts an entry into the copy part only for `record-complete` with a source and NO reason (:1215). Both moves carry or leave no such line, so nothing is enqueued. The pass never calls `copyOn`, `lookupContextFor`, the settings or `download`. It never sets the pick, and it skips any entry that gained one meanwhile (the version check plus `cur.copyDespiteLink`).
- **Counts on the stand-in sources and the fetcher.** Zero in every implementer test: P4, the reverse, an entry with the pick, `not-this-file`, a stored original, two links of which one is there, a deleted source, a locked encrypted project. Zero also in my probe A.
  - In probe B (300 entries), the single lookup and download came from a separate no-file entry the probe added on purpose. Its old rest was `held-full`, which is resumed as before. None came from the 300.
- **Callers.** `resume` is the only caller: the library opened and the project unlocked. A locked project returns before the pass (`isUnlocked`).
  - For an encrypted project only the reverse move is possible (it refuses linked files). That move ends at "in your library" and is harmless.
- **What changed at opening, and for which entries.** Only entries resting `record-complete` / `linked-file-missing` WITHOUT the pick are no longer sent to the copy part (:2725).
  - Every other `record-complete` entry is resumed exactly as before: rules reasons, `held-full`, switched off, no reason.
  - So is an entry with the pick interrupted mid-fetch: it is `looking-for-copy` or `fetching` and so `inCopyPart`.
  - An entry resting `linked-file-missing` never carries the pick: `getCopy` writes `looking-for-copy` in the same write.
  - So no press is lost (checked by reading, and by RE-7b's restart test, which still passes).
- **Written once.** Probe B: after the first opening, a second opening added 0 lines (301 → 301) and 0 lookups. The implementer's test also counts the events.
- **Cost and failure.**
  - The pass runs apart: `resume` returned in 0 ms. A copy-part entry of the same project was fetched at 0.8 s, while the pass over 300 resting entries ended at 2.2 s. It reads one source and does one `lstat` per resting entry, sequentially, outside the store turn, and takes the turn once to write.
  - A failure is caught and logged by name only (:2720). It cannot fail the opening.
  - `stopAll` waits for it (`inflight`), and the stop signal ends it through `guard`.
  - A queue of thousands therefore costs seconds of background reading, not a slower opening.

**N1 (Minor) — two resting entries the copy part used to settle at opening are now left saying the linked file cannot be found** (probe A). Before this round, both entries below went through `copyOn` at opening:
- **An entry resting `linked-file-missing` whose source now has no original at all** (its link was destroyed). `originalsReach` says "none", the pass leaves it, and the copy part no longer runs. Before this round, `copyOn` found no file and looked for a copy, which is ordinary Find behaviour for a record without a file.
- **An entry resting `linked-file-missing` whose source was deleted.** Before, `copyOn` made it `no-open-copy` / `record-removed`.

Both now stay "Its linked file cannot be found…" and offer "Get a copy for this source". The sentence is untrue for them.
- The press still recovers both: `copyOn` then looks for a copy, or says the record was removed.
- No standing rule is touched.
- Direction:
  - "none": leave the copy part for these entries (do not skip them at :2725 when the source has no linked original), or have the pass move them back to plain `record-complete`.
  - Deleted: say `record-removed`, as the copy part did.

### 2. M2 (R483 b)
Closed. All three ways to "in your library" drop the pick, each with a test that fails without its drop (mutations above).

### 3. M1 (R483 c)
Closed. `review.ts:756` adds `copyDespiteLink` to the discard's drops and nothing else, and the test fails without it. The state, the reason and "Get through my library" are unchanged.

### 4. R480 e
- **Where the flag comes from.** `withReach` (`routes/sources.ts:95`) runs only in `GET /projects/:id/sources/:sid` (:214). PATCH, recheck and the list routes still return `record()` without it.
  - It adds `linked.missing: true` and nothing else: `libraryRelativePath` was already sent. No absolute path; the service test checks the body does not contain the temporary root.
  - It uses `missingAt`, the same rule as Missing files. An error counts as there.
- **Which file the reader opens** (`reader.tsx:382`):
  - an asked asset is opened as asked, missing or not (tested);
  - then the located one;
  - then the first PDF not marked missing, so the copy added beside a missing link opens (tested);
  - then `pdfs[0]`, today's behaviour, when none can be reached or no flag is sent (tested).
- **The missing file.** It stays in the File list. Choosing it navigates with its `assetId` and shows today's sentence (tested).
- **ReaderLink and Library.tsx:378.** Both link without an asset, so the reader decides. Unchanged.
- **Older interface.** The UI does not schema-parse responses. The field is optional and ignored by code that does not read it. `SourcePatch` carries no assets, so the flag is never sent back and stored. An older service sends no flag, so this interface behaves as today.

**N2 (Minor) — one `lstat` per linked asset is added to the reader's source read.** On an unresponsive network mount this can make the reader's "Loading" wait as long as the Missing files check would. I judged this by reading only. No change needed. Note it with FR-727.

### 5. What I approved before
Nothing broken:
- RE-7b's tests all pass (21 total).
- The route, the hold and attach, and the queue-file reading are untouched this round.
- The press path is unchanged: `getCopy`, then `copyOn`.

### Could only judge by reading
- That the implementer's eight R483 a tests failed first.
- An unplugged network volume's `lstat` latency.
