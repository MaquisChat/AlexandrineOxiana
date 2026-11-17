# FR-A7 — adversarial review (R362 g, R365)

Worktree `agent-a45f6da14291d4e55`, branch `worktree-agent-a45f6da14291d4e55`, head bd99a97 (unchanged; `git status --short` empty at the end). Probes: scratch `*.probeFRA7.*` files beside the code (old parsers copied from `claude/pdf-reader-highlights` for side-by-side runs), one temporary test inside `refman.test.ts` (reverted), eleven scratch mutations (reverted). All removed.

## Verdicts
- **Spec (R362 g, R365): partly met.** The core defect is fixed in both readers: a line "@someuser replied…" inside a braced or quoted value, first or last line, with tabs/spaces, CRLF, lone CR, nested ten deep, inside `#` concatenation and `@string` macros, keeps the value and every later field, with no doubt. The recovery is used only for a block that never closes, and a cut / end-of-file record carries the doubt, which reaches the review queue and the import report on the wizard, CLI, folder import, drag-and-drop and watched-folder paths. Not met: the doubt is dropped when the record merges into an existing source (I2); the "line that begins an entry" test is weaker than the brief's "`@type{key,` of a known or well-formed type", so ordinary social-media lines give the third doubt or a cut (I3); and the new "closed anywhere" rule turns a common two-error file into a silent-ish mass swallow that the old recovery handled (I1).
- **Quality: needs fixes** (0 Critical, 4 Important, 6 Minor). Linear and bounded as claimed; tests mostly able to fail.

## Point 1 — the plain statement: shapes in which data is still lost, cut or merged WITHOUT a doubt
1. **A record that merges into an existing source** (duplicates "merge", the CLI default): a cut record's fields, including a truncated value, are written into the existing source, and the doubt is nowhere (I2).
2. **Sidecar, `(` entry with an unmatched ")" inside a braced value** ("We ask 1) why and 2) how"): every field after it is lost (I4, new in this task).
3. **Sidecar, an unmatched "}" inside a quoted value**: later fields lost (new in the sidecar; the export reader lost them before too) (M1).
4. **Export reader, an unmatched "}" inside a quoted value** (`title="a } c", doi=…, year=…`): title "a ", doi and year lost, no doubt (as before) (M1).
5. **Missing brace + extra brace with the next entry on the SAME line** (`… year={2001} @article{b, …}}}`): b merged into a, a takes b's DOI, no doubt (as before) (M2).
6. **A missing brace inside a value compensated by an extra one later in the same entry** (`title={A, year={2001}, doi={…}}}`): year and doi read as part of the title, no doubt (as before; undetectable by counting) (M2).
7. **Unclosed entry followed by a line no reader takes as an entry** (`@ article{b, …}`): a takes b's DOI; the doubt given (eof) says "may be incomplete", not that foreign fields were taken (M3).
8. **A `@string` holding a pasted entry line**: the third doubt is not passed to the entries that use the macro (M4).
With a doubt, but a large loss: an entry missing its closing brace and ANY later extra "}" → every entry between is swallowed into the first (I1).

## Findings

