# The known-gaps round (Rulings R502, R503) — common brief; your dispatch names your batch

The project's owner said "keep building". The round before this one (the "rough-edges round") listed gaps it found and did not build: FR-717 to FR-741. This round builds them, in batches by area. You are the implementer of ONE batch, in your own git worktree, on your own branch (from the finished branch's head 579bdcd; dependencies installed). Other agents are doing other batches at the same time in theirs.

## Read first, in this order
1. `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-fix-common.md`, in full — who the project is for, where you work, how (tests first; NEVER `git stash`; the smallest change; the commit trailers), how to report. Where it says "the finding in the review file" read "the item in the list". It names `impl-common-reader.md` (the house rules): read that in full too. **Where it says to run "the whole suite of each package" or `pnpm -r typecheck`: DO NOT — this brief's "Verify" replaces that part.**
2. The round's ruling, in full — it rules what to build for each item and overrides the item's own text where they differ: `grep -n "Ruling R503" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-9000`.
3. Your batch's brief (your dispatch names it).
4. For EACH of your items, its full entry: `grep -n "FR-738\b" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-3000` (adjust the number). Rulings an entry names: `grep -n "Ruling R495\b" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-7000`. File and line hints may have moved: find the code by reading.

## For each item
1. **Does it still hold at this head?** Check by reading and, where quick, by a test. If it is already closed, say so in your report with the evidence and change nothing.
2. **Test first.** Write the test that shows the gap, SEE IT FAIL for the right reason, then make the smallest change that meets the ruling. One commit per item (items your brief names together may share one); the message names the FR number(s) and says in plain words what is now so. Commit as you go: the machine restarts now and then.
3. **If the code disagrees with the ruling, or an item needs a choice about what the researcher sees that the ruling does not make, or it is plainly much larger than it looks: do NOT guess.** Stop that item, put it under "NEEDS A RULING" in your report (what you found, the options, your recommendation with the exact wording you would use), and go on with the others.
4. **Wording.** Plain words and whole sentences that say what happened and what the researcher can do next. No jargon, no secret, no internal name; no file path unless the ruling allows one for that item. A sentence shown in two places lives in ONE place (`packages/shared` where the service and the screens both say it). Before writing a new sentence look for the one the app already uses for the same thing. List every sentence a researcher can see that is new or changed, word for word, in your report.
5. **The house rules hold for every change:** every change to a library is decided by the policy engine, audited and crash-safe (the transaction marker); nothing a person put in the library folder is ever deleted by the app's own repair; in the screens colours come from theme tokens, outside text is shown through `UserText`, never `innerHTML`, focus is asserted through `document.activeElement`; a found file is never attached without the researcher's confirmation and nothing is fetched that was not asked for.
6. Never loosen or skip an existing test. A test that asserted the gap is changed and named in your report. A test that waits for something waits for the TRUE resting state and asserts it exactly — no sleep, no retry; a promise a test holds back is released when the test ends, whatever its end (`onTestFinished`).

## Verify — SINGLE FILES ONLY (the machine has 4 cores and several agents; whole-suite runs under load only produce false time-limit failures, and the coordinator runs ONE full verification of everything after the join)
Each at `nice -n 10`, one command at a time, nothing left running:
- each test file you added or touched, and the existing test files of the code you changed (find them: same folder, same name), by path: `nice -n 10 pnpm --filter <package> exec vitest run <path> --testTimeout 120000` (packages `@ao/core`, `@ao/library`, `@ao/library-service`, `@ao/ui`, `@ao/cli`, `@ao/shared`);
- the typecheck of each package you changed, one at a time: `nice -n 10 pnpm --filter <package> typecheck` (if you changed `@ao/shared` or `@ao/library`, also the packages that import what you changed);
- if you changed a screen: `nice -n 10 pnpm --filter @ao/ui run lint:css` and `lint:colours`;
- **if you changed a service route or a screen that an end-to-end scenario drives** (search `e2e/*.spec.ts` for the route's address or the button's words): build the interface once (`nice -n 10 pnpm --filter @ao/ui build`) and run THAT ONE spec file in Chromium: `cd <your worktree>/e2e && nice -n 10 pnpm exec playwright test <file>.spec.ts --project=chromium --trace off`. The last round's one real fault passed its review because nobody ran the scenario that covered it. If a scenario fails because it asserted the gap you closed, change nothing in it: say so in your report.
- A time-limit failure is re-run alone before you believe it. The machine's environment sets `NODE_OPTIONS=--max-old-space-size=8192`, which makes ONE unrelated test fail (`packages/library/src/citation/custom-styles.test.ts`, "…needs too much memory…"): ignore that test unless your batch is about it.
- `git status --short` empty at the end.

## Report
Write `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-<your batch, e.g. KG2>-report.md`:
- a table, one row per item: FR | still present? | what changed (file:line) or why nothing | its test, and that it failed first | note;
- every researcher-visible sentence that is new or changed, word for word;
- **NEEDS A RULING** (may be empty);
- what only a real Mac or a real service can show;
- the runs (the last summary line of each).
Final message to the coordinator, at most 180 words: status (DONE / DONE_WITH_CONCERNS / BLOCKED), head commit, how many items built / already closed / need a ruling, the runs in one line. Exactly one final message. If an action is refused by a permission check, do not work around it: say so.
