# RE-3 review: the Library screen, import, the chooser, workspace tags, Move library, capture settings

Reviewer: a fresh, adversarial reviewer. Worktree `.claude/worktrees/re-3-library-ui`, branch `re-3-library-ui`, 567d98d..987753a (12 commits, `packages/ui` only). Tracked files were edited only for a moment to take guards out (each restored with `git checkout`). The probes (`App.probeRE3.test.tsx`, `components/Parts.probeRE3.test.tsx`, `routes/governance.probeRE3.test.tsx`) are deleted. `git status --short` is empty at the end.

## Verdict: APPROVED WITH SMALL POINTS. There is one fix round, for I1 and I2.

Every item claimed as fixed removes the rough edge its entry describes, and each new test fails without its fix. Two of the changes take keyboard focus away (I1, I2). Both are small to mend and both break R145 (focus is managed and asserted through `document.activeElement`). They need mending before the batch is merged.

## What I ran (each alone, at `nice -n 10`)
- **Guards taken out, then put back:**
  - FR-151: without `written.current = undefined` (Library.tsx:497), the App test "a later change of the address's project…" fails.
  - FR-152: without `|| !listCurrent` on the button, the "Load more is off…" test fails ("expected false to be true").
  - FR-363: with `focusOnArrival={arrived}`, "focus stays where the researcher moved it…" fails and the guard test still passes.
  - FR-390: the probe below run against the 567d98d copy of `GovernanceSettings.tsx`.
- **App probe (FR-151):**
  - Back and Forward through pushed `?project=` addresses: each is followed. Source reads were `["p3","p1","p3","p1"]`, one per selection, with no second read.
  - Two `navigate()` calls in one act (to p1, then to the locked p2): the last one wins and the locked project is selected.
  - A click selection, then Back: consistent.
- **Component probe:**
  - The workspace tag rename confirmation: focus after Enter, Tab, Cancel, Rename and Escape.
  - The twisty in a read-only tree; the keyboard after it.
  - PendingWritesDialog: a resolve that succeeds, then a reload that fails.
- **Governance probe:**
  - An event stream that opens with a `library.state` snapshot, as the real `GET /events` does (routes/libraries.ts:462): requests counted.
  - FR-390: focus after Cancel in the reason dialog, by the Enter path and by the Tab path, before and after the fix.
- **Closure tests:** the MoveLibrary "finished with an error (this attempt's)", LibraryChooser "as D7" and ImportWizard "files copied / left as links" tests pass.

## Findings

### Important

**I1 (FR-165): the new rename confirmation takes focus away from the researcher. It is never focused or announced, and focus is lost again after Rename or Cancel.** `components/TagList.tsx:50-60, 107-125`.
- **What the probe showed:**
  - After `method{Enter}` in "New name for …", `document.activeElement` is `BODY`. The form that held focus is removed, and the confirmation group has no focus target and no live region.
  - Tab then goes to the first focusable element of the page (here "to read"), not to the question.
  - After a click on Cancel, focus is `BODY`. After a click on Rename, focus is `BODY`.
  - Escape in the confirmation does nothing: the group stays open.
- **Who is hurt:** a screen-reader user hears nothing about the question that now blocks the rename, and a keyboard user has to search the page for it.
- **R376 c is met, but only by accident:** a held or second Enter confirms nothing (0 calls), because focus is on `body`.
- **Direction:**
  - When the question opens, focus its text (`tabIndex -1`, the heading-first pattern of R376 c), never the Rename button.
  - After Rename or Cancel, return focus to the row's "Rename workspace tag X" button.
  - Let Escape cancel.
  - Assert all of it through `document.activeElement` (R145). The new tests click only.

**I2 (FR-390): the fix takes focus away after a cancelled reason; before the fix, focus came back.** `screens/GovernanceSettings.tsx:329, 428-430, 442`.
- **Cause:** every `ListInput` is now keyed by `cancelled`, so Cancel remounts all of them. `useTrap`'s cleanup (`ReasonDialog.tsx:21-23`) then focuses the old, detached input.
- **What the probe showed:**
  - Type in Platforms, then Enter, then Cancel. Before the fix (567d98d), focus is on the Platforms input. After the fix, it is on `BODY`.
  - Type in Platforms, then Tab (focus is on Populations), then Cancel. Before the fix, focus is on the Populations input. After the fix, it is on `BODY`.
- **Who is hurt:** a keyboard user who cancels a loosening loses their place in a long form.
- The same pattern (from review M2) already had this effect for the legal-basis field. This fix spreads it to six fields.
- **Direction:** reset the cancelled field's draft without a remount (for example, the parent passes the count and `ListInput` resets its draft in an effect). Alternatively, after a cancel, move focus to the same field again. Add `document.activeElement` to the FR-390 test.

### Minor

- **M1 (FR-389): duplicate reads.**
  - The real service opens every `/events` stream with a `library.state` snapshot. So opening the Governance form reads `GET /projects` twice and `GET /libraries` twice. The probe counted 2 and 2; the test's fake stream sends no snapshot, so it does not show this.
  - Every later `library.state` (published at 27 places, including after each rules save, an import start and review actions) costs two requests. The event already carries `mode`.
  - `routes/governance.tsx:47-93`. **Direction:** skip the first event, as other screens use `onOpen` for this, and take `mode` from the event data.
  - The implementer already notes that nothing reconnects when the stream ends.
