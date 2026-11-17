# Task FR-A3 — report (R362 d, f, h)

Branch `worktree-agent-a6ee131b0cb253cae`, head `7e29380`. Based on `claude/pdf-reader-highlights` (f7da5a6); the reader branch merged in at the end (`a5896e4`, `git merge --no-ff`, no conflict; it touched only apps/desktop and the plan).
Commits: `4ff6be9` point 1 · `bf19a8f` point 2 · `c2c3b7d` point 3 · `a5896e4` merge · `7e29380` point 1 follow-up (two older e2e scenarios press as a researcher does; see "Expectations changed").
Disk: 5.8 GB free at the start (13 GB after the restart).

## Point 1 (R362 d, D28) — the panel's deciding controls get the found files' guards

**Lifted into shared code:** `packages/ui/src/screens/import/pressGuard.ts` (new): `DECIDE_SETTLE_MS`, `PRESS_PLACE_TOLERANCE_PX`, `SCROLL_SETTLE_MS`, `PRESS_SHOWN_TEXT` (moved from ReviewQueue.tsx unchanged, and re-exported from it), `usePointing()` (the window pointermove/scroll watch, was inline), `useQuiet()` (the quiet: hold/active, was `quietUntil`/`holdQuiet`), `pressVerdict()` (the place-then-quiet decision that `decideHeld` made inline), and `usePressGuard()` — the per-control half (seen place on a real pointer movement, stillness for touch/pen, pointerdown matching, held-key cancelling) that was inside `FileCard`. FileCard now uses it (ReviewQueue.tsx:1418); `decideHeld` uses `pressVerdict` (:782). Nothing of the found files' behaviour changed — their 100+ tests pass untouched.

**Controls guarded (ItemPanel, the panel for import entries: an import's doubts, a field changed on both sides, a file added by hand):** Accept, Skip, Keep both, Merge into the likely duplicate, each candidate's "Use this match", "Save and accept" (its click, also the implicit one from Enter in the title; a press not taken prevents the submit), each search result's "Merge into …". `usePressGuard(pointing, epoch)` in ItemPanel (:1768), with `epoch` = the list, so the places seen are forgotten whenever the list changes; `admitPanel` (:773) applies `pressVerdict` with the panel's own quiet.
**Not guarded, as they are:** Edit and Merge (they open a form, decide nothing); in VerificationPanel "Reviewed after the withdrawal…" (opens a dialog that needs a typed reason) and the field badges of a capture (FieldCheck: open the evidence dialog; the value is confirmed inside it). No control named "keep mine / take theirs / set aside / dismiss" exists in the panel; a field changed on both sides is decided through FieldCheck's dialog.
**Quiet:** the panel's own (`panelQuiet`, DECIDE_SETTLE_MS), held when an entry leaves (`leave`, :594), when the queue is read again during the visit (:485), and by a press it swallows. Not at the screen's opening (the place rule covers the pointer there; focus is not on a deciding control).
**Focus after a decision:** the next entry's heading — the record's title, now an `h3.ao-review__title` with tabIndex -1 (was a `p` of the same class) in both panels; while that record is read, the panel's own heading (Section's h2, now always focusable), and focus moves on to the title when it comes (`panelHeadRef`, :332). With no entry left beside the panel: the found files' heading while files wait, else the "Nothing is waiting" message (the found files' rule).
**Press not taken:** shown under the panel's controls in a reserved line (`ao-review__file-note`, so its coming moves nothing), tied to every deciding control by aria-describedby, said once in the polite region; cleared when the pointer moves over the panel. Sentences added (pressGuard.ts, beside the existing ones):
- "Not taken. Look at the entry, then move the pointer and press again."
- "Not taken: the page had just moved. Look at the entry, then tap again."
- "Not taken: the list had just changed. Look at the entry, then press again."

**Unit tests** (ReviewQueue.test.tsx, describe "R362 d (D28)…"), all five seen to fail first against the old code for the right reason: two presses at one spot decide ONE entry; a second press after the next entry slid in is not taken and says why (panel + polite region, aria-describedby), then taken after a movement; a key press inside the quiet is not taken and says so, then taken; Enter held decides one; focus goes to the next entry's heading, the heading decides nothing, and after the last to the "Nothing is waiting" message.

