# RE-7c review: looking at a held file before deciding (FR-490; R470 b)

Reviewed: worktree `.claude/worktrees/re-7c`, branch `re-7c-find`, 7a8f5ee..ba36ce7 (3 commits). Reviewer probes were `*.probeRE7c.test.ts(x)`. All of them are deleted, and `git status --short` is empty. No commits were made and `git stash` was not used.

**Verdict: APPROVE WITH SMALL POINTS.** The owner's rule holds: a look attaches nothing and writes nothing, and the route is bounded and refused where it must be. There is one Important point, an edge case about focus and a false sentence when a decision lands while the dialog is open. There are three Minor points.

## What I ran
- **Service tests, each file alone:**
  - `documents-route.test.ts`: 24 passed.
  - `media.test.ts`: 27 passed.
  - `held-file-document.test.ts`: 10 passed.
  - `ui-only-routes.test.ts`: 126 passed.
- **Library tests:**
  - `asset-content.test.ts`: 9 passed.
  - `asset-content-open.test.ts`: 3 passed.
  - `held-file-content.test.ts`: 5 passed.
  - `lock-mid-read.test.ts -t "openHeldFileContent|seam"`: 2 passed.
- **UI tests:**
  - `ReviewQueue.look.test.tsx`: 6 passed.
  - `Reader.test.tsx`: 56 passed.
  - `ReviewQueue.test.tsx`: 116 passed.
- **Typecheck:** `@ao/library`, `@ao/library-service` and `@ao/ui` are each clean.
- **Service probe** (`held-file-document.probeRE7c.test.ts`):
  - After "Use this file", the held route answers 404 "That file was not found.".
  - A library opened read-only, with an encrypted project unlocked, can still be looked at: 206, the right bytes, and the library folder hashed the same before and after.
  - A range past the end gives 416 `bytes */5000` with no body. Several ranges give 400. HEAD gives 404, because it is not routed.
  - A damaged sealed held file gives 409 "An encrypted file could not be read (damaged, or made with another key).", with no path in it.
- **UI probe** (`ReviewQueue.probeRE7c.test.tsx`):
  - A: a decision is out, then the look is opened, then the decision lands, then Close.
  - B: every key on the pages, Shift with each key, the context menu, mouse down and up, and every toolbar button. The only requests were ranged GETs of the held route. Nothing was stored and the dialog stayed open.
  - C: Tab and Shift+Tab stay inside the dialog: Close, Next page, page field, zoom buttons, Fit width, Rotate view, Pages, and round again.

## Findings

### Important
**I1. A decision that lands while the look is open: the dialog says something false, and Close loses focus.**
- Where: `packages/ui/src/screens/import/ReviewQueue.tsx:1584-1599` (the Look control and `LookDialog`), and `useTrap`'s restore in `components/ReasonDialog.tsx:20-24`.
- "Look at the file" stays enabled while that card's own decision is out. Probe A did this:
  1. pressed "Use this file" (the service held the answer back);
  2. pressed "Look at the file" (its `disabled` was `false`);
  3. let the answer land.
- **The dialog stays open over a file that is now attached.** It still says "This file has not been added to your library. Use this file, or Not this file, in the review queue." That sentence is now false.
- **Close puts focus in the wrong place.** Focus is restored to the same `<button>` DOM node, which React has reused for the `aria-hidden`, `inert` stand-in. Probe output: `after close, active: BUTTON Look at the file connected: true`.
  - In a browser, focus on an inert element fails, so focus drops to `<body>`.
  - `fileLeft` does not move focus to the next waiting file, because focus was in the dialog's portal rather than in the card.
- The same applies when a decision is given up and re-read (R313 e) and when a 404 happens mid-look.
- Directions (one or both):
  - Disable or hold back the look while the card's decision is out.
  - When the card ends while its look is open, close the dialog and send focus where `fileLeft` would have sent it (the next waiting file).
- No test covers this.

### Minor
**M1. The look shows a sentence that offers a note.**
- `reader/PdfPages.tsx:68,602`: for a page without text, the look shows "This page has no text to select. It is probably a scanned image; you can still add a note to it." In a look nothing can be added, so the sentence is false there.
- Probe B saw it in the dialog for each stand-in page.
- It is already shown in a read-only library, but the look is a new place where it is false.
- Direction: drop the second half when `readOnly` or `look`.

**M2. `LOOK_GONE` is false when the held file is gone from disk but its entry still waits.**
- "This file is no longer waiting for your decision, so it cannot be shown." is the sentence for every 404 (`ReviewQueue.tsx:174`, `Reader.tsx:301`).
- One of those 404s is the held file missing from disk while its entry is still pending (`held-file-document.test.ts` covers it). In that case the card still waits, with "Use this file".
- Direction: a sentence true in both cases, such as "This file cannot be found, so it cannot be shown." Or keep the route's single 404 and accept the wording. This is the coordinator's call.

