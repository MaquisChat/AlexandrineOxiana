# Task RE-7d — a closing window (FR-297, R470 c), and FR-561 in the shell (R472)

Worktree `.claude/worktrees/re-7d`, branch `re-7d-find`, from 7a8f5ee. Not pushed.

| commit | what | for |
|---|---|---|
| c1994d7 | feat(ui): the closing page | FR-297 |
| **be398d6** | **fix(desktop): a late answer to an older sign-in open no longer closes a newer window** | **FR-561 (on its own)** |
| e4d7d3d | feat(desktop): the closing window in the shell | FR-297 |
| 77b491e | test(desktop): launch-check scenario F and the checks in A, B, D, E | FR-297 |

**FR-561 is be398d6 alone.** It touches only `library_window.rs` and the `close_library_window` command in `lib.rs`. It depends on nothing of FR-297: `git apply --check` of its patch onto 7a8f5ee's tree succeeds. The FR-297 commits are c1994d7, e4d7d3d and 77b491e.

## FR-561 (R472): a window is closed only on behalf of the open that made it

### What changed (`apps/desktop/src-tauri/src/library_window.rs`)
- `Inner.window_owner` holds the ticket of the open that made (or re-used) the open window.
  - `open` sets it together with `ticket`. A failed open puts it back to what it was.
  - It is kept after a hand-over, because the window stays.
  - `window_closed` clears it.
- `open_still_its_own(owner_now, ticket)` is a pure function. It is true while no other open has taken the window, and also when the window was closed meanwhile (that case answers as before).
  - `open` checks it after the window is shown. If another open took the window meanwhile, this open answers **false** and emits no `opened`.
  - So the page's handler for a late answer (`late === true`) closes nothing. This covers both a newer start and the window that "Test" on Your library opened. In the real shell, the newer open can get the window only after the older ticket was ended by a close (R342 b), so this is exactly the reviewer's sequence.
- `close_allowed(owner_now, asked)` is a pure function.
  - With a ticket, the close goes ahead only when that ticket's open made the window, and the ticket is well formed. A late, repeated or older close does nothing. It neither closes a window nor ends the newer ticket when there is no window.
  - Without a ticket, it closes whatever is open, as before.
