# FR-756, the other screens — what both builders share

You are an implementer on a TypeScript monorepo (pnpm 10, Node 22, strict TypeScript, ESM, Vitest; the React 19 page is `packages/ui`, tested with Vitest + Testing Library + MSW; browser scenarios in `e2e/` with Playwright): "Alexandrine Oxiana", a local-first research library app for social scientists. The page talks to a local service over HTTP and an event stream. You have no other context: everything you need is named in your brief and here. Tests first (each seen to fail before its fix); the smallest change that makes each ruled property true.

## The fault
Opened by its address (or reloaded), a screen makes its first reads. A read the browser never settles — neither answered nor failed (seen in the WebKit test browser at a reload) — leaves the screen at its loading words for ever, with no error and no "Try again". This has been mended for four screens; you mend the screens named in your brief by the SAME pattern.

## Read first
1. The house rules: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/kg-common.md`.
2. The item: `grep -n "FR-756" /home/user/AlexandrineOxiana/docs/review/final-review/final-review-list.md | cut -c1-3000`.
3. The rulings: `grep -n -E "Ruling R(579|586|591|597)\b" /home/user/AlexandrineOxiana/docs/handoff/LEDGER.md | cut -c1-7000`.
4. The pattern, built and in your checkout: `packages/ui/src/api/firstRead.ts` (`readWithin`, `FIRST_READ_TIMEOUT_MS` = 20 s, `isUnreachable`); `packages/ui/src/api/client.ts` (`noAnswerInTime`, the two sentences: "The library service did not answer in time." for a read given up at the limit, the existing "could not be reached" words for a failed request — never merged, never both; `events({ openWithinMs })` and `STREAM_OPEN_TIMEOUT_MS`); how `packages/ui/src/screens/FindAcquire.tsx`, `WatchedFolders.tsx`, `ZoteroSync.tsx`, `Library.tsx` and `routes/library.tsx` use them, with their tests (`*.test.tsx`, `Library.firstReads.test.tsx`; the test helper `packages/ui/src/test/service.ts` can hold a request so that it never settles, and can make a stream attempt hang). The reports, for reasoning and traps already met: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-FR750-report.md`, `task-FR750-review.md`, `task-FR756a-report.md` (skim).

## The rule for every screen you mend
- Every FIRST read the screen needs in order to show itself gets the limit (`readWithin`, 20 s). A read given up at the limit or failed shows the screen's EXISTING kind of alert (`role="alert"`), with the true one of the two sentences, and a real "Try again" button that makes the read(s) again and shows the loading words meanwhile. Where the screen already handles a FAILED read, keep what it shows; add only the never-settles case and "Try again" if it is missing.
- A read the screen does not need in order to show itself (a count, a side panel) must not block it; list each in your report and say what it does when it fails or hangs.
- The limit is for READS only: acts (a save, an attach, a move, an import) have no such limit.
- A late answer of a read that was given up changes nothing (the request is cancelled).
- Focus is not lost when the alert replaces the loading words (follow FindAcquire).
- No new sentence unless a screen has none that is true: then propose it in your report and use it (plain, short, no jargon).
- Colours from theme tokens only; user and source text through `UserText`, never `innerHTML`.
- Do not change `packages/ui/src/api/firstRead.ts`, `api/client.ts`, `test/service.ts` in a way that changes what an existing export means (add only; say what you added). Do not change the service, the engine, or any screen not named in your brief.

## Mechanics
- EVERY shell command starts with `cd <your worktree> &&`. Never `git stash`. Do not push. No new dependencies. Start test commands with `NODE_OPTIONS="--use-openssl-ca"`. Run SINGLE test files (`nice -n 10 pnpm --filter @ao/ui exec vitest run <file>`), one at a time: other agents run tests in other checkouts on this machine; a time-out under load is run again alone before it is believed. No test may reach a public host. First check that one existing test file runs in your checkout; if a workspace package must be built first, build it.
- At the end: every new and changed test file, each alone; every other test file of each screen you changed; `pnpm --filter @ao/ui run typecheck`, `lint:css`, `lint:colours` (see `packages/ui/package.json` for the exact names). No browser scenario is asked for unless your brief says so. `git status --short` empty; no background process left.
- COMMITS on your branch, one per screen or family (tests with the code they prove; plain words; name FR-756 and the screen), each ending with exactly:

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JfZFTcXP1442Jh7BrkG3hS

- STOP AND REPORT (a clear question is a good result) if a screen's first read is also an ACT (it changes something at the service), or if the pattern cannot be applied without changing what a screen shows on a FAILED read.
- If an action is refused by a permission check, do not work around it: say so.
