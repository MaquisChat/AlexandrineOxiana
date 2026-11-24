# Rough-edges round — task RE-7c: looking at a held file before deciding (FR-490; Ruling R470 b)

Read first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/re-common.md` (the round's rules; it names the general brief and the house rules — read those too). Then this. You take over one point from the implementer of batch RE-7 (Find and acquire and the desktop shell), who has no room left; you have none of their context, so read before you change.

## Where
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/re-7c`, branch `re-7c-find`, at 7a8f5ee = batch RE-7 as built (dependencies and citation styles installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/re-7c &&`. Two other agents are building other points of this batch in their own worktrees, and a reviewer is reading the batch in a fourth: stay in yours. Do not push.

## Read
1. **Ruling R470, its part (b):** `grep -n "Ruling R470" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-7000`; and R301, R303 (a found file is never attached without the researcher's confirmation).
2. The first implementer's findings — the section "NEEDS A RULING", FR-490, of `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE7-report.md`; the list entry: `grep -n "FR-490\b" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-2500`.
3. The code: where held files live and how they are sealed (`packages/library/src/find`: `find/held/<entry>.<pdf|epub>`, encrypted in an encrypted project) and read; how the service serves an ATTACHED file's content to the reader by ranges (the asset content route, `apps/library-service/src`; `packages/library/src/asset-content.ts`, `crypto/random-access.ts`), with its token, Host and Origin checks, its refusal while a project is locked, and its plain errors; the reader in `packages/ui` (how it gets its bytes; where highlights, notes and the "last page" are written); the found-file cards in `packages/ui/src/screens/FindAcquire.tsx`; `FilePreview` and its sentence "No preview of this file can be shown here."; and how a lock behaves (Rulings R435–R445: a lock takes effect at once — a read cut by a lock ends as "locked").

## What to build (tests first, each seen to fail; one commit per step)
1. **A read-only route for a held file** — the app's own (the token, the Host and Origin checks as every route; NOT among the browser extension's routes), by ranges like the asset content route and through the same reading code (do not write a second decrypting reader), for the held file of ONE entry of ONE project; refused while the project is locked ("locked", never "damaged"); a lock landing mid-read ends the read as locked; errors in plain words with no path; nothing recorded, nothing audited as a change, nothing written anywhere by a look; an entry with no held file, a held file that is gone, an entry of another project: plain refusals that tell nothing more than today's routes tell.
2. **"Look at the file"** on each found-file card (an accessible name that says which reference): for a PDF it opens the app's reader on that route in a LOOK-ONLY mode — no highlights, no notes, no "last page" remembered, no citation or source actions, nothing attached and nothing written by looking; a visible line says what it is ("This file has not been added to your library. Use this file, or Not this file, on the Find and acquire screen."); closing it returns to the card with focus on the control that opened it. For an EPUB (the reader is PDF-only) the card says "No preview of this file can be shown here." and offers no look.
3. Add a row to the lock-mid-read harness for the new reader if that harness lists every reader of an encrypted project (`packages/library/src/repo/lock-mid-read.test.ts`; read its header: a new reading of sealed content belongs in it).
4. The screen's dialogs and focus follow the house rules (a dialog is never confirmed by the key that opened it; focus through `document.activeElement` in the tests).

If the reader cannot be given a look-only mode without a change larger than a few hours, stop and say what it needs.

## Verify
Your test files; `pnpm --filter @ao/library-service test`, `pnpm --filter @ao/ui test`, and the library's tests for what you touched, once each (heavily loaded machine: re-run alone what fails only on a time limit, and say which; `find-browser-routes.test.ts` "the pause after a hand-over…" is known to fail under load); `pnpm -r typecheck`; `lint:css`, `lint:colours`, `run build`; `git status --short` empty.

Commit trailers: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01JfZFTcXP1442Jh7BrkG3hS`.

## Report
`/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-RE7c-report.md`: per step what changed (file:line), its tests and that they failed first, the exact sentences; what a look can and cannot write, and the test that shows it; anything needing a real browser or Mac. Final message, at most 180 words: status, head commit, the runs in one line, anything needing a ruling.
