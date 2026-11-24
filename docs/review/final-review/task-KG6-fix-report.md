# KG-6 fix round report (Ruling R511: M1–M6)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-6`, branch `kg-6-shell`, from 17ba47b. Head **0a17de2**. Not pushed.

Commits, one per point:
- e10b54b: M1, Q's skip still checks that SIGTERM ends the app
- 81f561f: M2, a skip of Q reads as a skip; one closing line says whether Q ran
- 3761ad9: M5, `AO_SHELL_QUIT_HOOK installed|not installed`, and Q names a hook that was not installed
- f947a7e: M6, Q runs the Mac crash diagnosis when the shell ends at the quit without its line, or by a signal
- d9a0dae: M4, the waiting open's test answers within 60 s or fails
- 0a17de2: M3 (FR-734 point 1), an open that waits for another open's window fetches nothing from that window's page

M7 and M8 were not built, as the brief says.

## Per point

| Point | What changed (file:line, at 0a17de2) | Its test, and that it failed first |
| --- | --- | --- |
| **M1** | `apps/desktop/scripts/launch-check.mjs`: new pure `SIGTERM_STOP_LIMIT_MS` (:226), `sigtermStopProblems` (:232), `skippedQuitVerdict` (:248) and `printedAfterEvent` (:254). New `stopBySigterm` (:1171) is B's code, moved out of B's loop. It sends SIGTERM, waits up to 120 s for the exit, reports "an orderly stop", prints the closing-window note and runs `assertGone`. B now calls it (:1386). Q's `skip` calls the same function (:1548). The skip stands only when that stop passed; otherwise Q FAILS with `skippedQuitVerdict`'s sentence. The note says what the shell printed after the event: its output lines since the event, and the characters on its standard error, both captured before SIGTERM. The not-running skip (before any event) also gets B's checks. **B is slightly stricter**: it now also fails when the shell does not end within 120 s. Before, only the clean-stop line was asserted. README updated. | Three new unit tests in `launch-check.test.mjs` (suite "scenario Q"): <br>- `sigtermStopProblems` (ended and clean / time-out / forced); <br>- `skippedQuitVerdict`: no answer + clean SIGTERM stop → `{skip}`; no answer + the shell does not end → `{problem: "the app neither answered the quit Apple event nor ended cleanly on SIGTERM afterwards: it may hang at the quit (…)"}`; `{check}` and `{problem}` returned unchanged ("as today"); <br>- `printedAfterEvent`. <br>They failed first: the module did not provide the exports (SyntaxError on import). |
| **M2** | `launch-check.mjs`: `quitSkipLine` (:206) and `quitSummaryLine` (:215). Each Q run records its outcome (passed, failed or skipped); the second run, after a skip, is `skip … for the reason above`. The closing line is printed after the scenarios, before `all checks passed` / `FAILED` (:1609), on a Mac only. On Linux the existing `skip Q (quit by Apple event): …exists only on macOS` line is unchanged. README updated. | Two new tests: the skip line's prefix; the closing line for every case (ran, skipped, skipped in part, failed, failed after a skip, no run). They failed first (missing export). |
| **M5** | `apps/desktop/src-tauri/src/lib.rs:451-467`: `let hook = quit::install(…)`. Then, under `#[cfg(debug_assertions)] if test_mode()`, `println!("AO_SHELL_QUIT_HOOK {installed|not installed}")`, followed by `let _ = hook;`. All of this is inside the existing `#[cfg(target_os = "macos")]` block. `launch-check.mjs`: `parseShellLine` reads it (:93). `orderlyQuitProblems` (:272-278) uses it in two ways: <br>- if the quit line is missing and the hook was not installed, it gives the specific sentence instead of the generic one; <br>- a missing hook line is itself a problem. <br>The ok line's detail now says `quit hook installed`. README updated. | <br>- `library_window.rs` `a_release_build_has_neither_the_sign_in_windows_probe_nor_its_switch` is extended (:5440-5445): debug `lib.rs` has `AO_SHELL_QUIT_HOOK`, the release text does not. It FAILED first ("the debug build says whether the quit hook was installed"). <br>- In JS: new `parseShellLine` cases, and a new test "names a quit hook that was not installed…". Both failed first (2 failures). <br>- **Existing test fixture changed:** in `orderlyQuitProblems`'s tests, the `ORDERLY` events and the three "names a quit that skipped…" inputs now include the hook line `{kind: "quit-hook", installed: true}`, because a missing hook line is now a problem. No assertion was removed or loosened. <br>- The Mac lines type-check for aarch64-apple-darwin with no warning. |
| **M6** | `launch-check.mjs`: `quitCrashSuspected` (:266). Q's check path (:1583-1587) runs `diagnoseMacCrash(run, { debug: true })` before `orderlyQuitProblems` when the shell ended without an `AO_SHELL_QUIT` line, or by a signal. The exit is now passed as `exit.code ?? exit.signal`, where before it showed `null` after a signal. | New test (orderly end → no; no quit line → yes; signal → yes; time-out → no; exit 1 with the line → no). It failed first (missing export). |
| **M4** | `library_window.rs` tests: `open_during_a_build` returns a `SecondOpen` (:3808), a channel that the second open's thread sends its answer to. `answer()` waits with `recv_timeout(60 s)` (:3814) and fails the test with "the waiting open never answered within a minute (its wake-up was lost)". The five FR-734 call sites use `second.answer()` instead of `second.join().unwrap()`. | **Proved with a scratch edit, then restored:** I removed `self.built.notify_all()` on the success path (the `still_its_own` block). `cargo test … -- a_late_success a_second_open an_open_that an_open_closed` then FAILED in 60.18 s (3 failed, 2 passed), each with the time-limit message. The two that passed: one test's build fails, and the failure path's wake-up is still there; in the other, timing let the waiter find the build already answered. The line was restored; `git diff` showed no change before the commit. |
| **M3** | `library_window.rs`: `Inner.waiting: Option<String>` (:1447). Every open that takes the ticket sets it, to its ticket if it waits, otherwise to None (:1574). It is cleared when the waiting open builds the window itself (:1615), and once its `navigate` to its own address has succeeded (:1629). `page_loaded` (:1759) and `download_requested` (:1795) start no fetch while `Self::waiting` (:1770) holds, i.e. the open ticket is the waiting open's. Doc comments on `open`, `page_loaded` and `download_requested` say so. Ownership, tickets and owners are untouched (R472, R489, R491 B). `take_pdf`, the researcher's explicit take, is unchanged. | The reviewer's probe, as `a_page_of_the_window_an_open_waits_for_is_never_fetched_under_that_open_s_ticket` (:3938): <br>- while the second open waits, the first open's page `…/1.pdf` loads and a download is asked for; <br>- afterwards: no job and no `Fetching` event; the first open answers false, the second true; navigated to `START2`; <br>- the second open's own PDF is then fetched under TICKET2. <br>It FAILED first exactly as the probe did: `left: [("fedcba98…", "https://publisher.example/article/1.pdf")]`. A guard test, `an_open_that_built_the_window_after_waiting_fetches_its_own_page` (:3965), passes before and after: a waiting open that builds the window itself is not held. |

