# Task CI-278 — report

Worktree `.claude/worktrees/re-8-ci-tests`, branch `re-8-ci-tests`, from 567d98d. Test files only; no product code touched; nothing pushed; no stash used. Every temporary change (the `POLL`/`PIECE` hooks, the probes, the scratch copies `zz-*.test.ts`) was taken out again; `git status --short` is empty.

## The two failures of run 278

### 1. `packages/library/src/find/runner.test.ts` — "Try again: accepted on a record entry resting switched off" (fault of the TEST)

**Cause.** After `retry`, the test waited with `settled`, which returns at the first state in its list. The entry becomes `record-complete`, but OpenAlex is on in that test's settings file, so the runner's copy part goes on at once (`looking-for-copy`) and the entry rests at `no-open-copy` — outside `settled`'s list. `record-complete` is only passed through; a poll that misses the window waits for ever ("timed out waiting for the entry to settle"). This is the fault the brief suspected (a wait on a passing state), not the R451 kind (a read too early).

**Proof.** The helper's poll made an environment value: at 5 ms the test passes; at 250 ms and 1,000 ms it fails every time with GitHub's message. Mended (wait for `no-open-copy`): passes at 5, 250 and 1,000 ms.

**Mend (b9b3973).** Waits for the true rest `no-open-copy` and asserts it exactly: a source, no reason, the service asked, and `record-complete` among the entry's events (so the path through the record is still checked).

### 2. `apps/browser-extension/src/find.test.ts` :625 — "a tab whose file stops arriving" (fault of the TEST)

**Cause.** The test's fake fetch (`file: () => new Response(s.body)`) ignored the fetch's abort signal. In the path the test names — the first 1 MiB piece arrives, then the file stalls — the background's piece wait ends and it disconnects; the tab script aborts its fetch, which a real fetch answers by erroring the body (Fetch standard), but the fake did not, so the tab's `reader.read()` never ended, the script never ended, and `await Promise.all(r.scripts)` ran out the 5 s. Where its five seconds go: all of them in that wait (measured: the send itself ends ~1 ms after the piece wait).

Why it passed here and failed on GitHub (twice: runs 273 and 278): the first piece's honest work — `bytesToB64` of 1 MiB (`String.fromCharCode` over 32 KiB slices; 55–100 ms on this loaded machine, measured) — usually overran the test's 50 ms piece wait, so the background gave up on the FIRST piece, before the stall; the tab was then in `more()`, saw the disconnect and ended. The test passed without ever reaching what it claims to check. On a quicker machine the first piece arrives inside 50 ms, the stall path is taken, and the test hangs.

**Proof.** (a) Probe: the background sent only one "more" (`bgSent=1`) in every passing run here. (b) Fail at will: piece wait 150 ms or 500 ms (the first piece arrives in time) → timed out in 5000 ms every time, the tab stuck with `pulled = 1,114,112`, never cancelled. (c) Stop it: the fake made to follow the signal (abort errors the body) → the same runs end 3–5 ms after the send. (d) With the mend but a 50 ms piece wait, the new path assertion fails ("expected 1 'more' to have length 2"), showing the old configuration never reached the stall here.

