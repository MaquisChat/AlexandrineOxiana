# Build 16, batch D — second fix round (Ruling R658): two small mends

You are a fresh implementer. Work ONLY in the git worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-8` (branch `b16-d-streams`, head 9fb7369; dependencies installed). Do not push. Never `git stash`. Tests first: write the test, SEE IT FAIL for the right reason, then the smallest change.

Read first: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/kg-common.md` — only its sections "For each item" (points 2, 3, 6), "Verify" and the last line of "Report". The app is a research workbench; its screens follow live "streams" of events from a local service (`client.events(...)` in `packages/ui/src/api/client.ts`), and reopen a stream that dropped, did not open in time (`openWithinMs`) or stayed silent past a limit (`quietWithinMs`).

## Mend 1 — the import's run step starts its count again after a connection that proved itself (review M5)

`packages/ui/src/screens/import/StepRun.tsx`, the loop `for (let tries = 0; !stop && !over.current; tries++)` (≈ lines 84–118). `tries` is never set back. So over one long import, a few silences (the Mac slept three or four times, say) end in the notice "progress updates are not available" with "Check again", although every reconnect worked.

Ruled:
- The count starts again (back to zero) when a connection has **proved itself**: (i) an event arrived on it — any event the loop receives from `client.events`, whether or not it is this batch's; or (ii) the try ended because the OPEN stream stayed silent to its limit (`quietWithinMs`), i.e. it had been open and quiet for the whole limit.
- The count does **not** start again when a stream opens and closes at once, or when it was not opened in time. The existing test `packages/ui/src/screens/import/ImportWizard.test.tsx` › "run screen (R115 I5)" › "a stream that closes after connecting does not leave the screen on Starting…" must stay exactly as it is and pass.
- To tell (ii) from "not opened in time": read how the client ends each (`client.ts` ≈ lines 418–470; both end with the same sentence, `SERVICE_NO_ANSWER`). Prefer remembering in `onOpen` that this try opened, and treating "opened, then ended with the client's did-not-answer-in-time error" as (ii). Do not change `client.ts` unless there is no other way; if you must, say why in your report.
- No word on any screen changes.

Tests (in `packages/ui/src/screens/import/ImportWizard.firstReads.test.tsx`, beside the existing "R641 D2" test at ≈ line 221, on its pattern):
1. more silences in a row than the reconnect limit, each after an open: the notice does NOT appear and the step is still following (fails before the mend);
2. an event arrives, then the stream drops, more times than the limit: no notice (fails before the mend);
3. the R115 I5 test above passes unchanged; and a stream not opened in time, more times than the limit, still ends in the notice (name the existing test that covers it, or add one).

## Mend 2 — the reader's pause removes its listener (same as review M4)

`packages/ui/src/routes/reader.tsx` ≈ lines 328–331: the pause before the stream is listened to again adds an `abort` listener on each round and never removes it when its timer fires, so they pile up over a long outage. Mend it exactly as `packages/ui/src/routes/governance.tsx` ≈ lines 101–109 does (commit e21b664), with a test on the pattern of that commit's test in `packages/ui/src/routes/governance.test.tsx` (it counts live listeners); it must fail first.

## The tests must be certain (the last round's review finding I1 and "answer 4")
- Where a test asserts that a request was cancelled, keep the mock's `request` object and read `request.signal.aborted` when asserting. Never store the signal alone (a stored signal can miss an abort after garbage collection).
- Never assert on real timers that something "has not happened yet": use a fake clock, or hold the next try unopened so the screen rests. A promise a test holds back is released when the test ends (`onTestFinished`).
- Run each test file you touched 30 times under load and report the count: start four busy loops (`for i in 1 2 3 4; do (while :; do :; done) & done`), run the file 30 times with `NODE_OPTIONS="--use-openssl-ca" nice -n 10 pnpm --filter @ao/ui exec vitest run <path> --testTimeout 120000`, then kill the loops (`kill $(jobs -p)`); leave nothing running.

## Verify
The touched test files plus `ImportWizard.test.tsx`, `reader.firstReads.test.tsx`, `Reader.test.tsx`, each by path as above (once, without load); `nice -n 10 pnpm --filter @ao/ui typecheck`. `git status --short` empty at the end.

## Commits
One commit per mend. Each message ends with exactly these two lines:

    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_01JfZFTcXP1442Jh7BrkG3hS

No model name anywhere else.

## Report
Append a section "Second fix round (R658)" to `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-B16-d-report.md`: per mend the file:line, its tests and that each failed first, the 30× counts, the runs' last lines. Final message, at most 120 words: status, head commit, the counts, anything uncertain. If an action is refused by a permission check, do not work around it: say so.
