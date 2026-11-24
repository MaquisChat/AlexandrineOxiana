# RE-7e report — the review's small points on RE-7 (Ruling R472)

Worktree `.claude/worktrees/re-7-find-shell`, branch `re-7-find-shell`, from 7a8f5ee. Not pushed. No Rust touched, the shell was not built.

| FR | What changed (file:line) | Test, failed first? | Commit |
|---|---|---|---|
| FR-577 | Comments only. `packages/library/src/extract/pdf.ts`. At :20–28, `RANGE_CHUNK` and `MAX_PDF_BYTES` now say what bounds a file read whole. At :39–44, `extractPdf` says exactly when the whole file is read: pdf.js must rebuild the cross-reference of a damaged or crafted file, asks for the rest of the file as one range, and then copies it. That costs about twice the file's size, as before, and `MAX_PDF_BYTES` (512 MiB) bounds it. | None: the change is to comments only, and behaviour is unchanged (below). | d75ef20 |
| FR-576 | `packages/ui/src/screens/FindAcquire.tsx`. `ProjectQueue` takes a new prop `saidAbove`, the screen's settings sentence. It is passed at ~:898 and declared at ~:990. The queue's `loadError` is not shown when it is the same sentence (~:2265). | `FindAcquire.test.tsx` "FR-576: when the settings' read and the queue's read both cannot reach the service, its sentence is said once". It failed first: 2 elements, not 1. It waits until the queue's "Reading the queue…" is gone and the screen's own alert, above the Queue heading, is present. | a59e454 |
| FR-558 | `FindAcquire.tsx`. `readOnce(signal?)` passes the signal to `api.queue`. A read whose signal was aborted changes nothing, whether it answers or fails (~:1340–1349). `readWaited` aborts its read when it gives up at `QUEUE_READ_WAIT_MS` (~:1364–1385). The comment on `QUEUE_READ_WAIT_MS` (~:168) is updated. | `FindAcquire.test.tsx` "FR-558: a read of the queue given up as never answering is cancelled…". It runs 8 give-ups in a row and counts the open requests through `request.signal`: exactly 1 while a read is out, 0 after each give-up, at most 1 overall. The row is unchanged and no alert is shown. It failed first: still 1 open after the give-up. The existing FR-558 test passes unchanged. | d60f456 |
| FR-529 (R478) | Built under R478. The given-up request stays open, as FR-529 needs. `packages/ui/src/screens/import/ReviewQueue.tsx`: a new ref `givenUp` (~:285–289) holds one open given-up request per card, at most. In `decideHeld`, a new decision on the card aborts the card's earlier given-up request first (~:810–814). Each request carries its own `AbortController` signal. At the give-up it is kept as the card's given-up request. An aborted request's answer or failure returns before anything happens: no read, no error, no sentence. The `finally` drops the entry once its request settles. A new effect on `[projectId]` aborts every one still open on unmount or a change of project (~:525–532). | `ReviewQueue.test.tsx`, two new tests. "R478: a card holds at most one given-up decision…" counts through `request.signal`: one open after the give-up, the first aborted when the second is sent, never two open, and after the first's late answer no extra read, no alert, and the card still busy with its second decision. "R478: leaving the review queue cancels every given-up decision's request" unmounts and sees the abort. **Both failed first**: aborted 0, not 1. The FR-529 test and the R313 e test pass unchanged. | 834998c |
| FR-557 | No code change. The behaviour already holds: the wait sentence is in the polite live region only until the press's answer, and the failure's sentence then replaces it and is said once. | `YourLibrary.test.tsx` "when the test then fails, or signing out then fails, the failure's own sentence is what shows, said once". **It passed at once**, without a fix, so it is committed as a guard. | 3af7d84 |
| FR-561 (page side) | Comment only, at `FindAcquire.tsx` ~:1635–1640. It says the shell is the guard (it closes a window only for the open that made it, its ticket), that this check is only a second guard, and what the check cannot see: a start after the screen was left and opened again or the project changed, and the window that Your library's Test opened. Not moved, not rebuilt. | None (comment). | 964a310 |
| Added by the coordinator: R463 M7 pattern | `FindAcquire.tsx:826`. A locked project's `<option>` is now `⁨name⁩ (locked)`, with the escapes and a comment. No helper exists in `packages/ui`. The Collection options hold the name alone, with `dir="auto"`, so they are fine. Your library has no `<option>`. | `FindAcquire.test.tsx` "a locked project's name is isolated in the picker…", with an Arabic name. It failed first. **Existing tests changed** (they read the option's text): "M8: the project list is read again…" (:1016, :1022) and the one at :1393 ("Market study (locked)"). Each now includes the marks. | 3099997 |

