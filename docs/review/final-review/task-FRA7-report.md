# Task FR-A7 — report

Base: `git reset --hard claude/pdf-reader-highlights` (74f275c). Disk: 13 GB free.
Branch: `worktree-agent-a45f6da14291d4e55`. Commit: see the final message (point 1 is one commit).

## Point 1 (R362 g, FR-127) — DONE

### The rule (one rule, shared: `packages/library/src/import/bib-blocks.ts`)
A BibTeX block (`@type{…}` / `@type(…)`: an entry, @string, @comment, @preamble) ends at its OWN closing delimiter.

- `{` blocks: braces are counted (a backslash escapes the next character, never a line break — the same count the
  export reader's value parser keeps). The block is closed by the brace that brings the count back to zero,
  wherever it is. Every line inside it — "@someuser replied…", "@article{smith2020, …}" — is part of it.
- `(` blocks: closed by their own `)` (the export reader's field parser decides; the sidecar's skip blocks count
  parentheses), looked for only up to the next line that begins an entry.
- **Recovery, only for a block that would otherwise run unclosed:** it is cut at the first line after its opening
  that *begins an entry* — optional spaces/tabs, "@", one or more letters, optional white space, then "{" or "(".
  With no such line it runs to the end of the text. A line such as "@someuser replied" begins no entry and never
  cuts anything (before, ANY line-start "@" cut).

Cases, kept whole (no cut):
- "@someuser replied to the thread" on its own line in a braced or a quoted value, entry closed after it → no doubt.
- "@article{smith2020, title={X}}" pasted on its own line in a balanced value → kept whole, NOT split into a
  record; this record carries the doubt `innerEntry` (see "needs a ruling" below).
- an @comment holding commented-out entries, closed after them → stays a comment (before, the inner entries were imported).

Cases, cut (recovery):
- an entry missing its closing brace (or with a value missing one), followed by another entry → cut at that
  entry's "@type{" line, doubt `cut`; every field before the cut is kept (also those after an "@someuser" line,
  which before were lost); the next entry is whole.
