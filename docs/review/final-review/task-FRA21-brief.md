# Task FR-A21 — the import's progress tells the truth about the total (Ruling R392; found by the project's owner)

Worktree: `/home/user/AlexandrineOxiana/.claude/worktrees/fr-a21`, branch `fr-a21-import-total`. Report: `task-FRA21-report.md`. Common brief first: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-fix-common.md`. (This worktree has no Python environment for the media worker: tests that need one skip themselves.)

## What is wrong
The owner imported a Zotero library of several thousand items. The import's screen showed "97 of 98 items" with the progress bar almost full — the second number was always the first plus one.
Why: the bulk import engine (`packages/library/src/import/bulk/run.ts`, about :818–862) asks its source ("adapter") for a count before it starts (`adapter.count?.()`; the interface is in `bulk/scan.ts` about :207). Only the folder source (:371) and the ZIP source (:382) have a `count`. For every other source — Zotero from its local database, Zotero from the web, BibTeX, RIS, CSL-JSON and Zotero RDF files, a Calibre library, a device — the total is 0, and the engine then sends `total: Math.max(total, done + 1)` with each item (:855) and `Math.max(total, done)` after it. The screen (`packages/ui/src/screens/import/StepRun.tsx` about :140–144) shows whatever total it is sent: "x of x+1".

## What to build (Ruling R392 — read it: `grep -n -E "Ruling R392\b" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-4000`)
1. **The engine never invents a total.** When no total is known, its progress carries NO total (make `total` optional in the progress type and in what the service sends — find every reader of it: the service's events, the batch record `rec.total`, the screen, the command line's progress line `apps/cli/src/commands/import.ts`, the batch list's "x of y", the report) — never `done + 1`.
2. **A source says its total as soon as it knows it, without a second pass.** Keep `count()` for the sources that have it, and add to what the engine hands the scan (the context object with `workDir`, `note`, `skip`, … at about :833) one more callback, `total(n)`: a source calls it once, as soon as it knows how many items its scan will give; the engine then records it (`rec.total`) and sends it with every later progress event. Give a total:
   - **Zotero, local database** (`import/zotero-local.ts`): from a COUNT on its copy of the database with exactly the filters its scan uses (the chosen library; the kinds of item the scan yields; what it leaves out — deleted items, notes and attachments that are not items of their own — read the scan's own query and count the same rows), so that the number IS the number of items the scan will yield.
   - **Zotero, the web** (`import/zotero-web.ts`, about :674: it already reads the listing's `total-results` header): told from the first page's header. For a later sync that asks only for what changed since last time, the total is the number of changed items the service reports — say so in your report.
   - **Reference files** (BibTeX, RIS, CSL-JSON, Zotero RDF — `import/refman.ts` and its adapter): the number of records, told as soon as the file has been read (if the reader streams, tell it when known and say when that is).
   - **Calibre** (the books in its database) and **a device** (its listing), if their scans know the number up front; if one does not, leave it unknown and say so.
   - Items the scan yields more than once, or that are passed by because the batch already has them (a resume), count as done — the total stays the scan's total.
3. **A total that proves too small grows with the count** (never "x of y" with x above y); a resumed batch starts from the total it recorded and is corrected when the source tells a new one.
4. **The screen.** With a total: "97 of 3,412 items" and the bar with that maximum (as now). Without one: exactly "97 items so far" (singular "1 item so far"; before the first item, "Starting…" as now) and the bar WITHOUT a maximum (an open-ended bar), its accessible name unchanged. When a total arrives in the middle (Zotero web's first page), the screen changes to "x of y". The command line's progress line says the same two things in its own form. Any other place that shows a batch's "x of y" (the batch list, the report) follows the same rule — list them.
5. **The dry run agrees.** For the same source the dry run's number of items (`ScanSummary.items`) and the run's total are the same number, unless the source changed in between (a test per source that has a total).

## Tests first (each seen to fail first)
- Engine: a source with neither `count` nor `total()` → no progress event carries a total (the owner's case: assert it is never `done + 1`); a source that calls `total(5000)` after its first item → later events carry 5,000; more items than told → the total grows with the count; a resume keeps the recorded total.
- Zotero local, on the test databases the Zotero tests use: the total told equals the number of items the scan yields — for a personal library, for `#library=N`, with deleted items and child notes present.
- Zotero web, against the tests' stand-in for the service: the total equals the stand-in's listing total, told after the first page; a "changed since" sync tells the changed items' number.
- BibTeX, RIS, CSL-JSON, Zotero RDF: the total equals the records.
- The service: the progress events of a Zotero import carry the real total (one test through the service's event stream).
- The screen (`StepRun`): no total → "97 items so far", the `<progress>` element has no `max`; a total → "97 of 3,412 items" and `max` is 3412; a total arriving mid-run switches the text.
- The command line's progress line, both forms.
- End-to-end: if a spec imports from the Zotero stand-in (`grep -ln -i zotero e2e/*.spec.ts`), assert in it that the run's screen shows "of N items" with the stand-in's real N at some point (and never "of 2 items" when there are more); if the import ends too fast to see it, read the last progress event's total instead, or say why it cannot be asserted.

## Verify
The library's, the service's, the UI's and the command line's whole suites; `lint:css`, `lint:colours`, the UI build; the type-check; the end-to-end spec you touched (see the common brief).
