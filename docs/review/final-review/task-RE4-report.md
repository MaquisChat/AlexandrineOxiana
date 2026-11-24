# Batch RE-4: dialogs and focus, the media player, the optional tools (report)

Branch `re-4-dialogs-player`. It started at 567d98d and its head is d04061f. Nothing is pushed.

## Items

| FR | Still present? | What changed (file:line), or why nothing | Its test, and whether it failed first | Note |
|---|---|---|---|---|
| FR-203 | **No, closed by Task 34e (d543b11).** | Nothing changed. `DialogShell` removes `inert` in a **layout** effect (`components/ReasonDialog.tsx:58-66`). `useTrap` restores focus in a **passive** effect (`:20-24`). On unmount React runs layout cleanups first, so `inert` is gone before the opener is focused. A probe confirmed it: when the opener was focused, it had no inert ancestor. | New evidence: `src/dialogs.r145.test.tsx`. Like a browser, it refuses `focus()` inside an `[inert]` subtree, and every row's "focus returns to the opener" check and `refused == []` pass. That test would catch the defect. | The ledger line dates from Task 60 (11 Nov, 15:57). Task 34e moved the effect to a layout effect the same evening. |
| FR-234, FR-601 | **Yes, for three popovers or dialogs.** | New `packages/ui/src/dialogs.r145.test.tsx`: one table with 27 rows, listed below. It found three defects, now fixed. (1) `components/PendingWritesDialog.tsx` onKeyDown: Shift+Tab from the first button left the dialog, because the trap took the heading (tabindex -1) as "first". The trap now uses the tab stops only, and Shift+Tab from the heading or the message wraps to the last control. (2) `reader/HighlightToolbar.tsx` OverlapMenu: Tab closed the menu without `preventDefault`, so the focus did not go back where it was, as the component's own comment says it should; now it does. (3) `components/CitePanel.tsx`: the style list stayed open after Tab left the field; `onBlur` now closes it. | The table. All three fixes failed first: PendingWrites refused 4 focus moves onto the inert page, OverlapMenu left focus on body, and CitePanel's listbox was still shown. | R376 c / R377 is kept: the table opens every dialog with a click, never a key. |
| FR-259 | Yes | `components/MediaTicketPlayer.tsx`: a `playing` event after the resume seek was issued ends the wait (`onTimeUpdate` and its listener), so a seek that never reports landing no longer leaves the player ignoring the element's time. | `TranscriptViewer.test.tsx` "a resume seek that never lands…". It failed first: the segment playing was never marked. | This follows the reviewer's direction (accept the time after the first `playing`). |
| FR-260 | Yes | `MediaTicketPlayer.tsx`: the player keeps `lastActivity` (a new src, a time report, a play, a seek, `progress`). A failure after `MEDIA_TICKET_IDLE_MS` (shared, 10 min) without activity counts as the ticket ending on its own: it is renewed without a strike and `renewals` resets. It cannot loop, because each such failure needs 10 idle minutes. | "three ticket expiries after long pauses near one spot…". It failed first: the third failure gave up with "may be damaged". | |
| FR-261 | **No, closed by Task 62 (78453c4).** | Nothing changed. When `TranscriptViewer.tsx:536` gets a status-0 failure it reads the job once. If no run is pending it shows "The library service could not be reached." and Re-transcribe stays on. The sentence "may still be going" no longer exists. | Probe (deleted): a POST answered with a network error gave that sentence, the button on, and one call. The existing test `TranscriptViewer.test.tsx` "a start whose answer was lost reads the job's state…" covers the other branch. | |
| FR-266 | **No, closed by Task 63 (9b22e71).** | Nothing changed. The 503 sentence is now "The links could not be queued. The media helper is not running. Restart the app and try again." (`screens/Capture.tsx:90`). | `Capture.test.tsx:151` asserts that "queued" appears once ("Said once (Minor O2)"). | |
| FR-291 | Yes | `screens/ToolsSetup.tsx:511`: "Each download contacts only the addresses listed with the tool…", or, when the catalogue names no hosts, "…only the servers that host the tool…". "Publisher" is gone from the general sentence. The per-tool line, "its publisher's servers (the catalogue does not name them)", is kept: there the publisher is all that is known. | `ToolsSetup.test.tsx` "the screen's general sentence says the servers that host each tool… (FR-291)". It failed first. | |
| FR-315 | Yes | `components/FirstUseTools.tsx` onStarted: the dialog now goes to `toolsHref(first started tool)`, which is `?tool=<id>`. The tools screen then focuses that tool's heading. The banner and its opener are gone by then, so the restore had nowhere to go. | `FirstUseTools.test.tsx` "after the confirmation focus lands on a started tool…". It routes like App.tsx, and it failed first: focus was on body. | |
| FR-316 | Yes | `FirstUseTools.tsx` banner: the polite `role="status"` region now holds only the sentence, and the buttons sit beside it in the same banner. The live region is still present before the banner appears, and it is still not announced again after the unlock screen. | `FirstUseTools.test.tsx` "its live region holds the sentence only… (FR-316)". It failed first: the region's text included the labels "Choose tools…Not now". | `lint:css` passes. The banner box keeps its class. |
| FR-217, FR-218, FR-219 | Yes | **Service** (`apps/library-service/src/media.ts`): a `failed(cause)` hook in `sendContent` is called before the first byte and while sending. On the media route a `DecryptionError` or `EncryptionFormatError` marks the ticket `fileChanged`, and `POST /media-tickets/revoke` then answers `{ revoked, ended: "FILE_CHANGED" }`. **Shared** (`packages/shared/src/api/media.ts`): `MEDIA_FILE_CHANGED` and the optional `ended` field, a code and not a sentence. **Player** (`MediaTicketPlayer.tsx` `renew`): it revokes the ended ticket first. If the answer carries the code, the player stops at once with "The recording stopped: its file was changed outside the app, so it cannot be played from here. Check the verification report." Otherwise it renews as before. No path appears in any message, and the one warn line is unchanged. | `media.test.ts` "a stored file found changed while it is played" has two tests, on a real socket mid-stream and before the first byte. Both failed first: no `ended`. `TranscriptViewer.test.tsx` "a recording whose file the service found changed outside the app says so at once…" failed first (no alert). | Shared type: `MediaTicketRevokeResponse` gained an optional `ended`. The test mock `msw-transcripts.ts` gained `state.fileChanged`. "Check the verification report" is the app's existing next step (StatusBanner). |
| FR-350 | Yes | `packages/ui/src/api/client.ts`: a new `cutOff()` holds the one sentence "The library service's answer was cut off before it finished." (code INTERNAL, status 0). The NDJSON reader already used it, and `bytes()` now uses it for a body that fails part-way, both chunked and whole. | `client.test.ts` "bytes() — a body cut off part-way (FR-350)" has two cases. Both failed first, with "could not be reached". | The entry says "Service", but the code is the UI client. |
| FR-254 | Yes (in the media helper) | `services/media-worker/ao_worker/transcribe.py`: "the <model> model on disk could not be read" and "… could not be loaded" both end with "; remove it and install it again from the Optional tools screen" (`_REINSTALL`). The screens already had their own next step (`TranscriptViewer.tsx:100`, `api/capture.ts:242`). The helper's sentence is what the CLI (`commands/transcribe.ts:32`) and the logs carry. | `tests/test_transcribe.py`: `test_unreadable_models_folder…` (extended) and the new `test_model_that_cannot_be_loaded_says_what_to_do`. Both failed first. | The entry says "Desktop shell", but no such sentence is in `apps/desktop`. |