## FR-577: was a size limit at hand?
Yes, and it is already applied before any parsing at both places that run the file check. So I changed no behaviour.
- Downloaded copies: `fetchFile` refuses more than `FREE_COPY_MAX_BYTES`, 100 MiB, with "The file is larger than 100 MB, the most the app downloads." (`find/fetch-file.ts:142`).
- Handed-over files: `file.take(path, into, LIBRARY_FILE_MAX_BYTES)` (`find/runner.ts:3202`; the service's `takeInboxFile` checks lstat, fstat and the streamed count) refuses more than 200 MiB as `too-large`, which the view says through `lastFile`. The R329 g test "a file the service could not take (too-large) is not kept" covers this.
- `checkFileAgainstRecord` is reached only after these checks. A further check inside the extractor would be dead code.
- The other callers of the extractor (import, attach, resolve, proxies, bulk run, consent documents, project export) have no hand-over limit. For them only `MAX_PDF_BYTES` (512 MiB) holds: about 1 GB at peak for a damaged or crafted file, as before RE-7. **Listed.**

## FR-529 — ruled by R478 (option b), built
- What already existed: unmounting only moved the generation on (`useEffect(() => () => void gen.current++, [])`), so a late answer changed nothing, but no request was aborted. The load effect does the same when the project changes.
- What was added: an effect keyed on `projectId` whose cleanup aborts every given-up request still open. It runs on unmount, and also when the same `ReviewQueue` instance is given another project: the route at `routes/import.tsx:107` renders it without a key.
- The test covers the unmount. The change of project is not covered by a test of its own: it is the same cleanup on the `projectId` change.

## NEEDS A RULING
None.

## What only a real Mac or service can show
- The web view's real connection limit (FR-558).
- The shell's ticketed close (FR-561, built by RE-7d).
- How a right-to-left name looks in WebKit's native `<select>`.

## Runs (nice -n 10; load average 40–44 on this machine)
- `pnpm --filter @ao/ui test` (whole suite, started before the R478 commit): Test Files 8 failed | 108 passed (116); Tests 23 failed | 2220 passed (2243). The failed files were `client.test`, `PdfPages` (15), `AppearanceSettings`, `FindAcquire` (2: "Try again … waiting files" and "R342 j … after Cancel"), `Library.reader`, `Reader.highlights`, `ReviewQueue` ("loads titles six at a time") and `colourScan`. Every one re-run alone passes:
  - `colourScan` and `AppearanceSettings`: 27 passed.
  - `PdfPages`: 17 passed.
  - `client`, `Library.reader` and `Reader.highlights`: 75 passed. Their first re-run, as a group, had 3 failures on time.
  - FindAcquire "Try again": 1 passed. "R342 j" passed in the full FindAcquire run.
  - ReviewQueue "loads titles six at a time": 1 passed.
- After the R478 commit: `ReviewQueue.test.tsx` and `FindAcquire.test.tsx` together gave 2 failed | 328 passed (330). The two failures were the known load-sensitive "loads titles six at a time" and "Try again … waiting files", and each passes re-run alone. Earlier, `ReviewQueue.test.tsx` alone (after the change, before the test-only fix of one assertion) gave 117 passed, and the 4 R478/FR-529/R313 e tests pass. `FindAcquire.test.tsx` alone: 212 passed (212).
- `pnpm --filter @ao/library exec vitest run src/extract src/find`: Tests 1 failed | 1484 passed | 2 skipped. The failure was "HTML of 200,000 unclosed <title> tags", on time, and it passes re-run alone.
- `pnpm -r typecheck`: exit 0, run before the last commits. `pnpm --filter @ao/ui run typecheck` after the R478 commit: clean.
- `lint:css`: clean. `lint:colours`: "ok: no hard-coded colours". `run build`: "✓ built".
- `git status --short`: empty.

minor (deferred): the review's M4 wording ("Wait until the test has started." could read "Wait until the test is done.") was not ruled and is not changed. Review M5 (the file handle opened outside the `try` in `pdf.ts`) is not in this brief.

## Second look: R486 e and f
| Point | What changed | Test, failed first? | Commit |
|---|---|---|---|
| e: N1 (FR-529, R478) | `ReviewQueue.tsx`: a new ref `outstanding` maps every open decision request's `AbortController` to its give-up timer, whether the request is inside its 60 s or already given up. It is set when the request is sent and removed in `finally`. When the queue goes away, on unmount or a change of `projectId`, the cleanup clears each timer, aborts each request, and empties `outstanding` and `givenUp`. A cancelled request's answer or failure returns early, as before. | `ReviewQueue.test.tsx` "R486 e: a decision still inside its 60 seconds is cancelled when the review queue is unmounted / shown another project, and no give-up timer is left". It is the reviewer's probe: decide, unmount (or rerender with another project) after 1 s, then the signal is aborted, the request is no longer open, `vi.getTimerCount()` is 0 after the unmount and still 0 after 11 minutes, no unhandled rejection is heard, and nothing is said on the other project. **Both cases failed first**: aborted 0, not 1. The FR-529 and R478 tests pass unchanged. | 8c42be0 |
| f: FR-577 comment | `pdf.ts`, the `RANGE_CHUNK` comment: ranges are of this size or a multiple of it, each cut at the file's end, so the last range, and a file smaller than this, are shorter. | None (comment). | 29c3288 |

Runs on the quiet machine, each file alone:
- `ReviewQueue.test.tsx`: 120 passed (120).
- `FindAcquire.test.tsx`: 212 passed (212).
- `pnpm --filter @ao/ui run typecheck`: clean.
- `git status --short`: empty.
