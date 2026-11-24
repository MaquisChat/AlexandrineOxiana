# RE-7h: the look's small points (R487 a–e)

Worktree `.claude/worktrees/re-7c`, branch `re-7c-find`. Five commits on ba36ce7, one per point. Head **bd3cea8**. Nothing pushed, no stash, and `git status --short` is empty.

| Point | Commit |
|---|---|
| d (M3) | 5b18ef7 |
| c (M2) | 6ae579a |
| b (M1) | 7e6236a |
| a (I1) | 6f6b6c2 |
| e | bd3cea8 |

## (a) I1: a look and the card's own decision (6f6b6c2)

### (i) The Look control while the card's decision is out
- `ReviewQueue.tsx:1648`: "Look at the file" now takes `aria-disabled={busy ? true : undefined}`. This is the same mechanism as "Use this file" and "Not this file": announced as unavailable, never `disabled`, so focus stays on it.
- While the card is busy, a press opens nothing.
- The existing CSS rule `.ao-review__file button[aria-disabled="true"]` already styles it, so no CSS changed.

### (ii) The file stops waiting while the look is open
**The look now belongs to the screen, not the card.**
- The found-files section is unmounted while the queue is read again (`setItems(null)`). Because of that, a look held inside the card vanished on every re-read, including the very read that shows a late-recorded decision.
- State `lookAt` is at `:310`, with `openLook` beside it. The dialog is rendered at `:1143`.
- A lock (`forget`) or another project closes the look, as before.

**When the file counts as gone.**
- `lookGone` (`:946`) is true when the card has ended (`laid.ended`), or when the queue as last read no longer lists the file. While a read is in progress, the answer is not known yet.
- The reader's "not found" (404), at the first range or in mid-look, now calls the new `LookOnly.onGone()` (`Reader.tsx:154`, called at `:305`). It replaces `goneSentence`.

**What `LookDialog` (`:1694`) does once the file is gone.**
- It unmounts the reader. The reader's own clean-up aborts and destroys the document, so no range is read after that.
- It replaces the notice with `LOOK_GONE`.
- It says that sentence once, by moving focus to it. The paragraph gets `tabIndex=-1`. This follows how the reader announces a changed state: it focuses the state's heading. No live region was added.
- That paragraph becomes the trap's `initialFocus`, so Shift+Tab from it stays inside the dialog, as it does from the heading.

**Where focus goes on Close.**
- The search that `fileLeft` uses for "the next waiting card" is now one helper, `nextWaiting` (`:747`). `fileLeft` itself is unchanged in behaviour.
- `closeLook` (`:953`), on Close or Escape after the file has gone: focus goes to the next waiting card's heading, else to that card's own heading. This uses the existing `fileFocus` effect.
- If the file still waits, focus goes to the card's current Look control (token `LOOK_BACK`, `:177`). This matters only if the queue was re-read while the look was open: the old control node is then detached.

### Tests (`ReviewQueue.look.test.tsx`, written first, each seen failing)
- **(i), the reviewer's probe A reworked.** Probe A was: a decision is out, then the look is opened, then the decision lands, then Close. The test now checks:
  - with the decision out, the Look control is `aria-disabled="true"` and not `disabled`;
  - a click, Enter or Space opens no dialog and reads no range;
  - focus stays on the control;
  - after the decision lands, the control has become the stand-in.
  - It failed first: `aria-disabled` was null.
- **(ii), a given-up decision recorded late (two cards).** The look is opened first. The service's late record then shows at the next read. The test checks:
  - the notice becomes `LOOK_GONE`, once, and focus is on it;
  - there is no reader, no toolbar, no canvas and no live region;
  - the document is destroyed and no range is read afterwards;
  - after Close, `document.activeElement` is the second card's `<h4>`, neither inert nor `aria-hidden`, and not the old Look node.
  - It failed first: the dialog vanished during the re-read.
- **(ii), "not found" in mid-look (one card, Escape).** The test:
  1. makes a later range answer 404;
  2. fails the document as `missing`, as pdfjs.ts maps a 404;
  3. checks the same things as above;
  4. checks that after Escape, focus is on the card's own `<h4>`, which is reachable.
  - It failed first: focus went to the reader's "File not found" heading.
- **Changed existing test.** "the file no longer held…" asserted the old 404 behaviour (the reader's "File not found" heading with the look's sentence). It now asserts the notice is replaced by `LOOK_GONE` and there is no "File not found" heading. The 423 half is unchanged.

## (b) M1: no note offered in a look (7e6236a)
- `PdfPages.tsx:70` adds `LOOK_NO_TEXT_SENTENCE`.
- A new prop `look` (`:173`) chooses that sentence at `:606`.
- `Reader.tsx` passes `look={look !== undefined}`.
- The reader's own sentence outside a look is unchanged; `PdfPages.test.tsx` still asserts it (17 passed).
- **Test:** "R487 b: a page without text…" in the look test. It failed first: the export did not exist.

## (c) M2 (6ae579a)
- `LOOK_GONE` (`ReviewQueue.tsx:174`) is the one constant for this sentence and now holds the new words.
- The old words appeared nowhere else.
- **Test:** the look test's assertion of the constant was updated first and seen failing.

## (d) M3 (5b18ef7)
- `FilePreview.tsx`: `NO_PREVIEW` (`:25`) now comes before `assetName`'s doc comment.
- `ReviewQueue.tsx`: the look constants and `LookFor` now come before `HELD_DECIDE_WORDS`'s doc comment.
- No test, as ruled.

## (e) The two guards (bd3cea8)

