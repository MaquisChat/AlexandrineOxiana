# FR-A21 review: "the import's progress tells the truth" (R392, R423)

Reviewer: a fresh, adversarial reviewer. Worktree `.claude/worktrees/fr-a21`, branch `fr-a21-import-total`, head 3f81153, base 7537f63.

## Verdict: APPROVED WITH SMALL POINTS (one Important point needs the coordinator's ruling)

The owner's finding is closed. No source gets "done + 1" any more. Every source that used to get a made-up total now tells its real one before its first item: Zotero local, Zotero web (first import and sync), BibTeX, RIS, CSL-JSON, Zotero RDF, Calibre and a device. Folder and ZIP still use their `count()`. For a batch that completes, `done` ends equal to the total on every path I traced. The moved "gone" block in `zotero-web.ts` behaves exactly as before.

What remains: one Important finding (I1). A **resumed Zotero Web batch** drops its recorded total to "the part left", and rewrites `batch.json` with that smaller number. This does not meet R392 b ("a resumed batch keeps the total it recorded"). It is not a regression, because before the fix the total was `done + 1`. It needs a ruling on what "x of y" means for a resumed batch. There are also seven Minor points.

## What I ran (all at `nice -n 10`, each file alone; load average 20–27)
- **Probe** `packages/library/src/import/bulk/web-resume.probeFRA21.test.ts` (now deleted), against the FakeZotero stand-in through the real engine:
  - A first full Web import of 6 items, cancelled at done 3, then resumed with `resumeZoteroWebImport`.
  - The engine's `total()` given 2.5, NaN and −1.
- **Probe** `apps/cli/src/commands/import.probeFRA21.test.ts` (now deleted): what a TTY shows after the CLI's `\r` overwrites.
- `zotero-web.test.ts`, the whole file: **92 passed**.
- `bulk.test.ts`, `zotero-local.test.ts`, `refman.test.ts`, `device.test.ts` with `-t "FR-A21|Zotero Web batches resumed|gone"`: **28 passed**.
- `ImportWizard.test.tsx -t "FR-A21|progress follows"`: 2 passed. `apps/cli/src/commands/import.test.ts`: 2 passed.
- I tried to take guards out of `run.ts` temporarily, with `sed` and then `git checkout`. The session's permission classifier refused, so nothing was modified. See "Could not verify".
- At the end, `git status --short` in the worktree is empty.

## Findings

### Critical
None.

### Important

**I1 — A resumed Zotero Web batch lowers its total to the items left, and overwrites the recorded total** (`packages/library/src/import/zotero-web.ts:1048-1054` with `bulk/run.ts:827-838`)

What happens:
- The web scan leaves out of `told` every item the engine passes by: `skip(\`zotero:${it.key}\`)` is true for every item already in the batch's journal.
- It also does not yield those items, so the engine's `done` restarts at 0 for this part.
- The engine first emits `rec.total`, the whole batch. The scan then tells the remainder, and `progress()` writes that into `this.rec.total`, which is saved at the next checkpoint.

Probe output (6 items, cancelled at 3, resumed):
```
PROBE first   [[0,null],[0,6],[0,6],[1,6],[1,6],[2,6],[2,6],[3,6]]  rec1.total 6
PROBE resumed [[0,6],[0,3],[0,3],[1,3],[1,3],[2,3],[2,3],[3,3]]     rec2.total 3   state finished  items 6
```

What the researcher sees: the screen showed "3 of 6". After a restart the resumed batch reads "0 of 6", then "0 of 3". The bar jumps from half-full to empty, which reads as lost progress. The finished batch's `batch.json` then says `total: 3` for a batch of 6 items.

Scope:
- Every other source re-yields its journaled items, so `done` climbs back through them and the total holds. Zotero local, the reference files, Calibre and a device all do this; folder and ZIP use `count()`.
- Zotero Web is the source most likely to be resumed: thousands of items, hours of downloads.
- The FR-A21 resume test (`bulk.test.ts`, "a resumed batch starts from the total it recorded…") uses a synthetic adapter that ignores `skip`, so it does not cover this.