**M3. Doc comments separated from what they describe.**
- `FilePreview.tsx:24-27`: `NO_PREVIEW` was put between `assetName`'s doc comment and the function.
- `ReviewQueue.tsx:167-172`: the look constants were put between `HELD_DECIDE_WORDS`'s doc comment ("A waiting file's two controls…") and that constant.
- Each now has two stacked JSDoc blocks.

## Checked and sound

**A look changes nothing.**
- The chain is `heldFileToLook`, then `openHeldFileContent`, then `openStored`, then `serve`. It is one read of the review file and no `runMutation`. There is no audit, no transaction, and no write.
- The service test, and my read-only probe, hash the whole library folder and find it unchanged.
- In an encrypted project the plaintext lives only in memory: `openDecryptedHandle` with `cacheChunks: 1`, and each answer is at most 4 MiB, streamed in 64 KiB slices. Nothing is written to a temporary file.

**The path cannot be steered.**
- `isHeldEntry` requires `HELD_RE` (`^find/held/<uuid>.(pdf|epub)(.enc)?$`). The place is joined under the project's folder and checked by `assertContained`, and `openStored` refuses symbolic links (ELOOP).
- A doctored review file cannot point the route outside the hold.

**Who can read, and which file.**
- Only the desktop app's token: `caller !== "ui"` gives 403, and the `ui-only-routes` row checks both the route's own check and the global extension check.
- No token gives 401. A wrong Host or a foreign Origin gives 403.
- The preflight allows only GET, with `authorization`, `content-type` and `range`.
- A locked project gives 423 before any entry is looked at, the same for real and unknown ids.
- Another project's entry, an entry with no held file, a decided entry (either decision, see my probe) and a file gone all give the same 404.
- An EPUB gives 400 "This file cannot be shown here." A library opened read-only can still be looked at.

**A lock or a close mid-read.**
- `serve` is the PDF route's former tail, moved without change. Every read is guarded against a lock and a library close, then come the 512 MB limit, one range, 416, and the 4 MiB cap.

**The refactor's blast radius.**
- `openAssetContent` still gives the same NotFoundError, mime, linked-path handling and lock order.
- `guarded` now spreads `...c`, but `close` and `range` are still replaced explicitly.
- `sendContent` only takes the narrower type.
- The four existing route files pass unchanged.

**The look-only reader.**
- `assetId` is undefined and `readOnly` is forced, so `useHighlightMaking` and `useKeyboardMaking` return "not-sent" or "read-only" on every making path. That is a second layer beneath the key guard.
- The annotation request is skipped, the overlay returns null, and there is no list, no S or N buttons, no help and no notices.
- Probe B tried every key; it fired no request but ranges and stored nothing.
- The source's other files and annotations are never asked for or shown.

**The card and the dialog.**
- Look comes after the two deciding controls (the R303 b order is asserted in `ReviewQueue.test.tsx:890`).
- The stand-in keeps the line in place (R319).
- Focus goes first to the heading, then to the pages, never to Close; Enter and its repeats do not close the dialog.
- Tab is kept inside the dialog (probe C). Escape and Close return focus to the Look control when the card is still pending.
- The background is inert, so two dialogs cannot be open at once.
- The heading uses `UserText`. The accessible name uses `named`, built the same way as "Use this file".
- Colours come only from tokens; the CSS adds spacing and size only.

**Wording.**
- The screen's own heading is `<h1>Review queue</h1>` (`ReviewQueue.tsx:956-957`), so "in the review queue" names what the researcher sees.
- The EPUB sentence is now one constant and is unchanged on the file preview.

## Judged only by reading
- **The lock-mid-read harness row** (`lock-mid-read.test.ts`). It cannot fail for a lock missing from the held path, for two reasons:
  - `heldFileToLook`'s `assertUnlocked` comes before any opening the seam counts.
  - The harness accepts the unlocked result as an outcome.
  
  It does guard against a lock surfacing as damage, and against a trace being left. It is legitimate coverage as the harness's header asks, but it is not a guard of the new code as such.
- **The service's "lock in the middle of a read" test.** This was also judged by reading. Like its twin in `documents-route.test.ts`, it would likely still pass with `serve`'s per-read guard taken out:
  - the wiped key already makes decryption fail;
  - "aborted" is an accepted outcome;
  - `received ≤ 4 MiB` holds whatever happens.
  
  The guard is shared and was not changed. I did not edit tracked files to prove this.