### I1 (Important) — one missing closing brace plus one extra brace anywhere later now swallows every entry between them; the first record takes their fields
`bib-blocks.ts:214-216` (`block`: a `{` block is "closed" by whichever brace brings the count to zero, however far). Old recovery cut at the next line-start "@" and imported every entry.
Probe (bulk engine, temporary test): 50 entries, e10 missing its final "}", e40 ending "}}". **Old: 50 records. New: 20 records** — e11…e40 are not imported; e10 carries the third doubt. Parser probe `missingThenExtra`:
`@article{a, title={A}, year={2001}\n@article{b, title={B}, doi={10.5555/b}, year={2002}}}\n@article{c, …}` → old a, b, c; new `a` with `doi=10.5555/b` (b's DOI on a's record) + c. A wrong DOI then also drives deduplication (with "merge" it lands in an existing source — see I2).
The doubt is given (R365 b knew the shape), but the doubt's single record hides 30 lost records, and the import's count drops with no other word. The commonest hand-edit break (the entry's own closing brace deleted) is distinguishable: the swallowed `@type{key,` line then sits at depth 1 (between fields), never inside a value, whereas a pasted citation is at depth ≥ 2.
Direction: a line that begins an entry at the block's field level (depth 1 relative to the block) ends the block as a cut (with the cut doubt), whatever closes later; keep "closed + third doubt" only for depth ≥ 2. Test: the 50-entry file above imports 50 records, e10 with the cut doubt.

### I2 (Important) — the doubt is dropped when the record merges into an existing source; its fields are written silently
`bulk/run.ts:1299-1301` → `mergeInner` (`run.ts:1759ff`) never looks at `r.verification`; only `create` gets `reviewFor`. The implementer listed it as "minor (deferred)"; no ruling covers it. The CLI's default is `--duplicates merge` (`apps/cli/src/commands/import.ts:220`).
Probe: import `@article{x, title={Clean X}, doi={10.5555/x}, year={2020}}`; then, with merge, `@article{x, title={Clean X}, doi={10.5555/x}, journal={Journal of X, volume={3}\n@article{y, title={Y}}\n`. Result: counts `merged:1`; source "Clean X" now has container **"Journal of X, volume=3"**; `pendingReview` holds only y's reasons — the cut doubt is nowhere. (With "skip" nothing is written; acceptable.)
Direction: a resolution with BibTeX doubts (or `verification.overall === "needs-review"` from doubts) is not merged silently: either create + queue as a likely duplicate, or merge and put the target on the review queue with the doubt; say it in the report. Test both.

### I3 (Important) — "a line that begins an entry" is too loose: social-media lines such as "@jdoe (2021) wrote back" give the third doubt, and in a `(` entry they cut it
`bib-blocks.ts:184-191` (`beginsEntry`: "@", letters, optional white space, "{" or "("). The brief asked for "a line-start `@type{key,` of a known or well-formed entry type"; R365 b: "A line such as "@someuser replied" gives none."
Probes: `abstract={Replies.\n@jdoe (2021) wrote back\nEnd.}` (braces or quotes) → record whole but **third doubt** ("begins like another entry ("@type{")" — untrue to the reader). A social-media bibliography whose abstracts quote accounts with a date in parentheses floods the review queue, one entry per record. In a `(` entry the same line **cuts** the entry: export reader keeps only `title`, loses doi/year, and yields a spurious entry `jdoe:2021`; the sidecar loses doi/year (old sidecar kept them) — with the cut doubt, but data lost for an ordinary line.
Direction: an entry line is "@" + type letters + ws + "{" or "(" + ws + a key token (no white space, braces, parentheses, quotes, "=" ) + ws + "," (and/or a known type set, with @string/@comment/@preamble treated apart). Tests: "@jdoe (2021) wrote back" and "@jdoe {at} …" lines give no doubt and no cut, in both readers and in a `(` entry.

### I4 (Important) — sidecar: a `(` entry is now ended by the first unmatched ")" anywhere, also inside a braced value; later fields lost silently
`bib-blocks.ts:217-224` counts parentheses only (braces ignored); `sidecar.ts:199-205` now bounds the field parse by that end (`const n = block.end`). Before, the sidecar's fields ran to the text's end.
Probe `@article(a, title={T}, abstract={We ask 1) why and 2) how.}, doi={10.5555/a}, year={2001})`: old sidecar `title, issued 2001, doi`; **new: title only, no doubt**. The export reader is not affected (its field parser decides `(` closes).
Direction: for `(` blocks count parentheses only at brace depth 0 (skip braced and quoted values), as the export reader's field parser effectively does. Test in sidecar.test.ts.

### M1 (Minor) — an unmatched "}" inside a quoted value closes the block silently
`bib-blocks.ts:124-145` ignores quotes. `title="a } c", doi={10.5555/a}, year={2020}}` → export reader: title "a ", doi and year lost (same as before); sidecar: **year and doi lost (old sidecar kept them)**. Not legal BibTeX, so Minor. Direction: when a `{` block closes and non-blank text other than "}" follows before the next "@", give the record a doubt; or track quotes at depth 1.

### M2 (Minor) — merges no counting can see stay silent (pre-existing)
Same-line next entry after a missing brace plus a later extra brace (probe `missingThenExtraSameLine`: a takes b's DOI, no doubt); a value missing a brace compensated in the same entry (`missingValCompensated`: year and doi swallowed into title). Both unchanged from before; record them as known limits.

### M3 (Minor) — the eof doubt's sentence is not true when the unclosed entry swallowed a following entry the readers do not recognise
`@article{a, title={A}, year={2001}\n@ article{b, title={B}, doi={10.5555/b}}` → a gets `doi=10.5555/b`, doubt "not closed before the end of the file; some of its fields may be incomplete" — fields are also foreign, not only incomplete. Direction: "…its fields may be incomplete or include text from what follows it."

### M4 (Minor) — `@string` holding a pasted entry line: the third doubt is lost
`refman.ts:654-657` computes doubts only for entries. `@string{tw = {T\n@article{z, title={Z}}\n}}` then `title = tw` → title holds the pasted entry, no doubt (before: z imported as a record). Direction: carry a macro's doubt to the entries that expand it, or accept and note.

### M5 (Minor) — false "too many references" for a one-entry file
Openers inside values (`a@b{c}`, also `\@ifnextchar{`) are tracked in `closedAt` and never deleted (`bib-blocks.ts:132-142`); 1.1 M of them in one note (7 MB) → "This export has too many references…" for a file with one entry. Hostile only. Direction: track only openers at the reader's level (depth 0 relative), or forget closed inner ones.

### M6 (Minor) — tests that cannot fail
- `resolve.ts:543` (`if (doubts.length) report.overall = "needs-review"`) removed: **all 118 tests pass** — both doubt tests use records already needing review for other reasons (missing creators). A complete record with a doubt is untested.
- `MAX_TRACKED_BLOCKS` removed (`new BibBlocks(src)`): no test fails (only load-timing flakes in unrelated RIS / Zotero RDF linear tests).
- The 1 s linear-time tests (incl. the new one) fail spuriously under load (seen in 6 of 11 mutation runs on unrelated parsers).

## Point 2 — the old cases
`git diff claude/pdf-reader-highlights bd99a97 -- '*.test.ts'`: 168 lines added, 2 removed — both import lines (`primary`, `BIB_DOUBTS`, `parseBibtexEntries`); no test body changed. "recovers after an unterminated entry…", backslash, lone-CR, sidecar R57 M2 / R58: green (118/118 at baseline).
Differences in record counts, each judged:
- `@comment{…}` holding entries: old imported them (as classic BibTeX does), new does not (as biber, JabRef and Zotero do). A correction — commented-out entries were meant out. Sidecar likewise now takes the first real entry.
- Pasted "@type{" line inside a balanced value: old split off a spurious record and cut the host; new keeps the host whole with the third doubt. Correction.
- Unclosed entry + later extra brace: old N, new fewer — **not** a correction (I1).
- `(` entry with "@handle (" line: spurious record as before, now with a cut doubt (I3).

## Point 3 — the doubt reaches the researcher
Followed: `BibEntry.doubt` → `recordItem(... {doubts})` (`refman.ts:672`) → `ScanItem.doubts` → `run.ts:1282` → `resolveItem` reasons + needs-review (`resolve.ts:542-543`) → `reviewFor` (`common.ts:120`) → review entry + report `pendingReview[].reasons`. Wizard and CLI (`apps/cli/src/commands/import.ts:53`) both use `bibtexAdapter` → bulk run. Folder import: bulk run with `findSidecars` → sidecar doubt (`resolve.ts:458`). Drag-and-drop and watched folders: `attach.ts:294-302` → same `resolveItem` → `reviewFor`. Zotero-exported `.bib`: `bibtexAdapter`. A sidecar not used (unreadable / no metadata) gives no doubt — right, its data is not used. Undo removes the created source with its review entry (existing mechanism); there is no redo.
Dropped: merge into an existing source (I2). Sentences: cut's is true (it is cut at an "@" line); eof's not always (M3); the third's is misleading for "@jdoe (2021)" lines (I3). Flood: "@someuser replied" lines give none (checked, also the 50-entry test); "@jdoe (…)" lines flood (I3); abstracts quoting BibTeX give one per record — accepted by R365 b.

## Point 4 — hostile or huge files (parser alone, Node, loaded machine)
1 M unclosed `@a{` heads (3.8 MB): 0.5 s, ~44 MB · 1.1 M: refused "too many references" in 0.09 s · 4 MB nesting (closed / unclosed): 0.18 s, ~4 MB · 50 MB single unkept value: 0.9 s, ~46 MB · 400 k `{}{}` alternations (7 MB): 0.5 s · 365 k entry lines in one value (8 MB): 0.23 s, ~36 MB · 335 k `(` entries with pasted lines (9 MB): 0.56 s · unclosed + 600 k closed (7 MB): 0.84 s · 2 M mid-line `@c(` (8 MB): 0.45 s · 700 k `@comment(a)`: 0.23 s · long leading-space lines: 0.24 s · sidecar 1 MB shapes: ≤ 72 ms. Nothing quadratic found; the record-count refusal is unchanged (adapter, 200 k). Only M5.

## Point 5 — tests able to fail (scratch mutations, reverted)
Old rule restored (any line-start "@" ends the block): 10 new tests fail. Remove run.ts doubts pass-through: bulk test fails. Remove sidecar doubt push: sidecar resolve test fails. Remove reasons push: 2 fail. Remove adapter doubt: 3 fail. Remove the third doubt: 2 fail. eof → cut: 2 fail. Sidecar unbounded entry: 1 fails. **Cannot fail:** needs-review line, tracking bound (M6).

## Could not verify
The screens (Review queue "Why it needs review") — read, not run; no e2e by instruction. Undo after a cut import was not run.