**Real browsers** — `e2e/review-queue.spec.ts`, six scenarios × Chromium and WebKit, each on its own queue of four entries attached by hand; the first press is a researcher's (`pressByMouse`, lifted to `e2e/press.ts`, find-copies.spec.ts imports it), then the rhythm without moving the pointer for ~3 s; the service's queue is read: exactly the first entry decided, the other three still waiting; for the key rhythms the next entry's heading has focus; then a deliberate press decides the next entry.

| rhythm | Chromium BEFORE | WebKit BEFORE | Chromium AFTER | WebKit AFTER |
|---|---|---|---|---|
| double click on Accept | 1 | 1 | 1 | 1 |
| click every 150 ms | **4 (all)** | 1 | 1 | 1 |
| click every 400 ms | **3** | 1 | 1 | 1 |
| click every 700 ms | **2** | 1 | 1 | 1 |
| Enter held 1 s | 1 | 1 | 1 | 1 |
| Enter ×3 quickly | 1 | 1 | 1 | 1 |

(BEFORE run: the same scenarios against f7da5a6, output kept in scratchpad `e2e-old.txt`.) In WebKit the old code decided one entry at every rhythm in this probe; why WebKit's presses at a resting point did not fall on the next entry's Accept was not established (the defect is shown in Chromium). By key the old code also decided one (focus went to the next row's "Show" button, not a deciding control).

## Point 2 (R362 f) — a recording never starts by itself

`packages/ui/src/components/MediaTicketPlayer.tsx`: the resume in progress (`Pending`) now records whether the new `src` was set (:184) and whether the researcher pressed play since. Until the new `src` is set every pause, play and seek the element reports is the researcher's: `onPause` (:226) keeps a pause (`pending.play = false`), `onPlay` keeps a play, the new `onSeeking` (:233) keeps the place asked (`pending.at`). After the new `src`, a pause is the browser's own (the source changed) unless the researcher pressed play since. At metadata `wantPlay = pending.play` (:244); `play()` only when it is true, and an element found playing when it is false is paused.
Tests (TranscriptViewer.test.tsx, the player's tests live there), each seen to fail first: playing → ticket ends → pause during the renewal (+ the browser's own pause after the new src) → lands at 4.25, PAUSED, `play()` not called (old: called once); paused → play during the renewal → plays when it lands (old: not played); seek during the renewal → resumes at 30 (old: 4.25). The existing player tests untouched and green (56/56).

## Point 3 (R362 h) — the note where a name stays readable

`packages/ui/src/components/ReadableNameNote.tsx` (new): `useReadableNote(encrypted, text)` gives `describedBy` for the field and the note element; nothing at all when the project is not encrypted. Sentences:
- "In an encrypted project this name can be read without the passphrase. Do not put a person's name in it."
- "In an encrypted project this text can be read without the passphrase. Do not put a person's name in it." (consent scope)

Fields (each tested encrypted and not):
1. CollectionTree — new collection's name and a collection renamed (one input, `CollectionTree.tsx:60`).
2. TagList — new tag's name (:134), a project tag renamed and a workspace tag renamed (TagRow, :45).
3. Fieldwork — the new consent's "Scope" (:90) and an edited consent's "Scope of this consent" (ConsentEditor, :65).
How the screens know: the project's own `encrypted` flag (ProjectSummary, the one ProjectNav's Locked badge and the lock/unlock controls use; no new request): Library.tsx passes `project.encrypted` to CollectionTree and TagList (:745 and the TagList beside it); routes/governance.tsx passes `encrypted: project?.encrypted === true` in the route context to Fieldwork (:120).
No tag editor on a source exists (SourceDetail has no tag field; the review queue's bulk "Add tag"/"Move to collection" choose existing ones); the watched-folder dialog chooses a collection from a list.
Guide: `docs/first-run.md` line 75, appended: "The names of an encrypted project, its collections and its tags, and the text of a consent's scope, are not sealed: they can be read without the passphrase."
Tests, all seen to fail first in their encrypted case (the not-encrypted cases pass before and after, by design): `components/ReadableNameNote.test.tsx` (7), Fieldwork.test.tsx (2), Library.test.tsx (2, wiring), routes/governance.test.tsx (2, wiring). (The Library test's first version also had its project-list override after the shared handlers; reordered.)

## Expectations changed (only where the change makes them untrue)
- ReviewQueue.test "after a decision, focus moves to the next item": now the next item's heading (was the "Show" row button).
- ProjectReviewQueue.test, the capture entry resolved: focus now on the heading "Entry 4" (was "Show Entry 4").
- Panel presses in older unit tests (`user.click`, `user.dblClick` on Accept/Skip/Keep both/Use this match/Save and accept/Merge into …): now a press that moves the pointer onto the control (`pressPanel`), and `settle()` (the panel's 600 ms quiet) between decisions. The double-click test still asserts one request.
- e2e: review-queue.spec.ts's drag-and-drop scenario and import.spec.ts's Accept and Save and accept used Playwright's `.click()`, whose move to the control is the first pointermove the page sees (not a movement): now `pressByMouse` (commit 7e29380).

## Runs (each at nice -n 10, foreground)
- Touched UI test files (ReviewQueue, ProjectReviewQueue, TranscriptViewer, ReadableNameNote, Fieldwork, Library, routes/governance), after the merge: `Test Files 7 passed (7) · Tests 253 passed (253)`.
- `lint:css`: exit 0 (no output) · `lint:colours`: `ok: no hard-coded colours in src/**/*.ts(x)`.
- `pnpm --filter @ao/ui run build`: `✓ built in 6.14s`.
- `pnpm -r typecheck`: all Done, exit 0.
- `pnpm --filter @ao/ui test` (once, at the end): `Test Files 113 passed (113) · Tests 2091 passed (2091)`.
- `pnpm e2e -- --app-only e2e/review-queue.spec.ts e2e/find-copies.spec.ts --trace off`: `2 failed, 32 passed (5.8m)` — the two were the drag-and-drop scenario (Chromium, WebKit), made untrue by point 1 (see above); after the change, that scenario alone: `2 passed (12.6s)`. The twelve D28 scenarios on the final code: `12 passed (2.6m)`.
- import.spec.ts (also presses the panel): `6 passed (1.7m)`.
- The spec covering the media viewer: `e2e/capture.spec.ts` (scenario 9 opens the transcript viewer and its player): `8 passed (1.1m)`. No spec drives a ticket renewal in a real browser.

## What only a real Mac or VoiceOver can show
- Whether macOS's WebKit web view (the product) fires the element's `pause` on a source change before or after the app's own `src` assignment is seen — the rule assumes it comes after (spec: the load algorithm); a pause fired by the browser on the media ERROR itself would be taken as the researcher's (the renewal would end paused, never playing by itself). No e2e drives a renewal.
- VoiceOver: that the panel's heading (record title, h3, tabIndex -1) is announced on focus after a decision, and that the note under a deciding control and the readable-name note are read as the field's description.
- Why WebKit decided one entry at every rhythm with the old code here (not established).

minor (deferred): the panel's quiet is not held at the screen's opening (the place rule covers the pointer; focus is never on a deciding control there).
minor (deferred): "Reviewed after the withdrawal…" and the capture field badges are not guarded (they open dialogs; no decision without a further act).

## Round 2 (R371)

Worktree `agent-a6ee131b0cb253cae`, branch `worktree-agent-a6ee131b0cb253cae`, from 7e29380. Commits: `55d2cc1` (a) · `bc429b1` (b) · `65db7e1` (c) · `9b899a0` (d) · `7efa231` (e). Head **7efa231**. Nothing in the service or the library; no dependency.

### (a) I1 — the evidence dialog cannot be confirmed by the key that opened it
- `components/ReasonDialog.tsx:12-24, 38-41, 56-57`: `useTrap`/`DialogShell` take an optional `initialFocus` ref: focus on open goes there instead of the first field; Shift+Tab from it goes to the dialog's last control (Tab goes on natively to the first control after it). Without the option nothing changes: every other dialog's first focus and its tests untouched (ReasonDialog.test.tsx, ProjectReviewQueue's withdrawal tests, all green).
- `components/FieldEvidencePopover.tsx:18-22` (doc), `:120` (`heldAtOpen` prop), `:124` (`acts`: Enter anywhere; Space except in a text field), `:128-146` (the key guard), `:194-196`: the heading is `tabIndex={-1}` and the first focus; on the dialog's wrapper (capture phase) a keydown that is a repeat (`event.repeat`), or of a key already down (held since before opening, or down without a keyup since), has its default prevented when it is Enter/Space — so no implicit submit, no button press; a keyup of Enter/Space whose keydown the dialog never took is prevented as well. A key counts again once released.
- `components/VerificationBadge.tsx:88-128` (FieldCheck): the keys down on the badge (non-repeat keydown on the badge, deleted on keyup, cleared on the badge's blur) are handed to the popover at opening (`heldAtOpen`) — Enter opens the dialog on its keydown, so a held Enter is known to the dialog.
- Tests (each seen to FAIL on the old code first): `VerificationBadge.test.tsx:351-…` — Enter held `{Enter>4}{/Enter}` → no confirmation, focus on the heading; Enter twice → none (the second lands on the heading); keyboard path Tab → recorded value, ArrowDown → the other, Tab → "Confirm this value", Enter → ONE confirmation with the chosen value; Space chooses, Enter confirms once; a repeated keydown on a value or on Confirm is prevented (Enter and Space); a key down at opening is prevented until released, then one press confirms once; mouse double click on the badge → none; Escape from the heading closes and focus returns to the badge. The review's probe in the queue itself: `ProjectReviewQueue.test.tsx:169-…` (capture "Entry 3", title conflict): held Enter → NO `PATCH …/sources/s3/fields`; Enter twice → none, then Tab/ArrowDown/Tab/Enter → exactly ONE PATCH with the chosen title; dblclick → none. (On the old code the held and twice cases failed — focus was on the submit after submitting.)
- Expectation changed because this change makes it untrue: `VerificationBadge.test.tsx:304` "focus (R145)" — first focus is now the heading (was the first radio); it now also asserts Shift+Tab from the heading → Close, Tab → first radio, heading → Tab → first radio.
- **Dialogs a control of the review queue opens** (ReviewQueue.tsx has exactly two dialog sources; there is no set-aside dialog and no merge confirmation in the queue — Edit and Merge open inline forms, and each search result's "Merge into …" is a panel control already guarded by R362 d):
  1. The field badges' evidence dialog (FieldCheck → FieldEvidencePopover; captures' conflicts and an import entry's conflicting fields, `ReviewQueue.tsx:1106`): its default action (Enter on the pre-chosen value) decides WITHOUT typed input → given the three guards above.
  2. "Reviewed after the withdrawal…" (`WithdrawalReviewDialog`, `ReviewQueue.tsx:1574`): needs a typed reason → left as it is. Its first focus is the reason textarea (Enter there types a line break, never submits); "Record the decision" is disabled while the trimmed reason is empty and `submit` refuses it. Shown by `ProjectReviewQueue.test.tsx` "the withdrawal's dialog needs a typed reason…": Enter held on its opener → dialog open, focus in the reason, the held Enter typed only line breaks, submit disabled, a forced form submit → NO request.

### (b) I2 — the pause holds for the next renewal
- `components/MediaTicketPlayer.tsx:211-212`: when a renewal's seek lands (`seeked`, or a timeupdate at the place) and `pending` is cleared, `wantPlay = pending.play` — so a pause or play the researcher pressed between the metadata and the landing (already kept in `pending.play` by round 1's `onPause`/`onPlay`) is what the next expiry resumes with. The browser's own pause at the source change is still not taken (round 1's tests untouched, green).
- Tests `TranscriptViewer.test.tsx:266` (the review's sequence: play → 4.25 → error → new src → browser's pause → loadedmetadata → `play` → researcher's pause → seeked → error → new src → browser's pause → loadedmetadata ⇒ `play()` NOT called; failed first: 2 vs 1) and `:294` (the mirror: paused, play pressed in the window ⇒ the next renewal plays; failed first: 0 vs 1).

### (c) M2 — a seek just before an expiry keeps its place
- `MediaTicketPlayer.tsx:235-243`: `onSeeking` with no renewal pending records `position = el.currentTime` (the target asked); the pending branch is as before.
- Test `TranscriptViewer.test.tsx:320` (the probe: playing at 4.25, seek to 30, the seek's read meets the expired ticket ⇒ resumes at 30; failed first: 4.25).

### (d) M1 — the five guards, each held by a test, each proven by taking the guard out
Tests in `ReviewQueue.test.tsx`: found files (in "R322", `:1889-1990`) and the panel (in "R362 d (D28)", `:528-585`; the panel's re-read test sits in the found files' describe at `:1951`, since a re-read with the same entry shown needs a found file's give-up). Mutations of `pressGuard.ts`, each alone, the R371 tests run (baseline 9/9 pass):
| guard | mutation | fails |
|---|---|---|
| a press swallowed by the quiet renews it (R318 b) — key press at 500 ms (not taken), one at 700 ms from the quiet's start, past the first 600 ms (still not taken), one 600 ms after that (taken) | delete `quiet.hold(now)` in `pressVerdict` (:117) | 2 (found files, panel) |
| a scroll forgets the places seen (R323 a) — real move, scroll, 251 ms, press without a move: not taken; after a move taken | drop `was.scrolls === pointing.scrolls &&` (:226) | 2 (found files, panel) |
| the panel forgets its places on a re-read under a resting pointer — Accept moved over, a found file's decision given up (60 s) ⇒ queue read again, same entry shown, quiet passed, press without a move: not taken ("…move the pointer…"); after a move taken | delete `seen.current = {}` in the `forgetOn` branch (:173) | 1 (panel; the found files' cards have no `forgetOn`) |
| a click with `pointerType "mouse"` and no pointer-down: `check` answers **"moved"** — not taken, said "move the pointer"; a press with its pointer-down after a move is taken | delete `if (type === "mouse") return "moved"` (:230) | 2 (found files, panel) |
| a key press clears a stale pointer-down — pointer-down on the control, released elsewhere (no click), then Enter on it: taken | delete `down.current = null` in `onKeyDown` (:206) | 2 (found files, panel) |
No guard was found wrong; `pressGuard.ts` unchanged (restored after each mutation, `git status` clean).

### (e) M3 — why WebKit decided one entry, and a WebKit press that shows D28
Probed (temporary spec, deleted) with the OLD `ReviewQueue.tsx` (f7da5a6) swapped in and built, in both engines: after the first decision the next entry's "Accept" is enabled within ~50 ms and NOT under the resting pointer in WebKit — in Chromium it stands at the same place (364,634, 66×34), in WebKit 18 px HIGHER (364,616) because the panel above it is laid out shorter there; `pressByMouse` rests at the button's middle (y≈650.6), just below the next Accept (616–650) — `elementFromPoint` = a DIV. So WebKit's "1" was geometry, not an engine guard. Pressing 6 px below the top edge (inside both places), the old code decided ALL FOUR entries in WebKit and in Chromium.
Added to `e2e/review-queue.spec.ts`: `pressByMouseNearTop` (:302-331, `pressByMouse`'s rest-then-move-then-press with the pointer `dy` px below the top edge) and two rhythms (:345-347) "a click every 150 / 700 ms near the top edge of Accept without moving the pointer". On the old code: 4 failed (both engines × both rhythms; the service: none left waiting). On the current code: pass. The spec's header (:249-258) says what each engine proves: the middle-of-Accept rhythms prove the guard in Chromium only; the near-top rhythms in both; the last step of each scenario proves a deliberate press after a real movement is taken; the unit tests prove every rule engine-neutrally. (`e2e/press.ts` not changed.)

### Runs (nice -n 10, foreground)
- Touched UI test files (VerificationBadge, ProjectReviewQueue, TranscriptViewer, ReviewQueue) + ReasonDialog.test.tsx: `Test Files 5 passed (5) · Tests 244 passed (244)`.
- `lint:css`: exit 0 (no output) · `lint:colours`: `ok: no hard-coded colours in src/**/*.ts(x)`.
- `pnpm --filter @ao/ui run build`: `✓ built in 5.74s`.
- `pnpm -r typecheck`: all Done, exit 0 (also `@ao/e2e` typecheck).
- `pnpm --filter @ao/ui test`: `Test Files 113 passed (113) · Tests 2115 passed (2115)`.
- `pnpm e2e -- --app-only e2e/review-queue.spec.ts e2e/find-copies.spec.ts --trace off`: `38 passed (5.6m)` (34 before + the 4 new).
- `pnpm e2e -- --app-only e2e/capture.spec.ts --trace off`: `8 passed (1.0m)`.
- Old-code e2e probes (scratch outputs in the scratchpad: `fra3-probe-old.txt`, `fra3-probe-old2.txt`, `fra3-e-old.txt`); the old file swapped in and restored by `git checkout` each time.

minor (deferred): the e2e scenario 11 still opens the evidence dialog by mouse; no end-to-end run presses Enter on a badge (the unit tests and the review's plain-page probe cover the engines' implicit submit).
