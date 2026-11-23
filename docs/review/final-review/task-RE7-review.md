# RE-7 review — Find and acquire, and the desktop shell

Worktree `.claude/worktrees/re-7-find-shell`, branch `re-7-find-shell`, 567d98d..7a8f5ee (6 commits, one per item). Reviewed: FR-576, FR-529, FR-557, FR-558, FR-561, FR-577. FR-504/527, FR-490 and FR-297 were sent back for a ruling (R470) and are not reviewed here.

## Verdict
**NOT APPROVED for FR-561.** One Important finding: the late open can still close a newer sign-in window. The other five items hold, with small points, and may merge on their own.

## What I ran (each alone, at nice -n 10; every probe deleted; `git status --short` empty at the end)
- `extract/eq.probeRE7.test.ts`: the old `extractPdf` (copied from 567d98d) against the new one on 16 inputs, plus one file that grows and one that shrinks while it is read. The inputs: an empty file; 1 byte; a header alone; a plain PDF; object streams; 1,000 and 70,000 bytes of garbage before `%PDF`; 200 KiB of garbage after `%%EOF`; a PDF followed by a ZIP tail (a polyglot); a file cut short at 3,000 bytes; a broken `startxref` (pdf.js has to rebuild the cross-reference); a file of exactly 64 KiB; a rewritten later revision; the password-protected fixture; and the two f14 hand-built fixtures. **All 16 give results deep-equal to the old ones.**
- `extract/mem.probeRE7.test.ts`: a sparse 400 MB PDF whose bulk is a stream no page uses.
  - New code: +97 MB resident, 131,861 bytes read. Old code: +839 MB resident.
  - The same file with a broken `startxref`: the new code reads **419,431,182 bytes in 3 reads** and costs +874 MB resident (see M1).
  - A file over 513 MB: both versions return `{}` without reading.
- `extract/perf.probeRE7.test.ts`: 20 extractions of a 300-page, 314 KB PDF. Old: 7.4 s and then 3.1 s. New: 8.1 s and then 4.4 s. The machine was under load, so these timings are noisy.
- `screens/FindAcquire.probeRE7.test.tsx`: FR-561 with the screen left and come back to, and a baseline; FR-576 with the projects answering while the settings and the queue cannot be reached.
- I removed each guard for a run and put it back with `git checkout`:
  - FR-558 (`readWaited` back to `await readOnce()`): its test fails.
  - FR-561 (`&& !libTicket.current` removed): its test fails, and R342 a probe G still passes.
  - FR-576 (the `!== screenError` removed): its test fails.
  - FR-529 (`readLate` calls removed): its test fails, and the R313 tests pass.
- FR-557 and FR-577: I judged by reading that their tests fail without the fix. The FR-577 test needs the new seam; the FR-557 test asserts the new sentences.

## Findings

### Important
**I1 — FR-561: the late open still closes a newer window once the page is left and opened again, or another project is chosen.**
- Where: `packages/ui/src/screens/FindAcquire.tsx:1622`. The test `if (late === true && !libTicket.current)` reads the `libTicket` of the `ProjectQueue` that made the request.
- Why: that component is keyed by epoch and project (`:883`), so it is replaced when the screen is left and come back to, or when the project changes. The late handler also ignores `alive` and `gen`. When the old instance is gone, its `libTicket` stays `null`, and the newer start's ticket lives in the new instance, where the handler cannot see it.
- Probe:
  1. Start; give up at 60 s; the start is cancelled.
  2. `unmount()`, then `show()` again.
  3. Start again: the window opens for ticket SECOND, and the row is "Waiting for you in the sign-in window".
  4. Answer the first open with `true`. **`closeLibraryWindow` is called once**, which ends the newer wait.
  5. The baseline without leaving the screen calls it 0 times.
- Another way in: the shell has one window, and "Test" on Your library opens it too. A Find page's late answer closes that window as well; no state on the Find page can see it.
- The shell's `close` (`apps/desktop/src-tauri/src/library_window.rs:1755`) takes no ticket and closes whatever window is open. So the page cannot be the complete fix: only the shell knows which ticket its window serves.
- Direction: close by ticket — `closeLibraryWindow(ticket)`, which the shell ignores when the ticket is not its own. Or, at the very least, keep the "newer window" knowledge at the level of the screen or the app rather than in `ProjectQueue`. This is a Rust change, which this batch avoided.

### Minor
**M1 — FR-577: the check is bounded only for a well-formed file.**
- Where: `packages/library/src/extract/pdf.ts:35-56`. pdf.js asks for missing data as **one** range, and `readRange` allocates that whole range as a single `Buffer`. pdf.js's `ChunkedStream` also allocates `new Uint8Array(length)` up front.
- When pdf.js must rebuild the cross-reference (a damaged file, or a crafted one), it asks for the whole file: one 419 MB `Buffer`, then a copy. Peak memory is about twice the file size, as before the fix.
- On the hand-over path, `LIBRARY_FILE_MAX_BYTES` (200 MiB) bounds this at about 420 MB plus parsing. Elsewhere, `MAX_PDF_BYTES` (512 MiB) bounds it at about 1 GB.
- This is no regression, and the measured case (a well-formed file) is fixed. But the comments say "never the whole file into memory" (`:35`), and `MAX_PDF_BYTES`'s comment (`:22`) is stale.
- Direction: read and deliver large ranges in `RANGE_CHUNK` pieces (`onDataRange` per piece), and/or a lower size cap for the file check. Correct the two comments.

