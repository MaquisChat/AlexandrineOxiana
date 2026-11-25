# Build 16, batch D: report

`b16-d-streams` (kg-8) from fe85aac; two commits; not pushed.

| Item | Still a gap? | What changed | Test, failed first? |
|---|---|---|---|
| D1, Governance form | yes | f784ee9 `routes/governance.tsx` ≈:66-108: a reconnect loop (2 s pause), `openWithinMs` (prop `streamOpenMs`, 20 s). A reopened stream's first state counts as a change, so the projects are read again | `routes/governance.test.tsx` "R641 D1": a drop then a reopen; a stream that never opens. Both failed first |
| D1, reader hand-off | yes | nothing: NEEDS A RULING | none |
| D2 | yes | 1b68f67 `api/client.ts`: `events({ quietWithinMs })` and `STREAM_QUIET_TIMEOUT_MS` = 60 s. At the limit the request and the read are cancelled and the stream ends "did not answer in time". Turned on for the library screen (prop `streamQuietMs`) and the Governance form | `client.test.ts` "R641 D2": the limit failed first (it hung), the constant failed first, the keep-alive guard passed first. `Library.firstReads` and `governance.test` D2 tests: both failed first |
| D3 | yes | sized, not built: NEEDS A RULING | none |

**Heartbeat (D2):** the service already writes `: keep-alive` every 25 s (`routes/libraries.ts:630`), so nothing was added. Each consumer turns the silence limit on for itself, as R597 rules for the opening limit. Tied to `openWithinMs`, it broke three fake-clock tests (fakes send no keep-alive). The other eight consumers are unchanged. No existing test was changed.

## Sentences a person sees
None new or changed.

## NEEDS A RULING

**1. The reader hand-off (D1).** Its rule is "words are never kept unwatched; a lost watch drops them". A reconnect only helps if the words are kept through the gap, and then they are unwatched in it. A project lock in the gap cannot be detected afterwards, because `library.state` does not carry a project's unlocked state.
- (a) No reconnect. Add only the limits: a watch not open within 20 s, or silent for 60 s, drops the words ("Your search was not carried over", existing words). **I recommend this one:** the words live at most 60 s anyway.
- (b) Reconnect, keep the words through the gap, and drop them if the reopened state differs from the last one seen. This leaves the lock hole open.

**2. D3.** It fits: about 150 lines of product code and no background job.
- Engine: `checkOnce` (`reconnect.ts`) calls `onProgress(checked, total)` after each file (about 6 lines). It already takes a `signal`.
- Service: `GET /libraries/integrity` answers in NDJSON when asked: `{checked,total}` at most every 250 ms, then the report. `reply.raw.on("close")` aborts the check, as `:189` does (about 45 lines).
- Client: `integrityProgress(signal)` over `client.ndjson` (about 15 lines).
- Screen: `MissingFiles.tsx` gets the progress, "Stop" (it aborts the request), the stopped state and focus (about 80 lines).

The ruling gives no words for a stopped check. Proposed: "The check was stopped. Nothing was changed.", with "Check again" (words the app already uses). "Checking the library…" stays while the list of files is being read.

## Only a real Mac or service can show
Whether WebKit ends a silent real stream on the abort and `reader.cancel()`.

## Runs (each file alone, `nice -n 10`)
- governance.test 23/23 · client 46/46 · Library.firstReads 18/18 · governance.firstReads 37/37 · App 16/16
- Library 48 · dismiss 4 · notices 4 · reader 9 · recheck 12 · zotero 15 · routes/library 15
- FindAcquire 233/233 · ZoteroSync 60/60 · LibraryChooser 24 · YourLibrary 60
- New timing tests ×20: 20/20, 20/20, 20/20.
- typecheck, lint:css, lint:colours: clean. Build: done.
- Chromium: capture.spec 4/4. library.spec 4 passed, 1 failed (scenario 2, `/cite` 503): this worktree has no CSL bundle (gitignored), which is not related to this work.
- `git status --short`: empty.
