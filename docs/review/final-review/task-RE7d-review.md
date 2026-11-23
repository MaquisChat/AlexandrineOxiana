# RE-7d review: FR-561 (sign-in window owned by its open) and FR-297 (the closing window)

Worktree `.claude/worktrees/re-7d`, branch `re-7d-find`, head 77b491e, base 7a8f5ee. I read the briefs, the report, R470 (c) and R472, both list entries and the whole diff. I also read the tauri 2.12.5, tauri-runtime-wry 2.12.3, tao 0.37.2 and muda sources from `~/.cargo/registry`.

**What I ran** (all at `nice -n 10`):
- One `cargo test --lib` build.
- The FR-561 and `closing::` tests: all pass.
- Three probes in a scratch `mod probe_re7d` inside `library_window::tests`, since removed.
- Guard removal for FR-561: each guard taken out in turn, the tests run, the file restored.
- The whole lib suite with the probes: **135 passed, 0 failed**.
- `node --test launch-check.test.mjs`: 49 passed.
- `vitest run src/closing`: 7 passed.

I did not run the launch check, `build:linux` or the end-to-end scenarios (the brief forbids them).

**State at the end:** the coordinator reported a machine restart. All my runs had finished before it. `git status --short` is empty, and `apps/desktop/src-tauri/target` is deleted.

---

## A. FR-561 (be398d6): **APPROVE WITH SMALL POINTS**

### Findings

**A-M1 (Minor). When a newer open fails, a window can be left that no open owns. Today this changes nothing; once the page sends its ticket, that close would be refused.** (`library_window.rs:1568-1580` with `:1417-1419`)
- The sequence:
  1. T1 is being built.
  2. The page's ticketless close finds no window yet. It runs `window_closed`, which ends T1 and sets the owner to None.
  3. T1's window then appears.
  4. T2 re-uses that window. Its navigation fails, so the failed-open path puts the owner back to its "before", which is None.
  5. T1's build returns. `open_still_its_own(None, T1)` is true, so T1 answers **true** for a window whose ticket has ended.
- Probe `probe_failed_newer_open_leaves_unowned_window` printed:
  - "older open answered true"
  - "ticketed close of T1 closed: false"
  - "window exists: true"
- **Today:** the page's late handler sends no ticket, so it still closes that window. The behaviour is as before.
- **After the planned page change:** a `close(T1)` is refused, and the window stays open with no ticket and no owner. Only the researcher's close button, sign-out or quit would end it. The window is a plain re-used window: nothing is fetched without a ticket.
- **Direction:** pick one of these.
  - When the owner is None, `open` answers false if the window exists.
  - Or let a ticketed close also go ahead when `owner_now` is None and the window exists.

**A-M2 (Minor). The failed-open restore of `window_owner` has no test.**
- I removed only the restore of `window_owner` at line 1575. All 88 `library_window` tests still passed.
- What would go wrong without it: after a failed re-use of a window left by a hand-over, the owner would stay the failed ticket, and the hand-over ticket's own close would be refused. That only matters once the page sends tickets.
- `window_closed` clearing the owner is also untested. Leaving it out is harmless, because the next `open` overwrites the owner.

**A-M3 (Minor). `close_for` checks the owner, then closes the window, with the lock released in between** (`:1791-1798`).
- A ticketed close of T1 can pass the check (T1 still owns the window after a hand-over). A T2 open can then take the window before `close_window` runs, and T2's window is closed.
- This is a narrow race between two detached threads. Today it needs the page to send a ticketed close for T1 while it starts T2. The page's own guard (`libTicket` is set before the open) prevents the late handler from doing that.
- The lock is rightly not held across the host call. A generation check after the close could narrow the race. Note it for the page follow-up.

**A-M4 (Minor, by reading). The page cannot tell an overtaken open's `false` from a "refused" `false`.**
- The late (gave-up) path is right: `late === false` closes nothing. That is the case R472 describes.
- An overtaken open that answers false **within** the page's time limit is treated as R342 b "refused" (`FindAcquire.tsx:1627-1631`). The page then sends a ticketless close, which closes the NEWER window, and asks again.
- Reaching this needs another open to take the window during T1's build while the Find screen is still live:
  - two starts on the same screen, which the service's one waiting entry very likely prevents (not verified);
  - or Test on Your library, which is not possible while Find is live, because `live()` is false off-screen.
- I judge it unreachable in practice, but this is reading only. The follow-up page change should keep it in mind.

### Checked and sound
- **Guards fail without themselves.** The implementer's claim holds:
  - Without the `open_still_its_own` check, `a_late_success_…` fails.
  - With `close_allowed` returning always true, all four new tests fail.
