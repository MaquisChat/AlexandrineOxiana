# Task FR-A22, round 5 — one exact, tiny change (Ruling R446)

You make ONE small, exactly specified change with its tests. Do NOT redesign, refactor or "improve" anything else. If something here does not match the code you find, STOP and report it instead of guessing.

Project: `/home/user/AlexandrineOxiana` (pnpm 10 monorepo, Node 22, TypeScript strict ESM, Vitest). Work ONLY in the worktree `/home/user/AlexandrineOxiana/.claude/worktrees/fr-a22` (branch `fr-a22-junk-titles`, head d215275; dependencies installed). No other worktree or branch; no push; NEVER `git stash` (one stash list is shared by every worktree and other agents are working); no installs; nothing may reach the network.

Background: `packages/library/src/extract/title-like.ts` decides whether the title embedded in a file (a PDF's own "Title" field, for instance) looks like a real title or like junk. One of its rules: an embedded title that is just the file's own name is no title. That rule compares WITHOUT regard to capitals:

```ts
    const stem = fold(base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base);
    if (stem && stem.toLowerCase() === s.toLowerCase()) return false;
```
(about lines 181–182, inside `looksLikeTitle`). So a file "Weir accounts.pdf" whose embedded title is "Weir Accounts" loses that title, and the library shows the file's name "Weir accounts" instead — a browser scenario of the project fails on exactly this.

## The change (tests first)
1. In `packages/library/src/extract/title-like.test.ts` there is a table of rows `[embedded title, kept?, file name (optional)]` run by `it.each(TITLES)` (about lines 8–210). Add these rows (in the same style as the rows around them, each with a short comment):
   - `["Weir Accounts", true, "Weir accounts.pdf"]` — differs from the file's name in its capitals: someone's spelling of the title, kept (R446). This row must FAIL before the change.
   - `["Weir accounts", false, "Weir accounts.pdf"]` — the file's name itself: dropped (holds before and after).
   - `["WEIR ACCOUNTS", true, "weir accounts.PDF"]` — must FAIL before the change.
   If the table already has a row that expects a title equal to the file's name EXCEPT for capitals to be dropped (`false`), that row's expectation changes to `true` under R446: change it, and name it in your report. Do not change any other row.
2. Run the file and see the new rows fail: `cd /home/user/AlexandrineOxiana/.claude/worktrees/fr-a22 && nice -n 10 pnpm --filter @ao/library exec vitest run src/extract/title-like.test.ts`.
3. Change line 182 to compare character for character: `if (stem && stem === s) return false;` and update the comment above the rule (and the module's header comment if it describes this rule) to say: an embedded title that IS the file's name, character for character after the folding, is not a title; one that differs, even only in its capitals, is kept (R446). Look at what `s` and `fold` are in that function before you change the line, so that both sides of the comparison are folded the same way; if they are not, say so in your report and make them so in the smallest way.
4. Run again: all rows pass. Then run `nice -n 10 pnpm --filter @ao/library exec vitest run src/extract src/import/resolve-titles.test.ts src/find/file-check.test.ts` — everything must pass; if another test there expected the old, capital-blind behaviour, change only that expectation and name it. Then `nice -n 10 pnpm -r typecheck`.

One commit: `fix(library): an embedded title is the file's name only when equal character for character (R446)`, ending with the trailers your own session's instructions give; no model names anywhere else. `git status --short` must be empty at the end.

Final message (max 70 words): the commit, the runs' result lines, any existing expectation you changed, anything that did not match this brief.
