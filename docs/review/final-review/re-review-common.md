# The rough-edges round (Ruling R460) — the reviewer's brief; your dispatch names your batch

Read the general reviewer's brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-fix-review-common.md`. Then this.

## What you review
The project's owner asked for the 94 small rough edges of the final review to be fixed. They were built in seven batches by area, each by one implementer in its own git worktree. You review ONE batch: your dispatch names its worktree, its branch, its head commit, its brief and its report.

Read, in this order:
1. the round's rules for the implementer: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md` (what a rough edge is, what had to be checked first, what had to come back for a ruling instead of being guessed);
2. the batch's brief (`task-RE<n>-brief.md` in the same folder) and the implementer's report (`task-RE<n>-report.md`): a table with one row per item — still present? what changed, its test;
3. for each item, its full entry in the tracked list: `grep -n "FR-123\b" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-2500`;
4. the whole change once: `git diff 567d98d..HEAD` in the worktree (and `git log --oneline 567d98d..HEAD`).

## For EACH item of the batch
- **Said to be fixed:** does the change remove the rough edge the entry describes — the whole of it, in every place it showed — and nothing else? Try to make the rough edge appear again with your own probe (a different input, another screen that shows the same sentence, the other order of events, the keyboard instead of the mouse, a right-to-left name, an encrypted or locked project, a read-only library, the service answering late or not at all). Does its test fail without the fix (check by reading, or with a scratch copy if your edits of tracked files are refused — say which you could only judge by reading)? Does the test wait for the true resting state (no sleep, no retry, no read between two renders)?
- **Said to be closed already:** is it? Find the code or test that closes it and try the entry's own example.
- **Sent back for a ruling:** was that right — or is the fix in fact small and plain (say what it is), or the opposite, was something that needed a decision built anyway?
- **Wording:** every new or changed sentence a researcher can see — plain words, a whole sentence, what happened and what to do next, no path, no secret, no internal name; the same thing said the same way everywhere (look for the old sentence still standing somewhere); true in every case in which it is shown.
- **The house rules:** a library change decided by the policy engine, audited, crash-safe; no absolute path stored or shown; colours from theme tokens, outside text through `UserText`, never `innerHTML`; a found file never attached without the researcher's confirmation; focus where a keyboard or screen-reader user needs it after the change.
- **What else the change touched:** an exported function's behaviour that other callers rely on; a shared sentence used elsewhere; a test of another area that now passes for a different reason.

## Rules for you
Probes next to the code, named `*.probeRE<n>.test.ts` (or `.tsx`), run alone at `nice -n 10` (`pnpm --filter <package> exec vitest run <path>`), every one deleted before you finish; `git status --short` empty at the end; no commits, no `git stash` (one list shared by every worktree), no installs, no whole suites, no end-to-end runs, no build of the Rust shell unless your dispatch says so; temporary data only under `os.tmpdir()`. EVERY shell command starts with the `cd` into the worktree your dispatch names. The machine is heavily loaded: a time-limit failure is re-run alone before you believe it.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE<n>-review.md`: findings by severity (Critical / Important / Minor), each with the FR number, file and line, the evidence and the probe that shows it; then a table, one row per item: FR | the implementer's claim | your verdict (holds / does not hold / partly) | note; what you could only judge by reading; the verdict for the batch (approve / approve with small points / not approved). Final message to the coordinator, at most 200 words.
