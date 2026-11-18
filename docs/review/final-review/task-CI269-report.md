# CI-269: report

**Case: B, a fault of the product.** The fault is in `copyFileAtomic` (`packages/library/src/fs/atomic.ts:189`), which the export calls at `project-export.ts:396` and `:435`.

## Cause
`copyFileAtomic` builds the source stream first: `createReadStream(src)`, and with `decode` it also calls `raw.pipe(decryptStream(getKey))`, which sets the file flowing. It then runs `await applyMode(fh, opts.mode)` (an `fh.chmod`). Only after that await does it attach `source.on("error")`, `source.pipe(hasher)` and the `for await`. The comment at the top of the function says every listener is attached synchronously, but `applyMode` breaks that promise.

If the file's first bytes reach the decrypt stream before the chmod returns, and `readHeader` throws, the decrypt Transform emits `'error'` with no listener. A lock that wipes the key makes `readHeader` throw, as at CI (the stack is the same). In Node an error with no listener is an uncaught exception. Then `source.pipe(hasher)` is made on a stream that is already destroyed, so `hasher` never ends, and the `for await` waits forever. That is the hung export.

Whether this happens is a thread-pool race. The chmod is one operation; the file read is open plus read. The read usually loses, and on a loaded 2-CPU runner it sometimes wins.

## Evidence
1. **Baseline.** The row passes as it stands (94 s here).
2. **Fault reproduced.** A temporary 30 ms delay before the chmod in `applyMode` makes the row hang until its limit (temporarily 5 min), with `Uncaught Exception KeyNotAvailableError … assertLiveKey format.ts:103 ← readHeader :361 ← transform :379 ← ReadStream.ondata`. This is identical to CI.
3. **Cause removed.** With the same delay and `applyMode` moved to before the streams are created, the row passes, with no uncaught error.
4. **A wrong first attempt.** Attaching `source.on("error")` before the await removed the hang, but six uncaught errors remained. The forwarded error then hit `hasher`, which also had no listener yet. An emit probe showed that every decrypt `'error'` had a listener. So the only real fix is to have no await between creating the streams and consuming them.
5. **Deterministic test** (uncommitted): `packages/library/src/export/project-export.ci269.test.ts`.
   - The temp file's chmod is held until the read stream has closed. No machine timing decides anything.
   - It has 5 tests. All 5 fail (hang plus uncaught error) on the current code, and all 5 pass with the proposed fix.
   - With the fix applied temporarily, the CI-269 tests, `src/fs` and `project-export.test.ts` all pass: 55/55. The fix was then reverted.

## Without a lock: yes
All three cases were tried at the export level. Each one hangs and throws an uncaught error:
- a file sealed under another key (`KeyNotAvailableError`);
- a damaged file (`EncryptionFormatError: bad magic`);
- a file that is gone (`ENOENT`).

Plain `copyFileAtomic(missing, dest, { mode })`, with no decryption at all, also throws an uncaught `ENOENT` and hangs. The reason: when there is no `decode`, `raw` has no error listener during the await.

## Other callers
**Not safe** (each calls `copyFileAtomic` with a `mode`, so it has the await):
- `project-export.ts:396` and `:435`: decode plus mode. Lock, damage or a missing file.
- `repo/mutate.ts:276/278` (`copyFile`): with `sourceEncrypted`, the same as the export. Without it, an unopenable source when `noFollow` is off.
- `worker-client.ts:518`: the decrypt is in `transform`, which is applied after the await, so that part is safe. A missing or unreadable input still races.
- `worker-client.ts:908` (encrypt), `import/proxies.ts:334`, `repo/txn.ts:145`, `reconnect.ts:1110` (with a mode), `move.ts:606`: a source that fails to open during the await.

**Safe:**
- `worker-client.ts:914` and `reconnect.ts:1110` without a mode: `applyMode` returns at once, a microtask only, before any I/O can complete.
- `reconnect.ts:88` (`hashOf`): the pipe and the `for await` are synchronous together, and raw errors are forwarded.
- `repo/io.ts` `collect`: the listeners come before `end`.
- `export/backup.ts:790`: `pipeline` attaches everything synchronously.
- `asset-content.ts:100` and `crypto/random-access.ts` (`openDecryptedHandle`): promise-based reads with no stream events.

