# Batch RE-4b: the review's points on RE-4 (R462 a, R467) (report)

Branch `re-4-dialogs-player`, d04061f..1a6114a, 11 commits. Nothing is pushed. Every point has a test that was run against the old code and failed first, except M9. M9 is a change to a test, so there was nothing to fail.

## Per point

| Point | What changed (file:line) | Its test, and whether it failed first | Commit |
|---|---|---|---|
| **I1** (FR-260) | `packages/ui/src/components/MediaTicketPlayer.tsx`: the `lastActivity`/`active()` clock is removed. The player now records when it received each ticket (`ticketAt`, :225) and the ticket's own idle lifetime as the service gives it (`idleLifetime`, :107). That lifetime is `idleExpiresAt − (expiresAt − MEDIA_TICKET_LIFETIME_MS)`, falling back to the shared `MEDIA_TICKET_IDLE_MS`. A failure is treated as "may have expired" only when the ticket is at least that old, whatever the researcher pressed. A young ticket's failure still counts as a strike, and each new ticket starts young, so renewal cannot loop. | `TranscriptViewer.test.tsx` "after a long pause the researcher presses play (or seeks) and only then the expired ticket fails…". This is the reviewer's probe (pause, 11 min, play/seek, error at 50 s, 50.8 s and 51.5 s). It then sends young failures until the player stops. **Failed first**: the third round gave "may be damaged". The first implementer's FR-260 test still passes. | ff65bb3 |
| **M1** (FR-217) + **M2** | `apps/library-service/src/media.ts`. In `serve`'s catch, a header that fails its check (`EncryptionFormatError`/`DecryptionError` from `openAssetContent`) now marks the ticket before the route revokes it (:432). A marked ticket that ends (revoked, or swept as idle) leaves a mark in `marks`. The mark holds the digest, the reason and when it lapses, and nothing of the file or path. It is read once by `revokeForPlayer` (:180). It lapses when the ticket's 8-hour lifetime is over, and at most `MEDIA_TICKET_MARKS_MAX` (32) are kept, oldest out first. Player: one sentence, the ruled one, `MEDIA_FILE_CHANGED_SENTENCE` (:115). Shared comment updated. M1 and M2 share one commit because the header case needs the mark to outlive the revoke. | `media.test.ts` "a change in the file's header…" (M1), **failed first** (no `ended`). "the mark outlives the ticket's idle sweep…; bounded in time and in number" (M2), **failed first** against the old `media.ts` (the reviewer's probe S2). `TranscriptViewer.test.tsx` FR-218 test asserts the ruled sentence word for word. | df28ae1 |
| **M5** | `MediaTicketPlayer.tsx`: for a changed (or destroyed) file the halt has `retry: false`. | The FR-218 test now asserts that there is no "Try the recording again". **Failed first.** That test had asserted the button (the rough edge), and has been changed. | 40fbc90 |
| **M4** | `MediaTicketPlayer.tsx` `renew`: the revoke is raced against `REVOKE_WAIT_MS` (10 s, :98). With no answer by then, the player goes on as if no code came and renews. | "a revoke that never answers is waited for no longer than REVOKE_WAIT_MS…". The revoke handler never answers, and the test runs the time-limit callback. **Failed first**: no time limit was set, and the player stayed on "Reconnecting". | 4729812 |
| **M3** | Shared: new code `MEDIA_FILE_DESTROYED = "FILE_DESTROYED"`. Service: `MediaTickets.endDestroyed` / `forgetDestroyed` (media.ts:193, :205). The destroy route (`routes/governance.ts:231`) ends the tickets of those assets **before** anything is overwritten and marks them destroyed. If the destruction is refused it takes the marks back. Afterwards it also ends the tickets of derived files destroyed with them. A destroyed ticket is never marked "changed". Player: on `FILE_DESTROYED` it shows what the transcript viewer already says of a destroyed recording, "This source has no recording to play. Its transcript is shown below." That sentence now lives in one place (`NO_RECORDING_SENTENCE`, MediaTicketPlayer.tsx:95, used by TranscriptViewer.tsx). No retry is offered. | `media.test.ts` "a recording the app destroys while it streams…": an encrypted 16 MB recording streams on a real socket, and the destroy route runs mid-stream. **Failed first**: the old code answered `FILE_CHANGED`. Also `TranscriptViewer.test.tsx` "…raw data the app destroyed while it played…", which **failed first** (no alert). | defe5b2 |
| **M9** | `media.test.ts`: the `setTimeout(20)` poll in the mid-stream test is removed. The mark is set before the cut, and the cut is what ends `getAll`. | Run 3 times, passed each time. Nothing could fail first. | 35ada16 |
| **M6** (FR-350) | `packages/ui/src/api/client.ts`. In `byteRange`, a 206 body that breaks off now raises `cutOff()`. In `ndjson`, a `reader.read()` rejection after the answer began now raises `cutOff()`. A fetch that never got an answer is still `unreachable()`. MoveLibrary's `isStreamCutOff` was checked: no behaviour changed, because `reached` was already true once the headers arrived. | `client.test.ts` "byteRange() and ndjson() — an answer cut off part-way". **Both failed first** with "could not be reached". | 5f8506d |
| **M7** (FR-291) | **Mended:** the first-use banner's general sentence when no ticked tool lists hosts (`FirstUseTools.tsx:329`). It is now "Downloading contacts the servers that host each tool (the catalogue does not name them)." That matches the tools screen. **Kept:** `PUBLISHER_SERVERS` (`api/tools.ts:92`), the per-tool line "its publisher's servers (the catalogue does not name them)", because there the publisher is all that is known. | `FirstUseTools.test.tsx` "without hosts in the catalogue … the servers that host each tool, not its publisher". It had asserted "each tool's publisher" (the rough edge) and has been changed. **Failed first.** | bf97760 |
| **M8** (FR-254) | `services/media-worker/ao_worker/transcribe.py` `model_path`: a models folder that is not a folder, or cannot be read, now raises "the folder that holds the speech models could not be read, so the <name> model could not be used; check that the folder can be read, then try again". No path is in it. The "could not be loaded" and "could not be read" sentences for the model itself keep the reinstall step. | `tests/test_transcribe.py::test_unreadable_models_folder…` asserts the new sentence exactly, with no path. **Failed first.** | 8b746a1 |
| **M10** | `components/CitePanel.tsx`: the `<ul role="listbox">` cancels `mousedown`, so a press on its scrollbar keeps focus in the field. It has `tabIndex={-1}` (no Tab stop, even where scrollers can take keyboard focus). `onBlur` ignores focus moving into the list. | `CitePanel.test.tsx` "the style list stays open while its scrollbar is dragged, and closes when focus really leaves (Tab, a click elsewhere)". **Failed first** (`mousedown` not cancelled). The table's CitePanel row still passes. | 571754c |
| **I2** (FR-234/601) | `dialogs.r145.test.tsx`: 15 new rows, each opening its dialog from the real screen. `checkModal` gained a confirm path: after confirming, focus must land on a named place and never on the body. The file header is reworded to claim only what the test does. The desktop-shell mock now keeps the module's other exports. **Four faults found and mended:** `MoveLibrary.tsx` (Progress heading, `tabIndex -1`, focused when stage becomes `deleted`); `GovernanceSettings.tsx` (the "Destruction certificate" heading is focused after a destruction); `Fieldwork.tsx` (the Participants heading after a participant is deleted; the Consent records heading after a consent is withdrawn; this uses the same pattern the Sessions section already had). | The four rows **failed first**, each with `document.activeElement === body` after the confirm. | 1a6114a |

## The table: every dialog and popover, with its screen and result

"Hosted" means the row uses a stand-in opener or parent. "Screen" means the real screen and the real control.

| # | Dialog or popover | Opened from | Result |
|---|---|---|---|
| 1–4 | ReasonDialog, ConfirmDialog, ChoiceDialog, ReasonOptionalDialog (the shells themselves) | hosted | passed |
| 5–7 | ChoosePerson / ChooseWork / ChooseWorks (the components) | hosted | passed |
| 8 | A field's evidence (FieldCheck) | hosted | passed |
| 9 | Optional tools, first use | the FirstUseTools banner | passed |
| 10–14 | New project, New recovery code, the two recovery-code steps, Interrupted changes | screen: Library | passed |
| 15 | Set this aside | screen: AuditLog | passed |
| 16–18 | Add a watched folder, Download and import, Stop watching | screen: WatchedFolders | passed |
| 19 | Use your browser session? | screen: Capture | passed |
| 20 | Undo the import | screen: StepReport | passed |
| 21 | Reviewed after the withdrawal | screen: ReviewQueue | passed |
| 22–24 | Colour menu, Delete this note?, Discard this note? | the AnnotationList component | passed |
| 25–26 | Highlights here (OverlapMenu), Highlight toolbar | hosted (see below) | passed |
| 27 | Citation styles list | the CitePanel component | passed |
| 28 | Delete old copy (with confirm) | screen: MoveLibrary | **failed (body), mended**: Progress heading |
| 29 | Record a reason (a loosening; with confirm) | screen: GovernanceSettings | passed (focus back on the field) |
| 30 | Destroy raw data (with confirm) | screen: GovernanceSettings | **failed (body), mended**: Destruction certificate heading |
| 31 | Reset the list of paired browsers? (with confirm) | screen: ExtensionPairing | passed (Paired browsers heading) |
| 32 | Revoke this browser? (with confirm) | screen: ExtensionPairing | passed (Paired browsers heading) |
| 33 | Delete participant (with confirm) | screen: Fieldwork | **failed (body), mended**: Participants heading |
| 34 | Delete the session (with confirm) | screen: Fieldwork | passed (Sessions heading) |
| 35 | Withdraw consent (with confirm) | screen: Fieldwork | **failed (body), mended**: Consent records heading |
| 36 | Reset the list of added fonts? (with confirm) | screen: AppearanceSettings | passed (Your own font files heading) |
| 37 | Reset appearance settings? (with confirm) | screen: AppearanceSettings | passed (Appearance heading) |
| 38 | Choose the work (with confirm) | screen: FindAcquire queue row | passed (the row's "Open" button) |
| 39 | Choose the person | screen: FindAcquire queue row | passed. The confirm path is covered in FindAcquire.test ("This is the person…") |
| 40 | Choose the works | screen: FindAcquire queue row | passed. The confirm path is covered in FindAcquire.test ("Choose works: ticked works sent…") |
| 41 | A field's evidence (with confirm) | screen: SourceDetail badge | passed (the badge as it now reads) |
| 42 | A field's evidence | screen: the project's ReviewQueue, a capture's conflict | passed |

In total, 42 rows, and 15 dialogs and popovers that open from a real screen are now opened from it. That covers all the call sites `grep` finds (MoveLibrary:361, GovernanceSettings:476 and :1164, ExtensionPairing:585 and :597, Fieldwork:452, :472 and :513, AppearanceSettings:230 and :516, FindAcquire:2263, :2273 and :2284, ReviewQueue:1106, SourceDetail:481). The table found **4 faults**, all now mended. No other popover exists (`aria-haspopup` appears only on the badge and the colour menu). Every row opens its dialog with a click, so R376 c is untouched.

**Not opened from the real screen:** OverlapMenu and the highlight toolbar. Their real opener is a press on a page that pdf.js draws in the reader, and pdf.js does not run in jsdom. They are opened from their own components, as before.

## The exact sentences
- File changed (R462 a), the player's one sentence: "The recording stopped: its file is no longer as the app stored it — it was changed outside the app, or it is damaged — so it cannot be played from here. Check the verification report."
- Destroyed by the app while playing (M3), the transcript viewer's existing sentence: "This source has no recording to play. Its transcript is shown below."
- Cut off (M6): "The library service's answer was cut off before it finished." Unchanged from R462.
- First-use banner (M7): "Downloading contacts the servers that host each tool (the catalogue does not name them)."
- Models folder (M8, the worker's message): "the folder that holds the speech models could not be read, so the <name> model could not be used; check that the folder can be read, then try again".

## Notes for the coordinator (no ruling needed, but please confirm)
- **M4:** the client has no usual time limit; `client.ts` has none. I used 10 s (`REVOKE_WAIT_MS`), because a revoke is one call to the local service. The app's other waits for an answer are 60 s (FindAcquire, WhereToGetIt). Say if 60 s is wanted.
- **M1:** a file whose header is changed *before* a ticket is asked for is refused when the ticket is asked for. The player then says "The recording could not be opened. An encrypted file could not be read (damaged, or made with another key)." That is the service's own sentence for any encrypted file that fails. Only a change found while playing gets R462's sentence.
- **M3:** a renewal asked for *while* a destruction is running could, in a narrow window, get a ticket for a file being overwritten. The tickets that exist are ended first, and every later read finds the asset destroyed. Only the service route destroys raw data; the CLI does not, so it has no other path.
- **Reader screen (M6):** `Reader.tsx` still shows its own "unreachable" state for any status-0 failure, a cut-off included. The client now gives the right code and sentence, but that screen's mapping was outside the point.

## What only a real browser or Mac can show
- WebKit's event order after a long pause (I1). The test drives `play`/`seeking`/`error` by hand.
- Whether WebKit focuses or blurs on a press on a scrollbar (M10). jsdom cannot press a scrollbar; the test cancels `mousedown` and blurs into the list instead.
- A real destruction while WebKit's media element streams (M3). The service half runs on a real socket.
- Focus fix-up when a focused button becomes disabled (Destroy raw data). jsdom keeps focus on it; browsers move it to the body. Either way, the heading now takes focus.

## Runs (each at `nice -n 10`)
- Touched test files: `TranscriptViewer.test.tsx` 65 passed; `client.test.ts` 39 passed; `CitePanel.test.tsx` plus the table 32 passed; `FirstUseTools` plus `ToolsSetup` 53 passed; the table plus `MoveLibrary`, `GovernanceSettings` and `Fieldwork` 153 passed; `media.test.ts` plus `fieldwork-governance.test.ts` 55 passed.
- `pnpm --filter @ao/ui test`: `Test Files … | Tests 26 failed | 2264 passed (2290)`. No failure was in a file this round touched; all were time limits under load (PdfPages ×15 cascading after its first time-out, ChooseWorksDialog 200-works timing, client.test SSE linear-time, colourScan, ReviewQueue "six at a time", Library.reader, Reader.find, LibraryNotFound, Capture unmount, FindAcquire copy retry). Re-run alone, the ten files together: all passed except PdfPages, which passed alone (`Tests 17 passed (17)`). This round changed nothing under `src/reader`.
- `pnpm --filter @ao/library-service test`: `Test Files 1 failed | 44 passed (45)`, `Tests 1 failed | 1091 passed | 2 skipped (1094)`. The one failure is the known `find-browser-routes.test.ts` "the pause after a hand-over…" (being mended by another agent, untouched here).
- Media helper: this worktree has no venv, so the main checkout's venv ran against this worktree's code (`-p no:cacheprovider`). `tests/test_transcribe.py` 6 passed, 3 skipped. Not-slow suite: `190 passed, 1 skipped, 9 deselected`.
- `pnpm -r typecheck`: every package Done.
- `lint:css` clean. `lint:colours`: "ok: no hard-coded colours". `run build`: "✓ built in 33.08s".
- `git status --short`: empty.
