# Batch KG-2 — report (FR-727, FR-728, FR-734 point 2; R503 f, g, i)

Worktree `.claude/worktrees/kg-2`, branch `kg-2-find-linked`, from 579bdcd. Head **07f0ae0**. Three commits, one per item; not pushed.

| FR | still present? | what changed (file:line) | its test, failed first? | note |
|---|---|---|---|---|
| FR-727 (R503 f) | yes: the rule was `lstat` only; a dangling link or a folder counted as "there" in Find and acquire, and the Missing files list (the integrity check) put them under `mismatched`, which the screen does not show, and "Search a folder" did not search for them | `packages/library/src/repo/linked-file.ts:25` new `linkedStat` (the one rule: `lstat`; a link is followed with `stat`; ENOENT/ENOTDIR/ELOOP or a folder ⇒ missing; any other error thrown ⇒ callers count it as there), `:39` `missingAt` now uses it (so `originalsReach`, Find and acquire and the reader's one-source read change with it). `packages/library/src/reconnect.ts:516` (integrity check), `:674` (its confirming turn), `:1009` (Search a folder's list of missing files): a LINKED asset is judged by the shared rule; stored files unchanged. Commit 3aa22da | new `packages/library/src/repo/linked-file.test.ts` (8; the 4 new kinds failed first); `reconnect.test.ts` new describe "R503 f (FR-727)…" (7; all 7 failed first); `find/runner.linked-missing.test.ts` 5 new (the 4 missing kinds failed first, timing out on the wrong resting state; zero calls on the stand-in sources and the fetcher asserted) | see "findings" below |
| FR-728 (R503 g) | yes: the R483 a pass moved only "in your library" ⇄ `linked-file-missing` | `packages/library/src/find/runner.ts:191-194` (the two sets of reasons), `:2628` `restsWantingCopy`, `judgeResting` (≈`:2665-2690`): such an entry whose record now has a reachable original is moved to `in-library` with `attempts: 0`, dropping `reason`, `offers`, `nextTryAt` — in the same one write, on the version judged, entries with the pick skipped (unchanged guards). The R488 a "ordinary resume" now applies only to entries resting for their link (as before). Commit 993a23b | `find/runner.linked-missing.test.ts` new describe "R503 g (FR-728)" (31 tests; the 18 that expect a move failed first; the 13 "stays" passed before and after, as they should) | changed test, see below |
| FR-734 (2) (R503 i) | yes: `startWindow` did nothing with a late `true` once the row had left | `packages/ui/src/screens/FindAcquire.tsx:1707-1715`: when the shell's open answers `true` and the row is no longer live (screen left, project or library changed), the ticket is marked ended and `closeLibraryWindow(ticket)` is sent with THAT open's ticket. Nothing else in the window's ownership touched; `apps/desktop` untouched. Commit 07f0ae0 | `FindAcquire.test.tsx` "FR-734 (2): the row leaves (unmount/project)…" (2, both failed first: 0 closes) and "the reverse: a row still on the screen…" (passed before and after) | held promise released by `onTestFinished` |

## Findings and choices

**FR-727.**
- **Following a link:** only the link's status is asked (`stat`), and nothing is read. A link to a file on an unplugged drive gives ENOENT ⇒ missing. A link to a file that is there is present. A link that goes round in a circle (ELOOP) is missing. A link to a folder is missing. Cost: one more status call, and only for a path that is a link. A link into a network mount that does not answer could hold that call up, just as `lstat` already could. The reader's one-source read keeps its two-second bound (R488 b). The opening pass is not bounded, but it does not hold up the opening (R488).
- **Side effect, in line with the ruling:** in the integrity check, a linked path that is a link to a file that is there is now checked for size and hash against the target file. Before, it was reported "mismatched", because `lstat` of a link is not a file.
- **"Cannot be read" state:** I looked for one. The app has no researcher-visible state that says a source's file "cannot be read". The integrity report's `errors` and `mismatched` are not shown on the Missing files screen, and no sentence in `packages/shared` says it. So a file blocked for want of permission keeps today's answer: present. The tests prove this with a stand-in EACCES, because the machine runs as root and `chmod` cannot show it.
- **"A path that escapes the library root is refused as today":** the rule never refused such a path. A linked path may start with ".." by design (R24, `LinkedRelativePath`). Relinking still refuses a found file outside the library ("outside-library"). Neither was changed.
- **Reconnecting for each new kind:** "Search a folder" now lists each new kind as missing. For a linked asset it only points the record at the file it finds (`relinkLinkedAsset`, governed and audited). It never touches what is at the old path: tests assert that the dangling link, the folder, and the link to a folder are still there afterwards. No choice was needed, so this is not a NEEDS A RULING.
- **Scope:** stored (copied-in) files are judged as before. The ruling names linked files only.

