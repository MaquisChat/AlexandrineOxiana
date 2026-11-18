# Final review, Task FR-A7, round 3 — two small points (implementer's dispatch)

You make ONE small change and add tests in the project "Alexandrine Oxiana" (a pnpm 10 monorepo, Node 22, TypeScript strict ESM, Vitest). You have none of the earlier context; everything you need is here.

**Where you work:** the existing git worktree `/home/user/AlexandrineOxiana/.claude/worktrees/agent-a45f6da14291d4e55` (branch `worktree-agent-a45f6da14291d4e55`, head d09e907; `cd` there first; it is set up with dependencies — do NOT reset it, do not install). Nobody else works there. Stay out of every other folder; do not push. The machine restarts now and then: COMMIT after each point.

## Background
`packages/library/src/import/bib-blocks.ts` is the scanner that finds where each BibTeX block (`@article{…}`) ends, for the two BibTeX readers (the export reader in `packages/library/src/import/refman.ts`, and the "sidecar" reader that reads a `.bib` file lying next to a dropped PDF — find it with `grep -rn "bib-blocks" packages/library/src --include=*.ts`). When a block cannot be taken whole, the record carries a "doubt" (the texts in `BIB_DOUBTS`); a record with a doubt is held for the researcher's review instead of being merged silently. One of the doubts, `textAfter`, is given when text that belongs to no entry follows an entry's closing brace — it exists for a case like `@article{a, title="a } c", year=2020}`: the "}" inside the quoted title closes the entry early and ` c", year=2020}` is left over, so the entry's fields are incomplete.

## Point 1 — free text between entries is not a doubt (Ruling R374 b)
Today the function `textAfter(src, end)` (about line 95) answers true for ANY character after the closing brace, before the next "@", that is not white space, an extra "}" or part of a `%` comment. But classic BibTeX lets a file carry notes and section headers between its entries:

```
@article{a, title={One}, year={2020}}

==== Chapter 2 ====
Some notes the exporter wrote here.

@book{b, title={Two}, year={2021}}
```

Such a file must import with NO doubt on `a`. New rule, exactly: the doubt is given only when the text between the entry's closing brace and the next "@" (or the end of the file) looks like the remains of the entry's fields — that is, when, outside `%` comments (a `%` comment runs to the end of its line, as now), at least one of its lines, trimmed of white space:
- (i) holds a field assignment: a name (a letter, then letters, digits, `_`, `:`, `.`, `+` or `-`), optional white space, "=", optional white space, then one of `{`, `"`, a letter or a digit; OR
- (ii) ends with ","; OR
- (iii) ends with "}" AND has other, non-space, non-"}" text before it on that line.
A line that is only "}" characters and white space stays ignored, as now (an extra closing brace is not a doubt). The first "line" is what follows the closing brace on its own line. Keep the scan linear and bounded (one pass over that stretch; no regular expression that can backtrack badly on a long line — a simple hand scan or an anchored, linear expression per line is fine; lines can be megabytes long).

Tests FIRST (see each fail for the right reason before you change the function), in the test files that already test `BIB_DOUBTS.textAfter` (find them: `grep -rln "textAfter" packages/library/src`) — add, do not rewrite, existing tests; every existing test must still pass unchanged:
- the file above, through BOTH readers: no doubt on `a` or `b`, both records whole;
- a prose line with a comma and an equals sign in the middle that is not an assignment (`Sorted by year, descending. ==== 2020 ====`): no doubt;
- still a doubt (each through the scanner; at least the first through both readers): `@article{a, title="a } c", year=2020}`; an entry closed early whose remains are ` c",` on the entry's line and `doi = {10.1/x}` on the next; remains that are only `more text}` (ends with "}" after other text); remains ` c",` alone (ends with ",");
- still NO doubt: an extra `}` alone on the next line; `% a comment, with = {braces}` lines; blank lines; a trailing `% note` after the closing brace on the same line;
- a 2 MB single line of prose after an entry is read in well under a second (use the bound the neighbouring linear-time tests use).
Update the comment above `textAfter` and, only if its words are no longer true, the comment near `BIB_DOUBTS.textAfter`. Do NOT change the doubt's sentence.

## Point 2 — a test for the forgetting of inner blocks (Ruling R374 c)
In the scanner, `finish(o, r)` (about line 196) keeps a resolved block's result only when no other block is open (or it is the block asked for): a block resolved INSIDE another open block is forgotten, so memory stays bounded. No test fails if that forgetting is removed. Add one: build a `BibBlocks` (the exported class; its constructor takes the text and `maxTracked`) with a SMALL `maxTracked` (say 10) over a one-entry text whose single value holds many more than that many pasted, CLOSED block lines (each on its own line, like `@a{p,}`), ask it what the tests around it ask (read how the neighbouring tests of `MAX_TRACKED_BLOCKS` / `TooManyBibBlocks` drive it), and assert the text reads as ONE closed entry and is not refused. Then prove the test: temporarily change `finish` to keep every result (`this.done.set(o.open, r)` unconditionally), see the test FAIL, and put the code back. If the test does not fail under that mutation, find the smallest honest way to observe the forgetting (for example a read-only count of kept results exposed for tests) and say what you did. Leave `finish` as it was.

## Rules
- Files you may change: `packages/library/src/import/bib-blocks.ts` and test files next to it or the readers' existing test files. Nothing else. No new dependency.
- Tests first; plain names for tests; no `it.skip`, no loosening of any existing assertion or time bound.
- Verify, each at `nice -n 10`, in the foreground, and give the final summary line of each: the test files you touched, by name (`pnpm --filter @ao/library exec vitest run <paths>`); `pnpm --filter @ao/library exec vitest run src/import` (a time-limit failure in a test you did not touch is re-run once alone and both results reported); `pnpm --filter @ao/library typecheck`. Leave nothing running.
- Commits on the worktree's branch, one per point, each message ending with the trailers YOUR OWN session's instructions give; no model identifiers anywhere else. `git status --short` empty at the end.

## Report
Append a section "## Round 3 (R374)" to `/tmp/claude-0/-home-user-AlexandrineOxiana/ac3b5cb4-f467-5f83-9948-4e7d2e34f036/scratchpad/task-FRA7-report.md`: the new function in full; each test and that it failed first; the mutation's result for point 2; the runs. Final message to the coordinator (max 120 words): status (DONE / DONE_WITH_CONCERNS / BLOCKED), head commit, the runs in one line, anything unsure. Exactly one final message.
