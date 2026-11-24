# KG-2 — adversarial review (FR-727, FR-728, FR-734 point 2; R503 f, g, i)

Worktree `.claude/worktrees/kg-2`, branch `kg-2-find-linked`, 579bdcd..07f0ae0 (3 commits, 9 files). Reviewed against R503 f/g/i, R505, R301, R303, R470 a, R472, R478, R483, R486, R488, R489, R491 B, the brief and the report.

**Verdict: NOT APPROVED as it stands.** There is one Important point, and the fix is small. FR-727 and FR-728 hold. FR-734 (2) closes the window as ruled, but it leaves the service's start waiting.

## What I ran (all `nice -n 15`, single files)
- library `src/repo/linked-file.test.ts` 8/8; `src/find/runner.linked-missing.test.ts` 60/60; `src/reconnect.test.ts` 52/52.
- Mutation, `restsWantingCopy` widened to every `no-open-copy`/`failed`/`needs-check`: 6 tests fail (record-removed, not-allowed, needs-key, switched-off, no-legal-basis, needs-check). The exclusions are held. Restored.
- Mutation, `!facts.hasFile` removed from `libraryChancesOf`: `runner.test.ts` "R324 a: not offered for an entry whose record has a file…" fails (1 of 300). The guard that the changed R345 b test used to show is still held. Restored.
- Mutation, the FR-734 (2) block disabled: both "row leaves (unmount/project)" tests fail, and "the reverse" passes. Restored.
- Probes PROBEKG2 and PROBEKG2b, scratch tests in `FindAcquire.test.tsx` (restored from a copy): see I1.
- e2e: `@ao/ui build`. Then `e2e/reader.spec.ts -g "missing linked file"` in Chromium. The spec as it is passed (1 passed). Two scratch variants (restored) put a dangling link in place of the deleted file: one against the new rule, one with `missingAt` put back to the old `lstat`. See M1.
- At the end `git status --short` is empty. No probe file is left, and every scratch edit is restored with `git checkout --` or from a copy.

## Findings

### Important

**I1 — FR-734 (2): the late close leaves the service's start waiting, so the whole library's sign-in window is "busy" for up to 30 minutes.** `packages/ui/src/screens/FindAcquire.tsx:1707-1715`.
- When the open answers `true` after the row has left, the page closes the window with its ticket, as ruled. But it sends no `libApi.cancel`.
- The not-opened path just below does send that cancel, even when the screen is no longer live (`:1726`). The late answer of a given-up open (R342 a) goes down that path too: `openWindow` returns false.
- The shell does not tell the service when a window closes. With no page listening, nobody ends the runner's ticket.
- Probes:
  - PROBEKG2 (unmount), after the release: `closeLibraryWindow` called once with TICKET; `cancels: 0`; service state `waiting-sign-in`.
  - PROBEKG2b (project change): the same, with `closes: [[TICKET]]` and `cancels: 0`.
- What follows, by reading `runner.ts:3083`. The runner holds ONE `libTicket` for the whole library (`if (libTicket || libClaimed) throw busy`). Until LIBRARY_TICKET_MS (30 min) runs out, or until the researcher finds that row and presses "Cancel":
  - every "Get through my library", link start or browser start in ANY project is refused as busy;
  - the row says "Waiting for you in the sign-in window" while there is no window.
- Before this commit the window at least stayed open, so the researcher could use it or close it. Now the app itself creates a wait that nobody owns, with nothing on screen.
- Direction: after the ticketed close, cancel the start at the service, as the not-opened path does. That path cancels whether or not the screen is live. Add a test that asserts one cancel.

### Minor

**M1 — FR-727: the reader still says "Not a PDF — This file cannot be shown here." for a dangling link (and for a folder), while the Missing files list now says the file is missing. A link to a file that is there counts as "present", but the app's own reader can never read it.**
- The e2e variant replaces the linked PDF with a dangling link. The reader shows "Not a PDF / This file cannot be shown here.", not "File not found". It does so with the new rule and with the old one, so this is not a regression.
- Cause: `packages/library/src/asset-content.ts:133` opens with O_NOFOLLOW, and ELOOP is "unsafe", which becomes 400, which the screen shows as "not-a-pdf". When every PDF is flagged missing, the reader (R480 e) falls back to the first PDF, and the content route refuses the link before it could say "missing".
- So, for the cases R503 f now calls missing, the reader's sentence is untrue.
- And a symbolic link to a readable file:
  - is "in your library" in Find and acquire (as before), and R503 g now moves resting entries to "in your library" for it;
  - makes `holdMismatchedFile` refuse a found copy (`HeldFileSourceHasFileError`);
  - and yet it shows as "Not a PDF" in the reader.
- The brief told the implementer that such a link is present. Direction: the coordinator rules whether the content route maps a dangling link or a folder at a linked path to "missing". It would also rule whether a link to a file counts as present, given that the app never reads through a link. Otherwise list it as a new item.

**M2 — Following a link is unbounded inside a governed change and in the integrity check.**
- `linkedStat` now calls `stat` through a link. Where it runs:
  - `originalsReach`, inside `holdMismatchedFile`'s `runMutation` (`packages/library/src/repo/review.ts:626`);
  - `checkOnce`/`stillWrong`, where `stillWrong` runs in the write queue's confirming turn (`reconnect.ts:517`, `:675`).