### The R145 table (`packages/ui/src/dialogs.r145.test.tsx`): every dialog and popover, with its result

The checks for a modal dialog: focus moves in (to the named element); the page is inert; Tab and Shift+Tab stay inside past both ends; Escape and the close control close it and give focus back to the opener or a named fallback; no `[inert]` remains; nothing tried to focus an inert element. For a menu: focus moves in, and Tab, Shift+Tab and Escape each close it and give focus back. Every row passes now.

| # | Dialog or popover | Result |
|---|---|---|
| 1 | Record a reason (ReasonDialog) | passed |
| 2 | Typed confirmation (ConfirmDialog) | passed |
| 3 | Yes/no question (ChoiceDialog; first focus on the heading, R376 c) | passed |
| 4 | Optional reason (ReasonOptionalDialog) | passed |
| 5 | Choose the person (ChoosePersonDialog) | passed |
| 6 | Choose the work (ChooseWorkDialog) | passed |
| 7 | Choose the works (ChooseWorksDialog) | passed |
| 8 | A field's evidence (FieldCheck → FieldEvidencePopover) | passed |
| 9 | Optional tools, first use (close control "Not now" → the Optional tools link, a named fallback) | passed |
| 10 | New project (Library) | passed |
| 11 | New recovery code (Library) | passed |
| 12 | Save the recovery code after a new code (Escape must NOT close it, R134; Done gives focus back) | passed |
| 13 | Save the recovery code after creating an encrypted project (the same) | passed |
| 14 | Interrupted changes (Library → PendingWritesDialog) | **failed, fixed** (Shift+Tab left the dialog) |
| 15 | Set this aside (AuditLog) | passed |
| 16 | Add a watched folder | passed |
| 17 | Download and import (WatchedFolders) | passed |
| 18 | Stop watching (WatchedFolders) | passed |
| 19 | Use your browser session? (Capture) | passed |
| 20 | Undo the import (StepReport, alertdialog; it has no focus test of its own) | passed |
| 21 | Reviewed after the withdrawal (ReviewQueue) | passed |
| 22 | Colour menu of a highlight (AnnotationList, menu) | passed |
| 23 | Delete this note? (AnnotationList) | passed |
| 24 | Discard this note? (AnnotationList; opened by Escape in a changed note, focus back to the note) | passed |
| 25 | Highlights here (OverlapMenu, menu) | **failed, fixed** (Tab left focus on nothing) |
| 26 | Highlight toolbar (never takes focus; Tab enters; Escape or Cancel → page) | passed |
| 27 | Citation styles list (CitePanel combobox: focus stays in the field; Escape and Tab close the list) | **failed, fixed** (the list stayed open after Tab) |

