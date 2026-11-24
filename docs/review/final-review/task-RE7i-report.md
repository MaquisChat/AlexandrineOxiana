# RE-7i: R492 a, b, c (`re-7c-find`, bd3cea8..d9923fd)

Commits, one per point:
- 5c4196e (a)
- e85d767 (c)
- d9923fd (b)

(c) was committed before (b). (b) replaces the ended-card fallback that (c)'s `closeLook` still had, so in this order each commit passes its own tests.

## (a) R492 a: `openAssetContent` asks for the key at the file's opening (5c4196e)

**What changed**
- `packages/library/src/asset-content.ts`:
  - The held-file look's device (`keyNow`, R487 e) is now one function, `keyAtOpening(repo, projectId)`, at about :111.
  - Both `openAssetContent` (:87) and `openHeldFileContent` (:105) pass it to `openStored`.
  - No second device was invented. The held file's behaviour is unchanged.
- The eager check before opening stays in both functions. A project already locked is refused before anything is opened, as before.
- A plain (unencrypted) project still passes no key getter at all (`key && …`, with `key` null), so it behaves exactly as before.
- A successful read returns the same as before: the same bytes, `size`, `mime`, ranges and `asset`.

**Harness row** (`packages/library/src/repo/lock-mid-read.test.ts`, the "openAssetContent" row), tightened as the held row was:
- `ASSET_MARKER` is written 256 bytes before the end of source 0's stored PDF (the fixture, at about :489).
- The file is read slice by slice (64 KiB).
- If the lock was asked at an opening before the key was asked for (`lockAsked` set and not `after`), any byte returned is counted as a problem, and the problem names the marker if it came back.

**It failed first.** It was run against the unchanged code, which still had the eager getter, so this is the eager-getter run. The row failed with:
`openAssetContent (a whole stored PDF) @3/3 (mark): rejected with Error: 2029 bytes of the stored file's content came back after the lock, its later part (the marker) included`.
In other words, a lock by the mark at the decrypting opening let the whole file through. With the fix, both this row and the held row pass.

### Callers of `openAssetContent` (none outside the service)

| Caller | Protected until now by | A lock at the opening (mark), before → now |
|---|---|---|
| `apps/library-service/src/media.ts:312`, GET `/projects/:id/sources/:sid/assets/:aid/content` (pictures) | **Nothing per read.** `sendContent` is called with `{}` hooks, so there is no `check`. Only the lock check in `getSource` and the wipe (the eager getter held the key buffer itself, and a wiped key fails `assertLiveKey`) protected it. | **Changes.** Before: the whole picture (up to the picture limit) was served after the lock. Now: `ProjectLockedError` reaches the global error handler and the answer is **423 PROJECT_LOCKED**. `openStored` closes the handle. |
| `media.ts:328`, POST `.../media-ticket` (opens, then closes, to check) | Nothing per read. It reads no bytes. | **Changes.** Before: a ticket was issued (200, with the size), and the ticket's first use was then refused by `serve`'s `isUnlocked` check. Now: **423**, and no ticket is issued. |
| `media.ts:364`, GET/HEAD `/media/:ticket` (`serve`) | `isUnlocked` before opening, and `check` after the first read, before the first byte. | **Same answer.** Before: the open succeeded, then `check` gave 423 and revoked the ticket. Now: the open throws; the existing catch revokes the ticket and rethrows; the answer is 423. |
| `apps/library-service/src/routes/documents.ts:158`, the reader's document route | `serve`'s `guarded` check before every read. | **Same answer.** Before: the open succeeded and the first guarded read gave 423. Now: `openFailure(ProjectLockedError)` gives `locked()`, also 423. |

- No export, worker input, CLI or extension path calls `openAssetContent`. Those copy assets through other functions, so their lock-mid-read rows are not affected.
- In the harness, only this one row reads through `openAssetContent`.

## (c) R492 c: "not found" while the card still waits (e85d767)

**What changed** (`packages/ui/src/screens/import/ReviewQueue.tsx`)
- `closeLook` (about :963) no longer decides by the dialog's `gone`, which a 404 also sets. It decides by the card:
  - If the card has not ended (not in `laid.ended`) and the queue as last read still lists it, or the queue is unknown during a re-read, focus goes to that card's current "Look at the file" (`LOOK_BACK`).
  - Otherwise focus goes on.
- `LookDialog`'s `onClose` no longer passes `gone`; `closeLook` does not need it.

**Test** (`ReviewQueue.look.test.tsx`)
- The earlier test "(ii) a “not found” in mid-look … Escape sends focus to the card's heading" pinned the old fallback. It was **changed** to "R492 c: …":
  - after Escape, `document.activeElement` is the card's "Look at the file" button;
  - neither it nor an ancestor is `inert` or `aria-hidden`;
  - it is not `aria-disabled`;
  - "Use this file" is still there.
- It failed first: focus went to the card's `<h4>`.

## (b) R492 b: an ended card, by `fileLeft`'s own rule (d9923fd)

**What changed** (`ReviewQueue.tsx`)
- `focusAfterLeft(item, list, ended)` (about :758) is `fileLeft`'s rule, taken out of it unchanged: the next waiting card, else `:section` while other entries wait, else `:empty`.
- `fileLeft` (about :764) now calls it. Its behaviour is unchanged: `ReviewQueue.test.tsx` passes all 116 tests.
- `closeLook`, for an ended card, calls `focusAfterLeft(at.item, itemsRef.current ?? laid items, laid.ended)`. This replaces the fallback to the ended card's heading.

**Tests** (`ReviewQueue.look.test.tsx`)
- The late-record setup is now a helper, `lookThenLateRecord(items)`. The existing "next waiting file" test uses it, and its assertions are unchanged.
- New: "the card ended and no other file waits, other entries do". An import entry waits. Close sends focus to the section's heading, "Files found for records".
- New: "the card ended and nothing else waits". Escape sends focus to "Nothing is waiting for review in this project.", which is reachable and is not the card's `<h4>`.
- Both failed first, against the (c) commit: focus was on the ended card's `<h4>`.

## Runs (nice -n 10, single files)

**Library**
- `lock-mid-read.test.ts`, the whole file, alone, `--testTimeout 240000`: 44 passed (44), 718.5 s; it started after the fix was written.
- `held-file-content.test.ts`: 5 passed
- `asset-content.test.ts`: 9 passed
- `asset-content-open.test.ts`: 3 passed

**Service**
- `documents-route.test.ts`: 24 passed
- `held-file-document.test.ts`: 10 passed
- `media.test.ts`: 27 passed (the picture, ticket and media callers)
- `ui-only-routes.test.ts`: 126 passed (it also drives the picture and media routes)

**UI**
- `ReviewQueue.look.test.tsx`: 12 passed
- `ReviewQueue.test.tsx`: 116 passed

**Typecheck**
- `@ao/library`, `@ao/library-service` and `@ao/ui`: clean (tsc gave no output).

## Uncertain, or for a ruling
1. Two service answers change on a lock by the mark at the opening, as the table shows: the picture route and the ticket issue now answer 423. This is the intended effect, and a successful read is unchanged. No service test drives that exact timing for these two routes; the library harness row is the proof.
2. While the queue is being read again (`itemsRef` null), a card that is not in `laid.ended` counts as still waiting, so focus goes back to its Look control. An ended card in that window uses the laid-out items as the list, as the previous round's `closeLook` did.
3. `minor (deferred)`: `documents-route.test.ts` "M3: a project locked in the middle of a stream" still accepts `end` (the RE-7h report noted this). It was not touched.
