# Rough-edges round — task RE-7e: the review's small points on RE-7 (Ruling R472)

Read first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md` (the round's rules; it names the general brief and the house rules — read those too). Then this. You take over from the implementer of batch RE-7, who has no room left; you have none of their context, so read before you change.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-7-find-shell`, branch `re-7-find-shell`, at 7a8f5ee = batch RE-7 as built and reviewed (dependencies and citation styles installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-7-find-shell &&`. Three other agents are building other points of this batch in their own worktrees (one of them the shell's part of FR-561): stay in yours and do NOT touch `apps/desktop/src-tauri` (no Rust, no build of the shell). Do not push.

## Read
1. **Ruling R472, every clause:** `grep -n "Ruling R472" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-6000`.
2. **The review, in full** — the evidence, the probes and file:line for every point: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE7-review.md`. The reviewer's probes are your first tests.
3. The first implementer's report: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE7-report.md`.

## The points (each: a test first, seen to fail; the smallest change; one commit)
- **FR-577** (`packages/library/src/extract/pdf.ts` and its callers): the comments must not say the file is never read whole — a damaged or crafted PDF still costs about twice its size in memory, as before the change: say exactly when the whole file is read. If the size limit that a handed-over or held file already has is at hand where this code is called, refuse a larger file before parsing with the sentence that limit already uses, and prove it with a test; if no such limit is at hand there, change nothing in behaviour and say so in your report (it is then listed).
- **FR-576** (`packages/ui/src/screens/FindAcquire.tsx`): the "service cannot be reached" sentence is shown ONCE also when both the settings' read and the queue's read fail (the reviewer's case).
- **FR-558, FR-529**: a request that the screen gives up on as never answering is CANCELLED (the client's abort), so that given-up requests do not pile up against the web view's connection limit; a late answer of a cancelled request changes nothing on the screen. Count the open requests in a test across many give-ups.
- **FR-557**: "Wait until the test has started." (and its sibling "Wait until signing out is finished.") is not left standing when the test (or the sign-out) then fails: the failure's own sentence is what shows; it is announced once.
- **FR-561, the page's side only:** the check built in `FindAcquire.tsx` may stay as a second guard, but its comment must say that the shell is the guard (another agent is making the shell close a sign-in window only by the ticket of the open that made it) and must not claim more than it does. Do not move or rebuild it.
- The tests wait for the true resting state (no sleep, no retry, no read between two renders).

## Verify
Your test files; `pnpm --filter @ao/ui test` and `pnpm --filter @ao/library exec vitest run src/extract src/find` once each (heavily loaded machine: re-run alone what fails only on a time limit, and say which); `pnpm -r typecheck`; `pnpm --filter @ao/ui run lint:css`, `lint:colours`, `run build`; `git status --short` empty.

Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JfZFTcXP1442Jh7BrkG3hS`.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE7e-report.md`: per point what changed (file:line), its test and that it failed first; for FR-577 whether a size limit was at hand; the runs. Final message, at most 150 words: status, head commit, the runs in one line, anything needing a ruling.