**M2 — FR-576: the sentence is still said twice in another state.**
- Where: `FindAcquire.tsx:875` removes the duplicate only between the projects' error and the settings' error.
- Probe: the projects answer, and `/find/screen` and the queue cannot be reached. Two `role="alert"` elements then both say "The library service could not be reached.": the settings' one and `ProjectQueue`'s queue error.
- This can happen when the service goes away part-way through loading, or on a re-read after the connection is lost.
- Direction: one rule for "the service cannot be reached" across the screen, including the queue's error.

**M3 — FR-558 and FR-529: a request that never answers is now left open, never aborted.**
- Where: `FindAcquire.tsx:1362-1369` and `ReviewQueue.tsx:822`.
- FR-558: each later read starts a new request while the old one still hangs, so with a service that takes requests but never answers, one more connection is left open each time a read is given up (60 s). The WebView keeps about 6 HTTP/1.1 connections per host, and the event stream holds one, so after a few minutes every request of the app to the service waits. Before the fix there was at most one hung read.
- FR-529: one more hung request is left for each press that is given up.
- I could judge this only by reading.
- Direction: abort the hung read when the wait gives up. A late answer is then lost, but the next read shows the same.

**M4 — FR-557: one sentence promises something that may not happen.** "Wait until the test has started." (`YourLibrary.tsx:84`) is also said when the test then fails ("could not be started"). "Wait until the test has finished." or "Wait until the test is done." is true in both cases.

**M5 — FR-577: small points about file handles.**
- `getDocument` and the transport are built after `fsp.open` and outside the `try`, so a throw there leaks the file handle. Unlikely, but a one-line move.
- The handle is now held for the whole extraction, not only during `readFile`. A bulk import that runs many extractions at once holds that many handles (macOS's default limit is 256). I did not measure this.
- The probe shows the new code about 10–40 % slower on a 314 KB file under load; the timings are noisy.

**M6 — FR-561 test (`FindAcquire.test.tsx` "FR-561 …").**
- After `answer(true)` it waits 300 ms (`quiet()`) to show that something did *not* happen. That is the file's existing pattern, and acceptable for an absence.
- Its shell double opens the newer window while the first open is still pending. The real shell would refuse that open, because its ticket is still held (`library_window.rs:1498`), and R342 b would then close the leftover. The test proves the page's guard, not the real order of events.

## Checked and sound
- FR-577: every input gives the same result as before (above), including a header not at byte 0, garbage after `%%EOF`, a polyglot, a truncated file, a rebuilt cross-reference, an encrypted file, and a linearised file. pdf.js decides linearisation the same way in both modes: `Linearization.create` compares `/L` with the length.
- FR-577: what is decided from the file's first bytes is unchanged (`fileTypeByBytes`), and so is the hash: the hold's `tx.copyFile` → `copyFileAtomic` already hashes while it streams, also when it seals the copy in an encrypted project.
- FR-577: all callers (`file-check.ts`, `extractMetadata` from import/attach/resolve/proxies/bulk run/consent-docs/project export) get identical results. The export extracts a decrypted copy and shreds it after the awaited extraction. A 10 GB file is refused at the take (200 MiB) and is never read by the extractor (over 512 MiB it returns `{}`). A file that shrinks while it is read ends as `readFailed`, where the old code read what was there; that is acceptable.
- FR-561: on the screen as it stays — two starts in quick succession, a start for another entry, a late failure (`late === false` does nothing) — the newer window is left alone, and R342 a probe G still passes.
- FR-558: given up after `QUEUE_READ_WAIT_MS` (60 s), then free. The read's late answer is still taken, in its order (`clock`/`metaSeq`). The test waits for the resting state (`aria-busy` absent, then the row's new state).
- FR-529: re-read only while the file is still listed (not after a lock or a change of project). `fileLeft` is not called for a late answer, so nothing is said twice. The R313 e test is unchanged and passes. The test waits for "No longer waiting." and counts exactly one more read.
- FR-557: each new sentence is shown only while that control's own request is out, is said once per press through the polite region, sends nothing, and uses plain words. The two new sentences are not used anywhere else.
- House rules: no colour, `innerHTML` or path was added. The sentences go through `say`/`UserText`.

## Table
| FR | Implementer's claim | Verdict | Note |
|---|---|---|---|
| FR-576 | sentence said once | partly | M2: twice when the settings' and the queue's reads both fail |
| FR-529 | late record shown at once | holds | M3 (request no longer aborted) |
| FR-557 | press says to wait | holds | M4 wording of `waitTest` |
| FR-558 | hung read keeps nothing busy | holds | M3 (hung reads pile up) |
| FR-561 | late open no longer closes a newer window | does not hold | I1: screen left and come back to / project changed / Your library's Test window; the shell's ticket-less close is the root |
| FR-577 | PDF read by range, not whole | holds for well-formed files | M1 (a rebuilt cross-reference still costs about twice the size; comments overclaim), M5 |

## What I could judge only by reading
- The real shell's order of events for a late open (no Rust build).
- The WebView's connection limit (M3).
- Whether bulk import's parallel extraction approaches the handle limit (M5).
- Resident memory inside the real desktop service (the probe measured a Vitest worker).
