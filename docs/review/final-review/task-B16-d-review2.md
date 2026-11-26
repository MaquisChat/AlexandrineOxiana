# Build 16, batch D: second review (`b16-d-streams` 64d525a)

**Verdict: CHANGES NEEDED.** One mend (M5) does not do what R658 asks once the real service is behind it. Everything else is confirmed.

## Important (new)

**M5 lets a stream that opens and closes at once loop for ever, with no notice.** Where: `StepRun.tsx:101-102` (`proved = true` on any event). The real service writes `library.state` the moment a stream opens (`apps/library-service/src/routes/libraries.ts:651`). So every opening "proves itself", which is exactly what R658 rules out ("a stream that opens and closes at once … still counts").

The R115 I5 test passes only because its fake (`test/importService.ts:349`) sends a `: connected` comment and no event. The new test "a stream that delivered an event and then dropped … keeps following" (`ImportWizard.firstReads.test.tsx`) writes the wrong behaviour into a test.

Evidence: a probe whose `/events` answers as the service does (the state, then end) made 27 connections in 8 s, each with a `GET /imports` recheck. The notice "Progress updates are not available right now" never came. At 9fb7369 the count never reset, so the notice came after three tries.

Smallest fix:
- Do not count the first `library.state` of a connection as proof: prove a connection only by an event after its first one, or by the quiet limit.
- Make the "event then drop" test send the opening state first.
- Add one test: state then close, repeated, ends in the notice.

**Note.** The quiet-limit reading (`opened && isNoAnswerInTime`, `StepRun.tsx:118`) is correct at this head of `client.ts`. It would break silently if the client ever gave that error another meaning once open. A comment in `client.ts` at `noAnswerInTime()` naming this caller would guard it.

## Confirmed

- **M5, the count:** `tries++ >= RECONNECTS` is the same count as before for tries that never proved themselves (notice at the third in a row). `ImportWizard.test.tsx` has not changed since fe85aac and passes 56/56, R115 I5 included. The first new M5 test (five silences, then a held sixth try) is certain: its sixth try has a 20 s opening limit, so the exact `toBe(6)` cannot race.
- **c6ff19b:** `reader.tsx:328-335` removes the pause's listener when the pause ends, the same mend as M4. `reader.firstReads` passes 7/7.
- **64d525a:** either "Check again" hands focus to the `h1` (`tabIndex -1`, `MissingFiles.tsx:100-104,122`). Not at mount, not after `search()`. `MissingFiles.test` passes 14/14.
- **I1, M1, M3, M4, M6, I2:** as in phase 1.
- **M2:** with the signal no longer passed to `hashStream` (my local revert), the "stop mid-hash" test fails. `reconnect.test` passes 58/58 at 64d525a. A stop cannot leave anything written: the check only reads, and a stopped check throws before it reports.
- No test was loosened or skipped beyond what was ruled. No on-screen words changed beyond "Check again".

## Runs (each file alone, `nice -n 10`)

`reader.firstReads` 7, `MissingFiles` 14, `ImportWizard.firstReads` 16, `ImportWizard` 56, `reconnect` 58: all passed. Probe and mutation removed; `git status` is empty; HEAD is 64d525a.

## Not checked

- The full suites (the coordinator runs them).
- Load runs of the stream tests at this head.
- Everything that only a real Mac shows (see the first review).
