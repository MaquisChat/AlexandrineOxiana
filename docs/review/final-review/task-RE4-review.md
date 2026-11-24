# Review — batch RE-4 (dialogs and focus, the media player, the optional tools)

Worktree `.claude/worktrees/re-4-dialogs-player`, branch `re-4-dialogs-player`, 567d98d..d04061f (9 commits). Reviewer: adversarial re-review (R460 round). Ruling R462 read in full.

**Verdict: APPROVE WITH SMALL POINTS.** Two Important points should be fixed or ruled on before the merge: FR-260 is only half closed, and the R145 table leaves out the real screens that open the shared dialogs (one of them drops focus onto the page body). Neither involves data, privacy or governance. Everything else holds.

## What I ran (each alone, at `nice -n 10`; every probe deleted; `git status --short` is empty)
- `dialogs.r145.test.tsx` as built: 27 passed.
- The guards for FR-234/601 taken out (CitePanel, HighlightToolbar and PendingWritesDialog put back to 567d98d): rows 14, 25 and 27 fail, and 24 pass. Restored with `git checkout --`.
- The FR-203 fix taken out (DialogShell's layout effect turned into a passive effect): rows 1–3 fail. Restored.
- `MediaTicketPlayer.tsx` put back to 567d98d: the three new player tests (FR-259, FR-260, FR-218/219) all fail. Restored.
- `media.test.ts -t FR-217`: 2 passed. With `t.fileChanged = true` taken out, both fail. Restored.
- Probes:
  - `TranscriptViewer.probeRE4.test.tsx`: FR-260 with the true order of events; a revoke that never answers; a revoke that answers 500.
  - `media.probeRE4.test.ts`: the header changed while a ticket is live; a chunk changed, then 10 idle minutes; an unencrypted recording changed; the revoke without a token; the log lines.
  - `MoveLibrary.probeRE4.test.tsx`: where focus lands after "Delete old copy".
- FR-254: this worktree has no venv (`services/media-worker/.venv` is missing), so as the dispatch says I judged it **by reading only**.

## Findings

### Critical
None.

### Important

**I1 — FR-260 is closed only when the element fails while it is still idle. The common order still gives "may be damaged".** `packages/ui/src/components/MediaTicketPlayer.tsx:263` (`onPlay` → `active()`), `:280` (`onSeeking` → `active()`) and `:210`.
- When a researcher comes back after a long pause, they press play or click a segment. The element fires `play` or `seeking` first, then reads with the expired ticket, then fires `error`.
- `active()` has just reset `lastActivity`, so `idleExpiry` is false and the failure counts as a strike.
- Probe: three rounds at 50 s, 50.8 s and 51.5 s, each "pause, 11 minutes, `play`, `error`". The alert read "The recording could not be played: it stopped at the same place again. Its file may be damaged or in a format this app cannot play. You can choose Try the recording again."
- The new test fires `error` without a `play` before it, so it covers only the order in which the element errors while still paused. That happens when the service's sweep cuts a connection the browser kept open. The failure after a press of play is just as likely, and in WebKit it may be the usual one.
- Direction: measure idleness from activity that comes from the element only (`timeupdate`, `progress`, a new `src`). Or, when `play` or `seeking` arrives after more than `MEDIA_TICKET_IDLE_MS` of silence, remember that the ticket has probably expired, so the next failure is a renewal. Add the probe's order to the test.
- Answers to the attack questions:
  - It cannot loop. A new `src` resets `lastActivity`, so a second failure without 10 idle minutes is a strike.
  - A real failure is skipped only when 10 idle minutes come before every failure.
  - `progress` and `timeupdate` are fair as activity.

**I2 — FR-234/601: the table opens the shared dialogs only in a test host, never from the screens that use them. One of those screens loses focus to the page body.**
- The file header (`packages/ui/src/dialogs.r145.test.tsx:2-4`) says each dialog is "opened from the control a researcher uses". In fact rows 1–7 (ReasonDialog, ConfirmDialog, ChoiceDialog, ReasonOptionalDialog, ChoosePerson, ChooseWork, ChooseWorks) are mounted under a stand-in `Opener`.
- These real call sites are in no row:
  - `MoveLibrary.tsx:361` (Delete old copy)
  - `GovernanceSettings.tsx:476` (Record a reason) and `:1164` (Destroy raw data)
  - `ExtensionPairing.tsx:585` and `:597`
  - `Fieldwork.tsx:452`, `:472` and `:513`
  - `AppearanceSettings.tsx:230` and `:516`
  - `FindAcquire.tsx:2263`, `:2273` and `:2284`
  - `FieldCheck` in `ReviewQueue.tsx:1106` and in `SourceDetail.tsx:481`
- Only one row (FirstUseTools) tests the case "the opener is gone when the dialog closes".
- Probe: in MoveLibrary, after "Delete old copy" is confirmed, `document.activeElement === document.body`. `deleteOld()` sets `stage = "deleted"` in the same render as the dialog closes (`MoveLibrary.tsx:205-207`). The opener is removed, and `useTrap` gives focus back to a detached button. `MoveLibrary.test.tsx` has no focus assertion at all.
- The same is likely, by reading, for "Destroy raw data" (`GovernanceSettings.tsx:1085-1087`). `load()` refreshes `due`, and the opener can be disabled when focus comes back. `GovernanceSettings.test` has one `activeElement` assertion.
- Direction:
  - Add rows that open each of these from its real screen, including the confirm path where the opener disappears.
  - Give MoveLibrary (and GovernanceSettings, if the probe confirms it) a named fallback: the status line "The old copy was deleted", or the section's heading.
  - Reword the test's header so it claims only what the test does.

### Minor

**M1 — FR-217/219: a change to the file's header is never marked.** `apps/library-service/src/media.ts:376-381`.
- `openAssetContent` parses the header, and checks the length, before `sendContent` runs. If that throws `EncryptionFormatError` (bad magic, version or chunk size, or a file replaced by a plain copy) or a length `DecryptionError`, `serve` revokes the ticket in its `catch`. The `failed` hook is never reached.
- Probe S1 (byte 0 changed with a ticket live): the GET answers 409, the revoke answers `{"revoked":false}` with no code, and the next ticket request answers 409 "An encrypted file could not be read (damaged, or made with another key)."
- The player then shows "The recording stopped and could not be started again. An encrypted file could not be read (damaged, or made with another key)." That is a third wording of the same fact, and not R462's sentence. It does at least not retry into "may be damaged".
- Direction: mark the ticket before that revoke for those two error classes. Or have the ticket refusal carry the same code, so the player says R462's sentence.

**M2 — FR-217: the mark is lost if the ticket is swept first.**
- Probe S2: a chunk was changed and the GET answered 409. After 10 idle minutes the revoke answers `{"revoked":false}`, because `sweep()` deleted the ticket together with its `fileChanged`.
- The player recovers on the next ticket: it reads the bad chunk again, so the code comes on the second round. But that costs one extra renewal and can count as a strike.
- Direction: keep a short-lived record of the ticket digests that ended because the file changed, or exempt marked tickets from the idle sweep until they are revoked.

**M3 — FR-217: the code can be wrong when the app itself destroys the file.**
- Raw-data destruction overwrites the file in place (`packages/library/src/fs/shred.ts:19-25`, `r+`). The route `governance.ts:215-235` does not end the media tickets of the destroyed assets.
- If a recording is streaming while it is destroyed (for example from the CLI, or from another window), the read fails its chunk check. The ticket is marked `FILE_CHANGED`, and the player says the file was changed outside the app (even in R462's wording, "changed outside the app, or damaged"). Neither is true: the app destroyed it on the researcher's order.
- This is a narrow case, judged by reading. The gap is older (tickets outlive destruction); the new code turns it into a false sentence.
- Direction: the destroy route ends the tickets of those assets (the same `MediaTickets` hook as `revokeProject`), before it shreds.

**M4 — FR-217: the player now waits for the revoke before it renews, with no time limit.** `MediaTicketPlayer.tsx:230-244`.
- Probe: when the revoke never answers, the player stays on "Reconnecting the recording…" for good, and no new ticket is asked for. The ticket request could already hang in the same way, so this adds a second wait in the chain rather than a new class of hang.
- A revoke answering 500 renews as before (probe passed).
- Direction: give the revoke a short time limit, and renew if it runs out.

**M5 — FR-218 wording.** `MediaTicketPlayer.tsx:90` says the recording "cannot be played from here" but offers "Try the recording again" (`retry: true`, `:242`). Choose one: drop the button for this message, or say what a retry can do. This is noted for the R462 rewording round.

**M6 — FR-350: the same rough edge stands in the two sibling readers.**
- `client.ts` `byteRange()` (`:531-533`, `throw unreachable()` after a 206 header) still says a PDF range that broke part-way "could not be reached", and `Reader.tsx:180` and `routes/reader.tsx:97` treat it as unreachable.
- The NDJSON reader's `reader.read()` rejection (`:352`) is also still `unreachable()`. The move screen depends on that (`isStreamCutOff`, which uses UNAVAILABLE plus `started`), so changing it needs care.
- This is out of the entry's literal scope (`bytes()`), so it is a note. Also, "The library service's answer was cut off before it finished." gives no next step (for example "Try again."). Under the round's wording rule it should.

**M7 — FR-291: "publisher" stays in two sentences for the same fact.** `api/tools.ts:92` (`PUBLISHER_SERVERS`, the line for each tool) and `FirstUseTools.tsx:329` ("Downloading contacts each tool's publisher's servers…") still say "publisher" when the catalogue names no hosts. The new general sentence on the same screen says "the servers that host the tool". That is two wordings on one screen, and the per-tool one has the looseness the entry names (a model hosted by a third party). The implementer kept it on purpose; R462 (b) accepted only the general sentence.

**M8 — FR-254 (by reading): the next step may not be possible in the case its own test exercises.** `test_unreadable_models_folder…` makes the models folder a plain file. "remove it and install it again from the Optional tools screen" assumes the screen can remove that model, but a model the app cannot read is likely not detected as installed, so no Remove button would appear. The "could not be loaded" case (damaged weights) fits the sentence. Direction: say the next step for the case where the folder cannot be read (for example "restart the app; if it happens again, install the model again from the Optional tools screen"), or confirm that the screen offers Remove there.

**M9 — test quality.** `media.test.ts` (the new mid-stream test) polls `activeStreams()` with `setTimeout(20)` up to 100 times and goes on either way. The mark is set before the cut, so the wait is not needed. It is a sleep-and-retry that the round's rule forbids, though harmless here.

**M10 — CitePanel `onBlur` (could not verify).** The `<ul class="ao-listbox">` scrolls (`max-height: 14rem; overflow-y: auto`), and only the `<li>` elements cancel `mousedown`. In a browser that focuses a scroller or blurs on a press on its scrollbar (Chrome's keyboard-focusable scrollers), dragging the list's scrollbar would close the list. jsdom cannot show this; check it in WebKit.

## FR-217/218/219 — the attack questions answered
- **Can the code be wrong?**
  - Only `DecryptionError` and `EncryptionFormatError` from a read of this ticket's own asset set it. A ticket is tied to one asset, and the player's effect asks for a new ticket when the asset changes, so a ticket reused for another file is not possible.
  - A broken NETWORK read cannot set it: those errors are raised by the server's own disk read and decryption.
  - The false cases are M3 (destroyed by the app) and, for the wording, R462's point: the service cannot tell a person's change from damage.
- **A plain (unencrypted) recording:** nothing is detected (probe S3: 206, `{"revoked":true}`). The player shows the changed bytes, or retries into "may be damaged". This is the limit R462 accepted.
- **A path or anything of the file in the answer or the logs?** No. The revoke answers `{revoked, ended?: "FILE_CHANGED"}`. `logFailure` logs `{code, when}` only. Probe S2: the logs contain neither the temporary folder nor the ticket.
- **Who can call the revoke?** Only the UI caller: no token gives 401 (probe), another caller gives 403 (`media.ts:342`). It answers only for a ticket the caller presents (256 random bits).
- **What the player does on the code:**
  - It stops at once, with no new ticket (the test checks `tickets.length === 1`).
  - It keeps the position: `halt` stores `pending.at`, and Try again resumes there.
  - It offers Try again (M5).
- **A second player on the same recording:** it has its own ticket, which is marked only when that player reads the bad chunk. It is unaffected until then.

## R462 — every place the sentences are shown
- **"…changed outside the app…" (to be reworded):**
  - `packages/ui/src/components/MediaTicketPlayer.tsx:90` (`CHANGED`, shown at `:242`);
  - asserted verbatim in `packages/ui/src/screens/TranscriptViewer.test.tsx:569`.
  - Comments only (not shown): `MediaTicketPlayer.tsx:17`, `packages/shared/src/api/media.ts:58`, and `apps/library-service/src/media.ts:17`, `:78` and `:345`. Doc comment `msw-transcripts.ts:121`.
- **"…may be damaged or in a format this app cannot play…":**
  - `MediaTicketPlayer.tsx:216`. The tests match only `/The recording could not be played/` and `/may be damaged/` (`TranscriptViewer.test.tsx:536`, `:559` and `:570`), so it has no verbatim test.
- **A third wording of the same fact,** shown by the player when the header changes (M1): the service's `errors.ts:155` "An encrypted file could not be read (damaged, or made with another key).", wrapped by `refusal()` at `MediaTicketPlayer.tsx:98`.
- **Unrelated "may be damaged" sentences, kept as they are:** `TranscriptViewer.tsx:100` and `:102`, `api/capture.ts:242` and `:243`.

## FR-234/601 — the mended three, keyboard paths beyond the test
- **PendingWritesDialog:**
  - Shift+Tab from the first button, from the heading and from the alert wraps to the last control. Tab from the last wraps to the first.
  - The "Close" button is always enabled, so `items` is never empty, and dropping `[tabindex='-1']` from the trap removed no case.
  - Escape while a resolve request is out closes the dialog (no busy guard). That is older behaviour: the request finishes, governed, and `onResolved` refreshes the list.
- **OverlapMenu:** Tab and Escape both prevent the default action and close the menu. `useFocusReturn` gives focus back to whatever had it.
- **CitePanel:**
  - Tab closes the list. A mouse choice still works (each `li` cancels `mousedown`). See M10.
- **R376 c / R377 (FR-A9):** intact. The banner's buttons only moved: "Choose tools…" still opens the dialog on click, and no dialog's key handling changed except the trap in PendingWrites.
- The test's `inert`-refusal harness is sound. Moving focus into an inert element is recorded, and `refused == []` is asserted on every row; with the guards removed it caught all three.

## Table

| FR | Implementer's claim | Verdict | Note |
|---|---|---|---|
| 203 | closed by Task 34e | holds | Inert is removed in a layout cleanup, and focus is restored in a passive cleanup. Turning the layout effect back into a passive effect makes rows 1–3 fail. |
| 234, 601 | 27-row table; 3 fixed | partly | The three fixes hold, and their guards are tested. The list is incomplete: about 14 real screen call sites are missing, and MoveLibrary drops focus to the page body (I2). |
| 259 | `playing` after the seek ends the wait | holds | No harm when `playing` comes before `seeked`: currentTime already reads the target. A paused resume whose seek never lands still waits, until the researcher plays. |
| 260 | no strike after an idle expiry | partly | A press of play or a seek just before the failure resets the idle clock (I1). |
| 261 | closed by Task 62 | holds | Status 0 reads the job, then shows "could not be reached". "may still be going" no longer exists. |
| 266 | closed by Task 63 | holds | `Capture.tsx:90`; `Capture.test.tsx:161` checks that "queued" appears once. |
| 291 | general sentence reworded | holds | "publisher" remains in the per-tool line and in the first-use banner (M7). |
| 315 | navigate to `?tool=<first>` | holds | Every tool offered at first use has a heading on the tools screen. A retry after a partial failure uses the remaining tools. |
| 316 | live region holds only the sentence | holds | The live region is always present, and the sentence is outside it once announced. The CSS classes carried over. |
| 217, 218, 219 | ticket marked; the revoke answers a code | holds (mechanism) | Marked only mid-read (M1 header, M2 sweep, M3 destroy); the revoke waits with no time limit (M4); no path anywhere. |
| 350 | `bytes()` says cut off | holds | "Could not be reached" is still said when the fetch fails. The siblings `byteRange` and NDJSON are unchanged (M6). |
| 254 | next step added (worker) | holds, by reading | The next step may not fit the unreadable-folder case (M8). |

## Judged by reading only
- FR-254: no venv in this worktree.
- WebKit's event order after a long pause (it bears on I1), and the scrollbar press (M10).
- The likely focus loss after "Destroy raw data" (I2).
- M3, raw-data destruction while a recording streams.
- Whether the verification report actually lists an encrypted recording whose chunk check fails, as the new sentence promises.
- FR-350's guard: the test asserts the new sentence, and the old code produced the "unreachable" one.