- A link into a network mount that does not answer can therefore hold the library's write queue. Before, `lstat` of a local link answered at once.
- This was already true of a linked path that lies directly on such a mount, so it is a narrow widening. The reader's read stays bounded (R488 b). Judged by reading.

**M3 — Wording for new cases (no sentence is new).** `git diff 579bdcd..HEAD -- packages/shared` is empty, which confirms the report.
- "Its linked file cannot be found at the moment; the drive it is on may not be connected." is now shown for a folder at the path and for a link loop. There the drive IS connected. The "may" keeps the sentence from being false, but it points the researcher the wrong way.
- The Missing files screen's "… cannot be found where the library expects them." is true for every new kind.

**M4 — Stale comments.** `packages/shared/src/api/sources.ts:58` and `apps/library-service/src/routes/sources.ts:94` still define the service's `missing` flag as "nothing at its path". It now also covers a dangling link and a folder.

**M5 — The changed R345 b assertion is now vacuous.** `runner.test.ts` reads `expect(v.get(withFile.id)?.link).toBeUndefined()` for an entry that is now "in your library" and so is not among the entries viewed. The rule it guarded (no link start for a record with a file) still holds through the R324 a test, shown by mutation. Direction: assert on a resting entry whose file was attached after the opening, which is the mid-session case where the guard still matters.

**M6 — `checkOnce` bypasses the `opts.stat` test seam for linked files.** A test injecting `stat` no longer reaches them. This affects tests only.

## Per item

| FR | implementer's claim | verdict | note |
|---|---|---|---|
| FR-727 (R503 f) | one rule (`linkedStat`): ENOENT/ENOTDIR/ELOOP, a dangling link or a folder ⇒ missing; other errors ⇒ there; callers changed together; reconnect never touches the old path | **holds** (M1–M4) | Checked: a link to a link (stat follows the chain); ELOOP from a loop and from a loop in a parent ⇒ missing; a parent that is a dangling link ⇒ ENOENT ⇒ missing; a file in a folder's place (ENOTDIR) ⇒ missing; EACCES/EPERM on the file, its link target or its parent ⇒ thrown ⇒ "there" in every caller (`originalsReach` catch, integrity `errors`, relink skips, service `false`), as R503 f rules; a FIFO, a device or an empty file at the path ⇒ "there" (only the three ruled kinds are missing); Unicode form and case unchanged (one `lstat`); ".." paths are allowed as before (R24), and relink still refuses a found file outside the library. Following reveals nothing: only status is asked; the integrity check now hashes through a link whose size matches, and compares only. Encrypted projects cannot hold linked files (`state.ts:608`), so the locked-manifest path is not affected. Reconnect: `relinkLinkedAsset` only re-points the record, and the old link or folder stays (tested). |
| FR-728 (R503 g) | the listed resting states move to "in your library" when the source has a reachable original; nothing asked or fetched; once; locked judged at unlock; the view equals the usual way | **holds** | The included and excluded sets are reasoned and each is tested. The exclusions bite (mutation). Pick guarded twice, in the read and in the turn. Version checked in the turn. Not awaited before the queue answers (`inflight`, not awaited). A queue holds at most 500 entries, so the cost is ≤500 source reads at opening, off the first read. "Not this file": the held file was destroyed in that same change, and nothing re-offers it by itself. The one automatic path back to the copy part (R488 a's "none") cannot be reached by a source that rested here with a reachable original, because linked originals are never destroyed (`destroy.ts`) and an in-library entry with no file is left alone. Stand-ins: the same OpenAlex lookup and file dispatcher the runner uses with those settings. |
| FR-734 (2) (R503 i) | a late `true` after the row left ⇒ `closeLibraryWindow(ticket)` with that open's ticket; nothing else touched | **partly** (I1) | The close always carries a non-empty ticket (guarded by `ticket && address`). No ticketless close is added on this path (the tests assert every close is `[TICKET]`). A failure or "threw" answer leads to no close. A never-answering open goes through the existing gave-up path (R342 a), whose `shellWithin` timer is cleared when the answer comes or runs its course; nothing else is left. A lock (`gen++`) also counts as "left", and the window is closed. Single row re-keyed on a live screen: `live()` stays true, so the existing libTicket effect governs, unchanged. The browser build has no shell and returns early. Two rows: the service refuses a second start (busy). Route change: the window closes, as ruled. But see I1. |

## Could only judge by reading
- How the shell treats the ticketed close (the Rust side, R489). The page is tested against the fake shell only.
- M2 (a hung mount); real macOS permission folders (EPERM); Finder aliases.
- `stillWrong`'s new branch, covered by the reconnect tests' confirming turn for the folder kind (by reading, not mutated).
- Whether a closed event for the old project's ticket could be taken by a fresh page of another project that has exactly one waiting row (the pre-existing "held no ticket" rule). Rare; not probed.

## e2e coverage (brief item 5)
`grep -ln "Missing files\|linked" e2e/*.spec.ts` gives import, reader, reader-highlights, reader-search and zotero-sync. Only `reader.spec.ts` "a missing linked file says so" exercises what changed (the service's per-file `missing` flag, R480 e). It passes as it is. Its dangling-link variant shows M1. No scenario opens the sign-in window from a row in the browser build, as the report says.