- **M2 (FR-153, the same rough edge on a nearby path):** after a resolve that **succeeds**, `void load()` (PendingWritesDialog.tsx:205) can fail. The dialog then keeps the old list, with the resolved change still offering "Roll it back". The probe showed the alert "The library service could not be reached. The library service is not answering." with the stale button still there. The same holds for a reload because `changed` changed (line 196-198). The entry's own path (after a refusal) is closed. **Direction:** the same treatment, so a failed reload drops the list.
- **M3 (FR-412): the wording when the whole list was unreadable.**
  - The text is "the libraries it could still read are listed as before". When the whole file is unreadable (not JSON or not an array: `registry.ts:41-45`, the likeliest kind of damage), the list is empty, so the sentence suggests that some libraries are still listed.
  - The notice carries only its kind and time, so the screen cannot tell the two cases apart.
  - **Direction:** "Any libraries it could still read are listed as before." This is true in every degree of damage.
  - The old sentence remains nowhere else.
- **M4 (FR-170 a):**
  - "Collections created" and "Tags created" are rows in the table named "Items by outcome", but they are not items. A separate line, or a separate table, would read more truly.
  - The Z5 doc comment now sits above `createdRows`, not above `zoteroRows` (StepReport.tsx:96-97).
- **M5 (FR-152):**
  - The new guard in `loadMore` (`!listCurrent`, Library.tsx:431) has no test of its own. Only the `disabled` attribute is tested, and `user.click` on a disabled button is a no-op.
  - The button is now off during every reload, including the 2-second re-reads while the index rebuilds. A focused "Load more" that turns disabled loses focus in WebKit and Blink. This was already the case for `loadingMore`, but it now happens more often.
- **M6 (FR-155):** after "Try loading again", the alert and its button are removed, so focus falls to `body`. "Try saving again" behaves the same way, so this is not a regression.
- **M7 (FR-162):** the twisty's click target is 1em wide, which is under the 24 px minimum target size of WCAG 2.2 (2.5.8). Only a real WebKit can show the actual size.

## Table

| FR | Implementer's claim | Verdict | Note |
|---|---|---|---|
| 151 | fixed | holds | Back, Forward, two quick changes, a locked project and an unknown project are all followed; one source read per selection; the guard is tested |
| 152 | fixed | holds | the old offset is never asked for; the test fails without `disabled`; see M5 |
| 153 | fixed | holds (entry's path) | a nearby path stays open after a successful resolve (M2) |
| 155 | fixed | holds | the load error is kept apart from save errors; a retry that succeeds clears it; a change made meanwhile is not overwritten |
| 162 | fixed | holds | a click toggles without selecting and focuses the row (roving tabindex); still `aria-hidden`; keys unchanged (ArrowRight and Enter checked); read-only can toggle; see M7 |
| 165 | fixed | partly | the 409 wording (the service's own sentence, routes/sources.ts:378) and the reload after a failure hold; the confirmation's focus does not (I1) |
| 166/167 | closed | holds | MoveLibrary.tsx:104-108 ends on this attempt's `failed` after one status answer; the service's `failed` is in `/libraries/move/status`; tests pass |
| 170 (a) | fixed | holds | rows only when not zero; a report with no `created` is safe (`?.`); M4 |
| 170 (b) | sent back | ruled (R465 a) | not reviewed |
| 361 | closed | holds | `UserText as="h2"` (LibraryChooser.tsx:212); the D7 test passes |
| 362 | closed | holds (by reading) | StepReport takes only ids and reads `report.files` from the service |
| 363 | fixed | holds | the guard is tested. In the app, starting a run rewrites the address and remounts the wizard (routes/import.tsx:23, key = path + search), so every run was "arrived", which is how the rough edge arose; the fix covers that case |
| 389 | fixed | holds | lock, unlock and read-only are followed through `library.state`; an out-of-order answer is dropped (`live`); M1 |
| 390 | fixed | partly | the draft goes back as asked; focus is lost (I2) |
| 391 | fixed | holds | the only copy of the sentence |
| 412 | fixed | holds | M3 wording |
| 413 | sent back | the claim is right | `DELETE /projects/:id/watched-folders/:wid` (watched-folders.ts:736-760) no longer calls `startWatches`; `startWatches` runs only when the library opens (state.ts:892); add, retry and move start one folder each (`startOne`, lines 632/656/729/752). So the warning can go stale in the way RE-3 described |

## Checked and sound
- No absolute path is shown. New outside text goes through `UserText` (tag names in the confirmation). `innerHTML` is not used. The only CSS change is a `cursor` (no colours).
- **FR-165:** a failed workspace change re-reads only through the existing `refresh` (one read of each list). A PROJECT_LOCKED for the current project still goes to the unlock path.
- **FR-151:** the address is never rewritten when it already names the project (`routes/library.tsx:142`), so no extra history entries are added.

## Could only judge by reading
- **FR-389:** the real service's events on a lock taken by another device (`onLockLost` publishes, by reading).
- **FR-391:** the hint inside the real desktop app.
- **FR-162:** the cursor and target size in WebKit.
- **FR-362:** I did not re-run the D1 "open a report by its address" tests.
