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
