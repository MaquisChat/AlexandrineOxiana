# 0010. Reconnecting, missing files, offline drives and cloud placeholders

- **Status:** Accepted
- **Date:** 2026-11-10

(0009 is reserved for the capture tools ADR.)

## Context

Spec 4.5 says a library can be renamed or moved outside the app, can live on a removable or network drive that comes and goes, and can sit in a cloud-synced folder (iCloud Drive, OneDrive, Dropbox, Google Drive) whose files may be online-only placeholders. The app must find the library again, check it, rebuild its index, restore missing files, and handle a drive that disappears, all without losing data or writing to the wrong place. Reading a placeholder downloads it, so a check must never read one by accident.

## Decision

All of this is in `packages/library/src/reconnect.ts`.

- **Finding a library.** `findLibrary(libraryId, roots, { maxDepth = 4, signal })` walks each root depth first, in name order, looking for a `library.json` with the matching id.
  - It skips `.tmp`, `node_modules` and hidden folders. A root may itself be hidden.
  - It never follows a symbolic link below a root. A root that is a link is followed, because it was named explicitly.
  - It does not look inside libraries, since libraries do not nest.
  - It visits each folder (by device and inode) once, at its shallowest depth, so overlapping roots are reported once.
  - An aborted `signal` rejects with its reason. Unreadable folders are skipped.
  - Live copies are yielded as they are found. Destinations of unfinished moves (`moveIncomplete: true`) come after them, and moved-away old copies (`moved: true`, with the marker's `movedToHint`) come last. An old copy is never the answer.
- **Where to look.** `defaultSearchRoots(env)` takes a `LocationEnv` (ADR 0008) and returns, deduplicated (case-insensitively on macOS and Windows) and existing only:
  1. removable, network, uncertain or volume-like mounts: `/Volumes/*` on macOS, `/media`, `/run/media` and `/mnt` on Linux, every drive on Windows (never `/`)
  2. `~/Library/CloudStorage/*` and iCloud Drive on macOS
  3. `~/Dropbox`, `~/Google Drive`, `~/OneDrive*`, and the `OneDrive*` environment variables
  4. home
- **Reconnect.** `reconnect(path, expectedId, deps, opts)` accepts the folder or its `library.json`, and runs these steps in order:
  1. It reads `library.json` without opening anything. A different id throws `WrongLibraryError`, and nothing is written.
  2. A folder with `MOVED.json` throws `LibraryMovedError`. The error carries `movedTo` from this device's old-copy records when they exist, and the marker's `toHint`.
  3. It opens the library. That gives read-only for a newer format, another device's lock, or a move journal.
  4. `moveIncomplete: { completeWith: "completeMove", destRoot }` is reported when the folder has a move journal, or when this device has an unfinished move record into or out of it.
  5. When the library is read-write, it opens a repo first, so interrupted writes are recovered before anything is checked.
  6. It runs the integrity check, with a default sample of 0.05. A newer format is not checked (`skipped: "newer-format"`).
  7. It rebuilds `library.sqlite` when the file is missing, cannot be opened (the old file is kept as `library.sqlite.corrupt-<time>`), or is stale (`isIndexStale`). This needs read-write. When the library is read-only, `rebuilt` is false and `rebuildSkipped` says why.
  8. It records the location in the registry. This is skipped for a move-incomplete or newer-format folder.
  9. It appends `library.reconnect` to every project. The details hold a `host:folder` hint, the sample, `rebuilt`, and the integrity counts, never absolute paths. When the library is read-only, nothing is appended and a warning says so.
- **Integrity.** `checkIntegrity(lib, sample, { keyRing })` reads the asset list of each source from `source.json`, or from `source.json.enc` when the project's key is in the ring.
  - Every file is checked for presence, regular-file type and size. For an encrypted asset, the expected size is computed from the plaintext size: header, plus plaintext, plus one 16-byte tag per 1 MiB chunk (at least one chunk).
  - Asset hashes are checked for a deterministic sample: the `ceil(n × fraction)` asset ids with the lowest SHA-256(libraryId, assetId). Repeated checks of the same library hash the same files, and a growing library mostly keeps them. `"full"` hashes every asset.
  - Hashing streams the file, through `decryptStream` for encrypted assets. A file that fails to decrypt counts as mismatched.
  - For a locked encrypted project, only `manifest.json`'s file lists are readable. Those files are checked for presence only (`presenceOnly`), and their entries have `assetId: null`.
  - The check never writes.
- **Placeholders.** `isPlaceholder(path)` uses `size > 0 && blocks === 0` on POSIX: an online-only file reports a size but takes no blocks on disk. The integrity check stats each file first and lists placeholders in `placeholders`. It never opens them, so it never triggers a download. `hydrate(path, onProgress)` reads a file fully on purpose to download it.
  - Limits:
    - A sparse file made entirely of holes looks the same as a placeholder, which is acceptable for a "not downloaded" status.
    - macOS's `SF_DATALESS` flag would be exact, but Node does not expose `st_flags`, so it is not used.
    - **On Windows, `isPlaceholder` is always false in Phase 1.** Cloud Files placeholders are marked by file attributes (`FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`, `OFFLINE`) that Node's `fs.stat` does not report. A Windows check could read placeholders and trigger downloads. This needs a native helper in a later phase.
- **Relinking.** `relinkMissing(lib, searchDir, { keyRing, repo })` needs a read-write library; otherwise it throws `ReadOnlyLibraryError`. It walks `searchDir` to depth 6, skipping symbolic links and our temp files, and handles each missing file as follows:
  - **Plain assets.** It hashes only candidates of the right size and matches by SHA-256.
  - **Encrypted assets, project unlocked.** Candidates must have the right encrypted size and the project's key id in their header. They are decrypted and compared by the plaintext SHA-256.
  - **Encrypted assets, project locked.** A candidate matches on the same file name and the project's key id (and on size when it is known). If the matching candidates differ in content, the file is skipped as `ambiguous`. A restored file is listed in `relinkedUnverified`.
  - **Restoring a copy.** The match is copied with `copyFileAtomic` to `<target>.tmp-<hex>` (a name that `cleanupTempFiles` removes), and the staged copy is verified: re-hashed, or decrypted, or compared byte-hash with the candidate when the project is locked. Then it is placed with a hard link, which fails when the target exists. A file is never replaced. Where hard links are not supported (FAT/exFAT), it checks and then renames, which leaves a narrow race. The copy is mode 0600 when the source is identifiable or the project is encrypted. For encrypted projects this is stricter than the repo's own writes, which is deliberate because the file is restored from outside the app. Restored copies are recorded as `library.relink` in the project's audit log (counts and asset ids).
  - **Linked assets.** These are not copied. A same-hash file inside the library becomes the asset's new path through the repo (`asset.relink`: governed, change-logged, audited). A file found outside the library is skipped as `outside-library`, because linked files must be library-relative (spec 4.2).
  - The result is `{ relinked, stillMissing, relinkedPaths, relinkedUnverified, skipped, warnings }`. `relinkedPaths` is the list the controller ruling calls `relinked`, because the brief's `relinked` is a count.
- **Offline.** `watchAvailability(lib, onChange, { intervalMs = 5000 })` checks for `library.json` on each tick.
  - When it is gone, the handle becomes read-only with reason `offline`, through package-internal `markOffline`. Every handle now has live `mode` and `readOnlyReason` getters. A read-write handle also stops its heartbeat, so it does not report a lost lock after the stale window. Writes then throw `ReadOnlyLibraryError(offline)` from the repo.
  - When `library.json` is back, `markOnline` runs:
    - A handle that was read-write re-acquires the lock first. If another device holds it now, the handle stays read-only (`locked-by-other-device`) and `onLockLost` is called. If the lock cannot be written, the reason is `not-writable`.
    - A handle that was read-only gets its earlier reason back.
    - If re-acquiring fails with an error, the handle stays offline and the next tick tries again.
  - The returned function stops the watcher.

## Consequences

- The app can offer "Locate…", "Search for library", and a missing-files report with relinking, and it never reconnects to an old copy.
- The integrity sample is comparable between runs. A full check is one option away.
- Placeholders are safe on macOS and Linux. Windows needs native support before its checks can avoid downloads, which is tracked as a Phase 1 limitation.
- Locked encrypted projects can only be checked for presence, and their relinked files stay unverified until the project is unlocked. A later full check verifies them.