Direction, which needs a ruling on the meaning:
- **(a) "x of y" counts the whole batch.** The web scan includes the skipped tops (and skipped gone keys) in `told`, and the engine counts each journaled key the adapter passed by as done. This needs the engine to learn them without a yield, for example through `latest.size` at the start. Alternatively, the engine never lowers `rec.total` below what it had recorded plus what is left.
- **(b) "x of y" counts this part only.** Then R392 b's wording needs amending, and `rec.total` should not be overwritten. Keep the part's total apart from the batch's total.

Add a test through `resumeZoteroWebImport` either way.

### Minor

**M1 — The CLI line leaves stray characters when it gets shorter** (`apps/cli/src/commands/import.ts:161`)

The first event of a run carries no total, so the CLI writes "Imported 0 so far" (17 characters). The next line, "Imported 0 of 5" (15 characters), is written over it with `\r` and nothing clears the rest of the line. Probe output:
```
"Imported 0 so far" → "Imported 0 of 5ar" → "Imported 1 of 5ar" → "Imported 5 of 5ar"
```
This happens on every first run of a source with a total under 100. It also happens whenever a total shrinks: a Calibre or reference file passing an empty record by, or I1's "of 1000" becoming "of 999".

Before the fix the line was always "Imported x of y|?", so its length barely changed. Direction: clear to the end of the line (`\x1b[K`), or pad to the last line's length.

**M2 — The total guard is not held by any test** (`bulk/run.ts:302`)

The guard is `if (!Number.isSafeInteger(n) || n < 0) return;`. No test calls `total()` with a bad value. My probe showed the guard works: for 2.5, NaN and −1, every event's total stayed `undefined`. Direction: add those three cases to the FR-A21 describe.

**M3 — `startAndRun`'s doc comment now sits on the wrong function** (`apps/cli/src/commands/import.ts:127-135`)

The new `importProgressLine` and its own JSDoc were inserted between `startAndRun`'s JSDoc and `startAndRun`. That leaves two stacked doc blocks on `importProgressLine` and none on `startAndRun`. Direction: move the new function above the old comment.

**M4 — A ZIP with no importable entry is counted as one item** (`bulk/scan.ts:331-345`, `zipEntryCount` → `Math.max(1, n)`)

A ZIP with no importable entry yields nothing, but counts 1. A folder holding one ends with done one below its total, so the bar never fills. Its dry run says 0, which breaks R392 d. This code is older than the task and the task did not touch it, but R392 c/d ask that the run's total and the dry run agree "for the same source". Direction: count 1 only when the archive cannot be read (the scan then yields one unreadable item); count 0 for a readable archive with no entries.

**M5 — The sync screens say "not known yet" when the total is known to be zero** (`apps/library-service/src/routes/zotero-sync.ts:220`, `packages/ui/src/screens/zoteroWords.tsx:39`)

`cur.total = p.total ?? 0` maps both "not known yet" and a told total of 0 to 0. A sync with nothing changed is told 0, and its screen then says "the number of items is not known yet" although it is known. This is brief and harmless. Direction: keep `undefined` apart from 0 in the sync's shape.

**M6 — A test comment contradicts R423** (`packages/ui/src/screens/import/ImportWizard.test.tsx:821`)

The comment says "The source tells its total (Zotero web's first page)". Under R423 the web total is not the first page's header. Direction: reword the comment.

**M7 — The web dry run counts title-less standalone attachments that the run passes by** (`zotero-web.ts:1177`)

The dry run counts title-less, file-less standalone attachments because of the `!(isAtt && ctx.dryRun)` condition. The run passes the same items by and lowers its total. A non-PDF `linked_url` standalone attachment without a title gives dry run N against a final total of N−1. This is rare: Zotero attachments normally have a title. It sits next to the deferred R392 d gap.

### The implementer's deferred points

- **(1) A Web re-sync with deletions:** the dry run leaves the gone items out of its count; the run counts them. Rightly Minor. The total is still true for the run itself (the gone items are processed and counted), and the dry run's number is about what will be imported.
- **(2) A scan that ends in a failure item part-way leaves the told total above `done`.** Rightly Minor. The batch ends and the run screen hands over to the report at once, so "x of y" with x below y is never left in front of the researcher. The CLI's last line keeps it until the summary is printed.
- **(3) `<progress max=0>`:** less than described. With a total of 0, `done` is 0 (the grow rule keeps total ≥ done), so the browser reads value 0 of a default maximum of 1: an empty bar, not a full one. The text "0 of 0 items" is true. Barely a point.