**FR-728: which resting states mean "for want of a copy"**
- **Included:**
  - `no-open-copy` with no reason: no copy was found.
  - `not-this-file`: named by the ruling.
  - `copy-some-unreachable`: no copy was found, and "Try again" looks again.
  - `copy-not-downloaded`: a copy was found but could not be fetched.
  - `library-unfinished`: a fetch in the sign-in window was not finished, and nothing was added.
  - `failed` with a record and reason `unreachable` or `unexpected`: the copy part's passing faults. "Try again" sends exactly these back to look for a copy.
- **Excluded:**
  - `record-removed`: the record is gone.
  - `failed` with `not-allowed`, `no-legal-basis`, `switched-off`, or `needs-key`: a rule, a setting or a key. The researcher acts another way.
  - `needs-check`: a found file waits for the researcher's decision (R301).
  - `already`, `not-found`, `choose*`, `maybe-duplicate`, `looking-up`: the record part, not a copy.
  - `looking-for-copy`, `fetching`, `waiting-sign-in`: being worked on.
  - Any entry with the pick (`copyDespiteLink`).
  - All `record-complete` entries, including those a rule or setting stopped and `held-full`: the copy part already queues them at every opening and finds their source's file itself. `linked-file-missing` stays R483's case.
- **Guards:**
  - Nothing is woken, asked or fetched. The tests assert zero copy lookups and zero file requests.
  - The line is written once: at the next opening the entry is "in your library" and stays so.
  - A locked project is judged at the unlock and not before (tested).
  - The re-judged entry equals, field for field apart from id, timestamps and record, an entry brought to "in your library" by "Try again" and the copy part. `entryView` is a pure projection of the entry, and an in-library entry carries no library parts, so the service's view is the same too.

**Existing tests changed (they asserted the gap):**
- `find/runner.linked-missing.test.ts`, "an entry resting on "Not this file" is left alone, whether its linked file is there or not". It now reads: …stays so while its linked file cannot be found; the one whose linked file is there rests in your library.
- `find/runner.test.ts`, "R345 b: not offered for an entry with a file, …". The entry with a file now rests in your library at the opening. The test waits for that true resting state and asserts it carries no link offer, using `?.` for that one entry because it is no longer among the resting entries. The other assertions are unchanged.

## Researcher-visible sentences new or changed
None. The re-judged entries use the existing "In your library" state and the existing `linked-file-missing` sentence.

## NEEDS A RULING
None.

## What only a real Mac or a real service can show
- A real unplugged drive or network volume behind a link. Here, a removed folder stands in for it.
- macOS aliases (Finder aliases are files, not symbolic links, and stay "there").
- The shell really closing the late window by ticket. Here the page side is tested against the fake shell.
- No end-to-end scenario drives the sign-in window's opening from a row: the browser build has no shell, and no spec contains it. I ran `e2e/find-copies.spec.ts`, which drives the Find and acquire screen, including "Not this file".

## Runs (last summary line each, all `nice -n 10`, single files)
- library `src/repo/linked-file.test.ts`: 8 passed (8)
- library `src/reconnect.test.ts`: 52 passed (52)
- library `src/find/runner.linked-missing.test.ts`: 60 passed (60)
- library `src/find/runner.test.ts`: 300 passed (300)
- library `src/integrity-confirm.test.ts` 5 passed; `src/integrity-confirm-batches.test.ts` 6 passed; `src/repo/review-held.linked.test.ts` 6 passed
- library `src/repo/lock-mid-read.test.ts`: 2 failed | 42 passed (44). Both failures (exportBibliography, citeSources) are `CslBundleMissingError: No citation styles are available`. The citation-style bundle is not set up in this worktree, and they are unrelated to this batch. Re-run alone: the same.
- service `src/find-routes.test.ts` 46 passed; `src/find-browser-routes.test.ts` 44 passed; `src/records.test.ts` 9 passed
- ui `src/screens/FindAcquire.test.tsx`: 218 passed (218)
- typecheck `@ao/library`, `@ao/library-service`, `@ao/ui`: clean
- `lint:css` clean; `lint:colours`: "ok: no hard-coded colours"
- `@ao/ui build`: built; e2e `find-copies.spec.ts` (chromium): 8 passed (1.9m)
- `git status --short`: empty

## Fix round (R510)

Head **e59ea20**. Seven commits on top of 07f0ae0, one per point, plus one e2e test commit.

