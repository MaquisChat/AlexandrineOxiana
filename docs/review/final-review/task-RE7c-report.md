# Task RE-7c — looking at a held file before deciding (FR-490; R470 b)

Branch `re-7c-find`, worktree `.claude/worktrees/re-7c`. Head **ba36ce7**. It has three commits on top of 7a8f5ee. Nothing was pushed, and `git status --short` is empty.

## Step 1: a read-only route for a held file (450d8cb)
- **Library.** `packages/library/src/repo/review.ts:679` `heldFileToLook` reads the review file once and writes nothing.
  - It returns the place, kind and sealing of the file held for one **pending** entry.
  - A locked project gives `ProjectLockedError`.
  - These cases all give the same `NotFoundError("Held file", id)`:
    - an unknown entry, including an entry of another project;
    - an entry that holds no file;
    - an entry that has been decided.
  - A wrapper `heldFileToLookIn` is at `repo/repo.ts:1377`.
- **Library.** `packages/library/src/asset-content.ts`:
  - `StoredContent` (line 44) is the base of `AssetContent`. The new `HeldFileContent` also builds on it.
  - The body of `openAssetContent` that opens and decrypts a file is now `openStored` (line 108). It is the one reader, and both `openAssetContent` and `openHeldFileContent` (line 96) use it. There is no second decrypting reader.
  - A held file that is gone gives `NotFoundError`.
  - These are exported from `index.ts`.
- **Service.** `apps/library-service/src/routes/documents.ts` adds `GET /projects/:id/review/:itemId/held-file/document` (`heldHandler` at line 210, route at line 237).
  - The tail of the PDF route is now `serve` (line 170). It guards every read against a lock or a library close, checks the 512 MB limit, takes one range, answers 416, and caps each answer at 4 MiB. Both routes use it.
  - Only the desktop app's token is accepted, behind the global Host, Origin and extension checks. The route is not in EXTENSION_ROUTES.
  - The shell's preflight allows the Range header on this route (`HELD_DOCUMENT_PATH`, line 54).
  - `guarded` and `sendContent` (in `media.ts`) now take `StoredContent`.
- **Answers.** Each one is plain words with no path:
  - locked: 423 "This project is locked. Its passphrase is needed.";
  - no held file, whatever the reason: 404 "That file was not found.";
  - an EPUB: 400 "This file cannot be shown here.";
  - no range or several ranges: 400 "Ask for a byte range."
- **Tests.** Both files were written first and seen to fail before the code existed (the export was missing; 9 of the 10 service tests were 404).
  - `packages/library/src/held-file-content.test.ts` has 5 tests.
  - `apps/library-service/src/held-file-document.test.ts` has 10 tests. They cover:
    - plain and encrypted projects, ranges across chunk boundaries, and the 4 MiB cap;
    - **the library folder hashed before and after, and the audit unchanged**;
    - the entry still waiting after the look;
    - the 404 cases, EPUB, locked, a lock before the first byte, a lock in mid-read;
    - no token, a wrong Host, a foreign Origin, and the preflight.
  - `ui-only-routes.test.ts` has a new row for the route. It covers both the route's own check and the global extension check, and failed first.

## Step 3: the lock-mid-read harness (bf36536)
`packages/library/src/repo/lock-mid-read.test.ts`:
- The fixture now holds a sealed held PDF of about 3 MB for a record that has no file.
- A new row, "openHeldFileContent (a whole held PDF, looked at)", is in ROWS.
- The row passed when run with `-t`, together with the seam test and its neighbouring rows: 5 passed.
- It did **not** fail first, because the reader it covers already existed (it was built in step 1).

## Step 2: "Look at the file" (ba36ce7)
- **Where it is.** The found-file cards with "Use this file" / "Not this file" live in `packages/ui/src/screens/import/ReviewQueue.tsx` (the review queue), not in `FindAcquire.tsx`. The control is there.
  - It is at about line 1581, **after** the two deciding controls, so Tab from the card's heading still reaches "Use this file" first (R303 b).
  - Its accessible name is "Look at the file for <record title (Family, year)>".
  - Once the file is decided, the line keeps its place as an invisible stand-in, so nothing moves (R319).