**M3 residue, by reading the real host.** The model's `navigate` is synchronous. tauri's `navigate` from the command's thread posts a message to the main thread and returns. So a page-load "finished" event of the first open's page, queued on the main thread before that message, could still arrive after the hold ends. That window is the time between the post and the main thread taking it, microseconds, and WebKit cancels the old load when the new navigation starts.

I chose to end the hold at the navigation, not at a later "the page at my own address" event. The open's own address often redirects (a proxy login, `doi.org`), so an exact-address release would leave a redirected open with no automatic fetch for the whole life of its ticket. I judged that worse.

## The exact launch-check lines (a Mac)

**Q ran and passed** (for each label `Q (quit by Apple event)` and `Q (quit by Apple event during a slowed quit)`; the window, page and worker lines from `upAndProbed` come first, as before):
```
launch-check: ok   Q (quit by Apple event): the quit went the orderly way: the helpers stop cleanly and the shell exits 0 (quit hook installed; osascript answered)
launch-check: note Q (quit by Apple event): the helpers stopped within two seconds: no closing window was shown
launch-check: ok   Q (quit by Apple event): no helper process is left
launch-check: ok   Q (quit by Apple event during a slowed quit): the quit went the orderly way: … (quit hook installed; osascript …)
launch-check: ok   Q (quit by Apple event during a slowed quit): the closing window "Closing Alexandrine Oxiana" was shown two seconds after the quit, while the helpers ran
launch-check: ok   Q (quit by Apple event during a slowed quit): no helper process is left
launch-check: ok   no process of the app is left at the end
launch-check: Q ran: 2 of 2 runs quit the app by Apple event and were checked
launch-check: all checks passed
```
(`osascript said execution error: … (-128)` in place of `osascript answered` is expected too.)

