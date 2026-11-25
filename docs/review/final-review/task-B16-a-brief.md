# Build 16, batch A — lookups: nothing asked for a locked project; the pacing; two small points

You are the implementer of ONE batch of a round of small items, in your own git worktree, on your own branch. Other implementers build other batches at the same time in other worktrees; you never touch theirs.

## Where you work
- Worktree: `/home/user/AlexandrineOxiana/.claude/worktrees/kg-3a` (dependencies installed). Start with:
  `cd /home/user/AlexandrineOxiana/.claude/worktrees/kg-3a && git status --short && git checkout -b b16-a-lookups fe85aac`
  (`git status --short` must be empty before and after; fe85aac is the join branch's head.) Do not push. NEVER `git stash`.

## Read first, in this order
1. `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/kg-common.md`, in full — who the project is for, how you work (tests first and SEEN TO FAIL; the smallest change; one commit per item; single test files only, at `nice -n 10`), and how you report. Where it says "the round's ruling", that is **Ruling R641** for this round; where it names a starting commit, yours is fe85aac; its "Read first" items 1 and 4 hold (the house rules files; each item's full entry in the list).
2. The round's ruling, in full — it says exactly what to build for each of your items, and gives the words where a sentence changes: `grep -n "Ruling R641 " /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-9000` — your part is **"Batch A"**.
3. Each of your items' full entry: `grep -n "^- \*\*FR-NNN\*\* (listed" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-4000`.

## Your items
- **A1 — FR-769 (Important; do this first).** Background you need: commits `b23a81b` (FR-765: a Find run's stop signal reaches every lookup through `LookupContext.signal`; the shared lookup client is never halted) and `5fdd3fe`/`91c5de8` (FR-767: `forgetSensitiveIfLocked` at the end of every attach and Bulk Import run) are in your starting commit — read them (`git show b23a81b --stat`, `packages/library/src/lookup/context.ts`, `lookup/http.ts`). The test file `apps/library-service/src/lock-during-lookups.test.ts` shows the fault: after the lock, a run still asks the next service. The reports: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-FR767-report.md` (NEEDS A RULING 1) and `task-FR765-review2.md` (Minor 1).
- **A2 — FR-768 with FR-753 (2)** (`packages/library/src/lookup/http.ts`, `throttle` ≈ :699–709). Pacing must never be skipped: prove it still holds.
- **A3 — FR-753 (1).**
- **A4 — FR-758** (`packages/library/src/import/look-again.ts`, `settle`).

## Runs
As `kg-common.md` says (single files; prefix `NODE_OPTIONS="--use-openssl-ca"`); every new timing-sensitive test 20 times; the typecheck of each package you changed and of the packages that import what you changed.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-B16-a-report.md`, at most 600 words, as `kg-common.md` says (the table; every sentence a person sees that is new or changed, word for word; NEEDS A RULING; what only a real Mac or service can show; the runs). Final message: at most 180 words. If an action is refused by a permission check, do not work around it: say so.
