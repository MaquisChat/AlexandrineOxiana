# The rough-edges round (Ruling R460) — common brief; your dispatch names your batch

The project's owner has asked for the 94 small rough edges of the final review to be fixed ("group B" of the triage). They are in seven batches by area; you are the implementer of ONE batch, in your own git worktree. Other agents are doing the other six at the same time in theirs.

## Read first, in this order
1. `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-fix-common.md`, in full — who the project is for, where you work, how (tests first; NEVER `git stash`; the smallest change; the commit trailers), how to verify, how to report. Where it says "the finding in the review file" read "the item in the list" (next point). It names `impl-common-reader.md` (the house rules): read that in full too.
2. Your batch's brief (your dispatch names it): the items, one line each.
3. For EACH item, its full entry in the tracked list: `grep -n "FR-123\b" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-2500` (adjust the number). The entry gives the evidence and usually a file and line; the lines are from mid-November and may have moved. Rulings an entry names are in `/home/user/AlexandrineOxiana/docs/handoff/LEDGER.md` (`grep -n "Ruling R123\b" … | cut -c1-6000`).

## For each item
1. **Does it still hold at this head?** Fourteen fix tasks and several later ones have been merged since the list was written; some items are already closed. Check by reading and, where it is quick, by a test. If it is closed: say so in your report with the evidence (the code or the test that closes it) and change nothing.
2. **Test first.** Write the test that shows the rough edge, see it fail for the right reason, then make the smallest change that makes it pass. One commit per item (items named together in one line of your brief may share a commit); the message names the FR number(s) and says in plain words what the researcher now sees.
3. **A rough edge is a small fix.** "size S" is under an hour, "size M" a few hours. If an item turns out to need a decision about what the researcher should see or which of two behaviours is right, or is plainly larger than its size: do NOT guess and do not start it. Put it under "NEEDS A RULING" in your report — what you found, the options, your recommendation (with the exact wording you would use) — and go on with the others.
4. **Wording.** Plain words and whole sentences that say what happened and what the researcher can do next. No jargon, no file path, no secret, no internal name. A sentence shown in two places lives in ONE place (the shared sentences in `packages/shared` where the service and the screens both say it). Before writing a new sentence look for the one the app already uses for the same thing.
5. **The house rules hold for every change:** every change to a library is decided by the policy engine, audited and crash-safe; in the screens, colours come from theme tokens, outside text is shown through `UserText`, never `innerHTML`, and focus is asserted through `document.activeElement`; a found file is never attached without the researcher's confirmation.
6. Never loosen or skip an existing test. A test that asserted the rough edge is changed and named in your report. A test of yours that waits for something waits for the true resting state and asserts it exactly — no sleep, no retry (five tests of this project failed on a slower machine for reading too early).

## Verify
As the first brief says, each at `nice -n 10`: the test files you touched; the whole suite of each package you changed, once; `pnpm -r typecheck`; for a screen `pnpm --filter @ao/ui run lint:css`, `lint:colours` and `run build`. The machine is heavily loaded by the other six: a time-limit failure in a test you did not touch is re-run alone before you believe it; say which. Do not run the end-to-end suites (the coordinator runs them on the joined branches). `git status --short` empty at the end.

## Report
Write `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE<your batch number>-report.md`:
- a table, one row per item: FR | still present? | what changed (file:line) or why nothing | its test, and that it failed first | note;
- **NEEDS A RULING** (may be empty);
- what only a real Mac or a real service can show;
- the runs (the last summary line of each).
Final message to the coordinator, at most 200 words: status (DONE / DONE_WITH_CONCERNS / BLOCKED), head commit, how many items fixed / already closed / need a ruling, the runs in one line. Exactly one final message.
