# The known-gaps round (Rulings R502, R503, R505) — the reviewer's common brief; your dispatch names your batch

Read the general reviewer's brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-fix-review-common.md`. Then this, then your batch's review brief.

## What you review
The owner said "keep building": this round builds the gaps the round before listed and did not build (FR-717 to FR-741), in batches by area, each by one implementer in its own git worktree from the head 579bdcd. You review ONE batch, as an adversary: your job is to find what is wrong with it before a researcher does.

Read, in this order:
1. the round's rules for the implementer: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/kg-common.md`;
2. the round's rulings, in full — R503 rules what had to be built for each item, R505 rules on what the implementers' reports asked: `grep -n -E "Ruling R50[35]\b" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-9500`;
3. the batch's brief (`task-KG<n>-brief.md`) and the implementer's report (`task-KG<n>-report.md`), both in `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/`;
4. for each item, its full entry: `grep -n "FR-738\b" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-3000` (adjust the number), and the rulings it names;
5. the whole change once, in full: `git log --oneline 579bdcd..HEAD` and `git diff 579bdcd..HEAD` in the worktree.

## For EACH item
- **Built as ruled?** Does the change do what R503 (and R505) ruled — the whole of it, in every place — and nothing else? Where the implementer departed from the ruling or the brief, was that right, and is it said in the report?
- **Break it.** Try to make the gap appear again, or a new fault appear, with probes of your own: a different input, the other order of events, a crash or a lock or a close in the middle, an encrypted or locked project, a read-only library, the service answering late or not at all, two acts at once, the keyboard instead of the mouse, a right-to-left name.
- **Each guard has a test that fails without it** (check by a scratch edit that you restore, or by reading — say which you could only judge by reading). Each test waits for the TRUE resting state: no sleep, no retry; a promise a test holds back is released whatever the test's end.
- **Wording:** every new or changed sentence a researcher can see — plain words, a whole sentence, what happened and what to do next, no path (unless R503 allows one for that item), no secret, no internal name; the same thing said the same way everywhere; TRUE in every case in which it is shown.
- **The house rules:** every change to a library decided by the policy engine, audited, crash-safe; nothing a person put in the library folder deleted by the app's own repair; no absolute path stored or shown; colours from theme tokens, outside text through `UserText`, never `innerHTML`; a found file never attached without the researcher's confirmation, nothing fetched that was not asked for; focus where a keyboard or screen-reader user needs it.
- **What else the change touched:** an exported function's behaviour other callers rely on; a shared sentence used elsewhere; an existing test that was changed (the report names them: was each change right, or was an assertion loosened?).

## Rules for you
- EVERY shell command starts with the `cd` into the worktree your dispatch names. Change no product code; no commits; NEVER `git stash` (one list shared by every worktree); no installs; no network.
- Probes next to the code, named `*.probeKG<n>.test.ts` (or `.tsx`, `.mjs`, `.py`), every one deleted before you finish; a scratch edit of product code is restored at once (`git checkout -- <file>`); temporary data only under `os.tmpdir()`; `git status --short` empty at the end.
- SINGLE test files only, at `nice -n 15`, one at a time: `nice -n 15 pnpm --filter <package> exec vitest run <path> --testTimeout 120000` (packages `@ao/core`, `@ao/library`, `@ao/library-service`, `@ao/ui`, `@ao/cli`, `@ao/shared`). No whole suites, no `pnpm -r`. Other reviewers share the machine (4 cores): a time-limit failure is re-run alone before you believe it. The machine's environment sets `NODE_OPTIONS=--max-old-space-size=8192`, which makes one unrelated test fail (`packages/library/src/citation/custom-styles.test.ts`, "…needs too much memory…"): ignore it.
- You MAY run ONE end-to-end spec file in Chromium where your brief says a scenario covers what was changed and the implementer's report does not show it was run (the interface must be built first: `nice -n 15 pnpm --filter @ao/ui build`, then `cd <worktree>/e2e && nice -n 15 pnpm exec playwright test <file>.spec.ts --project=chromium --trace off`). Nothing else end to end; no build of the Rust shell unless your brief says so.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-KG<n>-review.md`: findings by severity (Critical / Important / Minor), each with the FR number, file and line, the evidence and the probe that shows it (or the reasoning, marked as reading only); then a table, one row per item: FR | the implementer's claim | your verdict (holds / does not hold / partly) | note; what you could only judge by reading; the verdict for the batch (approve / approve with small points / not approved). Final message to the coordinator, at most 200 words: the verdict, the count of findings by severity, and each Critical or Important finding in one line.