**Q skipped.** B's checks on the SIGTERM stop come first, then the skip:
```
launch-check: ok   Q (quit by Apple event), stopped by SIGTERM instead: an orderly stop (exit 0, stop clean)
launch-check: note Q (quit by Apple event), stopped by SIGTERM instead: the helpers stopped within two seconds: no closing window was shown
launch-check: ok   Q (quit by Apple event), stopped by SIGTERM instead: no helper process is left
launch-check: skip Q (quit by Apple event): osascript had no answer within 30 s (a request for permission to control the app may be waiting on the runner's screen); the shell printed nothing after the event was sent
launch-check: skip Q (quit by Apple event during a slowed quit): for the reason above
…
launch-check: Q SKIPPED (osascript had no answer within 30 s (…); the shell printed nothing after the event was sent): the Mac's own Quit was not checked
launch-check: all checks passed
```
If the first run ran and only the slowed one skipped: `launch-check: Q SKIPPED in part (1 of 2 runs checked; Q (quit by Apple event during a slowed quit): <reason>)`.

**Q failed**, for example an app hung at the quit:
```
launch-check: FAIL Q (quit by Apple event), stopped by SIGTERM instead: an orderly stop (exit timeout, stop not reported: the shell did not end within 120 s of SIGTERM; the helpers were not reported stopped)
launch-check: FAIL Q (quit by Apple event): the app ended after the quit could not be judged (the app neither answered the quit Apple event nor ended cleanly on SIGTERM afterwards: it may hang at the quit (osascript had no answer within 30 s (…); the shell printed nothing after the event was sent; …))
…
launch-check: Q FAILED (Q (quit by Apple event)): see its FAIL lines above
launch-check: FAILED (N problems)
```
Other failures use the same closing line, `Q FAILED (…)`:
- `FAIL Q (…): the app took the quit (… neither took the quit nor exited)`;
- `FAIL Q (…): the quit went the orderly way: … (<problems>)`.

**The hook's installation:**
- Installed: the ok line's detail starts `quit hook installed;`.
- Not installed: AppKit then ends the app at once. First the crash diagnosis runs (M6): `launch-check: Q (quit by Apple event): the shell exited (exit 0); what macOS can say follows (Task MAC5)`, then its blocks. Then:
  `launch-check: FAIL Q (quit by Apple event): the quit went the orderly way: the helpers stop cleanly and the shell exits 0 (the shell's quit hook was not installed (AO_SHELL_QUIT_HOOK not installed): without it the quit cannot go the orderly way; the orderly close never began (no AO_SHELL_CLOSING line); the helpers were not reported stopped)`
- No hook line at all: the FAIL detail includes `the shell did not say whether its quit hook was installed (no AO_SHELL_QUIT_HOOK line)`.

**On Linux**, unchanged: `launch-check: skip Q (quit by Apple event): the Mac's own Quit (Cmd-Q, the Dock's Quit, a quit Apple event) exists only on macOS`. There is no closing line. B's line now reads `ok   B (shell stopped with SIGTERM): an orderly stop (xvfb-run exit 0, stop clean)`, as before; it fails only if the shell does not end within 120 s.

## For the Mac build to watch (the whole of KG-6 as it now is)

