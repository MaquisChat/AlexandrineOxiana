# Build 16, batch D — event streams that reconnect, and the missing-files check's progress

You are the implementer of ONE batch of a round of small items, in your own git worktree, on your own branch. Other implementers build other batches at the same time in other worktrees; you never touch theirs.

## Where you work
- Worktree: `/home/user/AlexandrineOxiana/.claude/worktrees/kg-8` (dependencies installed). Start with:
  `cd /home/user/AlexandrineOxiana/.claude/worktrees/kg-8 && git status --short && git checkout -b b16-d-streams fe85aac`
  (`git status --short` must be empty before and after; fe85aac is the join branch's head.) Do not push. NEVER `git stash`.

## Read first, in this order
1. `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/kg-common.md`, in full — who the project is for, how you work (tests first and SEEN TO FAIL; the smallest change; one commit per item; single test files only, at `nice -n 10`), and how you report. Where it says "the round's ruling", that is **Ruling R641** for this round; where it names a starting commit, yours is fe85aac; its "Read first" items 1 and 4 hold (the house rules files; each item's full entry in the list).
2. The round's ruling, in full — it says exactly what to build for each of your items, and gives the words where a sentence changes: `grep -n "Ruling R641 " /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-9000` — your part is **"Batch D"**.
3. Each of your items' full entry: `grep -n "^- \*\*FR-NNN\*\* (listed" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-4000`.

## Your items
- **D1 — the two event streams without a reconnect** (the governance route's and the reader hand-off's). How the other consumers do it: `packages/ui/src/api/firstRead.ts`, `events({ openWithinMs })`, and the reports `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-FR756a-report.md` and `task-FR756-remainder-report.md` ("Listed, not built"). Ruling R597 (read it): the opening limit is turned on consumer by consumer, each with a test, never by default.
- **D2 — a stream that opens and then never delivers.** Find out first whether the service's event stream sends anything regularly (a heartbeat); say what you found.
- **D3 — the missing-files check shows its progress.** FIRST size it: read how the check runs today (the service route, the engine, the screen) and write down what progress and "Stop" would need. If it fits the ruling's limit (about 200 lines of product code, no new kind of background job), build it; if not, put the design and its size in the report and build nothing for D3.

## Runs
As `kg-common.md` says (single files; prefix `NODE_OPTIONS="--use-openssl-ca"`); every new timing-sensitive test 20 times; the typecheck of each package you changed and of the packages that import what you changed.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-B16-d-report.md`, at most 600 words, as `kg-common.md` says (the table; every sentence a person sees that is new or changed, word for word; NEEDS A RULING; what only a real Mac or service can show; the runs). Final message: at most 180 words. If an action is refused by a permission check, do not work around it: say so.