## Proposed fix (not built)
In `copyFileAtomic`, run `await applyMode(fh, opts.mode)` right after the temp file is opened, inside the same try. If it fails, close `fh` and `srcFh` and remove the temp file. Then create the streams and attach every listener with no await before the `for await`.

After the fix, a lock mid-export settles through `copyFileAtomic`'s catch. The export ends refused as locked, and `exportInner`'s catch shreds the `.partial` folder, so nothing is left behind (the test checks `walk(out) == []`). Nothing is uncaught, so the service keeps running. Damage and a missing file end as `ExportFailedError`.

One file, about 5 lines. Optionally, in the same file, `raw` could always get an error listener, as defence in depth.

## ROW_MS
A 30-minute limit per row is not needed: the slowest passing row at CI took 188 s (`restoreBackup`). About 10 minutes would have shown this fault. To see it in about a minute, put a hang detector of about 60 s on each single reading (each `cold()` call) rather than on the row.

## Uncertain
- I could not reproduce the natural race here without the delay. The CI identification rests on the identical stack plus the deterministic reproduction.
- The service has no `uncaughtException` handler (grep of `apps/library-service/src`), so I infer it would crash. I did not run the service to see it.

## The fix (R454)

Branch `ci-find-runner-flake` (worktree `.claude/worktrees/ci-flake`). Three commits, not pushed:

- `c4644c8` — **(a, b, c) `copyFileAtomic`** (`packages/library/src/fs/atomic.ts`).
  - The temp file is opened and its mode applied first, in one try. If that fails, both handles (`fh`, `srcFh`) are closed and the temp file is removed; it is removed only when this call created it.
  - Only then are the streams made. Every listener is attached with no `await` before the `for await`, and `raw` always has an error listener.
  - The catch also closes `srcFh`.
  - The opening comment now states the rule, and that an `await` there breaks it.
- `e53c0ee` — **(d) harness** (`packages/library/src/repo/lock-mid-read.test.ts`).
  - Every reading is raced against a 120 s limit (`READ_MS`, `hangLimit()`). With a lock, the clock starts when the lock lands; without one, it starts with the reading.
  - It covers the base, locked-from-start, lock-point and after-unlock readings.
  - A hang fails the row at once: "`<row>`: the reading did not end within 120 s after the lock landed at opening N: a hang".
  - `ROW_MS` is unchanged.
- `c563bd3` — **(e) two mends of the same shape.**
  - `extract/zip.ts` `extractArchive` with `sparse` (a restore): the sparse target is opened before the entry's stream. yauzl pipes that stream into the inflater at once.
  - `export/backup.ts` `writeZip`: the temp file is opened before the zip is built. yazl starts reading files as they are added.

### Tests, each seen first on the old code
- **`src/fs/atomic.test.ts`**, describe "copyFileAtomic: a source that fails at once (R454)". The temp file's chmod is held until the named stream has closed. Each test checks the right rejection, no temp file, no destination, every handle `fd === -1`, and no `uncaughtException`/`unhandledRejection` (process listeners).
  - A decode failing on its first bytes: FAILED first (hang plus uncaught).
  - A missing source with a mode: FAILED first (hang plus uncaught `ENOENT`).
  - A transform that fails at once: passed on the old code too. The transform is applied after the old await, so it is a regression guard.
  - A chmod that itself fails (with `noFollow` plus `decode`, so 2 handles): passed on the old code too, a guard.
- **`src/export/project-export-read-fails.test.ts`** (my five CI-269 tests moved here and renamed; the `.ci269` file is gone). Cases: a lock at the decrypt opening, another key, damage, a missing file. All 4 FAILED first (hang plus uncaught). Each now ends: refused as locked, or `ExportFailedError`; nothing in the destination folder; nothing uncaught.
- **`src/extract/zip.test.ts`** (new). A corrupt deflated entry, sparse extraction, with the target's open held until the entry stream emitted its error (seen through `emit`, not as a listener). It FAILED first with an uncaught `invalid block type`; it is now refused as `zip-invalid`.
- **`src/export/backup-read-fails.test.ts`** (new). A file is deleted after the snapshot (the `backupSeams.afterSnapshot` seam), and the temp file's open is held until the zip reported the error. It FAILED first with an uncaught `ENOENT` plus a hang; it now ends.
- **(d) shown:** with the old `copyFileAtomic` and the 30 ms delay put back temporarily, the export row failed in 136 s: "exportProjectOpenFormats: the reading did not end within 120 s after the lock landed at opening 14: a hang". Before, it took 30 min.