- `Library::close_for(host, caller, ticket)`. `close` now delegates to it with no ticket.
- `lib.rs`: `close_library_window(ticket: Option<String>)`. A call without the argument (today's page) works as before. The permission is unchanged.

### Tests (each failed first)
I disabled the two guards for a run and put them back.
- `the_decision_which_open_the_window_open_now_belongs_to`: the pure decision. It covers a late success, a late close, the same ticket twice, a malformed ticket, and a close with no ticket.
- `a_late_success_of_an_older_open_answers_false_and_touches_the_newer_window_not`: the reviewer's case through the controller. The stand-in host runs the page's R342 b close and a newer open while the older window is being built. The older open answers false, and only the newer `opened` is emitted. The newer ticket's fetch still starts. A late close for the older ticket, sent twice, closes nothing and ends nothing.
- `a_late_failure_of_an_older_open_leaves_the_newer_window_and_ticket_as_they_are`.
  - The older open's own failure was already guarded (`g.ticket == ticket`).
  - The test failed first on the late close of the older ticket.
- `after_a_hand_over_the_window_still_belongs_to_its_open_and_a_newer_one_is_not_closed_by_an_older_close`.
- In the shell, nothing else closes the window: a time-out, a failed fetch and the hand-over leave it open. Only `close_library_window`, sign-out and quit close it, and the last two are meant to close whatever is there.

### Limit, to note (not a new decision)
The page is unchanged, as instructed, and still sends **no** ticket, so every close it sends is the "no ticket" kind.
- The fix holds for the reviewer's sequence, because the overtaken open now answers false.
- One narrow race is left. The older open answers `true` while it still owns the window. Its ticketless close is then still in flight while the window is closed and a newer open takes it. With the page's ticket on that one call (`closeLibraryWindow(ticket)` in the late handler, `FindAcquire.tsx:1622`, and in `endWindow`), the shell refuses even that.
- The shell already accepts the ticket. Passing it is a one-line change on the page, for the agent correcting the page's comment.

## FR-297 (R470 c): the closing window

### What changed
- `packages/ui/closing.html` is a second page of the interface's build (`vite.config.ts`, `build.rollupOptions.input`).
  - `<title>Closing Alexandrine Oxiana</title>`, and one `<p>` with the sentence. No controls.
  - It carries the same content-security policy as `index.html`.
  - `src/closing/closing.ts` imports the token, font and base stylesheets and `closing.css`, and calls `followSystemTheme` (`closingPage.ts`). That function sets `data-theme` to light or dark from `prefers-color-scheme` and follows changes. It makes no request and uses no IPC.
  - `closing.css` uses tokens only (lint:css and lint:colours are clean).
- `apps/desktop/src-tauri/src/closing.rs` (new).
  - `LABEL` is "closing". It also defines `TITLE`, `SENTENCE`, `PAGE`, `AFTER` = 2 s, and a size of 440×160.
  - **The rule** is `due(waited, helpers_gone, start_failed) = waited >= 2 s && !helpers_gone && !start_failed`.
  - `open()` builds the window.
    - Built: `WebviewUrl::App("closing.html")`, the title, not resizable, maximizable or minimizable, centred.
    - Refused or left out: navigation outside the app's own origin, any new window, developer tools, and any initialisation script. So it gets no connection script and cannot reach the service.
    - In test mode it prints `AO_SHELL_CLOSING_WINDOW title=… visible=…`, `AO_SHELL_CLOSING_PAGE <document title>`, `AO_SHELL_CLOSING_WINDOW_CLOSED` and `…_FAILED`.
- `lib.rs`:
  - In `RunEvent::ExitRequested`, the closing thread now runs the unchanged steps on a helper thread: `at_quit`, `stop_helpers` and `empty_library_inbox`.
  - The closing thread waits on a channel for at most `closing::AFTER`. If the helpers are not gone and `due(...)` is true, it opens the window.
  - It then joins the helper thread and goes on exactly as before: `helpers_stopped`, then a relaunch or `app.exit(code)`, which takes the window with it.
  - If the stop panicked, the closing thread returns there, as it did when the stop ran on that thread. In a release build, `panic = abort` makes this moot.
  - The test command `close-closing-window` on stdin does what the window's close button does.
  - Closing the window makes the window count zero, so `ExitRequested` fires again. `closing` is already set, so the exit is prevented and nothing else happens.
- Nothing else changed: the exit code, SIGTERM and SIGINT, the second-launch hand-over, `fail()`, and the 95 s grace. The slowed-stop seam (`AO_SHELL_TEST_SLOW_STOP_MS`, debug builds with test mode only) already existed. No seam was added.
- Launch check (`apps/desktop/scripts/launch-check.mjs`):
  - It parses the new lines. Each event gets an `at` time.
  - `closingWindowProblems(events, {expect, closeAt, closedByButton})` is a pure function.
  - **Scenario F**: a 10 s slowed stop. The check closes the window, waits for the closing window and its page, closes the closing window, then requires exit 0, a clean stop, one stop, no relaunch, and no process left.
  - **D**: no closing window. **E**: the first instance showed it. **A** and **B**: a note says whether it was shown.
  - The CI step's label now says A–F.

### Tests
- `packages/ui/src/closing/closingPage.test.ts`, 7 tests (failed first: the module did not exist).
  - Title and sentence as text; no controls.
  - The only script is the theme module, and the policy is the same as `index.html`'s.
  - The script imports only the stylesheets and the theme switch, with no fetch or IPC.
  - The page is in the build config, and the theme follows light and dark.
- Shell, `closing.rs`, 3 tests.
  - The two-second rule: failed first against a stub that always said no.
  - The page has the same title and sentence, and no controls.
  - **The capability test:**
    - Every capability file names `main` only, and none names `closing`.
    - The built `gen/schemas/capabilities.json` is `main-window` alone, naming `main` only.
    - `tauri.conf.json` names `main-window` alone.
    - `open()` has no initialisation, connection or probe script and no external address.
  - This sits beside the existing `the_sign_in_window_is_granted_nothing_…`, which still passes (one capability file, `main` only).
- `launch-check.test.mjs`: parsing the new lines, and `closingWindowProblems` for every problem it names. These failed first (the import was missing).

### Launch check (Linux, xvfb; the worker from the venv `pnpm setup:py` made): **all checks passed**
- A: ok. Note: the helpers stopped within two seconds and no closing window was shown.
- B (SIGTERM): ok. Same note. C (SIGKILL): ok.
- D: ok, with no app window and no closing window. Exits non-zero.
- E: ok. The second launch handed over; the first instance showed its closing window, stopped cleanly and started again; nothing was left.
- F: ok. "Closing Alexandrine Oxiana" was shown at least two seconds after the close, while the helpers ran, with its page loaded. Closing it changed nothing. The stop was clean, exit 0, and no process was left.

I also looked at the window once by hand, with a screenshot on a private Xvfb display: the sentence centred on the light theme's `--bg`, in the bundled Goudy face.

## Runs (nice -n 10)
- `pnpm --filter @ao/ui exec vitest run src/closing`: 7 passed (7).
- `pnpm --filter @ao/ui run build`: ✓ built (`dist/closing.html` beside `index.html`). lint:css clean; lint:colours "ok: no hard-coded colours"; the UI typecheck is clean.
- `pnpm --filter @ao/desktop test`:
  - node:test: 120 passed, 0 failed.
  - vitest: 78 passed (7 files).
  - notices-targets: ok for both Mac targets.
  - cargo test: **132 passed, 0 failed**.
- `pnpm --filter @ao/desktop run build:linux`: done (debug).
- `pnpm --filter @ao/desktop run launch-check`: "launch-check: all checks passed".
- `pnpm e2e -- --desktop-only`, run without `AO_E2E_SYSTEM_SETUP`:
  - 1 passed: `desktop.e2e.ts`, including closing with nothing left.
  - **9 skipped**: every `library-window.e2e.ts` scenario, because that switch is not set. **So FR-561 has not been run against the real sign-in window scenarios here.** They need a run with `AO_E2E_SYSTEM_SETUP=1` (the coordinator's).
- `pnpm --filter @ao/ui test` and `pnpm -r typecheck`: see the end of this file.
- `apps/desktop/src-tauri/target` was deleted after the last run that needed it.

## What only a Mac build can show (FR-297)
None of this calls a Mac API; everything is Tauri's own.
- Whether the window appears in front. The app has just hidden or lost its last window and is in a prevented exit, and macOS may leave a new window of a background app behind others.
- Whether it shows in the Dock or the menu bar meanwhile.
- Whether a window built off the main thread during the prevented exit behaves. `launch()` already builds the main window this way, and that works on a Mac.
- That the red close button changes nothing.
- How the WKWebView renders the page: the bundled font, dark mode.
- Scenario F runs in the Mac launch check too (`--app`, debug), and E is skipped there as before.

## Points for the coordinator
- **The theme.** The closing page cannot reach the service, so it follows the **system's** light or dark. That is the app's default ("system"). A researcher who chose light or dark against the system, or high contrast, sees the system's theme here. Following their choice would need the main page to leave it somewhere the closing page can read, such as `localStorage`. I did not do that.
- **SIGTERM.** A SIGTERM or a logout goes through the same closing path, so a slow stop shows the window there too.
- **FR-561:** see "Limit" above. The page should pass its ticket at the late handler (one line).

## The interface suite and the typecheck (added after the runs)
- `pnpm -r typecheck`: exit 0.
- `pnpm --filter @ao/ui test`, the whole suite, at a load average of 43 on 4 cores: exit 1.
  - The failures were in `src/api/client.test.ts` ("… parsed in linear time") and `src/reader/PdfPages.test.tsx` (8 tests). These are timing tests in files this task did not touch, and both were named as load failures in the RE-7 report.
  - The log ends without vitest's summary line. The run was probably cut short; the machine reported a process killed for lack of memory during this session.
- The two files re-run alone: **Test Files 2 passed (2), Tests 52 passed (52)**.
- The new `src/closing/closingPage.test.ts`: 7 passed (7).
- **The whole interface suite needs one run on a quieter machine before it is believed.**
- `git status --short`: empty. `apps/desktop/src-tauri/target`: deleted.