## Checked and sound

- **The moved "gone" block in `zotero-web.ts` (1013-1043) behaves exactly as before:**
  - `api.lossy` is set only inside `pages()` (671-687) and `tagColorsOf()` (866). Both run during the listing, before the block's old position and its new one. Nothing in the item loop (`api.file`, `checkFiles`) sets it, so the full-run branch makes the same decision.
  - Its inputs (`tree`, `knownHere`, `deletedKeys`, `keyList`, `keyListAsked`) are all fixed once the listing ends.
  - `skip()` reads the engine's `latest`, which grows during the loop only with keys the loop yields. Those keys are in `tree.byKey`. The gone keys are binned (`tree.trashed`, which is disjoint from `byKey`) or are deleted or unseen keys for which `tree.has(k)` is false. So filtering the gone keys before the loop gives the same set as filtering them after.
  - On a mid-loop failure, the function still returns before the notes and `result.completed`, as before. The only new effect is a possible `api.lossy = true` on that path, and nothing reads it there.
  - First import: `knownHere` is empty, so nothing is gone. Re-sync, resume, lossy listing, cut-short listing: all traced the same as before.
  - The whole web test file passes (92/92), including every gone, bin, A5–A7 and C1 test.
- **The Zotero local refactor (`ownItem`)** is the old filter, in the old order. The standalone-notes count is unchanged. The total is a pass over the in-memory snapshot the scan already holds: O(n) with no I/O, trivial for 20,000 items.
- **Counting against yielding, per source:**
  - Zotero web: `told` uses the loop's filters exactly (child, `tops`, `skip`, note or annotation) plus the gone keys. An empty item lowers it.
  - Reference files: the parsed records; an empty record lowers the count; an unreadable file tells 1 for its one unreadable item.
  - Calibre: the books read from the copy; a book passed by lowers the count.
  - Device: groups plus copies, each yielded once with distinct keys.
  - A key yielded twice is counted as done in the run and twice in the dry run, so the two agree.
- **No second pass (R392 b)** for any source the task changed. Each total comes from data the scan already holds: the snapshot, the listing already read, the parsed file, the database copy, the device's existing passes.
- **`total` optional, every reader:**
  - The service's `import.progress` leaves the field out when the total is unknown (`state.ts:944`), and the UI type has `total?`.
  - StepRun only sets the total when it is a number. It never does arithmetic with it: there is no percentage and no division.
  - The zotero-sync route's publish passes `total: undefined`, which JSON drops. The UI reads `e.total ?? 0`.
  - The CLI and the open-ended bar handle both cases.
  - The batch list, jobs and report do not show the total.
- **The screen:** "Starting…", then "1 item so far", then "97 items so far", then "97 of 3,412 items". The label's accessible name "Import progress" is kept. The bar is indeterminate when there is no total.
- **Engine edge cases:**
  - A source that tells nothing gets no total: verified by the existing test, and in my probe the first event is `[0,null]`.
  - A total that is too small grows.
  - A total told late takes effect at once, through the immediate emit.
  - A pause in the same process keeps the same `Run`, so the total is kept.
  - A resume starts from `rec.total`.
- **The tests hold their guards (by reasoning, see below).** Without `total < done → total = done`, the "more items than told" test would end `{done:4,total:2}`. Without the `done++` on a key yielded twice, it would end `{done:2,total:3}`. Both assert `toEqual` on the last event.

## Could not verify
- **Removing the guards and watching tests fail.** The session's permission classifier refused the temporary edit to tracked files. The verdict on which test holds which guard is by reading only.
- **A real Zotero Web library of thousands of items:** how long "Starting…" lasts during the listing.
- **How WebKit/Tauri renders the indeterminate `<progress>`**, and what VoiceOver says for it.
- **The e2e assertion** (`e2e/import.spec.ts`, `rec.total === 5`): not run, since end-to-end runs are forbidden for me. It reads `batch.json` as plain JSON, which is right for that unencrypted project.