- How pdf.js renders a real held PDF, or garbage, in WebKit. pdf.js was stubbed. By the existing mapping, garbage gives "Damaged PDF" and a 409 gives "PDF not shown"; neither should spin forever.

## Second look (R487, R492)

Scope: ba36ce7..d9923fd (eight commits; RE-7h and RE-7i). The reviewer's probes were again `*.probeRE7c.test.ts(x)`. All are deleted; no commits were made and `git stash` was not used.

**Verdict: APPROVED WITH SMALL POINTS.** The lock hole R492 a names is closed: a lock asked before the file's key is taken, by the wipe or by the mark, now refuses the read. Each harness row fails without the change (result below). R487 a–e and R492 b and c are built and hold. Three Minor points remain, plus one point for the coordinator's ruling: how wide the window still is once a file is open.

### Runs
- **Service tests:**
  - `documents-route.test.ts`: 24 passed.
  - `media.test.ts`: 27 passed.
  - `held-file-document.test.ts`: 10 passed. This file hashes the library before and after a look; nothing changed, and the audit is the same.
  - `ui-only-routes.test.ts`: 126 passed.
- **Library tests:**
  - `held-file-content.test.ts`: 5 passed.
  - `asset-content.test.ts`: 9 passed.
  - `asset-content-open.test.ts`: 3 passed.
- **UI tests:**
  - `ReviewQueue.look.test.tsx`: 12 passed.
  - `ReviewQueue.test.tsx`: 116 passed.
  - `Reader.test.tsx`: 56 passed.
  - `PdfPages.test.tsx`: 17 passed.

### 1. The lock (bd3cea8, 5c4196e)

**When the key is asked for, and what that closes.**
- `keyAtOpening` (`asset-content.ts:113`) is passed as the key getter to `openDecryptedHandle`.
- That function calls the getter once: right after `noteOpening` (the seam) and before any byte is read (`random-access.ts:57-61`).
- Under the mark or the wipe, `projectDataKey` now throws `ProjectLockedError`. `openStored` closes the handle.
- So a lock asked before or at the opening serves nothing.
- A plain (unencrypted) project passes `null` and is read exactly as before.

**Picture route, a lock by the mark at the opening.** This was a service probe:
- I held a change of another project on a gate, counted the openings of an unlocked request, then locked by the mark at the last opening.
- Result: **423 `PROJECT_LOCKED`, no picture bytes** (97-byte body).
- The same probe with the OLD eager key put back (a `vi.mock` of `@ao/library`): **200, with the whole picture.**
- The happy path before and after is 200 with the exact bytes.

**Media-ticket issue, the same lock.** Result: **423**, and no ticket.

**Damaged, re-keyed and missing files.**
- `media.test.ts` (a damaged recording and a damaged picture give 409) and `documents-route.test.ts` (a missing linked file gives 404) pass unchanged.
- I probed a re-keyed picture: a file sealed under another project's key put in the asset's place. It answers 423. By reading, this is the same as before: both getters return `undefined` for a foreign key id, which gives `KeyNotAvailableError`. See M-c.
- A missing picture answers 404, as before.

**Callers.** `grep openAssetContent|openStored|keyAtOpening|openHeldFileContent` finds only:
- media.ts:312, 328 and 364;
- documents.ts:158 and 222.

The implementers' table is complete. `openDecryptedFile` has no caller outside tests. Previews, exports, the worker's inputs and the CLI do not use these readers.

**The tightened harness rows.**
- Probe `lock-mid-read.probeRE7c.test.ts`: a copy of the harness with both readers' OLD eager key put back through `vi.mock`, run with `-t "openHeldFileContent|openAssetContent"`. Result: **[see the line below]**.
- By reading, each row throws when `lockAsked && !after` and bytes come back. That is exactly the case the eager key allows (under the mark the getter would still hand over the captured key).

**THE WINDOW LEFT: the whole file, once it is open, at the library level.**
- `openDecryptedHandle` COPIES the key at the opening (`const key = Buffer.from(k)`, `random-access.ts:61`). After that, neither the wipe nor the mark reaches an open handle.
- Probe (`held-file-content.probeRE7c.test.ts`): open a 5 MiB sealed held file, read 10 bytes, `await lockProject` (the key is wiped, `isUnlocked` is false), then read the rest. Result: **all 5,242,947 bytes, correct.**
- So `keyAtOpening`'s comment, "not one byte of the file's content is read under it", is true only for a lock asked before or at the opening.
- **What bounds it at the service:**
  - The document and held routes: `serve`'s guard checks the lock before and after every 64 KiB read. Nothing read after a lock leaves; only bytes already in flight do. The held mid-read test now pins this: it fails with the guard removed, as the RE-7h report says, and it is consistent with my probe that the open handle would serve the whole range. Each request opens its own handle for at most 4 MiB.
  - The PICTURE route has no per-read check. Probe: a lock (the wipe) one microtask after the picture's opening gives **200 with the whole picture**, and `isUnlocked` is false afterwards. That window is bounded by the picture limit.
  - Media streams are cut by the lock route's `revokeProject`.
