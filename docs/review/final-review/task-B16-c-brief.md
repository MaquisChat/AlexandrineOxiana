# Build 16, batch C — screens: the alive-flag, four untidy points, and a 'Back up now' button

You are the implementer of ONE batch of a round of small items, in your own git worktree, on your own branch. Other implementers build other batches at the same time in other worktrees; you never touch theirs.

## Where you work
- Worktree: `/home/user/AlexandrineOxiana/.claude/worktrees/kg-7` (dependencies installed). Start with:
  `cd /home/user/AlexandrineOxiana/.claude/worktrees/kg-7 && git status --short && git checkout -b b16-c-screens fe85aac`
  (`git status --short` must be empty before and after; fe85aac is the join branch's head.) Do not push. NEVER `git stash`.

## Read first, in this order
1. `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/kg-common.md`, in full — who the project is for, how you work (tests first and SEEN TO FAIL; the smallest change; one commit per item; single test files only, at `nice -n 10`), and how you report. Where it says "the round's ruling", that is **Ruling R641** for this round; where it names a starting commit, yours is fe85aac; its "Read first" items 1 and 4 hold (the house rules files; each item's full entry in the list).
2. The round's ruling, in full — it says exactly what to build for each of your items, and gives the words where a sentence changes: `grep -n "Ruling R641 " /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-9000` — your part is **"Batch C"**.
3. Each of your items' full entry: `grep -n "^- \*\*FR-NNN\*\* (listed" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-4000`.

## Your items
- **C1 — FR-762** (`packages/ui/src/screens/Library.tsx`, `AuditLog.tsx`).
- **C2 — FR-756's four untidy points.** They are described at the end of FR-762's entry in the list and in Ruling R623 (`grep -n "Ruling R623 " /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-6000`). The rule they must keep — one sentence and one "Try again" per page, "could not be reached" wins over "did not answer in time" — lives in `packages/ui/src/components/PageReads.tsx` and `packages/ui/src/api/firstRead.ts`; read `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-FR756-common.md` for how the screens use it.
- **C3 — FR-754: the "Back up now" button** in the project's settings (the route exists: `apps/library-service/src/routes/projects.ts`, `POST /projects/:id/backups`). The words are in the ruling. Colours from theme tokens only; text through `UserText` where it comes from outside; a browser scenario in `e2e/` covers the button (run THAT ONE spec file in Chromium, as `kg-common.md` says).

## Runs
As `kg-common.md` says (single files; prefix `NODE_OPTIONS="--use-openssl-ca"`); every new timing-sensitive test 20 times; the typecheck of each package you changed and of the packages that import what you changed.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-B16-c-report.md`, at most 600 words, as `kg-common.md` says (the table; every sentence a person sees that is new or changed, word for word; NEEDS A RULING; what only a real Mac or service can show; the runs). Final message: at most 180 words. If an action is refused by a permission check, do not work around it: say so.
