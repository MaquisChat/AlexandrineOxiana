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