- **(1) Nothing older can close a newer window or end its ticket.**
  - Ticketed closes are refused for an older, repeated, malformed (`""`, upper-case), or non-main-caller ticket (probe 2).
  - A late failure of an older open cannot touch T2, because the restore is guarded by `g.ticket == ticket`.
- **(3) The owner is never stale in a way that matters.**
  - `open` sets `window_owner` itself under the lock, so a stale owner can never make the next open answer false.
  - Probe 1 (passing): a researcher close followed by a new open answers true; sign-out followed by a new open answers true.
  - Probe 2 (passing): a re-use after a hand-over answers true.
  - On Linux and macOS a crashed web process leaves the window in place, so the owner stays correct.
- **(4) No lock is held across a host call.** Both `self.lock()` temporaries sit in `if` conditions and are dropped before `emit` or `close_window`. Nothing awaits under the lock.
- **The shell is ready for the page's ticket.**
  - `ticket: Option<String>`: absent or `null` gives the old behaviour.
  - A wrong JSON type is rejected by deserialisation.
  - A malformed or stale ticket does nothing at all: it closes no window, ends no ticket and emits no event.
  - Caveat for the follow-up: a page variable that is `null` at call time falls back to "close whatever is open".
- **The end-to-end scenarios** (`apps/desktop/e2e/library-window.e2e.ts`; the path in the brief is wrong).
  - A wrong `false` would be seen by every scenario that uses `startThroughLibrary`, since it waits for the row to say "waiting".
  - Most directly by "closing the sign-in window while the entry waits … a new 'Get through my library' works" (l. 661): the second open comes after a researcher close.
  - And by "a link's start in the window a library's start left open" (l. 803): re-use after a hand-over.

### Only by reading
The real Tauri ordering of two builds with the same label (A-M1), and A-M4's reachability.

---

## B. FR-297 (c1994d7, e4d7d3d, 77b491e): **SOUND TO JOIN, with small points**

### Findings

**B-I1 (Important for the launch check, not the app). Scenario E can fail on a slow machine although the app is right.** (`launch-check.mjs:1265`, `:137`)
- E slows the stop by only 6 s (l. 1246).
- `firstRun` keeps only the events up to the first "stopped" line. The closing page's title (`AO_SHELL_CLOSING_PAGE`) must therefore arrive within about 4 s of the window being built.
- After "stopped" comes a restart, so a late title is never counted. On a loaded xvfb runner, starting a new WebKitGTK web process can take that long, and the check would report "its page did not load".
- F has about 8 s for the same thing.
- **Direction:** in E, require the page title only if it is seen, or give E a longer slowed stop.
- (E is skipped on the Mac.)

**B-M1 (Minor). If `closing.html` is missing from the bundle, the window shows the full app, not a blank page.**
- In tauri 2.12.5, `manager/mod.rs:403-411` loads `index.html` when an asset is not found.
- The closing window would then run the main app's page, with no capability and no connection script. It would neither hang nor crash, but it would show the wrong content. No Rust test checks the built `dist`.
- What protects it today:
  - `buildInterface` runs in both `build:linux` and `build:macos`.
  - `closingPage.test.ts` pins the Vite input.
  - F checks the page title in the debug build. The release build is not checked.
- I verified the current `dist/closing.html`: its own script is 214 B, plus the module-preload polyfill. It makes no request beyond its own assets.

**B-M2 (Minor). The closing window takes keyboard focus** (`closing.rs:41-55`; `focused` defaults to true).
- It appears 2 s after the close. On a SIGTERM or logout, or if the researcher has moved to another app, it may take focus from what they are typing into.
- Consider `.focused(false)`. That would also make window ordering on the Mac predictable (see the Mac list).

**B-M3 (Minor, very narrow race). The exit code can change in one small gap.**
- If the researcher closes the closing window between `helpers_stopped = true` (lib.rs:486) and `app.exit(code)` (l. 493), and the main window was already destroyed, that `ExitRequested{code: None}` is not prevented.
- The loop then ends with 0 rather than the requested code, which matters only for `watch_service`'s `app.exit(1)`. Even there, the main window is only hidden, so this needs both conditions at once. Negligible.

**B-M4 (Minor, wording; the sentence is ruled).** "up to a minute and a half" is a little short in the worst case. A forced stop is 95 s plus up to 10 s of killing, plus `at_quit`'s up-to-5 s window wait and the store emptying. Leave it as ruled, or note it.

### Checked and sound

**The quit path** (lib.rs:449-501):
- **Helpers gone within 2 s:** the window is not opened.
- **A slow stop:** the window opens, then `join` runs, then `helpers_stopped`, then the exit, exactly as before.
- **The 95 s grace** is still enforced inside `Service::stop`, now on the stopper thread. The closing thread waits for it in `join`, so the app cannot exit before the helpers are gone.
- **The stop panics:** the channel disconnects, which counts as "gone", so no window opens. The thread then returns.
  - Before the change, the same panic left the app stuck in the prevented exit. Unchanged, and moot in release (`panic = "abort"`).
