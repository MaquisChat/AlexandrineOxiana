# FR-A1 round 2 (R369, with R372): scoped second review

Worktree `agent-a0328b7cc1ec55b55`, head 0baa6a4 (`176f225..0baa6a4`). I changed nothing that stays: `git status --short` is empty, the head is unchanged, and every probe and scratch script has been removed.

## Verdict: APPROVED
Each clause of R369 is built. Each guard is held by a test that fails without it; I took each one out and saw its test fail. The two specific probes pass. There are no Critical or Important findings, and one Minor.

## (a) The guide paragraph and the dialog's note
- **Guide** (docs/first-run.md:77), read clause by clause against the code:
  - The set-aside, detach and withdrawal-review reasons are sealed: true.
  - The loosening reason's audit copy is sealed: true.
  - "A keyed fingerprint, which cannot be checked without the passphrase": true (see b).
  - The unlocked and locked sentences: true.
  - "An exception … the reason and the approver's name … are kept in `governance.yaml`, which is not sealed": true. This is the only place my round-1 probe found the marker.
  - "Reasons typed before this version remain readable": true.
  - The naming sentence: true.
- **When the note shows.** I checked every way the dialog opens in GovernanceSettings.tsx. The note shows only for `change()` with `needsException` (`exception: needsException` at :175; `encrypted && pending.exception` at :467).
  - Turning a profile off: no exception is written and no note is shown.
  - The save made again after the service asks: the reason goes to the sealed audit entry only, and no note is shown.
  - Both of these are correct per R372 a.
  - An exception typed straight into the YAML text opens no dialog of its own. Only the guide covers that case; R369 asks no more.
- **Screen reader.** The note's `id` is in `aria-describedby` on both the Reason textarea and the Approved-by input (ReasonDialog.tsx:89-96). The fields get no `aria-describedby` when there is no note.
- **Tests that fail without their guard** (scratch edits, each reverted; GovernanceSettings.test.tsx and routes/governance.test.tsx, 62 tests):
  - Note shown whenever encrypted, for any loosening: 1 fails.
  - `exception: true` set for every pending edit: 1 fails.
  - `aria-describedby` removed from the approver input: 1 fails.
  - The route's `encrypted` pass-through removed: 1 fails.

## (b) The keyed digest
- **Construction** (audit-reasons.ts:62-90):
  - HKDF-SHA-256 over the data key, with an empty salt, the info string `ao-audit-reason-mac` and a 32-byte output. Then HMAC-SHA-256 of the exact UTF-8 text under that derived key, as hex.
  - The derived key is zeroed after use. The data key is never the MAC key.
  - The comparison runs in constant time over equal lengths.
  - It uses Node `crypto` only. The construction is sound.
- **Whole-tree search.** After every operation, including the denied, locked and mid-lock variants and the restores, I searched the whole tree (UTF-8 and UTF-16LE) for the marker word and for the SHA-256 of every reason. Nothing was found: no file in the library, the app folder, the index and its WAL, the journals, the change logs or the backups holds the text or its unkeyed SHA-256.
- **What carries the MAC.** New entries carry `reasonMac` and no `reason`. Only the sealed line holds the MAC beside the text. The library store's clear wrapper holds only `{seq, hash, projectId, sealed}`. The error messages of the refusals carry no digest.
- **Entries written before this round** (`reasonSha256`) still read, are still checked, and still verify. Implementer tests cover this in the project's log and in the library's log.
- **Tests that fail without their guard** (scratch edits, audit-reasons.test.ts, 32 tests):
  - Digest back to the unkeyed SHA-256: 16 fail.
  - The HMAC keyed with the data key itself: 12 fail.
  - The legacy SHA path removed from `reasonMatches`: 2 fail.

## (c) The three guards
- `mutate.ts:514` condition replaced by `if (false)`: 3 fail. Only the "reason beside the digest" part dropped: 1 fails.
- `library-audit.ts:78` reduced to the project-id check: 3 fail.
- The in-process `undoAppend` neutralised: 1 fails.

## (d) A failed read
Each of the three reads now becomes `unreadable` and gives "A reason was given, but its text could not be read just now." It never gives "no longer in this project", and one unreadable place no longer fails the page (repo.ts:1617-1657).
- The project store's read changed back to `.catch(() => new Map())`: 1 fails.
- The review entries' read back to `.catch(() => [])`: 1 fails.
- The library store's read back to `.catch(() => [])`: 1 fails.

## The two asked-for probes (scratch test, removed)
1. **Lazy details, denied and locked** (encrypted project).
   - **Locked:** set-aside, governance edit, detach and withdrawal review each throw `ProjectLockedError`, and 0 audit lines are added. This is as before: `assertUnlocked` comes before `decide` in `runMutation`.
   - **Denied** (governance.yaml unreadable): set-aside, detach and withdrawal review each throw `PolicyDeniedError`, and each deny is audited with `details: {op}` only. The lazy details are never evaluated for a deny.
   - **Lock called right after starting a change:** `ProjectLockedError`, `governance.yaml` unchanged, and the chain verifies; the set-aside behaves the same.
   - No marker and no SHA-256 anywhere afterwards.
2. **Restored copies**, after all four operations and a backup:
   - Restored in the same library with the source unlocked: all four read `text`, and `verifyAudit` is ok.
   - Restored in the same library with the source locked and the passphrase given: all four read `text`.
   - Restored in another library with the passphrase: refused ("This backup is encrypted: unlock its project, or give the project's passphrase"). The key file comes only from this library's manifest, which is existing behaviour and not this round's.
   - Data keys are generated only at project creation (projects.ts:151, `generateProjectKey`). A restore unwraps the same key, and a passphrase change can only re-wrap it. No path re-keys, so restored reasons keep matching their `reasonMac`.

## Findings
- **M1 (Minor):** packages/library/src/repo/sealed-purposes.ts:21. The comment still says the store is "the sealed store of reasons the audit log names only by SHA-256". It should say "by its keyed digest (R369 b)".

## Runs (all `nice -n 10`, foreground)
- Baseline: audit-reasons.test.ts 32 passed. UI GovernanceSettings and routes/governance: 62 passed.
- Scratch probe: 2 passed (output as above).
- 10 library mutations and 4 UI mutations. Each failed as listed, and each was reverted.

## Not verified
- A restore into another library: refused before any reasons are read (existing behaviour).
- e2e: not run.
