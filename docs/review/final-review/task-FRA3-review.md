# FR-A3 review — NOT APPROVED (Important 2, Minor 3)

Worktree agent-a6ee131b0cb253cae, head 7e29380. Findings written as found.

## Findings

### I1 (Important) — a held Enter, or Enter twice, on a field badge decides the conflict unseen (the dialog's confirm is a deciding control and is not guarded)
- Where: `packages/ui/src/components/VerificationBadge.tsx:89-110` (FieldCheck) opens `FieldEvidencePopover.tsx` (a modal on `DialogShell`, whose trap focuses the FIRST focusable, `ReasonDialog.tsx:17`): in a conflict that is the first radio — the value already recorded, already picked (`FieldEvidencePopover.tsx:139`). Enter on a radio inside a form submits it implicitly through "Confirm this value" (`:248`).
- The report leaves the badges unguarded because "they open a dialog; no decision without a further act". The further act is the second Enter or the key's repeat — exactly what R313 b / R362 d forbid.
- Probe (scratch `ProjectReviewQueue.probeFRA3.test.tsx`, user-event, the capture entry "Entry 3" with a title conflict): badge focused, `{Enter>4}{/Enter}` → `PATCH /projects/P1/sources/s3/fields` sent with `{"field":"/title","value":…"Entry 3"}` (the recorded value; the dialog was never read); `{Enter}{Enter}` → the same PATCH. In real browsers Blink's and WebKit's `InputType::shouldSubmitImplicitly` submit a form on Enter's keypress in a radio, and a held key's repeats deliver keypresses to the newly focused radio — so the same is expected there (not run in a browser).
- Why it matters: R362 d names the panel for "a field changed on both sides" — and the report itself says such a field "is decided through FieldCheck's dialog". So the dialog's confirm is that kind's deciding control; for a capture entry, confirming its last field resolves the entry (R176 1). A held key decides it, unseen.
- Direction: give the dialog's confirm the guard of a held key (a repeated keydown in the dialog never submits; the first keydown after it opened counts only if it went down inside the dialog), or open it with focus on its heading/the evidence rather than on a control that submits; and a test: held Enter / Enter twice on a badge sends no PATCH.

### Point 1 — the lift (checked line by line)
Old `ReviewQueue.tsx` (claude/pdf-reader-highlights) vs `pressGuard.ts` + new `ReviewQueue.tsx`: constants (600, 1, 250), the three sentences, the Pointing watch (window capture pointermove/scroll, client-coordinate movement, first move not a movement), the quiet (max of now+600), the verdict order (place first and starting no quiet; then quiet, renewed), the per-control half (seen on a real mouse movement with the scroll count; still for touch/pen measured after every render and at pointerdown; pointerdown matched to the click; a key resets the pointerdown; held Enter/Space cancelled, Space's keyup), `decideHeld`'s order (ended/unlisted → busy card renews quiet → verdict) — all the same. The only change in behaviour: the ref deletes a key on unmount instead of storing null (measure returns false either way). Found files' unit tests: NOT changed (the diff of the two test files touches only panel presses and two focus expectations). `e2e/find-copies.spec.ts`: helpers moved to `e2e/press.ts` verbatim apart from a parameter (checked below).

Mutations of `pressGuard.ts` (each alone, the two queue test files; baseline 127 passed):
| mutation | fails | panel test fails? |
|---|---|---|
| place check gives "ok" | 22 | yes (1) |
| held key not cancelled | 2 | yes (1) |
| quiet ignored | 10 | yes (1) |
| DECIDE_SETTLE_MS = 0 | 12 | yes |
| scroll settle (250 ms) removed | 2 | no |
| same-spot check removed | 3 | no |
| touch stillness removed | 2 | no |
| pointermove without real movement counts | 4 | no |
| **a press swallowed by the quiet does not renew it (R318 b)** | **0** | no |
| **a scroll no longer forgets the places seen (R323 a)** | **0** | no |
| **the panel's `forgetOn` (list changed → places forgotten) removed** | **0** | no |
| **a click with pointerType "mouse" and no pointerdown taken** | **0** | no |
| **a key not clearing a stale pointerdown** | **0** | no |
The first two bold rows were equally untested on the OLD code (same mutation of the old `ReviewQueue.tsx` with the old tests: 122 passed) — a pre-existing gap, not caused by the lift.

### M1 (Minor) — five guards no test holds, in either section
See the bold rows above. R318 b's renewal by a swallowed press and R323 a's "a scroll forgets" are rulings' guards; the panel's `forgetOn` is this task's own (only reachable when the list is re-read while the same entry stays shown, since `ItemPanel` is keyed by the entry and remounts). Direction: one test each (a press inside the quiet at 500 ms, then a key press at 700 ms from the first is still refused; a real move, a scroll, >250 ms, a press → refused; a re-read under a resting pointer → a press refused). The FR-C2 test task may take them.

I1, real engines (scratch Playwright script, plain page `<form><input type=radio checked><button type=submit>`): Chromium AND WebKit — focus on the radio, `keyboard.down("Enter")` twice (the second with repeat set) → `keydown, keypress, click(submit button, pointerType ""), SUBMIT` for EACH, the repeat included. So in both engines a held Enter / a second Enter on a radio submits the evidence dialog; I1 holds where the product runs.

### Pointer-less activation (keyboard, VoiceOver, Switch Control)
Same scratch script: `element.click()` (WebKit's and Blink's simulated click, the path an accessibility "press" takes) arrives as a `PointerEvent` with `pointerType ""` and no `pointerdown` before it, in both engines; a keyboard Enter on a button likewise (`pointerType ""`). `usePressGuard.check` (pressGuard.ts:217-233) takes exactly that as a key's press ("ok"), subject only to the quiet. So a keyboard user and — by every sign short of a real Mac — a VoiceOver or Switch Control user can still decide an entry in the panel, as in the found files (R322 a: "the keyboard is as built"; the comment at pressGuard.ts:159-161 says a click with no pointerdown is "the click a key (or an assistive tool) makes"). Not verified with VoiceOver itself: if a future WebKit sent such a click with `pointerType "mouse"`, `check` would answer "moved" and the press would be refused with "move the pointer" (pressGuard.ts:230) — in both sections; nothing in the repository tests that branch (M1's fourth bold row).

