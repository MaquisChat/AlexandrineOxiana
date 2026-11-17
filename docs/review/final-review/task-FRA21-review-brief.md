# FR-A21 — review of the fix "the import's progress tells the truth" (R392)

Read the common brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-fix-review-common.md`. Then this. (This task does not come from the whole-branch review: its "finding" is the owner's own report, below; there is no earlier probe to re-run — write your own first.)

## The finding
The project's owner, importing a Zotero library of several thousand items with the built Mac app, saw "97 of 98 items" with the bar almost full. Cause: the import engine asked its source for a count, which only the folder and ZIP sources gave; for every other source the engine reported `done + 1` as the total.

**Ruling R392** (read it in full: `grep -n -E "Ruling R392\b" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-4000`): (a) the engine never invents a total — when none is known the progress carries none and the screen says "97 items so far" with an open-ended bar; (b) a source says its total as soon as it knows it, without a second pass over its items; a resumed batch keeps the total it recorded; (c) a total that proves too small grows, so x is never above y; (d) the dry run's number of items and the run's total agree for the same source.
**Ruling R423** (the coordinator's, on the implementer's one question; read it too): for Zotero WEB the total is NOT the first page's `total-results` header (that header counts attachments, notes, annotations and the bin: 7 where 3 items are imported) but the exact number of items the scan will yield, told once the listing is read and before the first item; during the listing the screen says "Starting…".

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/fr-a21`, branch `fr-a21-import-total`, base 7537f63, head 3f81153 (seven commits). Package: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/review-FRA21.diff` (849 lines; read it once, in full). Brief given to the implementer: `task-FRA21-brief.md`; its report: `task-FRA21-report.md` (same folder).

## Attack hardest
1. **Every source, every way a run can go.** Zotero local; Zotero web (a first import and a later "changed since" sync); BibTeX, RIS, CSL-JSON, Zotero RDF; Calibre; a device; a folder; a ZIP; a watched folder if it runs through the same engine. For each: is a total told, when, and does `done` END EQUAL to it for a batch that completes? Find a source where the count and the yield use different filters (an item counted and never yielded, or yielded and not counted: capped rows, child items, deleted or binned items, an empty record, an unreadable file, a key yielded twice, a "gone" item).
2. **Pause, resume, crash, cancel.** A batch paused and resumed; a service restarted in the middle (the batch resumes from its record: `rec.total`); a cancel; a batch that ends failed part-way. Is x ever above y, does the total ever go DOWN in front of the researcher in a way that reads as a fault, is a stale total of an earlier run shown?
3. **The moved code in `zotero-web.ts`.** The block that decides which known items are gone (binned or deleted at the source) moved from after the scan's loop to before it, so they can be counted. Is its behaviour exactly as before — on a first import, a re-sync, a resume, a lossy listing (`api.lossy`), a listing cut short by an error? Could an item now be marked gone that was not, or the reverse? (A wrong "gone" changes the researcher's library.)
4. **`total` is now optional** (`BatchProgress.total?`, the `import.progress` event, `rec.total`). Every reader: the service's event, the shared types, the import wizard, the Zotero sync screens (`cur.total = p.total ?? 0`), the command line, the batch list, the report, anything that does arithmetic with it (a NaN or "undefined" on a screen, a percentage, a division by zero with total 0).
5. **The engine's counting.** `seenKeys` → `done++` for a key yielded twice; `progress()` grows the total; `if (counted) total = counted` (a count of 0); `total(n)` called late, twice, with a huge, negative, fractional or NaN value.
6. **The screen.** The open-ended `<progress>` (no value, no max): its accessible name and what a screen reader hears; the status text ("1 item so far", "97 items so far", "97 of 3,412 items", "Starting…", "Paused."); a total arriving after items; a total of 0.
7. **No second pass (R392 b).** Does any source now read its items twice, stat every file twice, or make extra requests to a service, to learn its total? Zotero local with 20,000 items: time and memory of the count.
8. **R392 d.** The dry run's number against the run's total, per source. (Known and deferred by the implementer — say whether each is rightly Minor: a Zotero web re-sync with deletions counts the gone items in the run and not in the dry run; a scan that ends in a failure item part-way leaves the told total above `done`; `<progress max=0>`.)

## Rules for you
Probes next to the code, named `*.probeFRA21.test.ts` (or `.tsx`), run alone at `nice -n 10`; every one deleted before you finish; `git status --short` empty at the end; no commits, no `git stash` (one list shared by every worktree), no installs, no whole suites, no end-to-end runs. The machine is heavily loaded: a time-limit failure is re-run alone before you believe it and is not a finding in an untouched timing test.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-FRA21-review.md`, as the common brief says. Final message of at most 150 words.
