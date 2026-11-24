# KG-3a fix 3: the intermittent FR-720 failures in `device-notices.test.ts` (R540 a)

Worktree `.claude/worktrees/kg-3a`, branch `kg-3a-service`, from 57d550c. Not pushed.

## Verdict: (b), a race in the TESTS' set-up. The product never ignored the file.

The FR-720 tests that bring in a file used the default governance, which allows metadata lookups. So each PDF brought in made real network requests to the public metadata service (api.openalex.org). That service sometimes answered **HTTP 429 (too many requests)**. The library's HTTP client honours the answer's Retry-After and waited about **60 s** before it asked again. The import, and so the register line, came about 60 s late. The tests wait 30 s, so they timed out. The `afterEach` close then waited for the import still in hand, which is why the failing runs last 61 to 90 s.

## Failure rate before

20 runs of the whole file, each alone, one after another (`nice -n 5`, idle machine): **12 passed, 8 failed (40%)**. Each failure was ONE test, and all five FR-720 tests that bring in a file failed at least once:
- M3 "a read while the opening's own start…": 3 failures;
- M3 "two reads of the list in flight at once…": 3;
- I1 "a restart already under way when a move begins…": 2;
- I1 "a read of the list while a move holds the library…": 1.

Durations:
- a passing run takes about 29 s;
- a failing test takes 61 to 90 s;
- in run 1 the `afterEach` close also hit its 60 s limit.

Logs are in the scratchpad (`runs/base-*.log`).

## Evidence from failing runs

Temporary logging was added, and has since been removed:
- in the engine: the watch's creation, folderKeeper, choices, checkRoot, first readdir, walk, readOne, settle and judge, importNext, attach start and done, note, flush, stopWith;
- in the service: startWatches, stopWatches, watchedFoldersReadAgain;
- in `HttpClient`: one line per attempt, with host, time and status.

The FR-720 tests were then run in a loop until one failed.

**Failing run A** (M3 "two reads…"):
- Each project had exactly one watch, created once.
- Each watch: choices not paused, checkRoot ok, first readdir saw `report.pdf`, readOne then settle, judged `local`, importNext, `attach start` at t=0 for both projects.
- `stopWatches ALL` (the test's close) came at t=30 s.
- `attach done` came at t=60.8 s for both files ("needs-review"). Then `note in-library`, `flush 1`, `flushed 1`, `stopped done`.

So the watch did all its own work, and the attach took 60 s.

**Failing run B** (I1 "a restart already under way…"), with the HTTP log:
- `attach start` (both projects).
- `HTTP api.openalex.org attempt=0 94ms status=429` and `HTTP api.openalex.org attempt=0 254ms status=429`.
- About 60 s later: `attempt=1 408ms status=200` and `attempt=1 653ms status=200`.
- Then `attach done`, `note`, `flushed`.

Every passing run had only `attempt=0 … status=200` lines (300 to 700 ms).

What did NOT happen, in any failing run:
- no zero or double watches;
- no start left "in flight";
- no watch stopped by the move's wait or the M3 guard;
- no file judged unstable or not local;
- no missed first look.

## Why (b), not (a)

In real use the file IS brought in and registered. The import waits for the metadata service's Retry-After (about a minute, capped by the client's `maxRetryAfterMs`) and then completes. That is the client's designed, polite behaviour (R-rules on rate limits). The tests made it a timing race: they depended on a public internet service's rate limit, shared with every other test and agent on this machine's address. A real folder does not lose the file. The restart, the M3 guard and the move's wait behaved correctly in every failing run.

## Older than this branch?

The tests are this branch's (FR-720). At the base 579bdcd, `device-notices.test.ts` has no FR-720 test (`git show 579bdcd:… | grep -c FR-720` gives 0). The engine's lookup during an import, and the client's Retry-After handling, are older and unchanged. So the flaky set-up is new with this branch. The behaviour it tripped over is old and correct.

## What changed

`apps/library-service/src/device-notices.test.ts:242-245` and `:426-429`. In the two FR-720 describe blocks that bring files in (I1 and M3), the projects' governance now says `processing:\n  metadata_lookup: []`, with a comment saying why. That is the same way `watched-folders-routes.test.ts` (`OPEN_GOV`) keeps its imports off the network. With it, the logging showed **0 HTTP requests** across 3 runs of the FR-720 tests, with the same outcome for each file ("needs-review", one register line). No time limit was lengthened, no retry or sleep was added, and nothing in the product changed.

## Proof

- **30 runs in a row of the whole file, alone: 30 passed, 0 failed** (each about 28 s).
- Once with two `yes > /dev/null` beside it: **17 passed (17)**, 28.2 s. Both `yes` were killed afterwards, and none is left.
- `watched-folders-routes.test.ts` alone: 58 passed (58).
- `pnpm --filter @ao/library-service typecheck`: clean.
- The engine was not touched, so its tests and `@ao/library`'s typecheck were not needed.
- `git status --short` is empty after the commit.

## Noted, not built

Other service test files whose imports use the default governance may also reach the public metadata services, and so carry the same latent dependency. Worth a sweep: for example, a test-wide guard that fails any real HTTP request unless the test opts in.