| point | commit | what changed (file:line) | its test, failed first? |
|---|---|---|---|
| 1. I1 (FR-734 point 2) | 3857728 | `packages/ui/src/screens/FindAcquire.tsx:1707-1717`: after the ticketed close, `opened` is set to false, so the start takes the existing not-opened path. That path cancels at the service once (`libApi.cancel`, sent also when the screen is gone) and shows nothing on a row that has left. | `FindAcquire.test.tsx` "FR-734 (2): the row leaves (unmount/project)…". Both now also assert one cancel POST to that entry's `/library/cancel` and that the service's entry no longer waits. Both failed first (0 cancels). "The reverse" still asserts no close and no cancel. The service frees its one ticket on cancel by the existing route, already tested in the service. I added no service test. |
| 2. M1, the rule corrected | 7093f21 | `packages/library/src/repo/linked-file.ts:22` `linkedNotThere`, `:26` `missingAt` (`lstat` only: any symbolic link or a folder at a linked path is missing; ENOENT/ENOTDIR as before; other errors thrown, so a file not readable for want of permission stays "there"). `linkedStat` is removed, so the rule no longer looks through a link and M2 goes with it. `packages/library/src/reconnect.ts:522` (checkOnce, through the `opts.stat` seam again, M6), `:677` (stillWrong), `:1007` (Search a folder). | `linked-file.test.ts`: "a symbolic link to a file that IS there is missing too", and "the rule never looks through a link" (asserts that `stat` is never asked). Both failed first. The test for a link with a permission error on its target is gone, because the rule no longer asks that. `reconnect.test.ts`: the kind "a link to a file that is there" was added to the missing kinds, listed and relinked, with the old link left in place. The old "present" test was replaced by "R510 (M6): … through the check's own stat seam". All three failed first. `runner.linked-missing.test.ts`: the same kind added to the missing kinds (rests `linked-file-missing`, nothing asked or fetched). The "a link to a file … is in your library" test was replaced. A new FR-728 test, "an entry resting on Not this file whose only original is now a symbolic link to a file that is there stays as it is". All three failed first. |
| 3. M1, the reader | f7ef13c, e59ea20 | `packages/library/src/asset-content.ts:120-154`: `openStored` gains `linked`, passed only by `openAssetContent` for a linked original. For such an original, ELOOP from O_NOFOLLOW (a symbolic link) and a folder at the path are refused with the existing not-found error. The route then gives its existing 404 "The file of this source is not where it was recorded.", and the reader gives its existing "File not found" with "The file of this source is not where it was recorded, so it cannot be shown." A FIFO or socket stays unsafe. A stored file is unchanged: a link stays a PathEscapeError and a folder stays unsafe. The service's `missing` flag now covers these kinds through the corrected `missingAt`. | `asset-content.test.ts`: a new describe with 4 kinds (a link to a file that is there, a dangling link, a folder, a link to a folder). All 4 failed first. Two contrasts pass before and after: a FIFO at a linked path is unsafe, and a folder at a stored path is unsafe. `documents-route.test.ts`: **an existing test was changed because it asserted the old answer.** In "a symbolic link swapped in for the stored file or the linked file is never followed", the linked case now expects 404 NOT_FOUND with MISSING instead of 400 UNSAFE, and still never the secret bytes. New test "R510 (FR-727): … answers 404 as a file not there". Both failed first. The screen's mapping was not involved: a 404 already maps to "File not found" (`routes/reader.test.tsx` and `Reader.test.tsx` were run, not changed). The e2e step was added to `e2e/reader.spec.ts` "a missing linked file says so": a link to a copy that is there, and a link that leads nowhere, each give "File not found". It failed first with the old `asset-content.ts` (checked by restoring the old file temporarily, then putting the new one back). |
| 4. M4 | 1e7f08f | `packages/shared/src/api/sources.ts:55-58` and `apps/library-service/src/routes/sources.ts:94-96`: the comments now say the flag covers nothing at the path, any symbolic link, and a folder, and that a permission error counts as there. | comments only |
| 5. M5 | 8c34232 | `packages/library/src/find/runner.test.ts` "R345 b: not offered for an entry with a file…": one entry has a file at the opening (the pass moves it, marking the pass's end). The entry under test gets its file AFTER that; it still rests, and `v.get(withFile.id)!.link` must be undefined (`!` again, not `?.`). | Mutation: removing `!facts.hasFile` at `runner.ts:526` makes it fail ("expected true to be undefined"). Restored from a copy, and `git diff` was empty afterwards. |

**Sentences shown in a new case (none is new):**
- The reader now shows "File not found" and "The file of this source is not where it was recorded, so it cannot be shown." for a symbolic link or a folder at a linked original's path. Before, it showed "Not a PDF".
- The service sends "The file of this source is not where it was recorded." with 404 in those cases.
- Find and acquire's "Its linked file cannot be found at the moment; the drive it is on may not be connected." is now shown for a link to a file that is there too. That wording is FR-745, which is not built.
- The Missing files list now lists these paths.

**NEEDS A RULING:** none.

**Runs (fix round, `nice -n 10`, single files):**
- library: linked-file 9/9, reconnect 54/54, runner.linked-missing 62/62, runner 300/300, review-held.linked 6/6, integrity-confirm 5/5, integrity-confirm-batches 6/6, lock-mid-read 44/44 (passes fully now that the citation styles are there), asset-content 15/15, asset-content-open 3/3
- service: find-routes 46/46, documents-route 25/25, records 9/9
- ui: FindAcquire 218/218, Reader 59/59, routes/reader 13/13
- typechecks of `@ao/shared`, `@ao/library`, `@ao/library-service`, `@ao/ui`: clean
- `lint:css` clean; `lint:colours` ok
- `@ao/ui build` done
- e2e (Chromium): `reader.spec.ts -g "missing linked file"` 1 passed; `find-copies.spec.ts` 8 passed
- `git status --short`: empty
