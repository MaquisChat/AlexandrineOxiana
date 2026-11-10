# 0008. Moving a library: governed copy → verify → switch

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

Spec 4.5 lets a researcher move the whole library to another disk, a removable or network drive, or a cloud-synced folder from inside the app. The library holds IRB/GDPR/HIPAA data, so a move must never lose data, and each project's residency rules (`governance.yaml`, `residency.allowed` / `approvedCloudFolders`) decide where it may go. Moves can be large and are interrupted (laptop sleeps, drive unplugged), and the destination may be a sync client that rewrites files.

## Decision

- **Where is the destination?** `classifyLocation(path, env)` maps a path to `{ kind, cloudFolderId?, certain }` from the path alone. The environment (home folder, platform, mounts, whether the mount probe worked, and the `OneDrive*` variables) is injected, so the rules are pure and testable for any OS (`path.win32` / `path.posix` by `env.platform`, case-insensitive on macOS and Windows).
  - Cloud-synced folders win over the disk they sit on:
    - iCloud Drive → `icloud`
    - `~/Library/CloudStorage/OneDrive-<x>` and Windows `%USERPROFILE%\OneDrive[ - <x>]` or the folders named by `%OneDrive%`, `%OneDriveCommercial%`, `%OneDriveConsumer%` → `onedrive:<x>` (a plain `OneDrive` is `onedrive:Personal`)
    - Dropbox → `dropbox`
    - `GoogleDrive-<account>` → `googledrive:<account>`; Windows `X:\My Drive` → `googledrive` (the account is not in that path)
    - any other `~/Library/CloudStorage/<X>` → `<x>` lowercased
  - Windows UNC paths are `network`.
  - Otherwise the longest mount containing the path decides `network` / `removable`. On Linux, `/media`, `/run/media` and `/mnt/*` are `removable`.
  - What remains is `device`, which is `certain` only when the mount list is known and covers the path.
  - `defaultLocationEnv()` probes the machine best effort (`/proc/mounts` + `/sys/block/*/removable`, macOS `mount`, Windows `wmic`/PowerShell). A failure gives `mountsKnown: false`.
- **Plan.** `planMove` classifies both the typed destination and its real path (symbolic links in existing ancestors resolved), and evaluates `move` for every project against each classification. An uncertain classification is evaluated as device, removable and network as well. Any deny denies the project ("Destination type could not be determined …" when the deny came from a guess).
  - It refuses (`MoveNotAllowedError`) in these cases:
    - a read-only library
    - any `.tmp/txn-*.json` marker, or a `recoveryPending` project in the passed `sourceRepo` ("finish or resolve pending writes first")
    - a destination that is the library, inside it, or contains it (real paths)
    - a non-empty destination, unless it holds this library's `.move-journal.json` from the copy phase (a resume)
    - a `Projects/<n>` folder that looks like a project (governance.yaml, Sources or project.json) but has no readable project.json, since its governance cannot be checked
    - paths that collide under case folding or NFC normalization, whatever the platform, since the destination file system may fold them
  - Symbolic links or special files inside the library abort with `MoveVerificationError` naming them.
- **What is copied.** Everything except `.lock`, `.tmp/`, `library.sqlite-wal/-shm/-journal`, move markers, and project folders already marked MOVED.json.
  - A passed `IndexHandle` is checkpointed first. Otherwise `library.sqlite` is copied as is, since it is rebuildable.
  - Permission bits are preserved.
  - When projects are excluded, their folders are not copied, and neither is library-level derived data that may hold their content: `library.sqlite`, `Exports/`, `Backups/` and `.cache/` stay with them.
- **Copy, resumably.** The move holds the source lock throughout and copies with `copyFileAtomic`.
  - `<dest>/.move-journal.json` is rewritten atomically every 50 files or 5 s, and whenever the copy stops with an error. A throwing progress callback counts as an interruption.
  - A rerun skips a journaled file only if its destination copy's SHA-256 and mode still match the source.
- **Verify, independently.** After copying, both sides are re-read and hashed. Missing, different or mode-changed files, files that appeared in the source, and unexpected destination files fail with `MoveVerificationError` (up to 20 paths). The registry and source are untouched, and the destination and journal are kept for inspection.
  - Limit: right after the copy, the destination is usually re-read from the OS page cache, not from the medium. This catches copy and logic errors and later tampering, but not every write error a device would only show on a cold read. A full cold check belongs to the reconnect integrity check (spec 4.5).
