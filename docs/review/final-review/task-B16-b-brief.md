# Build 16, batch B — the move, the audit reader, two sentences, two checks

You are the implementer of ONE batch of a round of small items, in your own git worktree, on your own branch. Other implementers build other batches at the same time in other worktrees; you never touch theirs.

## Where you work
- Worktree: `/home/user/AlexandrineOxiana/.claude/worktrees/kg-3b` (dependencies installed). Start with:
  `cd /home/user/AlexandrineOxiana/.claude/worktrees/kg-3b && git status --short && git checkout -b b16-b-move-audit fe85aac`
  (`git status --short` must be empty before and after; fe85aac is the join branch's head.) Do not push. NEVER `git stash`.

## Read first, in this order
1. `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/kg-common.md`, in full — who the project is for, how you work (tests first and SEEN TO FAIL; the smallest change; one commit per item; single test files only, at `nice -n 10`), and how you report. Where it says "the round's ruling", that is **Ruling R641** for this round; where it names a starting commit, yours is fe85aac; its "Read first" items 1 and 4 hold (the house rules files; each item's full entry in the list).
2. The round's ruling, in full — it says exactly what to build for each of your items, and gives the words where a sentence changes: `grep -n "Ruling R641 " /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-9000` — your part is **"Batch B"**.
3. Each of your items' full entry: `grep -n "^- \*\*FR-NNN\*\* (listed" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-4000`.

## Your items
- **B1, B2 — FR-760 (1) and (2)** (`packages/library/src/move.ts` and its tests; the strict refusal of FR-068 is in your starting commit: read `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-FR068-strict-report.md`).
- **B3 — FR-766** (the words are in the ruling).
- **B4 — FR-751** (`packages/library/src/retention.ts`; the words are in the ruling).
- **B5 — FR-761**: a CHECK first; mend the reader only if it can really return events out of order.
- **B6 — FR-752**: a CHECK ONLY. Build nothing. Write what you found into the report under its own heading (at most 200 of your 600 words).

## Runs
As `kg-common.md` says (single files; prefix `NODE_OPTIONS="--use-openssl-ca"`); every new timing-sensitive test 20 times; the typecheck of each package you changed and of the packages that import what you changed.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-B16-b-report.md`, at most 600 words, as `kg-common.md` says (the table; every sentence a person sees that is new or changed, word for word; NEEDS A RULING; what only a real Mac or service can show; the runs). Final message: at most 180 words. If an action is refused by a permission check, do not work around it: say so.
