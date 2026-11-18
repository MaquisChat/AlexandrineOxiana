# Task FR-A10, round 7 — six exact, tiny changes (Ruling R440)

You make six small, exactly specified changes to a finished, reviewed piece of code, with a test for each. Do NOT redesign, refactor or "improve" anything else. If something here does not match the code you find, STOP and report it instead of guessing.

Project: `/home/user/AlexandrineOxiana` (pnpm 10 monorepo, Node 22, TypeScript strict ESM, Vitest). Work ONLY in the worktree `/home/user/AlexandrineOxiana/.claude/worktrees/agent-a45f6da14291d4e55` (branch `fr-a10-names`, head e354ae4; dependencies installed). No other worktree or branch; no push; NEVER `git stash` (one stash list is shared by every worktree and other agents are working); no installs; nothing may reach the network.

What the code does (so the tests make sense): research participants' real names must be replaced by their codes (P-001 …) in citations. `packages/core/src/participant-names.ts` finds names in text; `packages/core/src/citation/csl-map.ts` builds a citation (`toCslItem`) and, for a creator (author) who is not a participant, replaces a participant's name found inside that creator's name (`creatorWithWholeNames`); `packages/library/src/repo/pseudonyms.ts` decides which participant a creator is (`creatorKey`, `assignCodes`). A "run" is two or more consecutive words of a participant's longer name ("Lucía Fernández" of "Lucía Fernández Ruiz").

Read first: the review that asked for these changes — `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-FRA10-review5.md` (I1, I2, M1–M4: each has the probe to turn into a test) — and the existing tests near where you will add yours: `packages/core/src/citation/citation.test.ts` (search "R437"), `packages/library/src/repo/pseudonyms.test.ts` (search "R438").

## The changes (tests first: write the test, see it FAIL, then change the code; one commit per point)

**(a) A one-field creator is one text.** In `packages/core/src/citation/csl-map.ts`, function `creatorWithWholeNames`, the line
`if (!given || !family) return tryText(given ?? family, () => false);`
becomes
`if (!given || !family) return tryText(given ?? family);`
Update the comment above it: replace the sentence "A creator of one field takes no run." by "A creator of one field is one text, like a literal: runs count in it (R440 a)."
Tests in `citation.test.ts` (map `{"Lucía Fernández Ruiz" → P-005}`, a web page, as the R437 tests there build one): the creator `{family: "Lucía Fernández"}` prints as the literal "P-005"; the creator `{given: "Lucía Fernández"}` likewise. Both must fail before the change.

**(b) No run in the "family given" reading.** Same function, the line
``return tryText(`${given} ${family}`, across(given)) ?? tryText(`${family} ${given}`, across(family));``
becomes
``return tryText(`${given} ${family}`, across(given)) ?? tryText(`${family} ${given}`, () => false);``
Add to the comment: "In the second, family-given reading no run counts (R440 b): runs carry their own rotations, so swapped fields are coded by the first reading; whole names still count there."
Tests: with the same map, `{given: "Lucía", family: "Ortega Fernández"}` is printed UNCHANGED (given "Lucía", family "Ortega Fernández") and the source's own citation key is kept — must fail before the change (it prints "Ortega P-005"); guards that must pass before and after (say so in your report): `{given: "Fernández", family: "Lucía"}` → the literal "P-005"; `{given: "Lucía", family: "Fernández"}` → "P-005"; with the map `{"Maria Cocina" → P-001}`, `{given: "Cocina", family: "Maria"}`… only if a test of a whole name in swapped fields already exists, leave it as it is.

**(c) A full-width "＠" in front of a handle is read as "@".** In `packages/library/src/repo/pseudonyms.ts`, function `creatorKey`, the handle's leading at-signs are stripped with `/^@+/u`: strip `/^[@＠]+/u` instead (U+FF20 is the full-width form). Test in `pseudonyms.test.ts`, beside the R438 tests: creators with the handles "@x.dancer" and "＠x.dancer" get ONE participant through `assignCodes` (as those tests call it). Must fail first.

**(d) A handle with nothing visible in it is no handle.** Same function: after stripping the at-signs, if what is left has an empty `identityKey` (import `identityKey` from `@ao/core` if the file does not already; it removes invisible characters and white space), treat the creator as having NO handle — fall through to the literal, else the names, exactly as for a creator without a handle. Tests: `creatorKey({ handle: "​", literal: "Ana", role: "uploader" })` is "Ana"; `creatorKey({ handle: "​", role: "uploader" })` is `undefined`; two creators with the handles "​" and "⁠" and no other name get NO participant from `assignCodes` (their codes are `undefined`). Must fail first.

**(e) A whole name is found even where a run of the same letters was indexed first.** In `packages/core/src/participant-names.ts`, function `patterns`, inside `if (had) { … }`: the line `if (!f.part) had.part = false;` currently sits INSIDE the inner `if (!had.cands.some(…)) { … }` block. Move it to be the first statement inside `if (had) {`, before that inner `if`. Test in `citation.test.ts`: with the map `{"Lucía Fernández Ruiz" → P-005, "Lucía Fernández" → P-005}` (two entries, same code), the creator `{given: "Pedro", family: "Fernández, Lucía"}` is printed with the code in place of the name (it must no longer contain "Lucía"); see the review's M3 for the probe. Must fail first. If it does not fail first, stop and report (do not force it).

**(f) Two tests for guards that have none** (they must PASS as the code stands; then check each FAILS when you temporarily remove its guard, and put the guard back):
1. In `citation.test.ts` or `naming.test.ts`: with the map `{"Juan Carlos Pérez" → P-002, "Juan Carlos" → P-007}`, in either order of the two entries, the creator `{given: "Juan Carlos", family: "Onetti"}` prints "P-007 Onetti" (a participant whose WHOLE name is "Juan Carlos" is replaced inside the given field). Guard: `if (!f.part) had.part = false`.
2. A direct test of `scrubNames` from `packages/core/src/participant-names.ts`: the text "‮aícul zednánref‬" (a right-to-left override around the reversed letters of "fernández lucía") with names `{ map: new Map([["Lucía Fernández Ruiz", "P-005"]]) }` and options `{ runSpan: () => false }` still gives a text containing "P-005" (inside an override the run filter is not asked). Guard: the removal of `runSpan` on the override path in `findAll`. If the exact text does not match the way the existing override tests build theirs (search the test files for "‮"), copy their way of building it.

## Verify, then report
`cd` into the worktree; `nice -n 10 pnpm --filter @ao/core exec vitest run src/naming.test.ts src/citation` ; `nice -n 10 pnpm --filter @ao/library exec vitest run src/repo/pseudonyms.test.ts src/capture/profile-capture.test.ts src/export/bibliography.test.ts` ; `nice -n 10 pnpm -r typecheck`. A time-limit failure in a test you did not touch ("linear in the text", a 5-second rendering test) is named, not chased. `git status --short` must be empty at the end.

Commit messages: one line saying what changed and "(FR-A10 round 10 <letter>; R440 <letter>)", ending with the trailers your own session's instructions give; no model names anywhere else.

Append a section "## Round 10 (R440)" to `/tmp/claude-0/-home-user-AlexandrineOxiana/ac3b5cb4-f467-5f83-9948-4e7d2e34f036/scratchpad/task-FRA10-report.md`: per point, the file and line changed, the test, whether it failed first, and the three runs' result lines.

Final message (max 100 words): the head commit, the runs, any point you could not do exactly as written and why.