### Service: `held-file-document.test.ts:283`
- **What the test does now:**
  - A 6 MiB sealed PDF has a marker at offset 4 MiB − 4096, inside the one range asked for (0 to 4 MiB − 1).
  - The client pauses after its first data. The test then calls `await lockProject` and resumes.
- **What it asserts:**
  - the answer is cut (`aborted`), not complete;
  - the bytes that arrived are exactly the file's prefix;
  - the marker never arrives, and fewer bytes than the marker's offset arrive;
  - the next range answers 423.
- **What I saw:**
  - With the guard, 1,048,576 bytes arrived in all. 65,160 had arrived by the time of the lock, and 983,416 after it. Those were already in flight: the service had read them before the lock.
  - With `serve`'s per-read lock check (`if (!s.repo.isUnlocked…) throw`) removed for one run, the test failed: "expected 'end' to be 'aborted'". The whole answer arrived, because the open decrypting handle keeps its own copy of the key.
  - The file was put back with `git checkout --`.
- **The existing route has the same weakness.** `documents-route.test.ts`, "M3: a project locked in the middle of a stream", accepts `end` and only checks ≤ 4 MiB. Per the brief I did not change it. (Its unit test "M3: guarded() checks before and after every read" is sound for `guarded` itself.)

### Library: the harness row in `lock-mid-read.test.ts`
- **Harness changes:**
  - The harness now records when a lock is asked (`lockAsked`, `:175`). It is set in `cold` and in `exercise`'s `ask`, and is `after: true` for the "a microtask after the last opening" points.
  - The held fixture carries `HELD_MARKER` 4 KiB before its end.
- **What the row does:**
  - It reads the held file slice by slice (64 KiB), as the route does.
  - If the lock was asked at an opening, before the file's key was asked for, any byte returned is counted and reported as an error, naming the marker if it came back. The harness counts that as a problem.
  - A lock asked after the last opening finds the key already taken. That read may end as unlocked here; the route's per-read guard is what stops it (the service test above).
- **What it found, a real hole in the look:**
  - A lock **by the mark** at the held file's own opening still let the whole file through: `@3/3 (mark): 3147763 bytes … came back after the lock, its later part (the marker) included`.
  - The cause: `openHeldFileContent` took the key (`projectDataKey`) **before** opening the file, so the mark, which hides the key from every reader at once (R386 b), never reached it.
- **The guard added:**
  - `asset-content.ts:103` `keyNow`: the look asks for the key again at the file's opening.
  - Under the wipe or the mark, that refuses the look as locked.
  - `openStored` now takes a key getter. `openAssetContent` passes the same eager getter as before, so its behaviour is unchanged.
- **What I saw:** with the old eager getter put back for one run, the row failed with the same line. Restored with `git checkout --`.
- `heldFileToLook`'s own `assertUnlocked` runs before every counted opening, and the key lookups refuse a locked project behind it. I did not try removing it.

## Sentences a researcher can see, new or changed
- "This file can no longer be shown. It is no longer waiting for your decision, or it can no longer be found on this computer."
  - It replaces "This file is no longer waiting for your decision, so it cannot be shown."
  - It is now shown in place of the look's notice: when the file stops waiting during a look, and on any 404, including the first range.
- "This page has no text to select. It is probably a scanned image." (only in a look)
- "Look at the file" is announced as unavailable while its card's decision is out. Its words are unchanged.

## Runs (nice -n 10, each file alone)
- **UI tests:**
  - `ReviewQueue.look.test.tsx`: 10 passed.
  - `ReviewQueue.test.tsx`: 116 passed.
  - `Reader.test.tsx`: 56 passed.
  - `PdfPages.test.tsx`: 17 passed.
- **Library tests:**
  - `held-file-content.test.ts`, `asset-content.test.ts` and `asset-content-open.test.ts`: 17 passed.
  - `lock-mid-read.test.ts -t "openHeldFileContent|openAssetContent|seam"`: 3 passed.
- **Service tests:**
  - `held-file-document.test.ts`: 10 passed.
  - `documents-route.test.ts`: 24 passed.
  - `media.test.ts`: 27 passed.
- **Typecheck:** `@ao/library`, `@ao/library-service` and `@ao/ui` are each clean.
- **Lint:** no CSS or styling was touched, so `lint:css` and `lint:colours` were not run.

## Uncertain, or for a ruling
1. **The "bulk control's queue" does not exist on this branch.** The dispatch named it as a cause, but no control decides several found files (`ReviewQueue.tsx:33`: "nothing decides several files at once"; the same on `re-join`, `re-7b-find` and `re-7d-find`). The look ends on any cause that marks the card ended or drops it from the queue, so it would cover such a control.
2. **Where focus goes after the last waiting file.** I built the fallback as the ruling words it: the next waiting file, else **the card's heading**. `fileLeft`'s own fallback after a decision is the section's heading, or the "nothing waiting" note. If `fileLeft`'s exact rule is wanted, it is one line in `closeLook`.
3. **A 404 while the entry still waits.** This happens when the file is gone from disk. Focus on Close then goes to the next waiting file too, as ruled, although that card still shows its controls. Nothing re-reads the queue on a 404.
4. **The same mark-path hole exists in `openAssetContent` at library level.** Its row passes because the harness accepts the unlocked result. The document route is protected by `serve`'s per-read check: the mark makes `isUnlocked` false. Asking for the key at the opening there too is a one-line change. I left it for a ruling.
5. How the dialog behaves in WebKit (focus on an inert node, then moved) is shown only in jsdom here.
