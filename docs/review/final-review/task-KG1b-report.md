# Batch KG-1b: report (FR-735 with FR-723, R503 c; R509 M1, M2). STATUS: BLOCKED, two findings need a ruling before anything is built

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-1`, branch `kg-1-rollback`, head **ad99c57** (unchanged). **Nothing was built or committed.** `git status --short` is empty. No permission check refused anything.

I stopped at the questions the brief asks before building. The brief's own STOP condition (point 1) is met: the older reader refuses the whole marker when it meets a line kind it does not know. A second premise of the ruling does not hold either: the library has no lasting trash and no Trash screen. Every point of the batch (2, 3, 4, 5, 7, 8) depends on one of these two, so I built none of them. The design notes below are given so that the ruling can be made in one pass.

## Answers to the questions to answer BEFORE building

**Point 1 (how the older reader treats a line it does not know): it refuses the whole marker. STOP finding 1.**
- `markerProblem` (`packages/library/src/repo/txn.ts:338-383`) returns `"unknown entry kind"` for any `kind` other than created / replaced / dir / trashed / append. It returns `"unsupported formatVersion"` for any `formatVersion` other than 1.
- The same check is in `main` (2d12ab1, the owner's build 10). It has been there since 8909abe.
- What the older build then does with such a marker:
  - it is "invalid": nothing is undone and the marker is kept;
  - the warning is `invalid-txn-marker`;
  - BOTH the project it names and the project at its folder refuse every change until it is resolved.
  - A new line kind or a format version 2 would therefore block the project on build 10. It would not lose data, but the project would stay blocked.
- **What the older reader accepts.** It does NOT check for fields it does not know on a known kind. Only `sha256` (created/replaced), `backup`/`mode`, `shred` and `prevSize`/`created` are checked. So two shapes stay compatible:
  - **(i) The completion line as a second `created` line** for the same path, with the hash of the bytes on disk and an extra field the older build ignores, e.g. `{kind:"created", path, sha256, complete:true}`.
    - The older build's undo of it is `rm` of the path. That is exactly what it already does for the first `created` line, and inside a created folder the folder's own undo removes it anyway.
    - The older build's `changedSinceMarker` would then judge that path by its hash. It raises its existing "changed outside … was not kept" warning, which is true on that build, since it deletes.
    - The older build never runs `refuseMixed` on a marker it reads.
    - **This is the format I would choose.**
  - **(ii) Extra fields on the `trashed` line**, e.g. the original's hash, or a "being put back" flag (see point 7). The older build ignores them and undoes as today.
- **The reverse direction.** A marker written by build 10 (no completion lines) read by the new code: each path is treated exactly as today (point 2's "no completion line" case).
- Because the brief says "STOP and report before choosing a format", I have not chosen. **Recommendation: shape (i) for completion lines and shape (ii) for the trashed-line additions. No new kind, no version bump.**

**a. Can a completion line be written durably after a streamed copy without changing the commit order or the fsync discipline? Yes, with one correction.**
- **Where.** In `TxImpl.copyFile` (`repo/mutate.ts:266-280`), after `copyFileAtomic` returns. By then the temp file has been `fh.sync()`'d, renamed and its folder fsynced (`fs/atomic.ts:241-249`).
- **How.** Call `log.add(…)` (the marker rewritten by `writeSmallFileAtomic`, the same durability as every other line) before `copyFile` returns. That is still inside `fn(tx)`, before the change log, the audit append and the marker's removal, so the commit order does not change.
- **The correction.** `copyFileAtomic` returns the SHA-256 of the *plaintext source* (`atomic.ts:185-188`), not of the bytes on disk. In an encrypted project, or when the source is decoded, those differ.
  - The completion line needs the hash of what is on disk. Otherwise every copied file in an encrypted project would look "changed by a person" and be moved aside.
  - The fix is a second hasher after `transform` in `copyFileAtomic`, returned beside the existing one.
  - Reading the file again would be expensive for large originals.
- **Files inside a created folder.**
  - Written by `writeFile`: the hash is known before the write. The completion line can be written after `writeSmallFileAtomic`/`writeFileAtomic` returns, in the same way.
  - `TxnLog.created`'s `inNewDir` early return (`txn.ts:160`) needs a separate entry point for the completion line.
  - `refuseMixed` must not count the completion line as a second rewrite.

**b. Moving into "the library's own trash" from inside the undo: per project? needs the key? encrypted? NO. STOP finding 2: the premise does not hold.**
- **What "the trash" actually is.** It is `.tmp/trash-<txn>-<hex>` (`repo/mutate.ts:298-310`). It is per *transaction*, at library level (not per project), and is scratch:
  - **It is swept at every writable open.** `sweep` (`repo/repo.ts:523-540`) removes every `trash-*` as soon as no marker remains. It runs right after `recoverTransactions` (`repo.ts:658`). A file moved aside there by a roll-back that then completes (its marker removed) is **deleted in the same opening**. That is precisely what R503 c forbids ("nothing a person put there is ever deleted").
  - **Retention destroys files there.** `strayCopies` (`retention.ts:293-317`) collects files in orphan `trash-*` folders whose base name matches a file being destroyed, and `destroy.ts:134` shreds them. A hand-put file with a matching name would be overwritten and removed.
  - **Nobody can see it.** There is **no Trash screen**: nothing in `packages/ui`, `apps/library-service` or `packages/shared` lists trashed files. The only "trash" words in the interface are unrelated set-aside notices. A researcher cannot find a file there.
- **The key and locked projects.**
  - A move by `rename` needs no key, and a locked project can be rolled back today (`rollBackMarker` uses no key). So a rename-based move-aside works for a locked encrypted project.
  - The file would be stored as found: a person's plain file stays plain. It was already plain inside the project folder.
  - But the destination must be a lasting place, and that choice is the researcher's to see.
- **The ruling needed: where a moved-aside file goes and how the researcher finds it.** Options:
  - **A. A kept folder inside the project folder**, e.g. `<project>/Set aside by the app/`, under a name that keeps the original name and adds the date. Its pros:
    - it is per project, so it travels with the project on a move, backup or export, and it is findable in Finder;
    - in an encrypted project it holds what was already plain in the folder.
    - **Open questions:** whether the integrity check, the index, backups, exports and retention see unknown files there; to be checked by the implementer once the place is ruled.
  - **B. A kept folder at library level** (not under `.tmp`), e.g. `<Library>/Set aside/<project folder name>/…`.
    - It is outside every project's scans, but it does not travel with a project.
  - **C. No move.** Keep R491's conservative rule (incomplete, nothing deleted) and give FR-736 (KG-1c) the words and the "close" act. The researcher moves the file themselves, guided by the path R503 d allows in the list.
  - **My recommendation: A**, under a name such as `<original name> (found <YYYY-MM-DD HHmm>)<ext>` with a collision suffix (`withCollisionSuffix` exists in `@ao/core`). The warning sentence must then say where; see below.
  - **Either way, the sentence the brief anticipated** ("…MOVED the other one to the library's trash…") cannot be true as worded, because there is no trash the researcher can open.

**c. A read-only open writes nothing; the undo does not run. Confirmed.**
- `openRepoInternal` (`repo/repo.ts:613`) sets `writable = mode === "read-write" && !noHeal`.
- Only a writable open calls `recoverTransactions` and `sweep` (`:626-658`).
- A read-only open only inspects the markers (`:660-664`).

**d. Is the move aside crash-safe? Not decidable until its destination is ruled.** What it needs once the destination is known:
- The move is recorded on the marker BEFORE the rename: a field on the line, e.g. `movedAside: "<kept relative path>"`, which the older build ignores (shape ii).
- A second run then reads, from the marker itself, that what is at the kept place is the person's file. It does not move the put-back original as if it were a person's file (the trap in point 4).
- A crash between the move and the putting back leaves:
  - the person's file at the kept place;
  - the original in `.tmp/trash-*`, still covered by the live marker;
  - an empty path.
  The second run then puts the original back. Each step is a `rename` inside one volume.
- Writing that record means `undoEntries` must write to the marker. Today it only reads it. That is a small but real change of the undo, which point 6 says not to change.

## Points 7 and 8 (R509 M1, M2): a proposal, not built

**What the marker must carry so that "put back" is known, not guessed.**
- **Hashing the original on the `trashed` line is NOT cheap in general:**
  - a trashed *source folder* (`sources.ts:899`) has no single hash;
  - originals can be large;
  - a hash of every file under a folder would be a manifest.
- **My proposal: a "putting back" record**, written by the undo onto the `trashed` line (shape ii, e.g. `restoring:true`), atomically, BEFORE the rename back. A later run then reads:
  - **copy in the trash:** not put back, as today;
  - **copy gone and `restoring` recorded:** put back by the app, since a rename is atomic. The R493 skip applies and nothing is moved or flagged. This fixes M1 whatever the bytes are.
  - **copy gone, no `restoring`, and a later line of the marker exists:** the trash rename happened (the next step runs only after it returned), so the kept copy was deleted by hand. The undo is incomplete, with the cause `kept-copy-gone` (M2).
  - **copy gone, no `restoring`, and the trashed line is the marker's last:** the change stopped before or during the rename, so the original never left. Done, as today.
- **The crossover the ruling must accept or refuse.** A marker partly undone by build 10 (which puts back without writing `restoring`) and then opened by the new build would read as "kept copy gone" whenever a later line exists. The roll-back would then be incomplete with nothing deleted: wrong, but safe, and closable by KG-1c's act.
  - Mitigation: when the change's later write recorded a hash and the bytes at the path differ from every hash the change wrote, treat the file as the put-back original.
  - That reintroduces a judgement by bytes, but only for markers from build 10, and it errs toward "done", which is today's behaviour.
  - I need a ruling on which way that rare case should err.
- **The machine-readable cause.** Add `cause?: "kept-copy-gone"` to `RecoveryResult` beside `outcome: "rollback-incomplete"`. `undoEntries` would return `{ ok, cause }` instead of a boolean, which changes its exported signature.
- **Not built.** It depends on the format decision (finding 1) and on whether `undoEntries` may write to the marker.

## Point 5's sentence (not written: it depends on finding 2)

A draft for the ruling, **if option A is chosen**. These are proposed words, NOT built:
> "A file in {project} was put or changed outside the app, at a place where the app had to put back its own file after a change it had not finished. When the library opened, the app put its own file back and moved the other file to the folder “Set aside by the app” in that project. Nothing was deleted."

Notes on the draft:
- It names the project through the usual isolation and no path.
- It says where the file went, because otherwise the researcher cannot find it.
- It names a folder, not a path; whether a folder's name counts as a path is for the ruling.

The existing kind's sentence (R479 a: "…the outside change to that file was not kept.") stays true for the cases where nothing is moved aside: a hand edit to a source record that had a "replaced" line.

## Table

| FR | Still present? | What changed | Its test | Note |
|---|---|---|---|---|
| FR-735 | Yes (by reading `undoEntries`, `txn.ts:282-312`: "created" is `rm -f`; an occupied trashed path gives `ok = false`) | Nothing: **NEEDS A RULING** (findings 1 and 2) | none written | |
| FR-723 | Yes (`TxImpl.copyFile` records `created` with no hash, `mutate.ts:270`; in a created folder no line at all, `txn.ts:160`) | Nothing: depends on finding 1's format | none written | |
| R509 M1, M2 | Yes (as reviewed) | Nothing: proposal above | none written | |

## Researcher-visible sentences

None new or changed. Point 5 has a draft only, above.

## NEEDS A RULING

1. **Marker format (point 1's STOP).** Build 10's reader refuses a marker with an unknown line kind (the project is blocked until it is resolved). Recommended:
   - completion lines as a second `created` line with the on-disk hash and `complete:true`;
   - the put-back record and the moved-aside record as extra fields on the `trashed` line (both ignored by build 10);
   - no new kind, no version bump.
2. **Where a moved-aside file goes (points 2, 3, 5).** "The library's trash" is transaction scratch: swept at every open and shredded by retention, with no screen. Options A (a kept folder in the project; recommended), B (a kept folder at library level), C (no move; KG-1c gives the words and the close).
3. **Whether `undoEntries` may write to the marker** (the put-back record and the moved-aside record). This is needed for both the trap in point 4 and M1/M2, and point 6 says not to change the undo's order. The order would not change, but the undo would gain writes.
4. **The crossover case** (a marker partly undone by build 10, then reopened by the new build): should it err toward "done" (judged by the bytes) or "incomplete, closable"?
5. **The return value of `undoEntries`** would change from a boolean to `{ ok, cause }`, an exported function's signature (for point 8's cause).

## What only a real Mac or a real service can show

Nothing yet. Later: a rename across the library's volume, and a permission-denied read on macOS, since the machine runs as root.

## Runs

None. Nothing was built.
