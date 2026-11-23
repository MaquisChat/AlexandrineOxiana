# Rough-edges round — task RE-1c: the review's points on RE-1, all but FR-425 (Ruling R473)

Read first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md` (the round's rules; it names the general brief and the house rules — read those too). Then this. You take over from the implementer of batch RE-1, who has no room left; you have none of their context, so read before you change.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-1-core`, branch `re-1-core`, at 05451c3 = batch RE-1 as built and reviewed (dependencies and citation styles installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-1-core &&`. Another agent is working on the write queue and on FR-425 in ANOTHER worktree: **do not touch `packages/library/src/repo/sources.ts`, `repo/repo.ts`'s warnings, `reconnect.ts`, `retention.ts`** — if a point of yours needs one of them, stop that point and say so. Do not push.

## Read
1. **Ruling R473, every clause:** `grep -n "Ruling R473" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-9000`. Its corrected sentences are exact: use them word for word.
2. **The review, in full** — the evidence, the probes and file:line for every point (I2, I3, M1–M7; I1 is not yours): `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE1-review.md`. The reviewer's probes are your first tests.
3. The first implementer's report: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE1-report.md`; and R365 for what FR-410/618 is about: `grep -n "Ruling R365" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-6000`.

## The points (each: a test first, seen to fail; the smallest change; one commit)
- **I2 + M5 (FR-410/618) — the export's sentences about files left out.** `packages/library/src/export/project-export.ts` (about :377–393, :446, :507–511). Four cases, four sentences (plurals likewise: "N files are not included. They were left out … name them as destroyed."):
  - a restored copy, the file left out on records the app could NOT verify: "1 file is not included. It was left out when this project was restored from a backup, because records the app could not verify name it as destroyed."
  - a restored copy, the file left out on a VERIFIED record (possibly another project's): "1 file is not included. It was left out when this project was restored from a backup, because a verified record in this library shows it was destroyed."
  - the project's own log does not verify: "1 file is not included. It is marked as destroyed, but the project's audit log does not hold together, so the app cannot confirm it."
  - a destruction by the project's OWN verified record: "1 file was destroyed under the project's retention rule." (as today).
  A test for each, with the reviewer's probes A, B, C as the set-ups; no sentence says more than its evidence gives.
- **M1** a copy restored BEFORE this change has a count (`leftOutUnverified`) and no list in its `project.restored` entry: its export, and a restore of its backup, do not state those destructions as fact — treat every file that restore left out as unverified (the reviewer suggests how to find them); if they cannot be told apart, use the unverified sentence for all of that restore's.
- **M2** the export reads the log BEFORE it makes its `.partial` folder (or inside the same `try`): a read that fails leaves no folder and nothing in `activePartials`.
- **I3 (FR-124) — two works never mixed in one record.** `packages/library/src/import/resolve.ts` (about :497–505 and step 4, :528–537): when a sidecar or a later step brings the item's OWN title, the fields that only the lookup of a cited identifier gave (container, volume, issue, pages, publisher… every field of that lookup) are taken out of the draft and kept as the candidate the review step shows with its origin (`LOOKED_UP_FROM_TEXT`); while any value of that lookup IS in the draft, the reason is said. The reviewer's sidecar probe is the test. The rulings on title look-ups (R394, R410, R422, R425, R446) stay as they are — name any test whose expectation you change.
- **M7 (FR-123)** the sentence says "found in the file", not "found in the file's text".
- **M3 (FR-411)** `packages/library/src/library.ts` `registerLibrary` and the reads (`listLibraries`): within the process the writer reads the list again and merges its change just before it saves (so a change made by another writer since is not lost), and a read that would fall between a writer's rename and its save waits for that writer's turn. Correct the report's wrong statement in a comment where it matters. The race between two PROCESSES is listed (FR-721): do not build a lock file.
- **M4 (FR-030)** `packages/library/src/repo/move.ts` about :483 and `packages/core`'s policy sentence about `engine.ts` :280: when the destination's kind was only guessed, one plain sentence that says "may be" and holds no internal name ("The library's new place may be a cloud-synced folder; …" — keep the rest of the existing sentence); the cloud-folder refusal is a plain whole sentence with no id and no "(unspecified)".
- **M6 (FR-106)** the count of caption edits that could not be checked is said ONE way, from one place in `packages/shared`: "N possible edits could not be checked. Capture the profile again later to check them." (singular: "1 possible edit could not be checked. Capture the profile again later to check it."), used by the command line, the capture queue and the report file.

## Verify
Your test files; `pnpm --filter @ao/core test`, `pnpm --filter @ao/library test`, and the suites of any other package you changed, once each (heavily loaded machine: re-run alone what fails only on a time limit, and say which); `pnpm -r typecheck`; `git status --short` empty.

Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JfZFTcXP1442Jh7BrkG3hS`.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE1c-report.md`: per point what changed (file:line), its test and that it failed first, the exact sentences; the tests whose expectation changed; the runs. Final message, at most 180 words: status, head commit, the runs in one line, anything needing a ruling.
