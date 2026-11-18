# CI-269 review — `copyFileAtomic`, restore unzip, backup zip (R454)

Worktree `.claude/worktrees/ci-flake`, branch `ci-find-runner-flake`, base 4cc4348, head c563bd3 (c4644c8, e53c0ee, c563bd3).
Reviewer: a fresh adversarial review. Every probe (`*.probeCI269.*`) is deleted, and `git status --short` is empty.

## Verdict: APPROVED WITH SMALL POINTS

The fault is closed on every production path I could reach. Every failure I tried settles with the first error. Each one left no temp file, no destination, no extra fd and nothing uncaught. The success path is unchanged. All six new deterministic tests that should fail on the old code do fail there. No Critical findings, no Important findings, three Minor findings.

## Spec (R454)

| Item | Status |
|---|---|
| (a) mode applied right after the temp open, inside a try that closes both handles and removes the temp file; streams made after; no `await` before the `for await`; `raw` always listened to; the opening comment states the rule | Built. "`raw` always has a listener" has one theoretical gap (M1). |
| (b) the researcher sees the ordinary error; the service keeps running | Built (export: refused as locked / `ExportFailedError`; nothing in `out`). |
| (c) deterministic tests at `copyFileAtomic` and the export | Built. Checked against the old code (below). |
| (d) a 120 s limit on each reading, naming the row and the opening; ROW_MS kept | Built and shown to work. One gap: a reading whose lock point is never reached has no limit (M3). |
| (e) the other stream makers reviewed; same-shape faults mended | zip.ts (sparse) and backup.ts `writeZip` mended; media.ts:508 listed. Table spot-checked: sound. |
| (f) FR-711 listed, not built | As ruled. |

## What I ran (each alone, at `nice -n 10`)

- **`atomic.probeCI269.test.ts`** (21 cases), against the new code:
  - Failure cases:
    - a missing source, with and without a mode or `noFollow`;
    - ELOOP (a link with `noFollow`);
    - a directory as the source (EISDIR), plain, with `noFollow` and with `decode`;
    - a `decode` that throws synchronously, with a source that exists and with one that is missing;
    - a `transform` that throws synchronously (`encryptStream` with a wiped key);
    - a decode stream that errors before any data;
    - errors in the decode stream on chunk 1, 3 and 4 of 4;
    - a transform that errors in the middle and in `flush`;
    - a late `'error'` emitted on `raw` after the copy had rejected;
    - ENOSPC on `fh.write`, EIO on `fh.sync`, a failed rename (EISDIR: the destination is a non-empty directory), EPERM on `chmod`, and a failed temp open (no destination folder) with `noFollow`;
    - decrypt and transform together, to check that the first error wins.
  - Each was checked for:
    - a short limit (5 s);
    - the error expected;
    - the folder listing;
    - `/proc/self/fd` before and after;
    - `uncaughtException` / `unhandledRejection` listeners.
  - **All passed except M1.**
- **Success paths:** all identical.
  - A 64 MB copy: same sha256, byte count and bytes; mode 0o640.
  - An empty file with `noFollow`.
  - umask 077 with mode 0o644 gives exactly 0o644.
  - An existing destination is replaced, and no `.tmp-` file is left.
  - Encrypt through `transform`, then decode back: the same plaintext hash both ways.
  - Every `fh.write` happened with the temp file already at 0o600, and `sync` ran before the rename.