Disclosures (`aria-expanded` buttons in TagList, CollectionTree, SourceDetail, About, GovernanceSettings, MissingFiles, DropZone, the reader's key help, ReviewQueue edit/merge) open inline sections, not popovers. They move no focus, so they are not in the table.

Two things about the test harness, both said in the file. (a) As in a browser, `focus()` on an element inside `[inert]` is refused, and the refusals are recorded. (b) jsdom's selector engine lists a selector group's matches group by group, not in document order, so each dialog's own `querySelectorAll` is put in document order, as `NewProject.test` already does. Without (b), row 12 failed for that reason alone.

## NEEDS A RULING

None. Two choices of wording were made within the item. Please confirm them or change them:
- FR-217–219: "The recording stopped: its file was changed outside the app, so it cannot be played from here. Check the verification report." The service can tell a file that fails its encryption check, but it cannot tell whether the change was made by a person or came from disk damage. I used "changed outside the app" because that is what the brief asks for. A plain (unencrypted) recording whose bytes change on disk is not detected while it streams, so the generic sentence still applies there.
- FR-291: "Each download contacts only the addresses listed with the tool" / "…only the servers that host the tool".

## What only a real Mac or a real service can show

- The order of `seeking`, `seeked` and `playing` in WebKit's media stack, after a renewal and when a seek never lands (FR-259). The tests drive the events by hand.
- A real 10-minute idle expiry ending the element's read in WebKit (FR-260). The test moves the clock.
- The cut connection on a real tampered encrypted recording, seen by WebKit's media element and then the revoke answer (FR-217–219). The service half runs on a real socket in `media.test.ts`. The player half runs in jsdom.
- VoiceOver reading the first-use banner without its button labels (FR-316).
- Focus leaving the web view on Shift+Tab out of a dialog (FR-234). This was simulated by refusing focus to inert elements.

## Runs

All runs used `nice -n 10`, on a machine loaded by the other batches.
- Touched test files: `ToolsSetup.test.tsx` 30 passed; `FirstUseTools.test.tsx` 23 passed; `routes/tools.test.tsx` 9 passed; `TranscriptViewer.test.tsx` 62 passed; `api/client.test.ts` 37 passed; `dialogs.r145.test.tsx` 27 passed; with `PendingWritesDialog`, `HighlightToolbar` and `CitePanel`, 49 passed; `media.test.ts` 29 passed.
- `pnpm --filter @ao/ui test`, whole suite once: `Test Files 5 failed | 112 passed (117)`, `Tests 19 failed | 2250 passed (2269)`. None of the failures was in a test this batch touched: PdfPages 15 (they cascade after the first one timed out), Library.reader 2, colourScan 1, and client.test's "many small chunks… linear time" (a speed test). Re-run alone (client.test, PdfPages, Library.reader, colourScan): `Test Files 4 passed (4)`, `Tests 68 passed (68)`.
- `pnpm --filter @ao/library-service test`, whole suite once: `Test Files 2 failed | 43 passed (45)`, `Tests 2 failed | 1087 passed | 2 skipped (1091)`. Re-run alone, `main.test.ts` (standard-input token, 12.5 s under load) passes. `find-browser-routes.test.ts` "the pause after a hand-over… holds every start" fails alone too: it expects the exact text "Ready in 20 seconds." and depends on the clock on this loaded machine. This batch changed nothing in find (`git diff 567d98d --stat -- apps/library-service`: media.ts and media.test.ts only). **Concern:** it needs a run on a quiet machine.
- `@ao/shared` has no test script; typecheck covers it.
- Media helper, using the main checkout's venv against this worktree's code, `-p no:cacheprovider`: not-slow suite `190 passed, 1 skipped, 9 deselected`; `tests/test_transcribe.py` `6 passed, 3 skipped`.
- `pnpm -r typecheck`: every package Done.
- `pnpm --filter @ao/ui run lint:css`: clean. `lint:colours`: `ok: no hard-coded colours in src/**/*.ts(x)`. `run build`: `✓ built in 26.32s`.
- End-to-end not run (the coordinator runs it). `e2e/first-use.spec.ts` drives the banner (FR-316) and should be run.
- `git status --short`: empty.
