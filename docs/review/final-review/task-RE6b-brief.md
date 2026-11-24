# Rough-edges round — task RE-6b: the review's points on RE-6 (Ruling R474)

Read first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md` (the round's rules; it names the general brief and the house rules — read those too). Then this. You take over from the implementer of batch RE-6 (Zotero, watched folders, the PDF reader), who has no room left; you have none of their context, so read before you change.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-6-zotero-folders`, branch `re-6-zotero-folders`, at cf70b84 = batch RE-6 as built and reviewed (dependencies and citation styles installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-6-zotero-folders &&`. Do not push.

## Read
1. **Ruling R474, every clause:** `grep -n "Ruling R474" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-7000`.
2. **The review, in full** — the evidence, the probes and file:line for every point (I1, M1–M9) and its section of facts about `check-key`: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE6-review.md`. The reviewer's probes are your first tests.
3. The first implementer's report: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE6-report.md`.

## The points (each: a test first, seen to fail; the smallest change; one commit)
- **I1 (FR-132)** the note about what an import does not bring or apply is also in the "Zotero (web)" wizard's summary (`packages/library/src/import/**/zotero-web.ts` about :1255–1262; the local import says it at `zotero-local.ts` :614) — the same sentence, from one place.
- **M5 (FR-132)** the note is shown where it can matter: what only an UPDATE could do (removals of membership, tags, annotations not applied) is not said on a first import; for automatic account syncs it is in the run's report, not a notice repeated at every sync.
- **FR-507 with M1, M2, M3 — `ao zotero check-key`** (`apps/cli`): after a successful key check it does for every library the SETTINGS FILE lists (this computer's Zotero settings file — not the libraries list) what the app does for its open library: clears the pause "key refused" on every link, and "library gone" where the key now reads that Zotero library; never "undone"; ONE write, under the file's cross-process lock, through the library's own function for it (do not write the file by hand). It then says, in the shared sentences (`packages/shared`), how many links sync again (and nothing of the kind when none was paused); a settings file found damaged and set aside is SAID with the shared sentence the app uses for it, not passed over; a failure to write is said and the command exits non-zero; the key and any path appear in no output. Tests for each (a paused link of each kind in two libraries; "undone" kept; a damaged settings file; the app's own clearing unchanged).
- **M4 (FR-463)** in the Zotero report, the rows that are part of "Updated" (the conflicts; "Cleared in Zotero, kept here") say so, so that the rows are not read as adding up to more than "Items" — wording from one place, the same in the screen and the report file.
- **M6 (FR-454)** the quote's line joining (`packages/ui`, the reader): nothing between the lines also when a Chinese or Japanese character meets a DIGIT across the break; direction marks and zero-width characters at the break do not block the join; Bopomofo counts; a full-width space indenting a paragraph's first line is kept, not dropped. English, Korean, Arabic and Hebrew stay as they are — keep the tests that show it.
- **M7 (FR-467)** the undo's question says what the undo will do when it restores a bin mark (read the review's case).
- **M8 (FR-477)** a sync still running in ANOTHER process is not shown as a run whose end could not be written (nor as "the app was closed"): it reads as running.
- **M9 (FR-475)** the origins keep the order they had before this batch.

## Verify
Your test files; `pnpm --filter @ao/library test`, `pnpm --filter @ao/cli test`, `pnpm --filter @ao/ui test`, `pnpm --filter @ao/shared test`, `pnpm --filter @ao/library-service test` for the packages you changed, once each (heavily loaded machine: re-run alone what fails only on a time limit, and say which; `find-browser-routes.test.ts` "the pause after a hand-over…" is known to fail under load); `pnpm -r typecheck`; `lint:css`, `lint:colours`, `run build` if a screen changed; `git status --short` empty.

Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JfZFTcXP1442Jh7BrkG3hS`.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE6b-report.md`: per point what changed (file:line), its test and that it failed first, the exact sentences; the runs. Final message, at most 180 words: status, head commit, the runs in one line, anything needing a ruling.