- **The committed R454 tests against the old `atomic.ts`** (a scratch copy of 4cc4348, wired in through the test's import):
  - "decode fails on first bytes" and "missing source with a mode" FAIL (hang).
  - "transform fails at once" and "chmod itself fails" pass, as the implementer said.
- **Mutants of the new `atomic.ts`:**
  - Without `await srcFh?.close()` in the first catch, "a chmod that itself fails" FAILS ("a file handle left open"). So that test does guard the new line; it is not useless.
  - Without the `r.on("error", …)` raw listener, no `atomic.test.ts` test fails. The export test "the file gone" does fail (hang). My probe "directory with decode" also failed: a hang, an uncaught EISDIR, and a temp file and fd left behind. See M2.
- **`project-export-read-fails.test.ts` against the old `atomic.ts`** (via `vi.mock`): all 4 FAIL (hang). This confirms that Vitest sees the uncaught error and that the listeners hide nothing.
- **`zip.test.ts` and `backup-read-fails.test.ts` against the old `zip.ts` / `backup.ts`:**
  - zip: FAILS with an uncaught "invalid block type".
  - backup: FAILS with a hang and an uncaught ENOENT.
  - Both pass on the new code.
- **Zip probe:**
  - Sparse extraction where `openReadStream` itself errors: refused `zip-invalid`, no fd leak, nothing uncaught.
  - A corrupt second entry: the same.
  - A sparse extraction on the new code and on the old code: the same names, byte counts, sha256 and modes (holes, a `.enc` stored entry, an empty file, all zeros).
- **Backup probe** (plain and encrypted):
  - After the snapshot, each file was gone, shorter, or replaced by a directory: each attempt ended (retried from a new snapshot); nothing uncaught; no fd leak.
  - A failure on both attempts: rejects with ENOENT, no temp file left in Backups.
  - Cross-version:
    - a backup made by the new code restores with the old `restoreBackup`, and the reverse (plain and sealed);
    - a damaged sealed backup restored from outside the library: `UnreadableBackupError`;
    - a damaged plain one: `zip-invalid`;
    - in both, no `.creating-*` folder left and nothing uncaught.
- **Harness (d):**
  - Setup: `lock-mid-read.test.ts` with `copyFileAtomic` replaced by the old code plus a 30 ms delay before `chmod`, run on rows `exportProjectOpenFormats`, `backupProject` and `checkIntegrity (quick)`.
  - The export row failed in 136 s: "exportProjectOpenFormats: the reading did not end within 120 s after the lock landed at opening 14: a hang". Vitest also reported the uncaught `KeyNotAvailableError`.
  - **The next two rows then passed** (25 s, 3 s). A cut-off reading did not leave the shared context broken (lock, key, held changes) for later rows.

## Findings

### Minor

- **M1 — `packages/library/src/fs/atomic.ts:226-230`: `raw` has no listener while `opts.decode` runs.**
  - Failing input: a `decode` that throws synchronously while the source is missing.
  - What happens: the promise rejects correctly with the decode's error. Then `raw.destroy()` runs during the stream's open, the open fails, and the stream emits ENOENT after destroy with no listener.
  - Probe output: `uncaught ["Error: ENOENT: no such file or directory, open '…/nope'"]`.
  - Not reachable today: every production `decode` is `r => r.pipe(decryptStream(…))`, which does not throw synchronously.
  - The old code had the same gap. The ruling's "`raw` always has an error listener" is not literally met.
  - Direction: attach a listener to `raw` as soon as it is made, before `decode` is called (for example, one that forwards to whichever stream is current).
- **M2 — `packages/library/src/fs/atomic.test.ts` (R454 describe): the `raw → source` listener is held only by the export test.**
  - Removing `if (s !== r) r.on("error", …)` passes all four `copyFileAtomic` tests. Only `project-export-read-fails` "the file gone" catches it.
  - Direction: a unit case at `copyFileAtomic` for a raw read failure with `decode`, such as a missing source with `decode` and no `noFollow`, or a directory source with `decode`.
- **M3 — `packages/library/src/repo/lock-mid-read.test.ts:218-226, 343-347`: the limit is armed only when the lock lands, or for the base reading.**
  - A reading at a lock point that hangs before reaching opening N has no 120 s limit, and falls back to ROW_MS (30 min).
  - With R443 marks a reading can wait on held turns, so that window exists.
  - This is the stated design ("after its lock landed, when one does"), but R454 (d) says "a limit on EACH reading".
  - Direction: arm a limit from the start of every reading as well, larger if needed.
- **Note (not a defect) — `extract/zip.ts:287-296`: an empty target file is now left when `openReadStream` fails.**
  - The sparse target is now created before `openReadStream`. If that call fails, an empty target is left; previously nothing was created.
  - `sparse.destroy()` is not awaited, so the handle closes asynchronously.
  - The restore removes its `.creating-*` staging folder (backup.ts:2024) and the library sweeps it on open (repo.ts:530), so nothing survives.
  - On Windows, a handle still open could make that `rm` fail until the next sweep.

## Checked and sound

- Between making each stream and listening to it, `copyFileAtomic` has no await, `nextTick` or promise. `raw`, `source`, the hasher and the transform output are each listened to from creation, except M1.
- Late errors after `destroy()` are absorbed: the listeners stay, and destroyed streams ignore a second `destroy(err)`.
- The first error wins; no "premature close" or "did not consume" error replaces it.
- `srcFh` is closed on every path.
- The temp file is removed only when this call created it.
- `applyMode` placed earlier changes nothing visible: no data is written before it, in the old code or the new.
- None of the 13 call sites depends on the old order or on the temp file's existence. txn, reconnect and move now get the plain ENOENT and so on, where before they got a hang.
- `writeZip`: the zip, its lazy readers and `zip.once("error")` are now created synchronously after the temp open. A file that fails mid-read reaches the zip's error through the reader's still-armed `once('error')`. The restore and backup bytes are unchanged (cross-version restore passes both ways).
- `extractArchive` sparse: only microtasks lie between `openReadStream`'s callback and `pipeline`.
- Stream-maker table, checked by reading:
  - reconnect.ts:85-95 (`hashOf`), :134 (`hydrate`);
  - move.ts:262;
  - watch-register.ts:230;
  - queue-store.ts:411;
  - sqlite-copy.ts:91;
  - fetch-file.ts:405-424;
  - zotero-web.ts:599;
  - sources.ts:363, common.ts:53, backup.ts:507;
  - asset-content.ts:141, random-access.ts:162, documents.ts:112.
  - Undici's no-op error listener is confirmed in undici 8.12.3 `lib/api/api-request.js:148,201`.
  - The grep turned up no stream maker missing from the table.
- media.ts:508: the `await` exists only when `mediaBeforeSend` is set. It is a server option that only tests pass (server.ts:78/322), so production goes straight from `rest.pipe(out)` to `reply.send(out)`. `rest` has its `once('error')` from creation.
- The test devices (holding `chmod` or `open` until a named stream has closed, watched through `emit` rather than through a listener) are event-ordered and do not depend on the machine's speed. The process-level listeners do not hide errors from Vitest: they are removed in `afterEach`, and Vitest reported the uncaught error in the harness run.

## Could not verify

- How long the slowest single reading takes under artificial load (`nice -n 19` plus a busy loop on every core): not run. Unloaded, at load average 0.3, whole rows took 3–25 s over up to 40+ readings, which is far below 120 s.
- The Windows behaviour in the note above.
- GitHub's run.

## Second look (R455)

Scope: `git diff c563bd3..e470217`: commits 26ccbc6 (M1, M2) and e470217 (M3). Every probe is deleted, and `git status --short` is empty.

**Verdict for this round: APPROVED.** M1, M2 and M3 are closed. One cosmetic point, which needs no change.

### M1: the raw stream is listened to before `decode` is called (`atomic.ts:228-233`)

The new listener is `r.on("error", err => (source !== undefined && source !== r ? source : hasher).destroy(err))`. It is attached before `decode` runs. It forwards to the decoded stream when there is one, and to the hasher otherwise. When `decode` throws, `source` is undefined, so the error goes to the hasher, which the catch destroys anyway.

A probe (13 cases) ran against the new code. For each case it checked:
- the promise settles exactly once (a counter);
- the error;
- 10 `setImmediate` turns, plus 150 ms, plus 10 more turns afterwards with nothing uncaught;
- `/proc/self/fd` before and after;
- the folder listing.

The cases:
- a `decode` that throws at once:
  - with a missing source, with and without a mode;
  - with a source that exists, with and without `noFollow`;
- a missing source:
  - plain;
  - with a `decryptStream` decode;
  - with a decode and a transform;
- a directory as the source, with and without a decode (EISDIR on read);
- an error on `raw` in the middle (chunk 2 of a 400 KB file), with and without a decoded stream;
- a decoded stream that fails in the middle;
- a decoded stream that fails first, followed by a late `destroy(err)` and then an `emit('error')` on `raw`.

Result: every case rejected with the FIRST error. That is "decode boom", ENOENT, EISDIR, "raw mid", "dec mid" or "first", never "premature close" or a secondary error. The fd count was unchanged and no temp file or destination was left. Nothing was uncaught.

The success path is unchanged: a 5 MB + 7 byte file, copied plain, with mode 0o640, with `noFollow`, with a decode, and with a decode and a transform, gave the same sha256 and byte count as the source.

Does the listener ever send an error to the wrong stream?
- When a decoded stream exists, `raw`'s error goes to it, and that stream's own listener passes it to the hasher, so the error stays the same object.
- When the decoded stream is already destroyed, `destroy(err)` on it is a no-op, so the first error stands. The late-raw case shows this.

### M2: do the two new tests fail without their guards?

The probe was a mutant copy of `atomic.ts` with the new raw listener removed and the old `s.on("error")` put back for the no-decode case, run against a copy of `atomic.test.ts`.
- Test (i) ("decode that throws when called") FAILS: "an uncaught exception or unhandled rejection".
- Test (ii) ("missing source with a decode") FAILS in 5 s: `expected 'hung' to match object { code: 'ENOENT' }`.

The test's own 5-second race turns the hang into a plain assertion failure, so this is not a hang until Vitest's limit. That is an acceptable and readable way for it to fail. Its `nothingLeft` checks then never run, but the failure is already clear.

### M3: the 300 s limit on a whole reading (`lock-mid-read.test.ts`)

- **When the timer starts and is cleared:**
  - The timer `w` starts when `hangLimit(whole)` is called. Nothing is awaited between that call and the reading's `try`.
  - In `cold` and in `exercise`, `clear()` clears both timers in the `finally` around the reading. So no timer outlives its reading or can fire into a later one.
  - Readings without a lock point (`cold(row)` and the locked-from-start reading) pass no `whole`, so they create no timer.
- **It fired once.** The probe was a copy of the harness with one extra row whose readings after the first hang before any opening. Message:
  `PROBE hangs before its lock: the reading did not end within 300 s (the lock had not landed yet): a hang`.
  The row failed at 300.2 s, the run ended in 5 m 7 s, and the process exited normally with no timer left behind. The getFieldwork row in the same run passed in 1.5 s.
- **Can it fire on a merely slow machine?** Not plausibly. In my first-round run, the `backupProject` row took 25.5 s for all of its lock-point readings together, and `checkIntegrity (quick)` took 3.4 s, at load average about 0.3. One whole reading is therefore well under a second here, so 300 s leaves a margin of more than 100×. I did not measure it under an artificial full-core load.

### Point (cosmetic, no change needed)

- When the lock has not landed, the 300 s message gives the row but not the planned lock point. For example, `exercise` says "(the lock had not landed yet)" without `n`. Which lock point hung could only be inferred from the order of the tests. Adding "(lock point N)" would make it exact.
