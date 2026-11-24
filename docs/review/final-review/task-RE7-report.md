# RE-7 report — Find and acquire, and the desktop shell

Worktree `.claude/worktrees/re-7-find-shell`, branch `re-7-find-shell`, from 567d98d. Not pushed.

## Items

| FR | Still present? | What changed (file:line) or why nothing | Its test, failed first? | Note |
|---|---|---|---|---|
| FR-576 | yes | `packages/ui/src/screens/FindAcquire.tsx` (~l.868): the projects' sentence is not shown when it is the same as the settings' one. Commit 02718f7 | `FindAcquire.test.tsx` "FR-576: when the service cannot be reached, its sentence is said once…" — failed first (2 elements, not 1) | |
| FR-529 | yes | `packages/ui/src/screens/import/ReviewQueue.tsx` `decideHeld` (~l.805–845): after the 60 s give-up, the request is no longer aborted. When its answer comes later, the queue is read again (only while the file is still listed: not after a lock or a change of project). The late answer still decides nothing by itself. Commit 23c33a2 | `ReviewQueue.test.tsx` "FR-529: a decision given up at 60 seconds that the service records later shows as soon as the service answers…" — failed first (the card still waited) | The existing R313 e test ("the late answer changes nothing") passes unchanged. |
| FR-557 | yes | `packages/ui/src/screens/YourLibrary.tsx`: a press on "Work out the address", "Stay signed in", "Save", "Test" or "Sign out of my library" while that control's own request is out now says to wait in the polite status region. It still sends nothing. Three sentences existed already (`waitDerive`, `waitStay`, `waitSave`). Two are new: `waitTest` "Wait until the test has started." and `waitSignOut` "Wait until signing out is finished." Commit 71320c2 | `YourLibrary.test.tsx` "FR-557 … each say to wait, and send nothing more" — failed first (nothing said) | The coordinator may want to confirm the two new sentences. |
| FR-558 | yes | `FindAcquire.tsx`: a new `QUEUE_READ_WAIT_MS` (60 s) and `readWaited`. The coalesced read loop (`readSoon`) and the start's read after the window opened (`startWindow`) now wait at most 60 s. After that the control is free and later reads go ahead. A late answer is still taken, in its order. Commit 526e7d1 | `FindAcquire.test.tsx` "FR-558: a read of the queue that never answers keeps no control busy…" — failed first (aria-busy still true after 60 s) | Nothing is said when a read is given up (R352 c leaves a client-wide end for reads to be weighed). |
| FR-561 | yes — on the page's side, not in the Rust shell | `FindAcquire.tsx` `openWindow` (late handler): an open given up on that the shell carries out later closes the window only when the page holds no newer ticket. If a newer start has opened its window, that one is left open. If the newer open is still under way, it finds the leftover and closes it itself (R342 b). Commit ee59e31 | `FindAcquire.test.tsx` "FR-561: an open given up on that the shell carries out only after a newer start opened its window does not close the newer window" — failed first (close called once) | R342 a's probe G test passes unchanged. |
| FR-577 | yes — in the library (Node), not in the Rust shell | `packages/library/src/extract/pdf.ts`: pdf.js now reads the file through a `PDFDataRangeTransport` over a file handle (64 KiB ranges, `disableAutoFetch`). Before, it was `readFile` and then a copy. A range that cannot be read ends the read as `readFailed` (pdf.js cannot fail a range, so the work is raced against that failure). New seam `pdfSeams.onRead` (only under NODE_ENV=test). Commit 7a8f5ee | `extract.test.ts` "FR-577: a large PDF is not read whole": a 33 MB PDF whose bulk lies beyond page 3 is read in less than 1/8 of its size, and title and text are still found (failed first: 33 557 657 bytes read). Also "a file that cannot be read part-way ends as unreadable" (failed first). | The proof is by construction (bytes read), not by resident memory. The hash on this path was already streamed (`copyFileAtomic` hashes while copying), and so were `takeInboxFile` and the type sniff. The whole-file load was pdf.js's input. The same extractor serves import, so import gains too. |
| FR-504, FR-527 | yes | Nothing changed — **NEEDS A RULING** (below) | — | |
| FR-490 | yes | Nothing changed — **NEEDS A RULING** (below) | — | |
| FR-297 | yes | Nothing changed — **NEEDS A RULING** (below) | — | |

## NEEDS A RULING

