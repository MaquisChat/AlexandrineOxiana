# Batch KG-6 report: Quit on a Mac, and one sign-in window at a time (FR-731, FR-734 point 1; R503 h, i)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-6`, branch `kg-6-shell`, from 579bdcd. Head **17ba47b**. Not pushed.

Commits:
- 24b8578: fix(desktop): the shell builds one sign-in window at a time (FR-734 point 1)
- d9a3921: fix(desktop): Quit on a Mac goes the orderly way (FR-731, the shell)
- 17ba47b: test(desktop): the Mac launch check quits the app by Apple event (FR-731, scenario Q)

## Items

| FR | Still present? | What changed | Its test, and whether it failed first | Note |
| --- | --- | --- | --- | --- |
| FR-731 | Yes, by reading the pinned sources (below). | New `apps/desktop/src-tauri/src/quit.rs`: `on_terminate`, plus a Mac-only `install` that adds `applicationShouldTerminate:` to tao's application delegate. Wired in `lib.rs:443-460` (`#[cfg(target_os = "macos")]`, after `build`). A quit asked by the researcher is answered `NSTerminateCancel`, and `AppHandle::exit(0)` is called: the same exit SIGTERM asks for. Test mode prints `AO_SHELL_QUIT orderly\|now`. | `quit::tests::the_researcher_s_quit_goes_the_orderly_way_and_nothing_else_changes`. It failed first against a stub (`left: Now, right: Orderly`). The Mac lines type-check for aarch64-apple-darwin. A deliberate type error in them failed that check (E0308), which shows the lines really are checked. | Answered `Now`, as before, in three cases: after the orderly exit has finished; while a failed start shows its error window; and when the system asks (the quit Apple event carries `keyAEQuitReason`, i.e. logout, restart or shutdown). See NEEDS A RULING. |
| FR-731, scenario Q | New. | `apps/desktop/scripts/launch-check.mjs`. Pure parts start at :153: `bundleIdOf`, `appleEventScripts`, `appRunningSkip`, `quitEventVerdict`, `orderlyQuitProblems`, `QUIT_EVENT_LIMIT_MS`, and `parseShellLine` now reads `AO_SHELL_QUIT`. Also a non-blocking `runCappedAsync`, and the scenario itself (:1422-, after F). README "Launch check scenarios on a Mac" now describes Q. | Seven new unit tests, plus extended `parseShellLine` cases. They failed first: the module did not provide the exports (SyntaxError on import). 57 of 57 now pass. | The scenario itself runs only on GitHub's Mac. I did not run it here. |
| FR-734 (1) | Yes. In the model, the second open built a second window while the first was still being built (`created: 2`). | `library_window.rs` `Library::open` (:1527-) and a new `built: Condvar` on `Library`. Chosen: the second open **waits**, and it takes the ticket and the window first. While another open's window is being built, the new open sets the ticket and owner as any newer open does. It then waits on the condvar until that build answers (`:1586`). The wait holds no lock and calls nothing of the host. It then re-uses the window, or builds its own if that build failed. Both answers of a build notify the condvar (`:1634`, `:1658`). If the waiting open then fails, the window goes back to the open that built it (`.or(waited)`, `:1639`). | Four new tests: `a_second_open_during_a_build_waits_for_it_and_re_uses_its_window`, `an_open_that_waited_for_a_failed_build_builds_the_window_itself`, `an_open_that_waited_and_then_failed_leaves_the_window_to_the_open_that_built_it`, `an_open_closed_while_it_waits_for_a_build_answers_false_and_touches_nothing`. All four failed on the old code, for the overlap itself (for example "a second window was built while the first was being built", left 2 right 1, and the second build starting before the first ended). Guard removal: dropping `.or(waited)` makes the third test fail. | Why waiting and not overtaking: overtaking would need the shell to close a native window that it can only reach by label, while two windows share that label. Waiting needs no change to the host. |

**Existing test changed:** `a_late_success_of_an_older_open_answers_false_and_touches_the_newer_window_not` (FR-561). It used to start the newer open on the same thread, inside the first open's build, with no window yet. That is exactly the overlap that is now removed: under the fix, that open waits for the build, so on one thread it would wait forever. It now starts the newer open on a thread of its own, as the real command does (through the shared helper `open_during_a_build`). Every assertion it had is kept, and all of them pass. No other test was changed or loosened.

## FR-731 step 1: what the pinned versions do

Versions from `apps/desktop/src-tauri/Cargo.lock`: tauri 2.12.5, tauri-runtime-wry 2.12.3, tao 0.37.2, muda 0.20.0. Paths are under `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`.

**Does the app set a menu?**
- No. `lib.rs` has no `menu` at all.
- tauri therefore installs its default menu on macOS:
  - `tauri-2.12.5/src/app.rs:1683`: `enable_macos_default_menu: true`.
  - `app.rs:2409-2414`: if no menu is set, `Menu::default`.
- Its app submenu ends with `PredefinedMenuItem::quit` (`src/menu/menu.rs:194`).