The step is "Launch check A-D"; its name is stale, as it runs A–F and Q.
1. **The closing line (updated by N2, R514).** `grep "launch-check: scenario Q result:"` finds exactly one line, on every path of a Mac run:
   - `launch-check: scenario Q result: ran (2 of 2 runs quit the app by Apple event and were checked)`: FR-731 was proved by the Apple event;
   - `launch-check: scenario Q result: SKIPPED (<reason>): the Mac's own Quit was not checked`, or `… SKIPPED in part (Q (quit by Apple event) ran and was checked; Q (quit by Apple event during a slowed quit): <reason>)`: it was not, and a skip also proved that the app ends cleanly on SIGTERM after the event;
   - `launch-check: scenario Q result: FAILED (<labels, or label: it did not finish: <error>>): see its FAIL lines above`;
   - `launch-check: scenario Q result: not reached (the check ended before scenario Q: <the error's first line>)`.
   The `launch-check: Q …` lines of the first fix round's closing line no longer exist (the sections above show them as they were; the R514 section below gives the lines that replace them).
2. **The hook was installed.** The ok line's detail says `quit hook installed`. If it does not, read the FAIL line: `not installed` means `class_addMethod` refused, or the delegate was missing. That is a tao/AppKit change, and a finding for the code.
3. No `the quit did not reach the shell's quit handler` with `quit hook installed`. That combination would mean AppKit does not consult a method added at run time: the one unknown by reading (R511).
4. **No crash diagnosis block in Q.** If one appears (`the shell exited (…); what macOS can say follows`), the shell ended at the quit without its line, or by a signal: read the crash report and backtrace.
5. **B's "an orderly stop" still passes on the Mac.** It now also requires the shell to end within 120 s, as R already did for the release app.
6. **The step's duration.** About A–F plus 2 minutes. A skip adds up to 120 s of SIGTERM wait only when the app hangs. A crash diagnosis adds up to about 2–3 minutes, only on failure.
7. The rest is unchanged from the first report: E is skipped on a Mac; F's known `at_quit` > 2 s risk applies to Q's slowed run as it does to F; `-128` in osascript's detail is expected.
8. **FR-734 (sign-in window)** has nothing in the launch check beyond A's single open. The owner's check: open a source's sign-in window and, while it is still appearing, open another (for example "Test" on Your library). One window appears, at the second address, and no PDF from the first page is taken for the second row.

**On a real Mac (the owner)**, unchanged from the review's list:
- Cmd-Q, the menu's Quit and the Dock's Quit each go the orderly way (closing window if busy; quits once);
- Cmd-Q again while closing changes nothing;
- the closing window's red button changes nothing;
- logout and restart end the app at once, without "interrupted logout" (R505 e, decision 30);
- the standard menu is intact.

## NEEDS A RULING

None (R514 ruled on the M3 choice below; see "Last points"). One choice was made within the brief and is stated under M3, for the reviewer to judge: the hold ends when the waiting open's own navigation has been sent, not at an exact-address match, so that a redirected address still auto-fetches.

## Runs (last line of each)

- `cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib`, shared target: `test result: ok. 142 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out` (140 before, plus the 2 M3 tests).
- `CC_aarch64_apple_darwin=clang-18 AR_aarch64_apple_darwin=llvm-ar-18 cargo check --locked … --target aarch64-apple-darwin --tests`: `Finished dev profile`, no warning (after M5, and again after M3).
- `node --test apps/desktop/scripts/launch-check.test.mjs`: `# tests 64`, `# pass 64`, `# fail 0` (57 before).
- M4 scratch proof (notify removed, then restored): `test result: FAILED. 2 passed; 3 failed; … finished in 60.18s`.
- Not run, as the brief says: `build:linux`, the launch check itself, any end-to-end run. Nothing was refused by a permission check. No `git stash`. Not pushed.
- `git status --short`: empty.

## Last points (R514)

Head **9704f93**. Two commits on `kg-6-shell` after 0a17de2:
- edb3690: N1
- 9704f93: N2

