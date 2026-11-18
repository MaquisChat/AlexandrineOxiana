# FR-A7, round 2 (R366): scoped review

Worktree `agent-a45f6da14291d4e55`, head d09e907, which is 9 commits on bd99a97. When I finished, the head was unchanged and `git status --short` was empty.

How I probed:
- Scratch `*.probeFRA7.*` files beside the code, running the base parsers (`claude/pdf-reader-highlights`) and the new ones side by side.
- One temporary test in `refman.test.ts`, reverted.
- Eight scratch mutations, all reverted.
- All scratch files removed.

Baseline: `refman.test.ts` + `sidecar.test.ts` → **147 passed (147)**.

**Verdict: APPROVED WITH SMALL POINTS.**
- Spec R366 a–h: met.
- Quality: good.
- Counts: 0 Critical, 0 Important, 5 Minor (new).

## The review's points

| Point | Result | Evidence |
|---|---|---|
| I1 | **fixed** | `bib-blocks.ts:204-211` (`blockLine` cuts every block at its own level, outside quotes) and `:186` (`base` = absolute depth). In the bulk engine, the 50-entry file (e10 missing its closing brace, e40 ending "}}") gives **50 records**. Each record has its own DOI, and the only BibTeX doubt is the cut on e10. `missingThenExtra` gives a [cut], b (with b's DOI), and c. The sidecar now gives a [cut] with no foreign DOI. The stray "}" after e40 is ignored: e40 has no doubt and e41 is whole. Depth stays right with escaped braces (`\}`, `\{`), braces in quotes (`"A {b} c"`), and a `%` line holding "}" (that one closes the entry, and textAfter flags it). The block-line cut is undone only by a `%` line holding an odd `"` (N4). A pasted citation inside a braced or quoted value stays whole and carries the third doubt. |
| I2 | **fixed** | `bulk/run.ts:1262` (`doubted`), `:1313` (a doubted record under merge is created with `reviewFor(r, dup)`), `:1512` (the recheck does not merge a doubted record). |
| I3 | **fixed** | `bib-blocks.ts:65-82`. "@jdoe (2021) wrote back" and "@jdoe {at} the meeting" give no doubt, no cut and no spurious record, with every field kept. This holds in braced values, in quoted values and in a `(` entry with either kind of value, in both readers. |
| I4 | **fixed** | `bib-blocks.ts:250-259`. `parenEnum` keeps every field in both readers, with braced and with quoted values. |
| M1 | **fixed** (with N1) | `bib-blocks.ts:95-106, :332`. `title="a } c", …` gives the textAfter doubt in both readers. No doubt from: `%` lines, blank lines, a trailing `% note`, CRLF, an extra "}", `sample.bib` (the repository's only `.bib` fixture), or my 20,000-entry file with `%` lines and blank lines between entries (0 doubts). |
| M2 | accepted by R366 i | Unchanged: a same-line merge, and a missing brace made up later in the same entry. |
| M3 | **fixed** | `bib-blocks.ts:29-30`. The words are now true for every case I probed, including the key-less entry and the quoted-key entry that a broken entry swallows. |
| M4 | accepted by R366 i | — |
| M5 | **fixed** | Mid-line openers are no longer tracked (`:242`, `:252`), and inner blocks are forgotten (`:196`). 1.1 M `a@b{c}` give 1 entry in 0.16 s. 1.2 M pasted entry lines inside one value give 1 entry in 0.36 s. **The forgetting at `:196` is untested** (N3). |
| M6 | **fixed** | Each of these mutations makes a test fail: removing `resolve.ts:543` (the complete-record test), removing `MAX_TRACKED_BLOCKS` (the nesting test), and removing either `doubted` guard (2 tests each). Also killed by tests: the field-level cut (4), textAfter (2), quote-aware parentheses (4). The linear-time test's bound is now 5 s. Old test bodies are untouched: the only removed lines are round 1's own linear test. |

## The three points left to the coordinator: what I would rule

### (1) The researcher's own "Merge" on the review entry
**Accept.** The entry shows the cut doubt and "This may be a duplicate of a s…", and nothing else in a run merges a doubted record.

Paths I checked, by probe and by reading:
- "merge" (the engine's and the command line's default): a new record waits for review with the doubt plus the duplicate reason. The existing source is byte-for-byte unchanged (no container written).
- "keep-both": a new record waits with the doubt.
- "skip": `duplicates 1`, nothing written.
- The same DOI twice in one file (clean first, cut second), under merge: the recheck path creates the cut one, waiting with both reasons.
- Attach, drag-and-drop and watched folders never merge.
- Resume goes back through `importItem`.
- There is no redo.
- Only the Zotero adapter is incremental, so the `update` path never sees a BibTeX record.

### (2) The cap on the scanner's work
**Accept.** What is counted: each character the scans step over, plus the spaces or tabs leading a line. The budget is `8 × length + 64 M` steps (`:295`), and an ordinary file uses about one step per character.

Ordinary files stay far below the cap (tested on 32.6 MB files of 20,000 entries with long abstracts, "@user" lines, and `%` and blank lines):

| Shape | Time | Heap | Entries / doubts |
|---|---|---|---|
| clean | 0.49 s | +9 MB | 20,000 / 0 |
| CRLF line ends | 0.46 s | +37 MB | 20,000 / 0 |
| one value unclosed | 0.44 s | — | 20,000 / 1 |
| every 100th value unclosed | 0.43 s | — | 20,000 / 200 |
| every value unclosed | 0.43 s | — | 20,000 / 20,000 |

None were refused. When the budget refuses a file, its sentence ("too many references") is not literally true; this only happens to a hostile file. I would accept it, or give it its own sentence (N5).

### (3) The three limits
- **(a) An unclosed `@comment` followed later by a stray "}":** **accept, but add one line.** As built, its entries are dropped with **no doubt anywhere**, because a comment yields no record. This is indistinguishable from a comment that deliberately holds entries (probe `unclosedCommentStray`: old x, y, c; new c only).
  - The cheap remedy: a line in the import report when a `@comment` holds entry lines: "N lines inside a @comment look like entries; they were not imported."
  - That covers both the intended case and the broken one without guessing (N2).
- **(b) A key-less `@article{,`:** **accept.** After an unclosed entry, it is merged into that entry, which carries the cut doubt. Its words ("may … hold text from what followed it") are now true. The key-less entry itself is not imported. On its own, a key-less entry is read as before. The same applies to a quoted key `@article{"q key",`, which is not valid BibTeX: it is swallowed, and the record carries the eof doubt.
- **(c) A "(" opener inside a quoted value:** **accept.** Rare. It is judged on its own scan if the reader asks for it.

## New findings (all Minor)

### N1: free text between entries gives the entry before it the textAfter doubt
- Input: `@article{a,…}\n\n==== Chapter 2 ====\n\n@book{b,…}`, or "Some notes the exporter wrote here."
- Result: `a [TEXTAFTER]` in both readers.
- Why it matters: free text between entries is classic BibTeX's own way of commenting. Hand-kept files with section headers or notes would see one false doubt per header. The ruling's words allow this, but the brief said ordinary files give none.
- Direction: give the doubt only when the stray text looks like field content (a `name =`, or a "," / "}" before the end of its line). Or accept it and note it in the guide.

### N2: an unclosed `@comment` drops entries silently
See (3a). Direction: the report line suggested there.

### N3: the forgetting of inner blocks (`bib-blocks.ts:196`) has no test
- Probe: with `finish` storing every resolved block, all 147 tests pass. The M5 test uses mid-line openers, which are no longer tracked at all, so it cannot see this.
- Direction: test a one-entry file with more than `MAX_TRACKED_BLOCKS` pasted `@a{p,}` lines inside one value (1.2 M lines, 8 MB, read in 0.36 s here).

### N4: a `%` comment line at field level holding an odd `"` flips the quote state
- Effect: a later entry line at that level is then not a cut. This matters only with a missing brace plus an extra brace later.
- Probe: `pctLineQuote` still gives a cut, through the eof recovery.
- Direction: none needed beyond noting it in the list.

### N5: the work-budget refusal reuses "too many references"
Hostile files only. Direction: its own sentence ("This export is too irregular to read safely…"), or accept.

## Hostile shapes, re-run (parser only, at `nice -n 10`, loaded machine)

| Shape | Size | Result | Time | Heap |
|---|---|---|---|---|
| 1 M unclosed `@a{k,` heads | 5.7 MB | 1 M entries | 0.70 s | +8 MB |
| 1.1 M nested unclosed inside values | 10.5 MB | refused | 0.40 s | — |
| 4 M-deep nesting | — | — | 0.08 s | — |
| 50 MB single value | 50 MB | — | 0.73 s | +43 MB |
| 8 MB of entry lines inside one value | 8 MB | — | 0.19 s | — |
| unclosed entry + 450 k closed | 5.6 MB | — | 0.59 s | +77 MB |
| 150 k nested pasted blocks after an unclosed value | — | — | 0.30 s | — |
| 2 M mid-line `@c(` | — | — | 0.48 s | — |
| 400 k `{}{}` alternations | — | — | 0.36 s | — |
| chain of 300 k block lines inside values | — | — | 0.14 s | — |
| staircase | — | — | 0.09 s | — |
| sidecar, 1 MB shapes | 1 MB | — | ≤ 57 ms | — |

Nothing quadratic, and memory is bounded.

## Plain statement: every shape in which a field or an entry is still lost, cut or merged WITHOUT a doubt
1. An unclosed `@comment` followed later by a stray "}": the entries between are dropped, with no doubt and no word in the report (limit 3a; the same as a comment that holds entries on purpose).
2. A brace missing inside a value and made up later in the same entry: later fields are read into the value (accepted, R366 i).
3. A missing brace with the next entry on the same line, plus an extra brace later: the two entries merge (accepted, R366 i).
4. An `@string` macro holding a pasted entry line (accepted, R366 i).
5. Outside the block rule, and as before this task: the **sidecar's own value parser** does not know escapes. A `\}` or `\"` inside a value (Zotero escapes braces this way) ends the value early, and the fields after it are lost. Probe: `title={a \} b \{ c}, doi=…` gives the sidecar `title "a \"`, with no DOI and no doubt. The export reader is right on the same input.
