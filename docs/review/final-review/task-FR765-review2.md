# Second review: bb9e1b8..91c5de8 (9d442f9, 5fdd3fe, 91c5de8)

**Verdict: Ready.** No Critical or Important finding. The builder is right on every claim I checked. Each new test fails without its mend.

## Findings
**Critical:** none. **Important:** none.

**Minor**
1. **A sensitive answer can sit in memory between the lock and the end of the work.** `import/bulk/run.ts:1116`, `import/attach.ts:452-458`. An answer that lands after the lock is dropped only when the run or attach ends. In a Bulk Import or Zotero run, that end comes after the next lookup the run still sends (FR-769). That lookup can take its retries and Retry-After waits, so the window can last minutes. The answer is still dropped at the end, so no leak remains, but there is a window. FR-769 (stopping a project's runs at its lock) closes this too. No separate fix needed; worth naming in FR-769.
2. **Unlocked again before the work ends.** An answer that landed while the project was locked is then kept. The project is unlocked, so this is allowed, and it is the same rule as R600 I2. Recorded only.

## 1–8
1. **Right.** The built-in wait's timer is set synchronously and cleared by the stop. A test's own sleep behaves as before. The `zotero-web.test.ts` change only adds a test and lets `scanWith` take no sleep. Nothing was loosened, and the file's `afterEach` restores real timers. The note is skipped only when `ctx.signal` is aborted.
2. **Right in every state.** It purges when the project is encrypted and locked, and when the project cannot be read (removed). It does nothing when the project is unlocked again or not encrypted. It is identical to the copy it replaced in "Look up again".
3. **Reached at every end.** `attachFiles` wraps the whole of `attachEach` in `try/finally`, which covers the route and the watched-folder call sites at `watch.ts:2009, 2561, 2750`; the service passes no attach of its own. `Run.run`'s `finally` runs on finish, failure, cancel, pause, a closing cut or a thrown error, and it covers Bulk Import, device import (`device.ts:361` goes through `startBatch`), Zotero Web import and resume (both build a `Run`) and Zotero sync. The attach route loses nothing: everything before `attachFiles` looks nothing up.
4. **Too early? Not found.** Bulk Import, resolve, `firstAnswer` and attach all await their lookups one at a time, and every `Promise.race` on these paths guards folder checks or external tools, never a lookup. A Find lookup that timed out still carries the run's signal, and since 91c5de8 its late answer is not remembered. A close stops the client. I could not construct a lookup that outlives its work.
5. **Dry runs:** no lookups. **Device import:** goes through `Run`. Other users of `s.http`: the "Search sources" Test sends fixed test words, so it holds no project data. I found no other uncovered path.
6. **Right place.** It sits after validate and before both `remember` and `writeCache`. A call without a signal behaves as before (tested). Holds are set in the request path, earlier. Only a stopped caller's answer goes uncached. The test seam is sound: `validate` runs exactly between the read and the remember, which is where the lock's stop-then-purge lands.
7. **Each test fails without its mend.** I reverted each mend locally and ran the tests: the timer test (1 timer left), the note test (2 notes), all five lock-during-lookups tests (1–2 entries left each), FR-759 with `attachFiles`' purge removed (1 left), and both FR-767 client tests (1 entry each). The no-signal case passed, as it should. Lock-during-lookups passed 20/20 with three busy loops running.
8. **Nothing else changed.** Only comments differ. No route shape or person-facing sentence changed, and no test was loosened. Typecheck is clean for `@ao/library-service`.

## Could not check
A real network. Whole-file runs. The typecheck of `@ao/cli`. An actual device import or Zotero sync against the real services (I checked these by reading and through the fake).