**FR-504 / FR-527 (R460 c) — larger than "a small change in the lists and one action".** Find and acquire has no run over "sources without a file". Entries come only from typed references. When an entry's record has an original, `copyOn` (`packages/library/src/find/runner.ts` ~l.2070) rests it at "in-library", using `sourceHasFile` (`repo/review.ts:516`). That function counts every non-destroyed original, including a linked one whose file is not there. Nothing in the find engine checks whether a linked file can be reached. What R460 c needs:
- (1) The runner tells a linked original it cannot reach (a file-system check at the copy step), and the entry rests with a new reason, "its linked file cannot be found at the moment; the drive it is on may not be connected". That is a new reason code in `@ao/shared` and its sentence.
- (2) A new act, "Get a copy for this source", with its route, the entry remembering the researcher's pick, and `copyOn` fetching despite `sourceHasFile`.
- (3) The hold, `holdMismatchedFile` (`repo/review.ts:623`), and the attach refuse a record that "has a file" (`HeldFileSourceHasFileError`), so both must accept a record whose only original is a missing linked one.
- (4) A decision: what "Use this file" does to the record's missing linked original. Does it keep both originals, or does the found file replace the link?
- (5) The row in the screen.

That is engine, shared types, service and screen, at least size M+, with decision (4) open. Recommendation: rule (4) first ("the found copy is added beside the linked original; the link stays, and the Missing files screen still lists it"), then build it as its own small task.

**FR-490 — no existing way to show a held file.** Held files sit in `find/held/<entry>.<pdf|epub>`, encrypted in an encrypted project. No route serves them. The app shows stored files only through the Reader, which reads an attached asset's content route, ranged; `FilePreview` shows pictures only. Showing a held file needs:
- a read-only service route for the held file (decrypting, ranged, and refused when the project is locked)
- the Reader opened on that route in a look-only mode, with no highlights and no record of the look (nothing is attached)
- a decision for EPUB held files: the Reader is PDF-only

Recommendation: a control "Look at the file" on each found-file card, opening the Reader in look-only mode for a PDF. For an EPUB, the card says "No preview of this file can be shown here." (FilePreview's sentence). Size M to L.

**FR-297 — what the researcher sees while the app closes is a decision.** When the last window closes, the shell (`apps/desktop/src-tauri/src/lib.rs`, `RunEvent::ExitRequested`) hides the main window and waits up to 95 s for the helpers, showing nothing. Options:
- (A) After 2 s without the helpers gone, the shell opens a small window of the interface's own. Title "Closing Alexandrine Oxiana"; one sentence: "Your library is being closed safely. This can take up to a minute and a half."; no controls. It goes when the helpers are gone. This needs a new page in the interface's build and a window in the shell.
- (B) Keep the main window open until the helpers are gone, showing the same sentence. This changes how the close works.

Recommendation: (A). Only a real Mac shows what is seen.

**The Rust shell:** no item here turned out to need a Rust change, so the shell was not built and its tests (`pnpm --filter @ao/desktop test`) were not run. A build I had started was stopped and `apps/desktop/src-tauri/target` deleted.

## What only a real Mac or a real service can show
- FR-561: the real shell's timing of a late open against a newer one (shown here with the shell's test double).
- FR-577: resident memory for a 150–200 MB PDF handed over by the real sign-in window or browser. Here it is shown by bytes read.
- FR-297: anything seen while the app closes.

## Runs (each at nice -n 10; the machine's load was 25–30 on 4 cores throughout)
- Touched test files: `FindAcquire.test.tsx` 209 passed (209). `ReviewQueue.test.tsx` 116 passed. `YourLibrary.test.tsx` 50 passed. `extract.test.ts` 43 passed | 2 skipped (45).
- `pnpm --filter @ao/ui test`: Test Files 5 failed | 111 passed (116). Every failure was in a test I did not touch, or a timing test under load (PdfPages, client.test, Library.reader, ReviewQueue "loads titles six at a time", FindAcquire "Try again … waiting files"). The failed files re-run alone: client, PdfPages, Library.reader, ReviewQueue — 4 files, 177 passed (177); FindAcquire — 209 passed (209).
- `pnpm --filter @ao/library test`: the first run was stopped by the background time limit (SIGTERM). The second run: Test Files 4 failed | 123 passed | 1 skipped (128); Tests 7 failed | 4436 passed | 22 skipped (4465). Every failure is a time-limit test in a file this batch did not touch and that does not use the PDF extractor: `html-strip`, `custom-styles` (the sandbox's limit), `refman` and `zotero-local` ("linear parsing … < 1 s"). Re-run alone they still fail on time (11 failed | 392 passed; `refman` alone 4 failed | 138 passed), at load 29.6 on 4 cores. **They need a re-run on a quiet machine before they are believed.**
- `pnpm -r typecheck`: exit 0, no errors.
- `pnpm --filter @ao/ui run lint:css`: clean. `lint:colours`: "ok: no hard-coded colours". `run build`: "✓ built".
- `pnpm --filter @ao/desktop test`: not run (no Rust change). `apps/desktop/src-tauri/target` deleted.
- `git status --short`: empty.

minor (deferred): `pdf.ts`'s header comment and the comment on `MAX_PDF_BYTES` ("not read into memory") still describe the whole-file read. The body of the new `read()` keeps its old indentation, inside a bare block, to keep the diff small.
