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