**Mend (adf836b).** `streamOf` gains `follow(signal)`: on abort the body is errored with an AbortError and `seen.aborted` is set, as a real fetch does; the rig passes the fetch's init to a `file` factory. The test: piece wait 1,000 ms (above the first piece's honest work: 110–200 ms on one busy core), and it now asserts it took its path — one piece sent, two "more"s, the read stopped exactly at the stall, the fetch aborted, nothing posted. `seen.cancelled` (the reader's cancel) was replaced by `seen.aborted` in this test because, with a fetch that honours abort, the read is ended by the abort (the tab script aborts before it cancels), as in a browser. Test cost ~1.1 s. Under `nice -n 19` against four busy loops, the first piece took over 1 s once (the path assertion then fails loudly instead of hanging); see "uncertain".

## The sweep

**Experiment 1 — slow polls.** Each wait helper's poll made `Number(process.env.POLL ?? <its own>)` (temporarily) in: `runner.test.ts` (`until`/`settled`), `watch.test.ts` (three helpers), and in `apps/library-service/src`: capture-queues, documents-route, find-browser-routes, find-routes (`settled`), import-disk-full, search-settings-routes, tools-routes, transcription-jobs, watched-folders-routes, your-library-routes. Each run whole at POLL=250 and 1,000, with test limits raised for the run so that only the helpers' own waits could fail. (The other Find tests in `packages/library/src/find` have no state-wait helper; `fetch-file.test.ts`'s loop waits on fake timers; `search.test.ts`'s `until` is not a wait.)

Turned over, and mended:
- `transcription-jobs.test.ts` "answers at once with a job; progress arrives…" — waited for progress 0.5, which the stand-in worker answers on one poll only (0.25, 0.5, then 0.75 until released). Fails at 1,000 ms every time (once at 250). Now waits for the rest at 0.75, asserts it exactly, and asserts the 50 and the 75 of 100 among the events. (2dae85f)
- `search-settings-routes.test.ts` "a second test of one source is refused while the first runs" — the first Test was only DELAYED 400 ms; a wait that overran it found it over, and the second was accepted (200, not 409). Fails at 1,000 ms every time. The answer is now HELD until the refusal and the other source's Test are checked. (a976f97)
- `watch.test.ts` "a failed download is listed and tried again later" — required exactly two tries, but tries go on every 700 ms while the service fails, so a late wait found 3 or 4 (fails at 1,000 and 2,000 ms every time). The failed tries seen when the service recovers are counted; exactly one more try follows, at least 400 ms after the last failed one, and every try is in the bytes count. (dfd2503)
- `runner.test.ts` at 250 and 1,000 ms: nothing else. One test ("R324 b: the five ways back") ran out its 30 s test limit at 1,000 ms; with a longer limit it passes — about 30 waits, a cost, not a passing state.

**The countdown read on the real clock** (found by the sweep here, and named by the coordinator's message; the same treatment as R452):
- `find-browser-routes.test.ts` "the pause after a hand-over from the browser holds every start" — asserted "Ready in 20 seconds." on the real clock, counted from the hand-over, which is taken at the START of the file's sending; the file's check and two writes had to take under a second. Here it said 18 every time, at any poll; a 1.1 s delay before the start fails it on any machine. Date alone is now frozen from before the sending to the start (the clock the runner reads); the exact "Ready in 20 seconds." still asserted; passes with the 1.1 s delay. (d86493e)
- `your-library-routes.test.ts`: "one ticket at a time, and the pause between hand-overs" and "F18c … refused like a library start" asserted exactly 20 (the 1.1 s delay made them say 19 every time); "R328 f: the pause outlives the library's close and reopening" accepted anything from 10 to 20 (`/^Ready in (1\d|20) seconds\.$/`). Date is frozen at the hand-over; all three assert exactly "Ready in 20 seconds."; the end of the pause is moved with `vi.setSystemTime(Date.now() + LIBRARY_PAUSE_MS)` (a second `useFakeTimers` does not move a clock already faked — the first attempt failed for that reason). Pass with the 1.1 s delay. (f02f00e)
- Looked for others in `apps/library-service/src` and `packages/ui/src` (`in N seconds/minutes`, `Ready in`, `toLocaleTimeString`, `getHours`): the UI ones (`FindAcquire.test.tsx` "Ready in 12/14 seconds.", `ExtensionPairing.test.tsx` "valid for 5 minutes", the "no answer in 60 seconds" tests) compare canned service answers or use fake timers — none reads the real clock. None other found.

**Experiment 2 — the processor scarce, the extension's tests.** `taskset -c 0` (one core, shared with this busy machine): all 241 pass; within half of their limit: the 200 MB no-length test (40.5–46.4 s of 60 s), body-size "then drops the extracted media links" (2.9–4.4 s of 5), real-service "paired: the list holds the waiting work…" (2.8–3.5 s of 5, also 2.6–3.5 s alone), and in the second run body-size "refuses locally" (2.4–3.5 s) and "drops the HTML…" (1.8–2.9 s). `nice -n 19` beside four busy loops (and seven other agents): 65 of 241 failed, including trivial tests taking a second — starvation far beyond any CI runner, so not used to judge.
Mended:
- body-size "refuses locally": two fittings of the same 33 MB body (one for the class, one for the message) → one fitting, class and message both asserted: 1.2–1.6 s. (4473a7d)
- body-size "then drops the extracted media links": the cost is measuring bodies over 32 MB (the service's limit), not the links — 16 links instead of 50 measured the same, so the work is kept; limit 15 s. (b2b542a)
- body-size "drops the HTML when an 18 MB PNG plus 4.5 M CJK characters…": both sizes are what it checks; limit 15 s. (7d68287)
- real-service "paired…": a real service, a library opened, a record written, three files sent and one checked — nothing can go; limit 15 s. (3026875)
- find.test.ts "a file larger than the limit with no length announced": 200 pieces of 1 MiB through base64 and back (the limit is the service's, the piece the protocol's); limit 60 → 120 s. (93753b4)

Not mended, reported: `watch.test.ts` "status is coalesced to one per second during a burst of 2,000 files" ran out its own 60 s wait for 2,000 imports once, in a run of watch + runner together at the machine's peak load (load average ~30); alone it passes in 4.2 s (poll 50) and 4.7 s (poll 1,000). Its wait is for a resting count, so it is not a passing state; a time-limit failure seen once.

In all: 2 tests of run 278 mended, and the sweep mended 10 more (3 passing-state waits, 4 countdowns on the real clock, 5 limits/work for the processor scarce).

## Commits (on `re-8-ci-tests`, not pushed)
b9b3973, adf836b, 2dae85f, a976f97, d86493e, dfd2503, 93753b4, b2b542a, 3026875, 4473a7d, 7d68287, f02f00e (head).

## Runs
- Touched files, three times each (`find.test.ts`, `body-size.test.ts`, `real-service.test.ts`: 102/102; `find-browser-routes`, `search-settings-routes`, `transcription-jobs`, `your-library-routes`: 138/138; `runner.test.ts` + `watch.test.ts`: 440/440) — all 3 runs passed.
- `pnpm --filter @ao/library exec vitest run src/find`: 13 files, 1,194 passed.
- `pnpm --filter @ao/browser-extension test`: 11 files, 241 passed.
- `pnpm -r typecheck`: every package Done.
- After the mends, slow polls at 1,000 ms: the ten library-service files 304/304; `runner.test.ts` + `watch.test.ts` 439/440 (the one: "status is coalesced…", see above; passes alone). Extension under `taskset -c 0`: 241/241.
- `git status --short`: empty. Head f02f00e.

## Uncertain / for a ruling
- The extension test's piece wait of 1,000 ms is a margin on the first piece's honest work (110–200 ms on one busy core, over 1 s only under `nice 19` starvation). If a runner were ever that starved, the test now fails with a clear path assertion rather than a hang. A seam in `readTabPdf`/`createFinder` (a per-piece wait, or a stalled piece announced) would remove the timing entirely, but that is product code.
- The tab script's end after a stall relies on the browser erroring a fetch's body when its signal is aborted (as the Fetch standard says); nothing else ends a pending `reader.read()`. I judged that correct product behaviour, so the fault was the fake's — a real-browser run (the e2e suite) is what shows it; not run here.
- Five limits were raised (with the honest work measured and named in each comment); the brief prefers smaller work, which was found for one test only.