- **How this fits the rulings.** R404 and R435 e accept "the right result" for a reading under way, and the harness exempts the "after the last opening" points. So this is the accepted design, but its size is the whole file per open handle, not one chunk.
- R386 a assumed that readers keep the ring's buffer, so that a wipe ends them. `openDecryptedHandle`'s copy is the exception (older than this task).
- **For the coordinator's ruling:** whether the picture route should take the same per-read guard as the document route, or `openDecryptedHandle` should re-check the key per chunk.

### 2. R487 a with R492 b and c (6f6b6c2, e85d767, d9923fd)

**(i) No look while the card's own decision is out.**
- `aria-disabled={busy}` and `onClick={() => busy || onLook(…)}`: the same state as the deciding controls.
- The test does with Enter, Space and a click what my probe A did, and checks that nothing opens and no range is read.

**(ii) A look whose file stops waiting.** The tests cover:
- a decision recorded late (given up, then shown at the next read), then Close, with two cards: focus goes to the next card's `<h4>`;
- the last found card while an import entry still waits: focus goes to the "Files found for records" heading;
- nothing else waiting, then Escape: focus goes to "Nothing is waiting…";
- a "not found" while the card still waits: focus goes to the card's live "Look at the file".

In each case the reader is unmounted, its document destroyed and no range read afterwards. `LOOK_GONE` is said once, by moving focus to it.

**What "the look now belongs to the screen" changed.**
- `lookAt` is screen state now, so a re-read (`setItems(null)` unmounts the section) no longer closes the dialog.
- A lock (`forget`) and another project or layout (`laidFor` key) still close it.
- A card that leaves the queue for another reason (decided elsewhere, a re-read that no longer lists it) makes `lookGone` true, which gives the sentence and no reader. It cannot stay showing a file that is no longer waiting.

**M-a (Minor): Close during a slow re-read loses focus.**
- File: `ReviewQueue.tsx` `closeLook` and the `fileFocus` effect (around :963 and :797).
- Probe P-gap:
  1. Card A's "Use this file" is given up after 60 s while card B's look is open.
  2. The re-read is held back.
  3. Escape during it.
- Result: focus goes to **BODY**, and is still BODY after the read lands.
- Why: `closeLook` targets `look:B`, but B's card is not mounted during the re-read. The effect finds no control, returns, and nothing retries.
- Narrow: it needs a given-up decision on another card and a Close inside the read's gap.
- Direction: keep the target pending until the section is back, or fall back to the screen's heading.

**Probe P-lock.**
- The re-read answers 423. `forget` closes the look and the screen shows the unlock form; focus goes to BODY.
- This matches the queue's behaviour on a lock without a look: neither `UnlockProject` nor `forget` places focus.
- So it is not caused by this round. I note it only.

### 3. R487 b, c, d, e
- **b:** `LOOK_NO_TEXT_SENTENCE` is shown only in a look (`PdfPages.tsx:70`, `:606`). Outside a look the reader's sentence is unchanged; `PdfPages.test.tsx` passes.
- **c:** `LOOK_GONE` is one constant with the ruled words, and the old words appear nowhere.
- **d:** both comments are back on their own declarations.
- **e, the service test:** it now asserts `aborted`, that the bytes are the file's own prefix, and that the marker at 4 MiB − 4096 never arrives. By reading, together with my probe that an open handle outlives a wipe, removing the guard lets the whole range through, so the test fails. The RE-7h report shows that run.
- **e, the harness row:** the eager-key run is the probe above.

### 4. What I approved before
- A look still writes and attaches nothing. The service test hashes the whole library before and after and compares the audit; it passed.
- The route's refusals pass unchanged: 404, 423, 400 and 416, and the token, Host and Origin checks.
- `documents-route` and `media` pass unchanged.

### Minor
- **M-a:** focus is lost to the page when a look is closed during a slow re-read (above).
- **M-b:** `keyAtOpening`'s comment claims more than holds. "Not one byte of the file's content is read under it" is true only for a lock asked before or at the opening. After the opening, the whole file stays readable through the handle (see "The window left").
- **M-c:** a re-keyed picture (or document) answers 423 "locked". This is older than this round and unchanged by it, but R435 d says "only a lock is locked". For the coordinator, outside RE-7c.