### (e) Every place that makes a file stream (non-test; packages/library, packages/core, apps/library-service, apps/cli)

| file:line | verdict | why |
|---|---|---|
| fs/atomic.ts:226 (`createReadStream`, `srcFh.createReadStream`, `.pipe`) | mended (a) | the await on the chmod was between making the stream and listening to it |
| export/project-export.ts:398, :435 | mended via (a) | `decode` through `copyFileAtomic` |
| repo/mutate.ts:273/276/278 | mended via (a) | `copyFileAtomic` with `decode`/`transform` |
| worker-client.ts:518, :908, :914 | mended via (a) | `copyFileAtomic` |
| import/proxies.ts:334 | mended via (a) | `copyFileAtomic` |
| repo/txn.ts:145, reconnect.ts:1110, move.ts:606 | mended via (a) | `copyFileAtomic` with a mode |
| extract/zip.ts:301 (sparse) | **mended** | `await sparseWriter(target)` was evaluated inside `pipeline`'s arguments, after yauzl had set the entry reading |
| export/backup.ts:790 (`pipeline`, yazl) | **mended** | `await fsp.open(tmp)` came after the zip was built (lazy reads start) and before `zip.once("error")` |
| export/backup.ts:764 | safe | the lazy getter attaches `open`/`error` synchronously |
| export/backup.ts:507, repo/sources.ts:363, import/common.ts:53, import/zotero-web.ts:622, :1322, reconnect.ts:134 | safe | `for await` straight on the new stream |
| reconnect.ts:88–100 (`hashOf`) | safe | pipe, the forwarding listener and the `for await` are synchronous together |
| move.ts:262 | safe | listeners chained on creation |
| import/sqlite-copy.ts:91 | safe | both streams made inside `pipeline`'s arguments, no await |
| repo/watch-register.ts:230 | safe | a handle stream (no open, no read until consumed); `createInterface` and `for await` follow synchronously |
| find/queue-store.ts:411 | safe | a handle stream, consumed at once by `yield*` |
| find/queue-store.ts:741, asset-content.ts:141, crypto/random-access.ts:162, library-service routes/documents.ts:112 | safe | `Readable.from` over memory or a generator: nothing runs until it is read |
| find/fetch-file.ts:422–424, import/zotero-web.ts:599 | safe | an undici body that fails is given undici's own no-op error listener (api-request.js `onError`), and `pipeline` on an errored stream rejects. The write stream is made inside the arguments |
| library-service media.ts:508 | listed | `await hooks.beforeSend()` sits between `rest.pipe(out)` and `reply.send(out)`, and a `stop` meanwhile would `out.destroy(err)` with no listener. `beforeSend` is a test-only seam (`mediaBeforeSend`, server option), so production has no await. Moving it would change what the tests that use it simulate, so I left it |

There are no file streams in `packages/core/src` or `apps/cli/src`.
Count: 2 mended directly, plus `copyFileAtomic` (a) covering its 13 call sites; 18 safe rows; 1 listed.

(f) FR-711, the service's last handler: listed, not built.

### Runs (each at nice 10)
- `vitest run src/fs src/export src/repo/lock-mid-read.test.ts`: 336 passed, 3 failed, 20 skipped, in 8 m 10 s. The export row passed.
- `pnpm --filter @ao/library test`: 4385 passed, 3 failed, 73 skipped (128 files), in 11 m 25 s.
- `pnpm --filter @ao/library-service test`: 1085 passed, 2 failed, in 3 m 32 s.
- `pnpm -r typecheck`: clean (exit 0).
- **All 5 failures are `CslBundleMissingError`**: "the CSL bundle is not set up". This worktree has no fetched citation styles (`pnpm fetch-csl` downloads them, which the "no installs" rule ruled out).
  - library: `refman-participants` R379 probe, and the harness rows `exportBibliography` and `citeSources`, which fail in their unlocked base reading;
  - service: `POST /cite` and R390 (c) `/bibliography`.
  - None of them touches a changed file. They need a re-run where the bundle exists (the main verification, or GitHub).
- `git status --short`: empty. Every temporary delay is out.