### I2 (Important) — a pause pressed after the renewal's metadata but before its seek lands is kept only for that renewal: the NEXT renewal starts the recording by itself
- Where: `packages/ui/src/components/MediaTicketPlayer.tsx:216-246`. At `loadedmetadata` (`onMetadata`, :240-246) `wantPlay = pending.play` is copied ONCE. `pending` lives on until `seeked` (:207-211). A researcher's pause in that window goes to `onPause`'s pending branch (:229-232: srcSet and playedSince are both true, because the player's own `play()` fired `play`) and sets only `pending.play = false`; `wantPlay` stays true. When `seeked` clears `pending`, the element is paused but `wantPlay` is true; the next ticket expiry (`onError`, :189-190, `play = wantPlay`) resumes it PLAYING.
- Probe (scratch copy of TranscriptViewer.test.tsx, the file's own helpers): play → 4.25 → error → new src → browser's pause → loadedmetadata (play() called) → `play` → **researcher's pause** → seeked at 4.25 → (paused) error → new src → browser's pause → loadedmetadata ⇒ `play() calls after the paused renewal: 1`. The recording starts by itself, aloud — R362 f's own harm, one step later.
- The window is the seek's landing after a renewal (a range read on the local service: short, but the moment the player visibly resumes is exactly when a researcher who has just been interrupted reaches for pause). The old code had the same hole (it ignored every pause while pending); the task's rewrite of `onPause` was the place to close it.
- Direction: when `pending.seekIssued` is set, a pause/play by the researcher updates `wantPlay` as well (or `onTimeUpdate` copies `pending.play` into `wantPlay` when it clears `pending`); a test exactly as the probe.

### M2 (Minor) — a seek made just before an expiry is lost
- `onSeeking` (:233-239) acts only while a renewal is pending. A seek the researcher makes while playing, with the ticket expiring before the seek lands (the seek's own range read is what meets the expired ticket — a likely moment), resumes at the last REPORTED time: probe ⇒ "resumed at: 4.25" after a seek to 30. Pre-existing; the same family as R362 f's "seeking keeps the place asked". Direction: `onSeeking` with no `pending` records `position = el.currentTime` (the target).

### M3 (Minor) — the WebKit rhythm scenarios cannot fail
`e2e/review-queue.spec.ts` (new D28 scenarios): by the report's own BEFORE table, WebKit decided ONE entry at every rhythm on the old code, and both engines decided one for the two Enter rhythms (old focus went to the row's "Show"). So in WebKit, where the product runs, and for every key rhythm, the scenarios pass with or without the guard; only Chromium's 150/400/700 ms clicks show D28. What does show the guard in WebKit: the last step of each scenario (a deliberate press after a real movement IS taken — no over-refusal), and the engine-neutral unit tests. The cause of WebKit's old "1" was not established (I did not run the old code in WebKit). Direction: find out why (likely the next entry's Accept is disabled or elsewhere until its record is read in WebKit), and add a WebKit press that reproduces D28 on the old code — or record in the spec that WebKit's proof is the no-over-refusal step only.

## Point 1 — plain statement
**Every guard of the found files' section is still in force, unchanged** (constants 600 / 1 px / 250 ms; the three sentences word for word; place → quiet order; held key; touch stillness; focus to the next waiting card's heading; the busy card's renewal of the quiet). The found files' unit tests and their end-to-end assertions are untouched (`find-copies.spec.ts` lost only the helper, moved verbatim to `e2e/press.ts`, its 60 s timeout the same). Five guards are held by no test (M1); two of them were already untested before.

## Points 2 and 3 — plain statements
- **Can a decision still land on an entry the researcher has not seen?** Not through the panel's own deciding controls: Accept, Skip, Keep both, Merge into the likely duplicate, each Use this match, Save and accept (click and Enter's implicit submit), each Merge into result — all guarded; `ItemPanel` is keyed by the entry, so the next entry's controls are new and have no place seen; a busy request disables them; the bulk bar only edits (type/tag/collection), it decides nothing; there is no shortcut. **But yes through the field badges' dialog (I1):** a held Enter or Enter twice on a conflict's badge confirms the recorded value without the dialog being read. The withdrawal's "Reviewed…" dialog needs a typed reason: safe.
- **Can a person without a pointer still decide?** Yes: Tab + Enter/Space decides once per press (a click with `pointerType ""` and no pointerdown is taken), focus after a decision goes to the next entry's heading (h3, tabIndex -1), with none left to the found files' heading or the "Nothing is waiting" message. VoiceOver/Switch Control: their press is, in both engines, a simulated click of the same kind (`element.click()` probe: `pointerType ""`), so taken — not verified on a Mac.
- **7e29380** is honest: Playwright's `.click()` produces one pointermove, the first the screen sees, which by R323 a is no movement; a person's hand produces many. It hides no way of pressing a real person uses, other than a mouse press on a control the pointer never moved over since the list changed — which R322 a refuses on purpose, in both sections.

## Spec table (R362)
| clause | built | note |
|---|---|---|
| d — panel's deciding controls get the found files' guards | partly | all panel controls guarded, shared code faithful; the dialog's confirm (a conflict's decision) is not (I1) |
| d — probed in both real browsers at every rhythm | partly | done; WebKit cannot show the defect (M3) |
| f — a pause during a renewal is kept; play/seek kept | partly | the three asked cases built and tested; a pause in the renewal's seek window is lost for the next renewal (I2) |
| h — the note, exactly the sentence, aria-describedby, only when encrypted; the guide | yes | CollectionTree (create, rename), TagList (create; project and workspace rename), Fieldwork (new consent's Scope, edited consent's scope); `project.encrypted` from ProjectSummary, no new request; guide `docs/first-run.md:75`. I found no other field (SourceDetail has no tag field; import/watched folders choose existing ones; withdrawal/participants are not in h) |
| scope / house rules | yes | only `packages/ui`, `e2e/`, the guide; no dependency; no innerHTML; `UserText` for titles; tokens (`lint:colours` ok, `lint:css` exit 0) |

## Runs (nice -n 10, foreground)
- ReviewQueue + ProjectReviewQueue + TranscriptViewer + ReadableNameNote: `Test Files 4 passed (4) · Tests 190 passed (190)`.
- Mutations: table above (each reverted; the old-code runs restored by `git checkout`).
- Probes: ProjectReviewQueue badge probe (I1), TranscriptViewer player probe (I2, M2), a Playwright script on a plain page in Chromium and WebKit (I1, pointer-less). All scratch files removed.
- Not run: the end-to-end specs (the report's runs stand: 12 D28 scenarios passed; I relied on reading).

## Checked and sound
- `pressVerdict`, `usePointing`, `useQuiet`, `usePressGuard` vs the old inline code; `decideHeld` order unchanged.
- The panel: quiet held on `leave` and on a re-read during the visit; not at opening (the report's minor — the place rule covers it); the reserved note line under the controls (nothing moves); `aria-describedby` on every deciding control; said once in the polite region with "entry".
- The player: the browser's own pause after the new `src` is not taken (srcSet set synchronously after `el.src =`, the load algorithm's pause is queued later); two renewals in a row carry `pending.play`; a failed renewal halts with `stopped` from `pending`; the three new tests and the old 53 pass.
- Point 3's tests pin the exact sentences as literals (not the constants).

## Could not verify
- A real Mac/WebKit web view; VoiceOver and Switch Control's actual events; a real recording's renewal (no e2e drives one); whether WebKit fires `pause` on the media error itself (would end a renewal paused — the safe side); why old WebKit decided one entry at every rhythm.

## Verdicts
- Spec compliance (R362 d, f, h): **not fully met** — d (I1), f (I2); h met.
- Quality: **Needs fixes** — Important 2 (I1, I2), Minor 3 (M1, M2, M3), Critical 0.
