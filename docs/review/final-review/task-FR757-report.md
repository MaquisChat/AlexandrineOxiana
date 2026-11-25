# FR-757 — report

Worktree `.claude/worktrees/kg-3a`, branch `fr-757-find-two-offers`. Commit `8789787` (not pushed).

## Result in short

Reproduced and the cause proved. **The product is wrong:** `fetchFile` (packages/library/src/find/fetch-file.ts) handed a request to the network after its caller had stopped it. The test also has a weakness that let it show (it ends while a try is still running, and its describe's afterEach takes the file mock away before the runner is closed). But with the product mended, no interleaving I could force fails. The two earlier guesses do not hold:

- "Only one offer's wait was collected": runner.ts:2240–2302 collects every offer's Retry-After before `tryLater`. In CI the test's own assertions passed; only the guard's afterTest failed it (log line 6641, `afterTest tests/net-guard.ts:97`).
- The coordinator's "real clock / date" idea: it does not matter what the real clock says. See "The clock" below.

## Reproduction

- Plain loop of the single test, before the mend (`nice -n 10 pnpm exec vitest run src/find/runner.test.ts -t "longest counts"`, 4-core machine, other agents also running): **9 failures in 30**. Later sets: 5 in 15, 2 in 12, and 4 in 20 twice. Every failure gave the CI message ("this test made a real request to arxiv.org").
- Instrumented with a local, uncommitted change: the guard printed the stack, the request's `signal.aborted`, and a phase marker set in the hooks. **Every refused request (8 of 8)** was `arxiv.org /pdf/2101.00002`, which is offer B. It was made during `phase = outer afterEach: stopAll begins`, with `aborted = true`, and the stack ran `fetchFile (fetch-file.ts:357) ← download (runner.ts:2064) ← copyOn (runner.ts:2248)`.
- Forced interleaving: offer A was held on the second try (`holdFiles.add(A)` before `nothingBefore`), and the describe's afterEach then released it with 500. Result: **10 failures in 10** before the mend, 0 in 10 after.

## The cause, step by step

1. The test (runner.test.ts:4158) waits until the second try begins (`nothingBefore` returns when the first new file request, A, is seen) and then ends **with that try still running**.
2. The F11 afterEach (runner.test.ts:3307) answers anything held, then puts the guard back as the global dispatcher (`setGlobalDispatcher(saved)`) and awaits `fileAgent.close()`. Only after that does the file-wide afterEach (runner.test.ts:299) call `runner.stopAll()`.
3. Meanwhile A has failed (503). Its `live()` check had passed while the run was still live (runner.ts:2245), so the runner moved on to offer B: `download()` → `fetchFile()`. That call got its place at once and then waited on the disk (`exists(into)`, `privateFolder(folder)`, fetch-file.ts:343–347).
4. `stopAll()` stopped the run and aborted the download's signal while `fetchFile` was in that wait.
5. `fetchFile` came out of the wait and called undici's `request()` anyway (fetch-file.ts:357). **undici gives a request whose signal is already aborted to the dispatcher all the same** (api-request.js: the handler only records the reason, and `this.dispatch(opts, handler)` still runs). So the request reached the global dispatcher, which by then was the guard, and the guard recorded arxiv.org and failed the test that was running.

In the product the global dispatcher is the real network. So after a stop, a lock or a close, a download that was between its checks could still give a request to that host's dispatcher. Its signal is aborted, so no body is kept, but a connection could still be opened. "Nothing is asked after a run has ended" did not hold.

## The mend (commit 8789787)

- `fetch-file.ts`: in the request loop, right after `release ??= await place(...)`, the call now does `if (ac.signal.aborted) throw ac.signal.reason;`. The existing finally still releases the place and unmarks the folder, and the caller's reason comes back.
- Tests. Each failed before the mend, every time, and passes after:
  - `fetch-file.test.ts` "FR-757: an abort after the start, while the folder is made, sends nothing and leaves nothing". The test aborts right after the call: the place is given at once, so the abort lands in the disk wait. Before the mend 1 request was recorded; now none.
  - `runner.test.ts` "FR-757: a close between two offers' downloads: the second offer's host is never asked". `stopAll()` begins in the microtask after the runner says that offer A failed. Before the mend, `fileRequests` was `[A, B]` (3 of 3 runs); now it is `[A]`.

## Proof runs (after the mend)

- The single test: **0 failures in 100 without load, 0 in 100 under load** (four busy loops I started and stopped myself). The clock probes below add 60 more passing runs.
- The whole runner.test.ts: **0 failures in 10 without load**. **Under load: 0 failures in 4** (each run took about 6 minutes under load). A first set under load was stopped by the background time limit and recorded no failure. I stopped the second set after 4 runs, so the whole file was run 14 times, not 20.
- Every test file under `src/find/`, each alone: all pass (elicit 18, fetch-file.recorded 15, fetch-file 43, file-check.hostile 275, file-check 112, free-copy 80, people 40, queue-store 81, reference 6, runner.linked-missing 62, runner 302, search 120, settings 21, where 87).
- `pnpm --filter @ao/library run typecheck`: clean.

## The clock (the coordinator's hypothesis), tested and ruled out

- The test's HTTP date is built from `timers.now`, which starts at the fixed `NOW = 2026-11-13T10:00Z` (runner.test.ts:73) and is moved only by hand. `askedWaitMs(retryAfter, now().getTime())` uses the runner's injected clock, and `retryAfterMs(value, now)` (lookup/http.ts:921) subtracts the `now` it is given. fetch-file.ts has no clock read on this path.
- If the clock were the cause, the test would fail on every run after about 07:00 UTC. It did not: before the mend it failed in about one run in four around 08:00–09:15 UTC, and after the mend it passed 100 of 100 at about 09:00 UTC.
- Direct probe, with the real `Date` faked by `vi.useFakeTimers({ toFake: ["Date"] })` inside the test (local, not committed):
  - Before the mend: 4 in 20 failed with the clock at 2026-11-25 05:00 UTC, and 4 in 20 at 2026-12-31 23:00. With A held, 5 in 5 failed at 05:00.
  - After the mend: 0 in 20 at each date, and 0 in 5 with A held at 31 December.
- The run of CI failures (a pass at 06:06, failures at 07:06 and 08:13) fits a race whose odds depend on how loaded the runner is.

## Also noticed (listed, not mended)

- **The F11 describe's hook order** (runner.test.ts:3307 against :299): the file mock is removed before the runner is closed. Any F11 test that ends while a download is still live (here, the "longest counts" test after `nothingBefore`) has a short window in which a live, not yet stopped run could hand a request to the guard. That is during `await fileAgent.close()`, before `stopAll` begins. I could not make this window happen even with A held, so it is unproved and I did not change it. The cheap fix is to call `stopAll()` on the runners in the F11 afterEach before `setGlobalDispatcher(saved)`. The other F11 tests that end on `nothingBefore` (:4206, :4213) ask only the copy service, which goes through the lookup client's own dispatcher, not the global one.
- **Hard-coded late-2026 dates** (as the coordinator asked). 84 test files under packages/library contain `2026-11-…`/`2026-12-…`. These 18 also read the real clock (`Date.now()`/`new Date()`), so they are the ones to look at first: import/watch, find/runner, find/settings, job-journal, job-journal-paths, retention-old-copies, find/elicit, import/zotero-local, import/attach-asked-to-wait, repo/review-held, find/runner.linked-missing, citation/custom-styles, transcript-segments, move, lookup/lookup, import/bulk/space, find/queue-store, export/project-export. I did not check which of them really compares a fixed date with the real clock. Next probe: run the suite once with the real `Date` moved forward (a set-up file calling `vi.setSystemTime` to, say, 2027-06-01) and see what fails.

## Uncertain

- The builder's earlier failure had no message, so I cannot tell whether it was this one.
- The whole file was run 14 times (10 without load, 4 under load), not 20, because a run under load takes about 6 minutes.

## Second round (test side and the review's points)

Commit on top of 8789787 (8789787 was not amended).

- **Hook order** (the review's finding 1): the F11 afterEach (`runner.test.ts` :3307) now does `for (const r of runners) await r.stopAll();` first, then answers held files, then `setGlobalDispatcher(saved)`, then `await fileAgent.close()`.
  - A held file does not need an answer before `stopAll()` can return, because the stop aborts its download through the interceptor's `abort`. No 5-second settle waits were added: F11 still takes about 20 s.
  - The file-wide afterEach's second `stopAll()` is harmless: `closed` is already true and nothing is in flight, so it returns at once.
- **Other inner describes:** only F11 swaps the global dispatcher in this file. `R338` (≈ :5692) resets the `checkFileAgainstRecord` mock in its afterEach before the runners are stopped. That is the same shape but not the same fault (no network involved), so I left it. It is noted here because a run still live could meet a reset mock.
- **Review wording:** the fetch-file.ts comment now says that undici dispatches an aborted request and the agent connects (DNS, TCP, TLS) before it notices the abort, with no request line written. The fetch-file test is renamed "FR-757: an abort right after the start, once the place is given, …". No code change.
- **The runner test cannot tell "B never started" from "B stopped":** nothing that already exists shows that B's download began. The runner returns silently after the abort, writes no debug note, and holds the folder for the whole copy part. So the test is left as it was.
- **Runs:**
  - The F11 describe, first set: 1 failure in 20. The failure was "R310 b (M3) … project-wide resume", a 30 s test timeout in the test body, not a hook, during a run in which every test was about 6 times slower (135 s in all, against about 20 s), with other agents loading the machine. Alone, that test takes about 0.8 s (3 runs).
  - Second set, with the load average about 1: 0 failures in 20.
  - The whole runner.test.ts: 0 failures in 3 (302 tests each).
  - fetch-file.test.ts: 43 passed.
  - Typecheck: clean.
- **Uncertain:** the one R310 b timeout. Its body runs before the hook I changed, which suggests it was load (49 held files are written in its set-up), but I have not proved that.