- **The dialog.** `LookDialog` (line 1634) uses the shared `DialogShell`.
  - Focus goes to the dialog's heading, never to Close, so the key that opened it never closes it.
  - Tab stays inside the dialog and the background is inert.
  - Close or Escape returns focus to "Look at the file".
- **Look-only mode.** `packages/ui/src/screens/Reader.tsx` has a new `look` prop (`LookOnly`, line 148). With it:
  - the reader reads ranges only from `heldFileRanges` (`api/reader.ts:57`);
  - the making hooks get read-only with no asset, so nothing can be sent;
  - the source's annotations are never asked for, no overlay is drawn, and there is no annotation list;
  - the making buttons, help, notices and the S, N and selection keys are absent;
  - there is no library link when locked, and the "missing" state uses the look's own sentence.
  - No "last page" memory exists in the reader. The test asserts that the look writes nothing to storage.
- **EPUB.** The card says the `FilePreview` sentence, now one constant `NO_PREVIEW` in `FilePreview.tsx:26`, and offers no look.
- **Styles.** CSS was added at the end of `import.css`.
- **Tests.** `ReviewQueue.look.test.tsx` has 6 tests. The first 5 were written first and seen failing (the button was not found, `NO_PREVIEW` was undefined). The 404/423 test was added after.
  - **The test that shows what a look can write:** the first test asserts that the only requests are ranged GETs of the held route, with no annotation or asset request, no non-GET request, and no storage `setItem`. The S and N keys make nothing.
- **Existing tests changed** in `ReviewQueue.test.tsx`, because the ruling adds a third control on each card:
  - "every file has its own two controls…" now expects the Look button after the two deciding controls;
  - the R319 helper `controls()` now counts deciding controls only.

## Sentences a researcher can see (new)
- "Look at the file" (the button), and the dialog heading "Look at the file: <title>".
- "This file has not been added to your library. Use this file, or Not this file, in the review queue."
- "This file is no longer waiting for your decision, so it cannot be shown." (shown when the held file is gone or decided)
- "No preview of this file can be shown here." (EPUB, an existing sentence)
- "Close"

## NEEDS A RULING (wording)
The brief's line says "…on the Find and acquire screen." The decision controls are in the **review queue**, so that wording would send the researcher to the wrong screen. I used "…in the review queue." instead. If the owner wants the brief's wording, it is one constant: `LOOK_ONLY_NOTICE`.

## Runs (nice -n 10, load around 40 on 4 cores)
- **Passed:**
  - `held-file-content.test.ts` with `asset-content.test.ts` and `asset-content-open.test.ts`: 17 passed.
  - `held-file-document.test.ts` with `documents-route.test.ts` and `ui-only-routes.test.ts`: 160 passed. The 2 failures in the first run were my test expecting the wrong error code (VALIDATION); I fixed the test.
  - `ReviewQueue.look.test.tsx`: 6 passed.
  - `ReviewQueue.test.tsx -t "R319|six at a time"`: 17 passed.
  - `Reader.test.tsx` alone: 56 passed.
  - lock-mid-read rows: 5 passed.
- **Typecheck:** library, service and ui each clean, run on their own. `pnpm -r typecheck` was not completed.
- **Lint:** `lint:css` clean; `lint:colours` "ok: no hard-coded colours".
- **Whole suites.** I ran the service and ui suites together, which overloaded the machine further. They were stopped on the coordinator's word, and the chain after them (`pnpm -r typecheck`, `run build`, the library files) was killed before it finished.
  - Service: 10 failed | 1089 passed. The failures are in files I did not touch: find-browser-routes, import-disk-full, main, open-library, recovery-code, server.
  - UI: 23 failed | 2222 passed. The failures are in client, ChooseWorksDialog, PdfPages, FindAcquire, colourScan, Reader and ReviewQueue "six at a time". All of these look like time limits, and Reader.test and "six at a time" pass alone.
  - **`run build` was not run.** These suites are left to the coordinator's single verification.

## Needs a real browser or Mac
How the dialog and reader look and scroll in WebKit, and how pdf.js renders a real held PDF in it. pdf.js was stubbed in the unit tests.

minor (deferred): `ReviewQueue.look.test.tsx` checks the dialog's heading focus only as "inside the dialog, not Close", because the reader moves focus to its pages once the file is open.