- **Switch, crash-safe.** Before the first registry write, the journal is rewritten with `phase: "switching"` and the full step plan. The plan holds no absolute paths: the old root and the verified hashes live in the pending old-copy record in the app config folder. The steps are recorded as done one by one, and each is idempotent:
  1. **mark-old:** this comes first, so the old copy can never be opened read-write once the switch has begun. Without exclusions, write `<old>/MOVED.json` `{ libraryId, movedAt, toHint }`. With exclusions, write `Projects/<moved>/MOVED.json` first, then give the old `library.json` a new id (planned in advance), the name `<name> (remaining projects)` and `splitFrom: <original id>`, and register it. Only these paths may be written in the old folder (allow-list, `assertContained`).
  2. **register:** the registry gets the new path first. This step is always redone on completion: it is an idempotent upsert, so the destination ends up first whatever happened in between.
  3. **close-source:** release the source lock.
  4. **audit-split:** with exclusions only, append `library.split` to the excluded projects through the remaining library.
  5. **audit-move:** open the destination, which records its location hint, or use `destRepo`. Append `library.move` to every moved project. Audit events carry a `moveId`, so a step that is rerun never records an event twice.
  6. **finalize:** mark the pending record complete and remove the journal.

  `completeMove(dest, deps, env)` runs the steps not yet done after a crash, and so does rerunning `executeMove`. While the journal exists the destination opens read-only (`move-incomplete`). The old copy opens read-only (`moved`) and is not recorded as the library's location. The repo, the index and the move skip a project folder only when its MOVED.json is valid: it parses, its libraryId is this library's id or `splitFrom`, and the folder's project.json is not newer than the later of `movedAt` and the marker's own modification time. Anything else is an ordinary project folder, governed and moved. A project-level MOVED.json is never copied. Folders skipped this way are reported as `projectsMovedAway` in the plan and the result. (The modification time is used together with `movedAt` because the app clock and the file-system clock can differ.)
- **Close after switch, a deviation from the controller ruling.** The ruling asked to close the source before the switch. We release the source lock after the first two switch steps instead: registering the destination and marking or splitting the old folder happen while the move still holds the old folder's lock, so no other device can open it read-write in between. The source repo is never written to after that.
- **Delete the old copy only on confirmation.** `deleteOldCopy(oldRoot, token | { confirm: true }, { deps, destRepo })` accepts the in-memory single-use token from the move, or, after a restart, `{ confirm: true }` for a record listed by `listPendingOldCopies(deps)`. Either way it must be within 24 h of the move; otherwise it refuses with a clear message and the old copy stays read-only.
  - It holds the old folder's lock while deleting, and refuses if another device holds it.
  - It deletes only files that were verified and still hash the same, never through a symbolic link or outside `oldRoot`.
  - Content that was not part of the verified move is never deleted. It is returned as `leftovers` (up to 50 paths) with a warning, and while any remains, `library.json` and MOVED.json stay, so the old copy keeps opening read-only. MOVED.json is likewise kept when changed files were kept. Then empty folders are pruned.
  - `{ confirm: true }` uses the most recent non-expired record for that folder. The verified-hash files are 0600, in a 0700 folder.
  - In a split library only `Projects/<moved>/` is touched.
  - It is recorded as `library.old-copy-deleted` at the destination.
- `library.move` records `destinationCertain`. FUSE file systems not known to be local (e.g. `fuse.rclone`, macFUSE) make the mount uncertain.
- **Audit failures after the switch** are returned as `warnings` and do not undo it: the data is already verified at the destination.

## Consequences

- A move never deletes or changes source data before verification. A failed copy leaves at worst a destination folder with a journal (opens read-only). A crash during the switch is finished by `completeMove`.
- The old copy is read-only until deleted, so two writable libraries with the same id never exist.
- Excluded projects get fresh audit anchors under the remaining library's new id, and their `library.split` event records the split.
- `findLibrary` / "search for library" (Task 14) must flag folders with MOVED.json or an unfinished move journal instead of offering them as the library.
- The pending old-copy record is per device: a move interrupted during the switch can only be finished on the device that started it.
- Moving to the sync server or S3 (Phase 5) will need a different copy back end but the same plan, verify and switch rules.
