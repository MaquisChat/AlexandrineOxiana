# KG-2 — second look at the fix round (R510), 07f0ae0..e59ea20

**Verdict: APPROVE WITH SMALL POINTS.** Nothing is Critical or Important. There is one Minor point, which already existed before this round and is narrow.

## What I ran (all `nice -n 15`, single files)
- library: `asset-content.test.ts` 15/15, `repo/linked-file.test.ts` 9/9, `reconnect.test.ts` 54/54, `find/runner.linked-missing.test.ts` 62/62.
- service: `documents-route.test.ts` 25/25.
- ui: `FindAcquire.test.tsx -t FR-734` 3/3.
- Mutations, each restored with `git checkout --`:
  - `opened = false` removed (I1): both "row leaves (unmount/project)" tests fail, and "the reverse" passes.
  - `linked ? missing() : unsafe()` changed to `unsafe()`: 4 of 15 `asset-content` tests fail.
  - `!facts.hasFile` removed (M5): "R345 b: not offered for an entry with a file…" fails.
- Probe `src/asset-content.probeKG2b.test.ts` (deleted): the path's PARENT is a symbolic link to a real folder that holds the file. Result: `missingAt` false, `originalsReach` "reachable", integrity 0 missing / 0 mismatched / 0 errors / 1 hashed, and `openAssetContent` reads the same bytes.
- e2e, after `@ao/ui build` at e59ea20: `reader.spec.ts -g "missing linked file"` in Chromium, 1 passed.
- At the end `git status --short` is empty and no probe is left.

## The points

**1. I1 — mended.**
- After the ticketed close, `opened = false` sends the start down the existing not-opened path (`FindAcquire.tsx:1714`). That path cancels at the service whether or not the screen is live, sets no note on a row that has gone, and clears `libTicket` only for its own ticket.
- The tests now assert, on leaving the screen and on changing project: one close with `[TICKET]`, exactly one `POST …/{eid}/library/cancel`, and an entry no longer `waiting-sign-in`. The row still shown: no close, no cancel.
- The runner's one ticket is freed by reading: `libraryCancel` (`runner.ts:3199`) calls `dropTicket()` when `ticketFor(projectId, entryId)`, and the service's `startWindow` refuses only while `libTicket` is held.
- Other orders, unchanged from before:
  - failure or "threw": the existing not-opened cancel;
  - no answer: the existing gave-up path (60 s), which cancels once;
  - a row re-keyed on a live screen: `live()` stays true, and the existing ticket effect governs;
  - a lock: `gen++` makes the row not live, so the close and cancel go out and a locked project refuses the cancel harmlessly.
- No ticketless close is sent on this path.

**2. M1, the rule — built as R510 rules.**
- `missingAt` is `lstat` only, with `linkedNotThere` (any symbolic link, or a folder) or ENOENT/ENOTDIR meaning missing; other errors are thrown, so a permission error still counts as "there".
- `linkedStat` is gone everywhere (grep: no use left).
- In `reconnect.ts` the remaining `.stat(` uses are `isPlaceholder`'s default (always given `st` here), `hydrate`, the search root and `library.json`. None of them looks through a recorded linked path.
- `checkOnce` and `stillWrong` use the `opts.stat` seam again (M6 gone). Because a link is missing before any hashing, the integrity check no longer reads through a link (M2 gone).
- FR-728: an entry whose only original is a symbolic link now stays as it is (new test).
- The Missing files list, Find and acquire, the service's `missing` flag and the reader all agree for: a link to a file that is there, a dangling link, a link loop (it is a symbolic link, so ELOOP is never reached), a folder, and a link to a folder. All of these are missing.
- A parent that is a link: `lstat` of the full path follows parent links, so the file is present, and the content route reads it, because O_NOFOLLOW guards only the last part of the path (probe above). What the app calls present it can read, so this is right.

**3. M1, the reader — built as ruled.**
- `openStored(…, linked)` is passed only by `openAssetContent`, and only for a linked asset. There, ELOOP and a folder become the existing `missing()`, which the route answers as 404 MISSING and the reader shows as "File not found" with its existing sentence.
- A FIFO or socket stays unsafe.
- A stored file is unchanged: its earlier tests are untouched, and a new test keeps a folder at a stored path unsafe.
- The changed route test (`documents-route.test.ts:337`, a linked file swapped for a link to a secret) moved from 400 UNSAFE to 404 MISSING. It still asserts that the secret's bytes never appear. That is the ruled answer, not a loosened test.
- Nothing new is followed: the open is still O_NOFOLLOW, and the fallback `lstat` runs only on the error path.
- The 404 tells a caller less than the 400 did: a link, a folder and a missing file now look the same, and the caller already holds the bearer token.

**4. M4** — both comments now say what the flag covers. **M5** — the assertion is real again (`!`, not `?.`), on a file attached after the opening's pass, and it fails without the guard.

**5. e2e** — the new steps in `reader.spec.ts` wait on Playwright's own true states (focus, text, canvas count) with no sleep, and the scenario passes at e59ea20. I did not re-run `find-copies.spec.ts` (one spec for me). The implementer lists 8/8 for it in the fix round, after the UI change of 3857728.

## Minor

**N1 — the cancel names only the entry, not the ticket, so a late cancel can undo a NEWER start of the same entry.** This already existed in the gave-up path, and this fix gives it a second way in.
- `libraryCancel(projectId, entryId)` drops whatever ticket that entry holds.
- The order that does it:
  1. the old open is still out in the shell (up to 60 s);
  2. the researcher returns and presses "Cancel" on the waiting row, which frees the ticket;
  3. the researcher presses "Get through my library" again, which gives a new ticket;
  4. the old open then answers `true`;
  5. the old page's cancel returns the entry, and the new window's row stops waiting.
- Narrow: it needs a shell that takes seconds to open a window. Judged by reading, not probed.
- Direction: let the cancel carry the ticket it is for, with the service cancelling only when that ticket is still the entry's. List it with FR-734 point 1, which is the shell's side.

## Could only judge by reading
How the shell treats the ticketed close (the Rust side), and N1's order.
