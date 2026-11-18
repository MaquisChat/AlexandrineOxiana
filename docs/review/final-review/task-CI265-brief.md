# Task CI-265 — two unit tests failed on GitHub's machines and nowhere else: find the cause

You have none of the coordinator's context; this brief stands alone. Read the common brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-fix-common.md` (tests first; one commit per point; NEVER use `git stash` — one stash list is shared by every worktree; the commit trailers it gives).

## What happened
The project (a pnpm 10 monorepo, Node 22, TypeScript strict ESM, Vitest) runs its unit tests on GitHub Actions (Ubuntu). Run 265 of the workflow `CI` (commit 6199d25 on branch `claude/pdf-reader-highlights`, tests started 21:11:03 UTC on 17 November 2026) failed in the step `pnpm test` with exactly two failures, both in ONE file, `packages/library/src/find/runner.test.ts` (300 tests, 38 seconds there):

1. `F12: Search sources and Elicit in the runner > Elicit failing never fails or delays an entry: a 401, a 400, a 429 or a 5xx, and the others' sure answer completes the record` — at `runner.test.ts:3082`: `expect(e.reason).toBeUndefined()` received `{ code: "switched-off", by: "settings" }`.
2. `F15: a fetch through the researcher's library > R324 b: the five ways back — cancel, the ticket running out, start-up, a lock, a close — from each resting state: exactly what it was, and the ticket gone` — in `sameRest` at `runner.test.ts:4871` (called from :5047): `expect(e!.reason).toEqual(rest.reason)` expected `{ code: "switched-off", by: "settings" }`, received `{ code: "copy-not-allowed", by: "rules" }`.

The same two tests PASSED:
- on GitHub's previous run of the SAME code apart from one line of the workflow file (run 264, second attempt, unit tests at about 20:26–20:45 UTC the same day);
- in every run on the development machine (Linux, heavily loaded at the time), including two full verifications of this code the same day.

So the failure is intermittent or depends on something that differs between runs (order, timing, load, the clock, the number of workers, leftovers of another test, a random value). The full log of the failed job (15,296 lines; the failures are at about lines 5000–5060; the line `runner.test.ts (300 tests | 2 failed) 38353ms` is line 1650) is at:
`/tmp/claude-0/-home-user-AlexandrineOxiana/ac3b5cb4-f467-5f83-9948-4e7d2e34f036/scratchpad/ci-265-test.log`
(strip the colour codes with `sed -E 's/\x1b\[[0-9;]*m//g'`; do not print the whole file).

## What I need
**The root cause, proven** — not a guess, and not "it is flaky". Use the method of systematic debugging: read the two tests and the code they exercise (`packages/library/src/find/` — the runner and whatever decides an entry's `reason`: "switched-off by settings", "copy-not-allowed by rules"), form hypotheses, and test each by an experiment that can refute it. Things to consider, none of them assumed: state shared between tests of the file (module-level caches, back-off clocks such as "after the 429 Elicit is not asked again for five minutes", settings or rules written by an earlier test); dependence on the real clock or the date; a race between the runner's passes and the test's reads (an `await` that does not wait for the thing it reads); the order of asynchronous completions under a faster or slower machine; a time limit; randomness. Note that the two failures may have ONE cause (the first received the reason the second expected).

Reproduce it: run the file alone many times (`nice -n 10 pnpm --filter @ao/library exec vitest run src/find/runner.test.ts`), run the two tests alone and together (`-t`), with the machine idle and with load, with fewer and more workers, and with small deliberate delays put (temporarily, in your worktree only) at the places your hypothesis names. A cause is proven when you can make the failure happen at will AND make it go away by removing that cause.

**Then say plainly which it is:**
- (A) a fault of the TESTS only (the product does the right thing; the test reads too early, shares state, or expects an order the product does not promise). Then FIX the tests — the smallest change that makes them deterministic, without weakening what they check (no added sleeps "to be safe", no loosened expectation, no retry, no skip) — commit (one commit; message in plain words; trailers as the common brief says), and show the failure can no longer be produced by the experiment that produced it.
- (B) a fault of the PRODUCT (under some order or timing the runner really records the wrong reason for an entry — which a researcher would then see in the app). Then do NOT fix it: write a failing test that shows it (leave it uncommitted in the worktree, named `*.ci265.test.ts`, and say so), and report what the product does wrong, when, and what a researcher would see. The coordinator rules on product behaviour.
- (C) you could not prove a cause. Then say exactly what you tried, what each experiment showed, and what you would try next. Do not change anything.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/ci-flake`, branch `ci-find-runner-flake`, at 6199d25 (dependencies installed). Work only there. Do not push. Do not touch any other worktree or branch. No installs. Do not run the whole suite or the end-to-end tests; the library package's `src/find` tests and `pnpm -r typecheck` are enough to check a fix. Temporary data only under `os.tmpdir()`. Leave `git status --short` empty at the end (case B's one test file excepted).

## Report
Write `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-CI265-report.md`: the cause in three or four sentences; the evidence (each experiment and its result, briefly); which case (A, B or C); for A the commit and the runs after it; anything uncertain. No file dumps.

Final message to me, at most 150 words: the case, the cause in two sentences, the head commit, the runs, anything needing my ruling.