**N1 (M3): the hold now ends on the main thread, as the navigation is issued.**
- **The host.** `Host::navigate(url, issued)` takes a step to run once the navigation is issued (`library_window.rs`, the trait). `TauriHost::navigate` posts ONE task with `run_on_main_thread`, or runs it at once when it is already on the main thread. That task calls `WebviewWindow::navigate`, which on the main thread is issued in that same turn (tauri-runtime-wry 2.12.3 `send_user_message` → `load_url`). It then runs `issued` and sends the result back. The waiting open waits for that answer; a loop that is gone drops the task, and the answer is false.
- **The release.** `Library::open` passes `issued` as a closure that ends the waiting open's hold, if that open still holds it (`waiting == own ticket`). To let it do that, `Library.inner` is now `Arc<Mutex<Inner>>`. The closure takes the controller's lock only inside itself. No lock is held across the host call or across a wait, and the closure calls nothing of the host. The waiting open answers as before.
- **What remains, as the comment says.** An event the web view would deliver for the OLD page after the navigation was issued. By reading WebKit's documented behaviour, a new navigation cancels the old load, which then never reports "finished". This cannot be shown here.
- **The test.** The reviewer's probe is `an_old_page_s_event_before_the_waiting_open_s_navigation_is_issued_starts_no_fetch`. `FakeHost` can now hold a posted navigation un-issued (`defer_issue`, `issue()`), as the real host's main thread does. Between "posted" and "issued", the old page's `page_loaded` (a PDF) and `download_requested` start no fetch; after `issue()`, the open's own PDF is fetched under TICKET2. It FAILED first, with the old release kept and the new signature in place: `left: [("fedcba98…", "https://publisher.example/article/1.pdf")]`, the probe's own result. All other tests are unchanged and pass.

**N2 (M2): one line, printed on every path, with a prefix of its own.**
- **Where.** `quitSummaryLine(outcomes, {reached, error})` in `launch-check.mjs`. It is now printed from `main`'s outer `finally`, after the end-of-check process line, on a Mac only.
- **When something throws.** A scenario that throws is caught there, kept as `ended` and thrown on. A Q run that throws is recorded as `failed` with `it did not finish: <message>`, never as passed. If the check ends before Q, the line is `not reached`.
- **The prefix** `launch-check: scenario Q result:` is written once in the script, and a test asserts that. The crash-diagnosis line (`launch-check: Q (…): the shell exited …`) no longer matches the search.
- **The tests.** The M2 closing-line test was rewritten for the new words. It covers ran, skipped, skipped in part, failed, failed after a skip, a run that threw, Q throwing before a run, not reached (with and without the error), and uniqueness. It failed first (1 failure) before the change.

**The exact lines (a Mac):**
```
launch-check: scenario Q result: ran (2 of 2 runs quit the app by Apple event and were checked)
launch-check: scenario Q result: SKIPPED (osascript had no answer within 30 s (…); the shell printed nothing after the event was sent): the Mac's own Quit was not checked
launch-check: scenario Q result: SKIPPED in part (Q (quit by Apple event) ran and was checked; Q (quit by Apple event during a slowed quit): <reason>)
launch-check: scenario Q result: FAILED (Q (quit by Apple event)): see its FAIL lines above
launch-check: scenario Q result: FAILED (Q (quit by Apple event): it did not finish: timed out after 180 s waiting for the page's probe): see its FAIL lines above
launch-check: scenario Q result: FAILED (scenario Q did not finish: <error>)
launch-check: scenario Q result: not reached (the check ended before scenario Q: <first line of the error>)
```
On Linux nothing changes: Q's own skip line, and no closing line.

**Runs:**
- `cargo test --locked --lib`, shared target: `test result: ok. 143 passed; 0 failed`.
- The Mac type-check with `CC_/AR_aarch64_apple_darwin`: `Finished dev profile`, no warning.
- `node --test apps/desktop/scripts/launch-check.test.mjs`: `# tests 64`, `# pass 64`, `# fail 0`.
- `git status --short`: empty.
- Not pushed. No `git stash`. Nothing was refused.
