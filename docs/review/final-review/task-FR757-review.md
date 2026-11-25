# FR-757 — review of commit 8789787

## Verdict: **Ready with fixes**

The mend is right and complete inside `fetchFile`. The fixes asked for are small: correct the code comment, and record the residual test window and the related product gaps. The builder is right on claims 1, 2 and 4, and right about the cause.

## Findings

**Critical:** none.

**Important**
1. **The original test can still hit the guard (runner.test.ts:3307 against :299).** After the mend, a run that is still live can reach `request()` for offer B *after* `setGlobalDispatcher(saved)` and *before* `stopAll()`, while `await fileAgent.close()` is running. Nothing in the product stops that, because the run is not yet stopped. I did not see it happen: the test passed 10 of 10 with the machine loaded. But no code rules it out. Fix: the hook order the other agent is changing (stop the runners before putting the dispatcher back). Nothing else is needed.

**Minor**
2. **fetch-file.ts:354–355, the comment says "nothing would otherwise stop it reaching the host".** That is overstated. The dispatcher opens a connection, but no request is written. Fix: "…undici dispatches it anyway and the agent opens a connection (DNS, TCP, TLS) before it notices the abort".
3. **The test name in fetch-file.test.ts says "while the folder is made".** The abort actually lands after the place is given, before the `await place` continuation runs. The check is the same, and no older test covers this ("an abort before the start" only covers `throwIfAborted`). Fix: rename the test, or leave it.
4. **The runner test cannot tell "B never started" from "B stopped".** It fails 5 of 5 without the mend, so today B does start. Fix (optional): assert that a debug note or a place showed B's download began.

## A–F

**A.** True. `api-request.js` only stores the reason, and `dispatch` runs anyway. `Client` connects because `request.aborted` is still false, and `onRequestStart` only aborts in `writeH1`, after the TLS `secureConnect` (connect.js:150). My probe used a local server on 127.0.0.1: a cold agent made 1 connection and 0 requests; a warm agent made 0 new connections and 0 requests, but its idle keep-alive socket was destroyed. **The exact sentence: "Before the mend, a download stopped during its disk wait could still make the app look up the file host's name and open a TCP connection (with a full TLS handshake naming the host) to it, or close an idle one, but no HTTP request line, header or other request byte was ever sent and nothing was received."**

**B.** Complete. The check sits after every wait that comes before `request()`: the first place, `exists`, `privateFolder`, a redirect hop's place, and the gap between a place being given and the continuation. There is no `await` between the check and `request()`. Callers get exactly what they got before for all three kinds of abort. A caller's reason, `Abandoned` or `TimedOut`, is the same object; the deadline throws a `FetchFileError`. The headers timer cannot be pending at the check. The reason is never `undefined`, because `abort()` with nothing gives an AbortError. A reason that is not an Error is rethrown through `err === opts.signal.reason`. The `finally` still clears both timers, releases the place and unmarks the folder. No part file exists at that point. The folder is left for the caller to remove, as before. No sentence a person sees changes. One existing gap remains: an abort during `privateFolder` that fails gives `write-failed`, not the reason.

**C.** Three other places:
- `import/zotero-web.ts:567`, after the `dump` at :553, and the retry sleeps at :422/:431 when `withKey=false`. The storage-redirect `get` skips `waitTurn`'s `throwIfAborted`, and the sleep cannot be aborted. A sync stopped during a storage retry back-off opens a connection to the storage host after the sleep. Minor to Important: the window lasts seconds.
- `lookup/http.ts:852`. The signal is built from `halt()` after `throttle`, with no `assertOpen`. Only a window of one microtask. Minor.
- `lookup/http.ts:623` (`postJson`). Same, after the `Promise.race`. Minor.

The media-worker calls go only to the local machine and carry no signal, so they are out of scope.

**D.** Downloads and the retry timers are safe: `later` and `enqueue` check `r.stopped`, and `stopRun` clears the timers. One gap: `guard()` (runner.ts:1144) lets lookups that are already running go on. At a project lock (`state.ts:1775`) or a library move (`state.ts:1365`), the lookup client is not halted. A running `findFreeCopies`, `fetchWork` or `searchWorks` still sends its retries and redirect hops after the stop. Only a close halts it (`beginClosing`). This was there before the commit. Important for a separate task.

**E.** Without the three lines, each new test failed 5 of 5. With them: fetch-file 0 failures in 30; runner 0 in 30 plain and 0 in 20 under four busy loops. The 30 ms sleep and the microtask are sound. The disk wait is libuv I/O, so the abort always lands before it ends. A false pass is possible only as in finding 4.

**F.** Only finding 1 remains. With the machine loaded, "longest counts" passed 10 of 10. The tests at :4145, :4206 and :4213 start no download after `nothingBefore`, and the copy services use the lookup client's own dispatcher.

## Not checked

- I did not run the whole runner file, or CI.
- I did not probe TLS against a real host: that comes from reading the code.
- I did not test the Zotero and lookup gaps with code, only by reading.
- The browser sign-in is in the desktop app, outside the trees I swept.