**What does the Quit item do?**
- `muda-0.20.0/src/platform_impl/macos/mod.rs:944`: `PredefinedMenuItemType::Quit => Some(sel!(terminate:))`.
- Its accelerator is Cmd-Q (`src/items/predefined.rs:669`).
- The Dock's Quit and a quit Apple event reach the same `-[NSApplication terminate:]`. That is AppKit's documented behaviour, not code in these crates.

**What does tao do on terminate?**
- tao registers only `applicationWillTerminate:` (`tao-0.37.2/src/platform_impl/macos/app_delegate.rs:61-64`). There is no `applicationShouldTerminate:`, so AppKit's default answer, "terminate now", applies.
- `application_will_terminate` (`:130-134`) calls `AppState::exit()` (`app_state.rs:271-281`), which sends `Event::LoopDestroyed` and drops the callback.

**Does tauri deliver `ExitRequested`, and honour `prevent_exit()`, on that path?**
- No. `tauri-runtime-wry-2.12.3/src/lib.rs:4131-4133`: `Event::LoopDestroyed => callback(RunEvent::Exit)`.
- tauri then runs only its Exit handling (`tauri-2.12.5/src/app.rs:1449-1456`: the callback, then `cleanup_before_exit`).
- `RunEvent::ExitRequested` is never sent on this path, so `api.prevent_exit()` cannot apply. The app's closure handles only `ExitRequested`, so it does nothing.
- AppKit then ends the process after `applicationWillTerminate:` returns. So `run_return` never returns, and neither the post-loop `stop_helpers` nor `process::exit` in `lib.rs` runs.
- Result: the helpers stop only because their standard input closes, nothing shows the closing window, and `at_quit` does not run.

**What the fix relies on:**
- `AppHandle::exit` sends `Message::RequestExit`. Its handler (`tauri-runtime-wry lib.rs:4300-4313`) calls back with `RunEvent::ExitRequested { code: Some(code) }` and sets `ControlFlow::ExitWithCode` only if the exit was not prevented. So the shell's existing quit path runs, prevention included.
- The request goes through the event loop's proxy (`lib.rs:2599-2603`), not the main-thread shortcut that panics (`:3189`). It can therefore be made from the delegate callback on the main thread.
- When the orderly exit finishes, tao ends the loop with `-[NSApplication stop:]` (`app_state.rs:402-409`), not `terminate:`. The hook is therefore not asked again. tauri's restart does not go through `terminate:` either.

**Unknown by reading:**
1. AppKit's behaviour itself, which is not in these sources:
   - that the quit Apple event and the Dock's Quit call `terminate:` and so consult `applicationShouldTerminate:`;
   - that a method added at run time with `class_addMethod` is found when AppKit asks;
   - that `currentAppleEvent` carries `keyAEQuitReason` only for system-initiated quits.
   All three are documented Apple behaviour, but none can be shown here.
2. What osascript prints when the app cancels the quit. I expect "User canceled. (-128)"; Q does not depend on it.

## FR-734 (1): the four guarantees

- **Never two windows:** an open never builds while another build is in flight.
- **Never a window nobody owns:**
  - A waiting open that fails gives the window to the open that built it.
  - A waiting open ended by a close leaves the window to its builder (R489).
  - When the build waited for fails, the waiting open builds its own window.
- **Never a newer window closed by something older:**
  - The overtaken builder answers false, and its ticketed close is refused.
  - The newer open owns the window from the moment it is accepted. So the older open's late `true` cannot arrive after the newer open has started.
- **No lock held across a wait or a host call:**
  - `Condvar::wait_while` releases the lock while it waits.
  - `window_exists()` is called with the lock released.
  - `open` runs on the command's own thread (`detached`), never on the main thread, where the build it waits for is done.

Residue, which I knowingly left as it was:
- **A page load under the waiting open's ticket.** While the second open waits, the first build's window may finish loading a page under the second open's ticket. This is the same as when a re-used window still shows its old page.
- **A narrow race, older than this work.** A build can answer between an open's `window_exists()` and its lock. The open then tries to build, and tauri refuses the duplicate label (`prepare_window` checks it), so that open answers false. There are never two windows.

## Researcher-visible sentences

None new or changed. `AO_SHELL_QUIT` is a test-mode line, and the README paragraph is for developers.

## NEEDS A RULING

**FR-731, Quit at logout, restart or shutdown.**
- When the system itself asks the app to quit, the quit Apple event carries a quit reason. The shell still answers "now", as before: the app ends at once and its helpers stop because their input closes.
- Answering "cancel" there, to go the orderly way, would make macOS report that the app interrupted the logout. The researcher would then have to log out again once the app had closed.
- Options:
  - (a) Keep it as built.
  - (b) Go the orderly way there too, accepting the interrupted logout.
  - (c) Answer "later" (`NSTerminateLater`) and reply when the helpers have gone. This keeps the logout waiting rather than cancelled, but it runs the loop in another run-loop mode and can only be proved on a Mac.
