# Build 16, batch D: review (`b16-d-streams` e1806fe)

**Verdict: Ready with fixes.** The product code does what R641/R649 ask. Two tests fail by chance, and a failed check leaves the person with no way on.

## Important

**I1. Tests that assert the mock request's `signal.aborted` fail by chance.** Under load (4 busy loops, all new stream tests ×20), 2 of 20 runs failed: `WatchedFolders.test.tsx:1455` and `Library.firstReads.test.tsx:419`, each with `expected false to be true` on `signals()[0].aborted`. Cause, proven by a probe: Node's `Request` passes the caller's abort to its own signal through a weak reference, and after garbage collection a signal kept without its request never aborts. Affected: `test/service.ts:78` (`sseAttempts`), governance `attempts`, Capture/ImportWizard `holding`, the reader and transcript tests, and MissingFiles `ndjsonCheck` (older FR-756 tests too). **Fix:** keep the `request` and read `.signal` at assert time (probe: a kept request reports aborted), or record the signal in the client's `fetch`.

**I2. A check that fails partway has no way on.** In `MissingFiles.tsx:107-120`, an error shows only the alert. If the service dies mid-check it says "The library service's answer was cut off before it finished." with no "Check again". **Fix:** show "Check again" under the error too (`load` must then clear `error`), plus one test.

## Minor

- **M1.** The hand-off's silence limit (`readerHandoff.ts:110`) is dead code. The words' 60 s timer starts first and its `release()` aborts the watch. With the limit removed, the "silent" test still passes.
- **M2.** "Stop" does not end the file being hashed: `hashStream` (`reconnect.ts:79`) takes no signal. A queued confirm batch (`:618`) still runs. Nothing is written. **Fix:** pass `signal` to `hashStream`, and call `throwIfAborted()` at the start of the confirm function.
- **M3.** The `role="status"` progress line changes up to 4×/s, so a screen reader keeps announcing it. Throttle what is announced.
- **M4.** `governance.tsx:103` adds an abort listener at every 2 s pause and never removes it (as `reader.tsx:330` already did). Remove it when the timer fires.
- **M5.** `StepRun` never resets `tries`. After three silences (not four, as reported), across a whole import, the person sees the notice. Reset the count on open, as Capture does.
- **M6.** Progress restarts from 0 when a project is locked mid-check. `pathFields.shell.test.tsx:31` still mocks the plain JSON answer (now a stale fake).

## Questions

1. Edits are kept: `GovernanceSettings` is keyed by project id, and its `load` ignores `stateSeq`. The reconnect sends only GET `/projects`. It ends at unmount. If the service stays down it retries every 2 s, one attempt at a time (plus M4).
2. The 20 s limit drops the words and nothing reopens (tested, failed first). A watch that opens with keep-alives carries the words. The silence limit is dead (M1).
3. Per consumer: there is no default in the client. A reopen re-reads only what the screen missed. Nothing typed, edited, read or running is lost or restarted (the run step rechecks only; see M5). The timer runs only while waiting on a read, and 60 s is more than two keep-alives. After sleep: at most one reopen per mounted consumer.
4. The failures are I1. The keep-alive test in `client.test` and every screen test wait on real time. Use fake timers to make them certain.
5. The words and focus are right. The plain answer is unchanged by code reading, but its test checks only the keys. The abort reaches the engine (with M2). There is no time limit, and n ≤ m. Each window runs its own read-only check. No locked-project detail is newly shown. The mirrored line format and Accept test are enough wiring.
6. Each reverted mend fails its tests (client, governance, MissingFiles, route, three consumers spot-checked), except M1. Nothing was loosened.
7. No other visible change. The three typechecks, `lint:css` and `lint:colours` are clean.

## Not checked

Only a real Mac can show these: whether WebKit ends a silent stream on abort and cancel; whether its timers count sleep time (if they do, every consumer reopens once on wake); App Nap timer ordering. No browser scenario drives the missing-files screen.
