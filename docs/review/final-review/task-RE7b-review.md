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