- an entry unclosed at the end of the file → runs to the end, doubt `eof`.
- unbalanced @comment / @string / @preamble → cut at the next entry line (no record, no doubt) — the existing
  malformed-file tests (refman.test.ts "recovers after an unterminated entry…", "BibTeX recovery copes with a
  backslash…/lone CR"; sidecar.test.ts R57 M2 / R58) are untouched and green.
- known limit: a `(` entry is still cut at a pasted "@type{" line inside it (its close is the parser's, bounded
  there); `(` entries are rare (old exports).

Linear: one forward brace scan shared by all queries (queries come in increasing order) and one memoised search for
entry lines. At most 5 × MAX_EXPORT_RECORDS (1,000,000) blocks are held open or closed ahead of the reader at
once; past that the export is unreadable with the existing "too many references" sentence (memory bounded on a
hostile file). Probed: 8 MB of "@a{k, t={\n" lines 1.6 s / 68 MB heap; 1 unclosed + 400k closed 1.3 s / 96 MB;
1.1M open heads → too-many in 0.1 s.

### Where a cut is said to the researcher
The doubt is an import doubt in the existing sense: a reason on the item's review-queue entry
(`Resolution.verification.reasons`, overall `needs-review` → `reviewFor` queues the item). Plumbing:
`BibEntry.doubt` → `ScanItem.doubts` (new, optional; `bulk/scan.ts`) → `ResolveInput.doubts` (new; `bulk/run.ts`
passes it) → `resolveItem` adds each to the report's reasons and sets it to needs-review. The sidecar's
`SidecarMetadata.doubt` is added the same way when that sidecar is the one used (`resolve.ts` step 4) — so drag
and drop / attach and watched folders get it too.
Shown on: the **Review queue** screen, import entry, section "Why it needs review" (lists every reason through
`UserText`; `ReviewQueue.tsx` ~:1174) — no screen change was needed; and the import report counts it under
"Waiting for review" / "Still waiting for review", `pendingReview[].reasons` in report.json.
Words, exactly (`BIB_DOUBTS`):
- cut: `The BibTeX entry was not closed, so it was cut at a line beginning with "@"; some of its fields may be incomplete.`
- eof: `The BibTeX entry was not closed before the end of the file; some of its fields may be incomplete.`
- innerEntry: `A line inside one of this BibTeX entry's fields begins like another entry ("@type{"); it was read as part of the field. If a closing brace is missing in the file, other entries may be inside this one.`

### Tests (each run before the code; result then)
refman.test.ts, new describe "R362 g: a line beginning with @ inside a field's value":
1. braces, "@someuser" lines in title and abstract, later keywords/doi/url/file kept, no doubt — FAILED first (title cut).
2. quotes, same — FAILED first (title cut).
3. pasted "@article{smith2020,…}" in a balanced abstract → 2 entries not 3, later fields kept, innerEntry doubt — FAILED first (split into 3).
4. truly unclosed + next entry → "a" keeps `year` after an "@someuser" line, doubt cut; "b" whole — FAILED first (year lost).
5. unclosed last entry → runs to end, doubt eof — FAILED first (no doubt).
6. real-looking 50-entry file, three abstracts with two "@user" lines each → 50 records, each with title, 2 creators,
   year, journal, doi, url, 2 tags, pages, no doubt — FAILED first (doi missing on entry 17).
7. linearity: 1 MB of "@someuser" lines in one value, 1 MB of pasted entries in one value, 1 MB of unclosed entries, each < 1 s — PASSED first (guard).
8. (bulk engine) a cut record waits in the review queue with the cut doubt as reason, the whole one does not — FAILED first (no entry with it).
sidecar.test.ts, describe "R362 g … (the same rule as the export reader)":
9. braces and quotes "@someuser" → later doi/year kept, no doubt — PASSED first (the sidecar's entry parser never cut at "@"; kept as a guard).
10. pasted citation → kept, innerEntry doubt — FAILED first (no doubt).
11. unclosed + next entry → cut, the next entry's doi NOT taken into it, doubt cut; unclosed at end → doubt eof — FAILED first
    (the sidecar took the next entry's `doi` as a field of the first: a real defect of the sidecar).
12. a sidecar's doubt reaches `resolveItem`: needs-review with the reason — FAILED first.

## Point 2 (FR-410) — STOPPED (nothing changed in project-export.ts)

The export cannot tell verified from unverified evidence at that point:
- `project-export.ts` has no verification step for destruction evidence; it only sees `asset.status === "destroyed"`
  (the schema's only value) and counts it.
- The restore (`repo/restore.ts` ~:645–673) knows per asset (`left[].unverified`) but persists it nowhere: the asset
  gets `status: "destroyed"` + `destroyedAt`; the copy's audit log gets only COUNTS in `project.restored`
  (`leftOutDestroyed`, `leftOutUnverified`, `destructionsNotVerified`), not which assets; the per-asset flag is only
  in the restore's answer (`RestoreResult.leftOut`), which nothing stores.
- Re-deriving it at export time does not work: the copy's assets have fresh ids (the inherited log names the old
  ones), the evidence lives in another project's log/certificates (which may since be gone), and the counts cannot
  be attributed to the files of the sources actually exported (withheld sources, a copy of a copy).
What would be needed (one of):
(a) the restore records per asset what the exclusion rests on — e.g. the copy's asset ids left out on unverified
    records in the `project.restored` event (`leftOutUnverifiedAssets: [ids]`, ids only, no paths) — and the export
    reads its project's audit log through `verifiedAuditEvents` (retention.ts) and states destruction as fact only
    for a destroyed asset not so named while the log verifies; otherwise the given sentence. Touches
    `repo/restore.ts` (outside this task's files) and the export.
(b) a field on the asset (`destroyedOn: "unverified-record"`): a `@ao/core` schema change.
Either way the counting in notes.txt would split into the two sentences (the fact one and
"The project's log says this file was destroyed under its retention rule; that entry could not be verified.").

## Runs (all at nice -n 10, foreground)
- `vitest run src/import/sidecar.test.ts src/import/refman.test.ts`: `Test Files  2 passed (2)` / `Tests  118 passed (118)`.
- `pnpm --filter @ao/library test` (once): `Tests  1 failed | 3575 passed | 22 skipped (3598)` — the one failure in
  `src/find/runner.test.ts` (F11 / R326 wakeSettings "the copy part: settings that still stop it…", a file not
  touched), re-run alone: `Test Files  1 passed (1)` / `Tests  284 passed (284)` (timing under load).
- `pnpm -r typecheck`: exit 0, no errors (last line `apps/browser-extension typecheck: Done`).
- e2e not run: no screen changed (the Review queue already lists every reason of an import entry).

Files changed: `packages/library/src/import/bib-blocks.ts` (new), `refman.ts` (parser :501ff, BibEntry.doubt,
recordItem/bibtexAdapter pass doubts), `sidecar.ts` (blockEnd replaced by the shared rule, entry bounded,
SidecarMetadata.doubt), `resolve.ts` (ResolveInput.doubts, sidecar doubt, reasons + needs-review),
`bulk/scan.ts` (ScanItem.doubts), `bulk/run.ts` (passes doubts), and the two test files. No route, file format or
shared (`packages/shared`) type changed. No dependency added.

## Needs the coordinator's ruling
- innerEntry doubt: a record that closed properly around a line beginning an entry (a pasted citation) is kept
  whole AND carries a doubt, because the same shape arises when a file lost one closing brace and has an extra one
  later (then whole entries are inside it — what BibTeX itself would also do). Drop it if the review queue should
  not see pasted citations (one line in bib-blocks.ts `bibDoubt`).
- Point 2: (a) or (b) above, and whether it may touch restore.ts.

minor (deferred): a cut record merged into an existing source (duplicates: "merge") does not go through review; its doubt is not shown then.
minor (deferred): `(` entries are still cut at a pasted "@type{" line inside them.

## Round 2 (R366)

Worktree `agent-a45f6da14291d4e55`, branch `worktree-agent-a45f6da14291d4e55`, from bd99a97 to d09e907 (9 commits, one or more per point). Files: `import/bib-blocks.ts`, `refman.ts`, `sidecar.ts` (doc comment only), `bulk/run.ts`, `refman.test.ts`, `sidecar.test.ts`. `resolve.ts`, `scan.ts`, `attach.ts` unchanged (attach cannot merge, see b). No dependency, route, file format or shared type changed. Old tests: no test body changed except round 1's own linear test (h); `git diff bd99a97 -- '*.test.ts'` removes only those 4 lines.

### Per point (the test first; each failed first unless said)
- **(f) M3** — `bib-blocks.ts:29-30` new words. Test `refman.test.ts` "R366 f" (quotes the words) — failed first. Commit 157bf07.
- **(c) I3** — `bib-blocks.ts:60-87` `beginsBlockLine`/`blockLineOpen`: the strict form. Tests: refman "R366 c" (8 cases: "@jdoe (2021) wrote back" and "@jdoe {at} the meeting" in braces, quotes, a `(` entry with a braced and with a quoted value — no doubt, no cut, all fields, no spurious record, parser and adapter) — all 8 failed first (third doubt, or the `(` entry cut with a spurious record `2021` / `at`); "'@article { smith2020 ,' still begins an entry; @comment{ and @string{x = lines end an unclosed one" — passed first (guard); sidecar "R366 c" — failed first. Commit 4f94860.
- **(a) I1 + (d) I4** — `bib-blocks.ts:153-284` a new scanner (`Scanner`): every block is judged at its own level (absolute brace depth, compared to the block's base); a block line at an entry's/@string's own level outside a quoted value cuts it (`blockLine`, :204); quotes at that level are tracked; `(` blocks count parentheses only at their level outside values (:252-262). `refman.ts:546,651` now takes every block's extent and state from `block()` for both delimiters. Tests: refman "R366 a" (50-entry file with e10 missing its brace and e40 ending "}}" → 50 entries, only e10 with the cut doubt, each record its own title/year/DOI — failed first: 20 entries; `missingThenExtra` → a, b, c, b's DOI on b — failed first; pasted citation in a braced or quoted abstract → whole, third doubt — passed first, guard); bulk engine "R366 a: the 50-entry file … imports 50 records" (50 sources; e10's source has DOI 10.5555/e.10 and waits with the cut doubt); sidecar "R366 a" (failed first: b's DOI on a); "R366 d" refman (passed first: the export reader was not affected, guard) and sidecar (failed first: title only). One commit for (a)+(d) (0354470): the same scanner change does both.
  **The stray "}" after e40**: e40 closes at its first "}"; the second is text between entries that is ignored (no block, no record); e41 is read whole. Under (e) a "}" after a close is allowed, so e40 carries no doubt (the 50-entry test asserts no doubt on any entry but e10).
- **(g) M5** — a block resolved inside another open block is not kept (`finish`, :196), and only the block asked for and blocks opened by a block line are tracked at all (:242, :252) — never one opened mid-line inside a value (`a@b{c}`, `x@c(`); the reader asks for such a block only when an outer one never closed, and then `block()` scans it on its own (:330), bounded by its extent; the scans' total work on one text is bounded (8 × length + 64 M steps, :295) — past it, `TooManyBibBlocks` (= "too many references", a hostile file only). Tests: "a one-entry file with over a million 'a@b{c}' inside a note is read" — failed first ("too many references"); the same with 2.1 M `x@c(` (added after my own probe found that a first version of the scanner tracked them). Commits 13fe965, 5de515a.
- **(e) M1** — `bib-blocks.ts:95-106` `textAfter` (after a closed `{` block, up to the next "@": anything but white space, "}" or a `%` comment to the end of its line), applied in `block()` (:332); doubt `BIB_DOUBTS.textAfter` (:31). Tests: refman "R366 e" (`title="a } c", doi=…, year=…}` → the doubt, parser and adapter — failed first; `%` lines, blank lines, an extra "}", a trailing `% comment` → none, and the sample export's 4 items carry none — passed); sidecar "R366 e" — failed first. Commit 3da7fc1.
- **(b) I2** — `bulk/run.ts:536` `BIB_DOUBT_SET`, `:1262` `Run.doubted(r)` (a resolution whose reasons hold any BibTeX doubt — the export's or a sidecar's), `:1313` under "merge" a doubted record with a certain duplicate is CREATED with `reviewFor(r, dup, …)` (the existing "likely duplicate" reason and `duplicateOf`), `:1512` the recheck in a later store turn does not merge it (stored as planned). Tests (bulk engine, "R366 b"): the review's probe under `merge`, under the default options (the engine's and the command line's default is merge) — both failed first (`merged: 1`); under `keep-both` — passed first (guard): existing source deep-equal before/after (source and assets), 3 sources, a new "Clean X" waiting with the cut doubt (and the likely-duplicate reason for merge), counts `items 2, merged 0, duplicates 0, failed 0, created+needsReview 2`; `skip` → `duplicates 1`, source untouched; a clean record with the same DOI is still merged. Commit e2614e1.
- **(h) M6** — bulk "R366 h: a COMPLETE record (title, creators, year) with a doubt waits for review; the same record whole does not": with `resolve.ts:543` (`if (doubts.length) report.overall = "needs-review"`) removed it FAILS (seen: `expected [] to deeply equal ['A Broken Record']`). Bound on tracked blocks: "a file nesting more unclosed entries than any export can hold is refused" — with `new BibBlocks(src)` in refman (bound removed) it FAILS (seen). Linear test: 1000 ms → 5000 ms, with two more shapes (nested unclosed entries; one unclosed entry around 52 k closed ones); older parsers' tests untouched. Commits e2614e1, 164da24.

### The rule now (bib-blocks.ts; both readers)
A block's own level = between its fields, inside no braced value, and (entry or @string) no quoted value. A "block line" = a line whose first non-space/tab is "@", type letters, white space, "{" or "(", white space, a key (no white space, brace, parenthesis, quote, "=", ","), white space, "," — or `@string{name =`, `@comment{`, `@preamble{` (also with "(").

| What happens | Where it ends | Doubt on the record |
|---|---|---|
| `{` block: brace count returns below its level | just past that "}" | none, unless one of the next two rows |
| …closed, and text other than white space / "}" / `%` comment follows before the next "@" | same | textAfter |
| …closed, with a block line inside a value (or inside a quoted value at its level) | same | innerEntry (third) |
| `(` block: its ")" at its level outside values | just past it | none / innerEntry as above (no textAfter) |
| a block line at an entry's/@string's own level (outside quotes) | cut at that line's "@" | cut |
| never closes (end of text reached) | the first block line after its opening, at any depth | cut |
| never closes, no block line after it | end of text | eof |
| `(` block left by a "}" below its level | as "never closes" | cut / eof |
| @comment / @preamble | own delimiter; not cut by a block line at its level (commented-out entries stay comments); unclosed → first block line after it | no record |
| unclosed @string / @comment / @preamble before an entry | the first block line after its opening (so `@book{fine,…` after `@comment{never closed` is read, as before) | — |
Precedence when several apply: cut, eof, textAfter, innerEntry (one doubt per record).

Words (`BIB_DOUBTS`):
- cut: `The BibTeX entry was not closed, so it was cut at a line beginning with "@"; its fields may be incomplete or hold text from what followed it.`
- eof: `The BibTeX entry was not closed before the end of the file; its fields may be incomplete or hold text from what followed it.`
- textAfter: `There is text after this BibTeX entry's closing brace that belongs to no entry; some of the entry's fields may be incomplete.`
- innerEntry: `A line inside one of this BibTeX entry's fields begins like another entry ("@type{"); it was read as part of the field. If a closing brace is missing in the file, other entries may be inside this one.`

### (b) Where a doubted record can and cannot go
- Cannot: merged by an import run (`importItem`, the recheck in `flushInner`) under any way with duplicates; attach / drag-and-drop / watched folders never merge (a certain duplicate is `duplicate`, nothing written; a drop on a source adds the file only, its sidecar is not read); Zotero's incremental update path does not read BibTeX or sidecars.
- Resume: items not yet in the batch's journal go through `importItem` again, so a batch planned before this change follows the new rule on resume; a merge already journaled (done before this change) stays done.
- Undo: removes the created record with its review entry; a merge done earlier is restored from its snapshot — undo never writes a doubted record's fields into a source. There is no redo.
- Can, only by the researcher: the review entry's "Merge" decision (`bulk/review.ts`, `{ action: "merge", sourceId }`) on the doubted record's entry, which shows the doubt and the likely duplicate.

### Probes (point 4 of the review; parser alone, Node, loaded machine, `nice -n 10`)
Reviewer's three, re-run: 1 M unclosed heads nested in values (9.5 MB) → refused "too many references" in 0.57 s, heap +112 MB (reviewer: 0.09 s / ~44 MB for its shape; this shape needs 1 M nested opens before the bound); 365 k entry lines in one value (8 MB) → 1 entry, 0.33 s, +9 MB (0.23 s); unclosed + 450 k closed (6.9 MB) → 450,001 entries, 1.1 s, +67 MB (0.84 s); also 2 M mid-line `@c(` (7.6 MB) → 1 entry, 0.13 s (0.45 s); 50 MB single value 0.78 s, +50 MB (0.9 s); 335k-style `(` entries with pasted lines (8.6 MB) 0.62 s (0.56 s); 700 k `@comment(a)` 0.41 s (0.23 s); `{}{}` alternations 7 MB 0.28 s (0.5 s); 1 M cut chain (each head between the previous one's fields, 5.7 MB) → 1 M entries 0.75 s; 1.1 M `a@b{c}` in one note → 1 entry 0.21 s. Sidecar on each ≤ 1.1 s. Hostile shapes needing more than the work bound (an unclosed value holding 50 k mid-line `x@c( {` … blocks) → refused in 1.5 s.

### Runs (all `nice -n 10`, foreground)
- `pnpm --filter @ao/library exec vitest run src/import/refman.test.ts src/import/sidecar.test.ts`: `Tests  147 passed (147)`.
- `pnpm --filter @ao/library test` (once): `Test Files  1 failed | 102 passed | 1 skipped (104)` / `Tests  1 failed | 3604 passed | 22 skipped (3627)` — the failure `src/index/annotations-cap.test.ts` "CJK, encrypted (in memory): memory and time per write" (1003.8 ms vs 1000, a file not touched); re-run alone: `Tests  6 passed (6)`. Disk 8.5 GB free.
- `pnpm --filter @ao/cli test`: `Tests  59 passed | 15 skipped (74)`.
- `pnpm -r typecheck`: exit 0, 0 errors (`apps/browser-extension typecheck: Done`).
- `pnpm e2e -- --app-only e2e/import.spec.ts --trace off`: `6 passed (1.8m)` (chromium and webkit); no expectation changed. (The script installed the worker's venv in the worktree; ignored by git.)

minor (deferred): a missing brace made up later inside the same entry, or with the next entry on the same line, still merges silently; an `@string` macro holding a pasted entry line carries no doubt (both accepted by R366 i).
minor (deferred): an unclosed @comment followed by entries and a later stray "}" still swallows those entries into the comment (a comment holding entries cannot be told from one that lost its brace); a key-less entry line (`@article{, …`) does not count as a block line, so it does not cut an unclosed entry before it.
minor (deferred): a `(` opener inside a quoted value at an entry's own level is not tracked (its quotes would be the value's); it is judged on its own scan if the reader asks for it.

## Round 3 (R374)

### Point 1: new function (bib-blocks.ts)
```ts
/** A character of a field name after its first letter. */
function isNameChar(c: string | undefined): boolean {
  return c !== undefined && (isLetter(c) || (c >= "0" && c <= "9") || c === "_" || c === ":" || c === "." || c === "+" || c === "-");
}

/** Whether `src[a, e)` (one stretch of a line, outside any `%` comment) looks like the remains of an entry's fields (R374 b). */
function looksLikeFields(src: string, a: number, e: number): boolean {
  let s = a;
  while (s < e && isSpace(src[s])) s++;
  let t = e;
  while (t > s && isSpace(src[t - 1])) t--;
  if (t === s) return false;
  // (ii) ends with ","
  if (src[t - 1] === ",") return true;
  // (iii) ends with "}" after other text on the line
  if (src[t - 1] === "}") {
    for (let k = s; k < t; k++) if (src[k] !== "}" && !isSpace(src[k])) return true;
  }
  // (i) a field assignment: a name, optional white space, "=", optional white space, then "{", a quote, a letter or a digit
  for (let k = s; k < t; k++) {
    if (src[k] !== "=") continue;
    let j = k + 1;
    while (j < t && isSpace(src[j])) j++;
    const v = src[j];
    if (j >= t || !(v === "{" || v === '"' || isLetter(v) || (v! >= "0" && v! <= "9"))) continue;
    j = k - 1;
    while (j >= s && isSpace(src[j])) j--;
    let letter = false;
    while (j >= s && isNameChar(src[j])) {
      if (isLetter(src[j])) letter = true;
      j--;
    }
    if (letter) return true;
  }
  return false;
}

/**
 * Whether text that looks like the remains of the entry's fields follows a block closed at `end`,
 * before the next "@" (or the end) (R374 b): outside `%` comments (to the end of the line), a line that
 * holds a field assignment ("name = {", "name = 2020"), ends with "," or ends with "}" after other
 * text. Free text between entries (notes, section headers) and extra closing braces are not a doubt.
 * One pass; each line is scanned a constant number of times.
 */
function textAfter(src: string, end: number): boolean {
  const n = src.length;
  let k = end;
  while (k < n) {
    let e = k;
    while (e < n && src[e] !== "\n" && src[e] !== "\r" && src[e] !== "%" && src[e] !== "@") e++;
    if (looksLikeFields(src, k, e)) return true;
    if (src[e] === "@") return false;
    if (src[e] === "%") {
      while (e < n && src[e] !== "\n" && src[e] !== "\r" && src[e] !== "@") e++;
      if (src[e] === "@") return false;
    }
    k = e + 1;
  }
  return false;
}

```

### Tests (all in refman.test.ts, one in sidecar.test.ts), written first
Failed first for the right reason (a doubt where there should be none): notes/section header through both readers; prose line with comma and "="; sidecar notes test. Passed before and after (guard the kept doubts and bounds): early-closed entry through both readers, two-line remains, remains ending "," / "more text}", extra "}" alone, % comment lines, blank lines, trailing % note, five 2 MB single-line prose shapes (< 1 s).

### Point 2
Test "R374 c" (BibBlocks(src, 10), 100 closed `@a{p,}` lines in one value): one closed entry, end = last "}". Mutation (finish keeps every result) made it FAIL with "too many BibTeX blocks"; finish restored (git checkout). The test file change is in the point-1 commit; the second commit is empty and records the proof.

### Runs
- refman.test.ts + sidecar.test.ts: 2 files, 155 tests passed
- src/import: 22 files passed, 948 passed | 1 skipped
- typecheck: clean
