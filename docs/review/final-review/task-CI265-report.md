# Task CI-265: report

**Case A: the tests were at fault. They are fixed in commit `e3ac256` on `ci-find-runner-flake`, which is not pushed.**

## Cause
Both tests read an entry while the runner's copy part could still write to it, so each read raced one write.

- **F12 "Elicit failing…"**: a record the runner has just completed is enqueued again for its copy part (`write()`, runner.ts:1206). The test's settings (`elicitOn()`) have no `copies`, so the copy part writes `record-complete` / `switched-off by settings` (R312 c, runner.ts:2100–2104). The test's `settled` returns at the first `record-complete`, and the test then checks that `reason` is undefined. That only holds if its read lands before the copy part's write.
- **F15 "R324 b: the five ways back"**: the row "record-complete / switched-off by settings" was set up under `NO_FREE`, rules that do not allow `free_copy`. A way back through `resume` (start-up, unlock, reopen) enqueues the returned entry for its copy part (runner.ts:2624). The copy part asks the rules before the settings, so it rewrites the reason as `copy-not-allowed by rules`. That is right under those rules.

Neither case is a product fault. In both, the product writes the reason the rules and settings call for. The tests either read a transient state or set up a rest that is not stable under the rules they chose. Whether the test sees the transient depends only on whether its read lands before the copy part's write. The read lost the race on GitHub's runner and won it here.

## Evidence
1. Baseline, idle machine with 4 CPUs: the two tests together, 20 runs, 0 failures.
2. A temporary 200 ms real delay between the test's wait and its read. Both tests failed every time, with exactly CI's messages. F12 received `{switched-off, settings}` at line 3082. F15 expected `switched-off` and received `{copy-not-allowed, rules}` at the start-up case (CI's :5047). A probe printing every case showed only that row turning, and only in the ways back through `resume`.
3. Removing the cause by slowing the copy part: a temporary 1000 ms delay at the start of `copyOn`. Both tests passed even with the 200 ms read delay (1 run), and 3 out of 3 without it.
4. After the fix, with the same probes: read delays of 200 and 1000 ms, the copy part delayed by 1000 ms, and both together. All passed.

## The fix (test file only)
- **F12**: after `settled`, the test waits until the copy part has rested. It then asserts `reason` is exactly `{switched-off, settings}`, `attempts` is 0 and there is no `nextTryAt`. An Elicit failure, which would mean a retry, an attempt or another reason, still fails the test.
- **F15**: a helper, `stableFor(rest)`, gives the `switched-off` row rules that allow `free_copy`, `library_access` and `reference_lookup`. Every copy service is off in the settings, so the copy part writes nothing again and the rest stays exactly as it was. The other rows keep `NO_FREE`.
- No sleeps, retries or skips were added, and no expectation was loosened.

## Runs after the fix
- The two tests ×10: all passed.
- `runner.test.ts` ×2, idle: 300/300.
- `runner.test.ts` under a 4-CPU busy load: 300/300 (184 s).
- `src/find`: 13 files, 1194 passed.
- `pnpm -r typecheck`: exit 0.
- `git status --short` is empty.

## Uncertain or worth a look
- **Why GitHub loses the race:** not measured. Faster file I/O there is likely.
- **One slip:** a mis-backgrounded command ran `vitest run` and `pnpm -r typecheck` once in the main checkout. It is read-only there, and that checkout's `git status` is clean.
- **Inconsistent order:** the record part asks the settings before the rules (runner.ts:1690–1700), but the copy part asks the rules first. The copy part's order is why a "switched off" rest turns into "copy-not-allowed" when free copies are forbidden too. That is correct as built, but the inconsistency could be worth a ruling.

## The sweep (R451 b)

**Result:** three more tests in `runner.test.ts` were racy, all at fault in the test (case A). No product fault was found and no `*.ci265.test.ts` file was left. The fixes are in commit `1f88219`, on top of `e3ac256`, not pushed.

**Where the delays went.** Every "wait, then read" in `src/find/*.test.ts` goes through `until` in `runner.test.ts`; `settled` is built on it. So a temporary delay at the end of `until`, once its condition holds, reaches every such wait. The mirror experiment slowed the copy part instead: a temporary 1000 ms delay at the start of `copyOn`.

**Experiments on the whole of `runner.test.ts`** (300 tests, `--testTimeout` raised):

| Delay | Before the fix | After the fix |
|---|---|---|
| 200 ms at the end of each wait | 2 failed | 300 passed |
| 1000 ms at the end of each wait | the same 2 failed | 300 passed |
| copy part slowed by 1000 ms, no read delay | 2 failed* | 300 passed |

*One of these two was my own first fix of test 1 below (see its note); the other is test 3.

**The three tests and why each read too early:**
1. **"a typed line becomes a record > a sure match creates one source…"** (read delay). It counted the entry's events as exactly `[looking-up, record-complete]`. The copy part then rests the entry at `switched-off by settings` (R312 c) and sends a third event. The fixed test waits for that rest and for its event, then checks the reason and the three events exactly. Under the slowed copy part, my first fix still lost the race: the event follows the line's commit, so the queue line can be read before the event arrives. Waiting for the event as well closed that.
2. **"R326 … the record part: a service switched on puts the entry back to work"** (read delay; it timed out). `settled` only returned because it caught the moment the record's line was written. The entry then goes on to look for a copy and rests at `no-open-copy`, which is not in `settled`'s final states, so a later read never finds a final state. The fixed test waits for `no-open-copy` and checks it has its record and no reason.
3. **"Try again: accepted on a copy entry resting switched off"** (the mirror fault). It waited a fixed 100 ms (`quiet()`) for the copy part to rest again. It now waits until the entry leaves `looking-for-copy`, then checks the same `switched-off by settings` rest.

The other `quiet()` waits check that nothing happens. They need a period of waiting by design, and none failed in any experiment.

**Other test files:**
- The other test files in `src/find` do not drive the runner (none calls `createFindRunner`).
- `apps/library-service/src/find-routes.test.ts` does drive it, and its own `settled` and `MADE` already allow for the copy part's states. I ran the same experiment there by delaying its `until` before it returns. It passed 43/43 in all four runs: no delay, 200 ms, the copy part slowed by 1000 ms, and 1000 ms.
- `packages/ui/src/screens/FindAcquire.test.tsx` runs against a made-up client with fixed queues and no runner, so the pattern is not there. I did not run the experiment on it.

**After the fix,** with every temporary delay removed (`git status --short` is empty):
- `runner.test.ts` ×2: 300/300 both times.
- `src/find`: 13 files, 1194 passed.
- `pnpm -r typecheck`: exit 0.

Every command in this round ran in the worktree.