- **My recommendation: (a) for this round, and put (c) on the owner's page as a question.**
- Note: the FR-731 entry says the window's close and "a system shutdown" take the orderly path. By reading, a system shutdown goes through the same `terminate:` and has never taken it.

## What only a real Mac can show

**What Q will show when it passes**, in the "Launch check A-D" step of `desktop-macos.yml`. The step names A–D, but the script runs A–F, and now Q too.
- `launch-check: ok   Q (quit by Apple event): the window exists and is visible`, and the page-probe and worker lines (from `upAndProbed`, as in F);
- `launch-check: ok   Q (quit by Apple event): the quit went the orderly way: the helpers stop cleanly and the shell exits 0 (osascript …)`;
- `launch-check: note Q (quit by Apple event): the helpers stopped within two seconds: no closing window was shown`, or a note that it was shown;
- `launch-check: ok   Q (quit by Apple event): no helper process is left`;
- for the second run, the same lines with label `Q (quit by Apple event during a slowed quit)`, plus `launch-check: ok   Q (quit by Apple event during a slowed quit): the closing window "Closing Alexandrine Oxiana" was shown two seconds after the quit, while the helpers ran`;
- finally `launch-check: all checks passed`.

**If Q was skipped instead:** the lines read `launch-check: note Q (…): not checked: <reason>` and then `note Q (… during a slowed quit): skipped, for the reason above`. The run can still pass, so the coordinator must read whether Q ran or was skipped.

**What could make Q fail on GitHub's Mac though the app is right, and the guard for each:**
1. **Automation permission.** osascript may be refused or prompt for consent. `-1743` / "not authorized" counts as a skip with a note. No answer within 30 s (for example a consent dialog waiting on the runner's screen) also counts as a skip with a note, and the app is then stopped with SIGTERM.
2. **The app not known under its bundle id.** The check runs the program inside the bundle directly, so LaunchServices might not know it by bundle id. Q first asks `application id "…" is running`, which sends no event and launches nothing. "false", `-600`, `-10814`, `-1728` and a missing osascript all count as a skip with a note. Q never sends `quit` to an app it has not seen running, so it cannot launch a second copy.
3. **The orderly quit reached but slow.** Q waits 20 s for `AO_SHELL_QUIT` after osascript returns, and 150 s for the exit (the 95 s grace and the slowed stop fit inside). osascript runs without blocking, so the shell's output pipes are drained meanwhile.
4. **The debug build's objc2 encoding check.** The quit-reason read could panic if an encoding were wrong. It is wrapped in `catch_unwind`, and a failure counts as the researcher's quit, so the app does not crash and the quit still goes the orderly way.
5. **F's known Mac risk applies to Q's slowed run unchanged.** If `at_quit` takes more than 2 s on the Mac, the closing window opens before `AO_SHELL_CLOSING` and "opened before the close began" is reported. That would be a false FAIL; F would fail the same way. I did not relax it, so that Q stays as strict as F.
6. **The step's 20-minute limit.** Q adds two app starts, plus about 10 s of slowed stop.

**What Q will not have shown:**
- a real Cmd-Q keystroke or the menu item;
- the Dock's Quit;
- Cmd-Q pressed while the closing window is up;
- logout, restart or shutdown;
- what the researcher sees.

The quit Apple event goes through the same `terminate:` and `applicationShouldTerminate:`, but the keystroke path through the menu is not exercised. **The owner's hands-on Cmd-Q stays the last word.**

**For the Mac build to watch:**
- Q ran rather than being skipped, and if skipped, the reason in its note.
- `AO_SHELL_QUIT orderly` appears in Q.
- No "the quit did not reach the shell's quit handler" in Q.
- No new crash report.
- On a real Mac, the owner checks:
  - Cmd-Q;
  - the Dock's Quit;
  - Cmd-Q while the closing window is up (it should change nothing);
  - that the app still quits from its menu after closing its window.
- Logging out with the app open still ends it as before; see NEEDS A RULING.

## Runs (last line of each)

- `cargo test --locked --lib`, shared target: `test result: ok. 140 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out` (139 after FR-734, 140 with the new quit test).
- `cargo check --locked --target aarch64-apple-darwin --tests`: `Finished dev profile`, no warning. It needed `CC_aarch64_apple_darwin=clang-18 AR_aarch64_apple_darwin=llvm-ar-18` in that command's environment, as in the F16 report. Without them, `objc2-exception-helper`'s build script fails, because the host `cc` does not know `-arch`.
- `node --test apps/desktop/scripts/launch-check.test.mjs`: `# tests 57`, `# pass 57`, `# fail 0`.
- Not run, as the brief says: `build:linux`, the launch check itself, any end-to-end run.
- Set-up: the worktree had no `packages/ui/dist`, so `tauri::generate_context!` would not compile. I built it once with `pnpm --filter @ao/ui build`; it is ignored by git.
- `git status --short`: empty.