- **A second `ExitRequested`** (the closing window closed, Cmd-Q, SIGTERM, SIGINT, `app.exit` from another thread) is prevented, because `closing` is already set.
- **The exit code** is `code.unwrap_or(0)`, as before, and `process::exit` still applies `failed`.
- **`fail()`:** it never goes through `ExitRequested` (`process::exit(1)`). A signal during `fail()` finds the service already taken, and `failed` is set, so no window opens. D checks this.
- **A quit before the main window exists:** `stop_helpers` finds no service, so no window opens. The orphaned-start case is unchanged and outside this task.
- **No deadlock.**
  - `WebviewWindowBuilder::build` off the main thread sends `Message::CreateWindow` through the event-loop proxy and blocks on `rx.recv()` (tauri-runtime-wry 2.12.3 lib.rs:300-325, 3980-3989).
  - The loop is running, because the exit is prevented.
  - If the loop were gone, the send would fail or the sender would be dropped, so `recv` returns Err, `build` fails and FAILED is printed. It cannot hang.
  - `app.exit` cannot run while `build` waits: only this same thread calls it, after `open` returns.

**Other code that looks at windows:**
- Every lookup is by label: `"main"` in `focus_main`, the hide in `ExitRequested` and `test_commands`; `library_window::LABEL` in the sign-in window's host.
- Nothing counts windows, takes "the first window" or runs start-up logic when a window is created.
- The main window's `Destroyed` handler closes only the sign-in window.
- A second launch while closing only sets `relaunch`. The closing window then goes with the restart, and its sentence is still true: the library is being closed first.

**The window is granted nothing:**
- The only capability, `main-window`, names `main` only; so do the built schema and `tauri.conf.json`. The test pins all three.
- The shell's commands are under the app manifest (build.rs) and also check the caller's label.
- There is no initialisation or connection script.
- `on_navigation` uses the app's own origin rule, new windows are refused and devtools are off.
- The page carries the same CSP as `index.html`.

**Test seams:**
- `close-closing-window` lives inside `test_commands`, which runs only under `test_mode()`.
- The `AO_SHELL_CLOSING_*` lines print only under `test_mode()`.
- The slowed stop is `#[cfg(debug_assertions)]` plus test mode, and was already there.
- This is the same mechanism as the existing `close` command and `AO_SHELL_*` lines. The as-released test covers only the probe strings, before and after this change, so nothing was weakened, and nothing was extended either.

**Launch-check parsers:** each line is matched whole; `AO_SHELL_CLOSING` is an exact match, so it does not swallow `AO_SHELL_CLOSING_WINDOW`; `println!` writes whole lines. The 2-second check measures from `closeAt`, taken before the close is sent, so it cannot fail by being early. A and B only print a note.

**Wording and look:** tokens only; the title and the sentence are plain, whole and match the ruling.

### Only by reading
- Everything in the Mac list below.
- Real window timing on Linux under load (B-I1).

---

## For the Mac build to watch
1. **Cmd-Q.** Tauri's default macOS menu has Quit as `terminate:`.
   - tao 0.37.2 implements only `applicationWillTerminate`, which sends `LoopDestroyed`. It has no `applicationShouldTerminate`.
   - By reading, Cmd-Q therefore ends the process **without** `ExitRequested`: no closing window, no wait for the helpers, no `at_quit`. The helpers then stop only because their input pipe closes (R155 rule 3), and the store is emptied at the next start.
   - The same applies to Cmd-Q pressed while the closing window is up.
   - This was there before the change, but it is untested: the Mac launch check uses stdin `close` and SIGTERM. Worth one manual Cmd-Q on the Mac build.
2. **Whether the window is shown, and in front.**
   - After a close button (the app stays active), tao's `makeKeyAndOrderFront` should bring it to the front.
   - After SIGTERM or logout, or if the researcher switched apps within 2 s, it may appear behind other apps' windows. Nothing activates the app, and I do not think it should.
3. **The Dock icon.** No `Reopen` handler exists. Clicking the icon while closing does nothing: no relaunch is noted, unlike the Linux hand-over.
4. **Scenario F on the Mac.** It reports "opened before the close began" if `at_quit` (`renew` → `remove_data_stores`, with up to 5 × 300 ms retries per store, and `start_webkit` waiting up to 10 s) takes more than 2 s. The window would then open before `AO_SHELL_CLOSING` is printed. That would be a false FAIL; the app itself would be right.
5. **The rest:** that `visible=true` and the title are reported on the Mac as they are on Linux; that `on_document_title_changed` fires for the closing page in WKWebView (the main window relies on the same); the bundled font and dark mode; and that the red close button changes nothing.
