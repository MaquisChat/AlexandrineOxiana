# KG-6 review: Quit on a Mac, and one sign-in window at a time (FR-731, FR-734 point 1; R503 h, i; R505 e)

Reviewer: a fresh adversarial reviewer. Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-6`, branch `kg-6-shell`, 579bdcd..17ba47b (24b8578, d9a3921, 17ba47b; 6 files, +621 −30).

**Verdict: APPROVE WITH SMALL POINTS.** Nothing is Critical or Important. There are 8 Minor points.

## What I read

- The briefs `kg-review-common.md`, `task54-fix-review-common.md`, `review-common-reader.md` and `kg-common.md`.
- Rulings R503 and R505, in full. Rulings R470, R472, R486, R489 and R491 B.
- The FR-731 and FR-734 entries.
- `task-KG6-brief.md`, `task-KG6-report.md`, and the review of the closing window `task-RE7d-review.md`: its Mac list, the residue of overlapping builds, and the second look.
- The whole diff, plus `lib.rs` `run`, `fail`, `launch`, `watch_service` and `stop_helpers`, and `library_window.rs` `open`, `close_for`, `window_closed`, `page_loaded`, `begin` and `TauriHost::create_window`.
- The pinned sources, by `Cargo.lock`: tao 0.37.2, tauri 2.12.5, tauri-runtime-wry 2.12.3, muda 0.20.0 and objc2 0.6.5.
  - tao: `macos/app_delegate.rs`, `event_loop.rs` (`new`, `run_return`, `Proxy::send_event`) and `app_state.rs` (`exit`, `cleared`).
  - tauri: `app.rs` (`exit`, `request_restart`, `build`'s default menu, `run_return`'s `Exit`) and `menu/menu.rs`.
  - tauri-runtime-wry: `lib.rs` (`request_exit`, `send_user_message`, `RequestExit`, `LoopDestroyed`).
  - muda: the `Quit` selector.
  - objc2: `class_addMethod`, `Imp`, and the debug message check.

## What I ran (shared `CARGO_TARGET_DIR`, `nice -n 15`)

| Run | Result |
| --- | --- |
| `cargo test --locked --lib` | `test result: ok. 140 passed; 0 failed` |
| `cargo check --locked --target aarch64-apple-darwin --tests`, with `CC_/AR_aarch64_apple_darwin` | `Finished dev profile`, no warning |
| `node --test apps/desktop/scripts/launch-check.test.mjs` | `# tests 57`, `# pass 57`, `# fail 0` |
| Probe module `probe_kg6`, 2 tests (below) | both ran; both removed |
| Guard: the wait removed (`(false, Some(b)) => None`) | all 4 new FR-734 tests FAIL (136 passed, 4 failed); restored |
| Guard: `.or(waited)` removed | `an_open_that_waited_and_then_failed_…` FAILS; restored |
| Guard: `notify_all` removed from the success path | the suite **hangs**; `timeout 300` killed it (exit 124); restored |

- No leftover test process.
- `git status --short` is empty at the end.
- Not run, as the brief says: `build:linux`, the launch check itself, end-to-end runs.
- Nothing was refused by a permission check.

## Findings

### Critical
None.

### Important
None.

### Minor

**M1 (FR-731, scenario Q; `launch-check.mjs` ~:1447-1452 and :1463-1466). A shell that hangs at the quit is reported as "not checked", not as a failure.**
- Suppose the quit hook blocks the main thread before it prints `AO_SHELL_QUIT`. That is exactly the "app that will not quit" a mistake in this code would cause.
- osascript then waits until its 30 s limit, `reached` is false, and `quitEventVerdict` returns `skip` ("no answer within 30 s (a request for permission … may be waiting)").
- `skip()` then sends SIGTERM and waits up to 120 s. It never checks that the app actually ended or that its helpers went: `continue`, then `finally killTree`.
- So the run prints only `note … not checked`, and still ends `launch-check: all checks passed`.
- By reading. A hung app cannot be produced here, and the decision function is unit-tested only for its inputs.
- Direction: on the skip path, still assert that the SIGTERM stop ended the shell (exit, helpers gone, as B does). In the timeout note, say whether the shell printed anything after the event was sent.

**M2 (FR-731, the Q log; :1438, :1449). A skip is hard to see, and one watch item cannot be read in the log at all.**
- On a Mac a skipped Q prints `launch-check: note Q (…): not checked: …`. That is the same prefix as a dozen ordinary notes. Every other skip uses `launch-check: skip …`: E on the Mac, and Q itself on Linux.
- The run still ends `launch-check: all checks passed`.
- R505 e says the log must be read for whether Q ran. Today that takes `grep -E "launch-check: (ok|FAIL|note) +Q "`, not one obvious line.
- The report's watch item "`AO_SHELL_QUIT orderly` appears in Q" cannot be checked in CI. The shell's own output is only collected (`run.lines`) and is printed only when something fails. Only the derived `ok` line shows.
- Direction: print a Mac skip of Q as `launch-check: skip Q (…): <reason>`, or add one closing line such as `Q: ran` or `Q: SKIPPED (<reason>)`. Correct the watch item.

**M3 (FR-734; `library_window.rs` :1586, the waiting open). The first open's own page can be fetched under the second open's ticket.**
- Probe `p2_first_page_under_second_ticket`. The first open goes to a PDF-like address. Its page loads while the second open waits (before that open navigates). The model then starts a fetch with ticket TICKET2 for the first open's address: `PROBE jobs: [("fedcba98…", "https://publisher.example/article/1.pdf")]`.
- Consequences:
  - The second row can receive a "found file" taken from the first row's page.
  - The second open's own PDF is then refused as busy.
  - If that hand-over completes, TICKET2's ticket ends, and the waiting open answers false.
- Nothing is attached without the researcher's confirmation, so this is not Critical.
- By reading of the real host the gap is narrow. The first page must finish loading between the build's answer and the waiter's `navigate`, which is microseconds later, and WebKit then cancels that first load.
- It is the same class as the implementer's stated residue, and it is NARROWER than before the change. Before, the first window lived on beside the second, loading under TICKET2 for its whole life.
- Direction: while an open waits for another open's build, `page_loaded` and `download_requested` start no fetch, for example with a "waiting" flag, or only once the window shows the open's own address. At least, say this in the residue.

**M4 (FR-734, test strength). The wake-up of the waiting open is held only by a hang.**
- Removing `self.built.notify_all()` from the success path makes the suite hang. `cargo test` has no time limit, so it never fails; `timeout 300` had to kill it.
- `until_locked` fails after a minute, but the waiter's `join()` has no limit.
- Direction: join the second open with a bound, for example a channel `recv_timeout(60 s)`, so that a lost wake-up fails the test.

**M5 (FR-731; `quit.rs` `install`, `lib.rs` :451). `install`'s answer is dropped.**
- `install` returns false, with nothing changed, when:
  - the delegate is missing;
  - `DECIDE` is already set;
  - `class_addMethod` refuses, for example because a later tao already implements `applicationShouldTerminate:`.
- `lib.rs` ignores that answer, and prints nothing even in test mode.
- Q would then fail with "did not reach the shell's quit handler", but nothing would say why.
- Direction: in test mode print `AO_SHELL_QUIT_HOOK installed|not installed`. Have Q, or A on the Mac, report it.

**M6 (FR-731, scenario Q). A crash at the quit is not examined.**
- When the shell dies, `upAndProbed` runs `diagnoseMacCrash`. Q does not: a crash in the new Objective-C code at the quit would show only as "the quit did not reach the shell's quit handler … ended without its orderly path".
- The report's watch item "no new crash report" depends on that diagnosis.
- Direction: when Q sees the shell exit without an `AO_SHELL_QUIT` line, or with a signal, call `diagnoseMacCrash(run, { debug: true })`.

**M7 (FR-731; `quit.rs` `on_terminate`, `failed ⇒ Now`). Cmd-Q at a failed start's error window exits 0.**
- While the error window is up, `failed` makes Cmd-Q answer "now". AppKit then ends the process with exit status 0, through `exit(0)` after `applicationWillTerminate:`.
- `fail()`'s own exit and the post-loop `process::exit` both say 1.
- This is unchanged from before, the ruling's "left as it was". It ends the app once, as asked.
- Answering `Orderly` there would keep exit 1: the closing path finds no service, and `process::exit` applies `failed`. Optional.

**M8 (FR-734, by reading). A build that never answers now blocks every later open.**
- The waiting open waits on the condvar with no limit.
- If the first build never answered, every later open would wait on it too, through a close and a new open, until the app restarts. Before the change, a third open would have built its own window.
- By reading of `TauriHost::create_window`, the build always answers:
  - `build()` waits on the main thread's reply;
  - if the loop is gone, the sender is dropped and `recv` fails;
  - a busy main thread only delays it.
- The waiter holds no lock and calls no host function. While its ticket stands it holds the shell's one ticket, which a ticketless close ends. It also holds its command's pending promise.
- Direction: none needed. Optionally, bound the wait and answer false.

## FR-731: the quit path, by reading the pinned sources

### 1. How the request is taken

A method is **added**, not swizzled: `applicationShouldTerminate:` goes onto tao's own delegate class with `class_addMethod`.

The facts at the pinned versions:
- **The class.** tao registers `TaoAppDelegateParent` (superclass `NSResponder`) once, in a `LazyLock` (`app_delegate.rs:46-88`). It implements `applicationDidFinishLaunching:`, `applicationWillTerminate:`, `application:openURLs:`, the two user-activity methods, `applicationShouldHandleReopen:hasVisibleWindows:` and `applicationSupportsSecureRestorableState:`. It does **not** implement `applicationShouldTerminate:`, and neither does its superclass chain. So `class_addMethod` adds it, and returns YES.
- **When tao sets its delegate.** In `EventLoop::new` (`event_loop.rs:161-179`), which tauri's `Builder::build` reaches. The shell installs after `build()` and before `run_return` (`lib.rs:441-461`), on the main thread (`run()` is `main`'s).
- **Nothing re-installs it.** tao never calls `setDelegate:` again: its only other `setDelegate` calls are for window delegates (`window_delegate.rs:156, 217`). tauri, wry, muda, rfd and the plugins never set the app delegate.
- **Return type.** `NSApplicationTerminateReply` is `NS_ENUM(NSUInteger)`. Rust uses `usize`, with type encoding `"Q@:@"`.
  - On arm64 and x86_64, `@encode(NSUInteger)` is `Q` and the value returns in x0/rax.
  - `NSTerminateCancel = 0` and `NSTerminateNow = 1` are right. The shell never returns `Later` (2).
- **Thread.** AppKit calls the delegate on the main thread.
  - The answer calls `AppHandle::exit(0)` → `request_exit` → `proxy.send_event(Message::RequestExit)` (tauri-runtime-wry `lib.rs:2597-2604`). This deliberately does NOT use `send_user_message`'s main-thread shortcut.
  - `Proxy::send_event` (tao `event_loop.rs:343-354`) sends on a channel, signals a run-loop source added in common modes, and wakes the loop. That is safe on the main thread and inside a delegate call.
  - The `RequestExit` is handled in the next `cleared` pass. It calls back `RunEvent::ExitRequested{code: Some(0)}` and sets `ExitWithCode` only if the exit was not prevented (tauri-runtime-wry `:4299-4312`). So the shell's existing handler runs, and its prevention is honoured.
- **Memory.**
  - Selectors are static; the C strings are literals.
  - `DECIDE` is a `static OnceLock` that keeps the closure for the life of the process: an `AppHandle` clone and an `Arc<Shell>`.
  - No block is made. No object is retained or released by the shell.
  - The delegate object is kept alive by tao's `EventLoop` (`IdRef`).

**Every `unsafe` line** (`quit.rs`):
1. `AnyClass::get(c"NSApplication")`: inside the `unsafe` block, but it is a safe lookup.
2. `msg_send![app_class, sharedApplication]`: assumes the main thread, which holds. tao already created the shared application with its own class (`APP_CLASS`), so this returns that instance. Its encoding (`@`) matches.
3. `msg_send![app, delegate]`: returns tao's delegate, unretained. That is safe because tao holds it strongly for the life of the event loop. The null result is checked.
4. `(*delegate).class()`: dereferences a non-null raw pointer to a live object.
5. `transmute::<extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize, Imp>`: objc2's standard way to make an IMP. The signature matches self, `_cmd` and the sender, and returns NSUInteger.
6. `class_addMethod(class as *const _ as *mut _, sel, imp, "Q@:@")`: changes a registered class at run time. The runtime allows that, and it is thread-safe. It is done once, before the loop runs, and only this one object has that class.
7. `unsafe fn quit_reason` and its four `msg_send!`s, each nil-checked:
   - `+[NSAppleEventManager sharedAppleEventManager]`;
   - `-currentAppleEvent`;
   - `-attributeDescriptorForKeyword:` with a `u32` AEKeyword (`I`), returning `@`;
   - `-enumCodeValue` returning `u32` (OSType, `I`).
   The encodings match the AppKit declarations. In debug builds objc2 0.6.5 checks every send and panics on a mismatch or a missing method (`message_receiver.rs:311-334`). Those panics are inside the `catch_unwind` around `quit_reason`. The sends in `install` are outside it, but their selectors exist and their encodings match.
8. `catch_unwind(|| unsafe { quit_reason() })`:
   - It catches Rust panics, which in practice means debug-only verification panics.
   - In release (`panic = "abort"`, `Cargo.toml:49`) there is no verification and no panic source: every pointer is nil-checked.
   - It does not catch an Objective-C exception. None of these four calls documents one.

**Unknown by reading (AppKit is not in these sources):** whether `NSApplication` reads `respondsToSelector:(applicationShouldTerminate:)` when `terminate:` is called, or caches it at `setDelegate:`. I believe it asks at `terminate:` time, but I cannot show it here.
- If AppKit cached it, the hook would be silently ignored. Quit would behave exactly as before, with no crash.
- Q would then **FAIL**, not skip: "the quit did not reach the shell's quit handler". That is the right signal.
- A cheap belt-and-braces would be to send `setDelegate:` again with the same object after adding the method. I do not require it.

### 2. The answer, and the app really ending
- **The orderly exit.** `app.exit(0)` → `ExitRequested` → `closing` is set, the exit is prevented and the main window hidden. Then `at_quit`, `stop_helpers` and the inbox are handled, the closing window shows after 2 s, `helpers_stopped` is set and `app.exit(0)` is called.
  - That ends the loop by `-[NSApp stop:]` plus a dummy event (tao `app_state.rs` `cleared`, about :400-409), never by `terminate:`.
  - `run_return` returns: `app.run()` returns, then `AppState::exit()` (`event_loop.rs:205-245`). The post-loop `stop_helpers` and `process::exit(code)` then run.
  - I grepped tao, tauri, tauri-runtime-wry, muda, wry, rfd, the dialog plugin and single-instance: none sends `terminate:`.
  - tauri's restart path (`process::restart`) spawns and exits; it does not use `terminate:`.
  - **So the final exit cannot come back and be cancelled: no loop.**
- **The "already closing" mark** is `closing.swap(true)` in the `ExitRequested` handler, not in the hook. That is enough:
  - every Cmd-Q before `helpers_stopped` answers Cancel and queues another `RequestExit`;
  - every later `ExitRequested` is prevented by `closing`;
  - the events are handled one at a time on the main thread.
- **The cases:**
  - **A second Cmd-Q during the closing:** Cancel, and the exit request is prevented. It changes nothing.
  - **Cmd-Q while the closing window is in front:** the same.
  - **Cmd-Q after `helpers_stopped`:** answered "now". AppKit ends the process with exit 0, without the post-loop lines, which are already done. This is harmless.
    - One negligible case: a second launch's hand-over sets `relaunch`. If Cmd-Q lands between `helpers_stopped` and `request_restart`, the restart is lost.
  - **Cmd-Q during start-up, before the service exists:** this goes the SIGTERM way. The closing finds no service, and the app exits.
    - A service still starting is orphaned, and it stops when its standard input closes.
    - That is the same as SIGTERM at that moment ("orphaned-start case", RE7d review), and as Cmd-Q before this change. It is not a regression.
  - **Cmd-Q at a failed start's error window:** answered "now", which ends the app once, as before (M7).
  - **Cmd-Q while the "service stopped unexpectedly" dialog is up:** this goes the orderly way and exits 0, not 1. That is the same as SIGTERM there today.

### 3. R505 e: a system quit is answered "now"
- The quit Apple event's `keyAEQuitReason` ('why?') attribute is read through `-[NSAppleEventManager currentAppleEvent]`. That is the documented technique.
  - Cmd-Q through the menu has no current Apple event, so it is answered orderly.
  - osascript's plain `quit` carries no reason, so it is answered orderly.
  - Logout, restart and shutdown, from loginwindow, carry a reason, so they are answered "now". R505 e rules exactly that.
- **When the reason cannot be read, the code chooses "the researcher's quit", i.e. orderly.**
  - In release, every "cannot read" is a nil current event, which is exactly Cmd-Q. No panic path exists. So the unsure case is not reachable for a real logout.
  - R505 e does not rule on "unsure". I accept the choice.
- **Whether the Dock's Quit carries a reason is not knowable here.** If it did, the Dock's Quit would stay "now", as before: no crash, just not orderly. That is in the owner's check.
- **The menu was not touched.** `lib.rs` has no menu code, so tauri's default macOS menu stays (`app.rs:2409-2414`; `menu.rs` app submenu with About, Services, Hide, Hide Others and Quit; plus Edit, View and Window). Quit keeps `terminate:` (muda `mod.rs:944`) and Cmd-Q.

### 4. Linux and the other ways to end
- On every platform only `pub mod quit;` (pure `Terminate`/`on_terminate`) and a doc line are new.
- Every line that acts is `#[cfg(target_os = "macos")]`: `DECIDE`, the constants, `install`, `should_terminate`, `quit_reason`, and the `lib.rs` block.
- The Linux `run()` is byte-for-byte the old path.
- The close button, SIGTERM, SIGINT, SIGHUP, the hand-over and `fail()` are untouched.

## FR-734 (1): one build at a time

- **What it waits on.** A `Condvar` (`built`) with `wait_while(building == Some(b))`. It is notified under the lock on both answers of a build (`:1634`, `:1658`). There is no lost wake-up, and spurious wake-ups are handled by `wait_while`. There is no polling, and no time limit (M8).
- **Locks and host calls.** No lock is held across the wait: `wait_while` releases it. Nor across a host call: `window_exists` and `navigate` are made with the lock released. `open` runs on `detached`'s thread, never on the main thread. Checked.
- **A third open during the wait.** Refused while the second open holds the ticket. Once a close has ended that ticket, the third open waits on the same build and wins.
  - Probe `p1_third_open_during_the_wait`: one window; the third open answers true; the second false; the first overtaken.
  - Older tickets' closes do nothing; the third's closes the window.
- **The first open's ticket ended while the second waits.** The second open has already taken the ticket and the owner. When the first build answers, `still_its_own` is false, so the first answers false and its close is refused.
  - When the second open's ticket is ended by a close while it waits, it answers false and touches nothing. The window then goes to its builder (R489; test 4).
  - When the second open fails after re-use, the window goes back to the open that built it (`.or(waited)`; test 3).
  - The researcher can close the half-built window. `Destroyed` → `window_closed` ends whichever ticket stands. A waiter whose ticket ended returns false, and if its `navigate` fails, `stands` is false and the owner becomes None.
  - **No window is left that nobody owns, and nothing older closes a newer window.** Checked.
- **Which address the re-used window shows.** The second open's: `navigate(url2)` and its title. The title keeps the host actually shown until that address commits (R360 b). A narrow residue is M3.
- **The duplicate native window of R491 B is closed.** A build now starts only when `building` is None. The other way two builds could have started is the race between `window_exists` and the lock; in that race tauri's `prepare_window` refuses the duplicate label.
- **The changed existing test** (`a_late_success_of_an_older_open_…`):
  - Every assertion is kept: the older open answers false; one `Opened(TICKET2)`; the PDF fetch is under TICKET2; the older ticket's closes do nothing, twice, with no window; TICKET2's own close closes.
  - What changed: the second open now runs on its own thread, through the shared helper, and asks for `START2` instead of `START`. Neither change weakens it. On one thread the second open would wait forever.

## Table

| FR | The implementer's claim | Verdict | Note |
| --- | --- | --- | --- |
| FR-731 (shell) | By reading, Quit bypassed the orderly path. The shell now takes `applicationShouldTerminate:` and asks for the SIGTERM exit. A system quit is left "now". Mac only. | **holds** (by reading; the Mac alone can prove it) | Every source citation checked. No loop at the final exit. A second Cmd-Q is harmless. The menu is intact. Linux is unchanged. The one AppKit unknown is that a run-time-added method is consulted; Q fails loudly if it is not. M5, M7. |
| FR-731 (scenario Q) | Quits by Apple event, asserts the orderly stop and, when slowed, the closing window. It skips with a note when macOS blocks or does not answer. Unit tests cover the decisions. | **partly** | The decisions and parsing are tested (57/57). The composition in `main` is untested (reading only). A hung app reads as a skip (M1); a skip is not loud (M2); a crash is not diagnosed (M6). |
| FR-734 (1) | A second open waits for the build in flight and re-uses its window. Four tests fail without the fix. One test was re-threaded with its assertions kept. | **holds** | The guards fail without themselves, except that the wake-up is held by a hang (M4). Probe P1 passes. P2 shows the first page fetched under the second ticket (M3; narrower than before). |

## What could make Q fail on GitHub's Mac though the app is right
1. **The app not known to LaunchServices under its id.** It is run directly from the bundle.
   - `application id … is running` is asked first. Any failure, or `false`, is a skip. "No AE sent" holds: `is running` sends no Apple event.
   - I expect `true`: an app run from inside its bundle checks in with LaunchServices.
2. **Two copies with the same id** (the debug bundle and the release app, which the DMG step may have registered).
   - AppleScript's `application id` addresses by bundle id, so the running process is the target.
   - Only one copy runs: the check stops every copy at the start.
   - I could not prove that osascript never launches the other, registered copy to deliver `quit`. If it did, Q would fail, and a copy would be found left at the end. I judge this unlikely: `quit` follows an `is running` that returned true.
3. **The Automation prompt.** The four required events (`aevt/quit` among them) are, to my knowledge, exempt from Automation consent. If a prompt does block, osascript is capped at 30 s and Q skips. The cap is the time limit on osascript itself, with SIGKILL.
4. **The app quitting faster than the check observes.** `reached` is the quit line OR the exit, so this is not a risk.
5. **The slowed run.** F's known Mac risk applies (`at_quit` taking more than 2 s → "opened before the close began"). Run 282 passed F on the Mac, so the same mechanism should pass in Q.
6. **An unlisted osascript error with the event not reached** (e.g. `-2741`, `-609`). This is a FAIL. `-609` is harmless, since the app exiting counts as reached.
7. **Time.** Two more starts plus 10 s fit inside the step's 20 minutes (A–F took about 4–6 minutes).

## What could make Q pass or skip though the app is wrong
- **A hang at the quit hook:** a skip (M1).
- **The hook not installed:** a FAIL. That is good, though the cause is unexplained (M5).
- **The app answering "now" for the plain quit** (for example, the reason misread as a system quit): a FAIL ("answered now").
- **A misread reason in the debug build only:** caught as orderly. That cannot hide a release-only fault, and release has no such path.
- **Q runs with the slowed stop:** yes. It asserts the closing window as F does: its title, visible, after 2 s, after the close began, before the helpers went, and its page loaded. It does not test the closing window's close button; F does.

## For the Mac build to watch (the "Launch check A-D" step; the step name is stale, as it runs A–F and Q)

**Q ran and passed**, for each label `Q (quit by Apple event)` and `Q (quit by Apple event during a slowed quit)`:
```
launch-check: ok   Q (quit by Apple event): the window exists and is visible
launch-check: ok   Q (quit by Apple event): the page reached the service and the worker (…)
launch-check: ok   Q (quit by Apple event): the worker runs under the service (helpers …)
launch-check: ok   Q (quit by Apple event): the quit went the orderly way: the helpers stop cleanly and the shell exits 0 (osascript answered | osascript said execution error: … (-128))
launch-check: note Q (quit by Apple event): the helpers stopped within two seconds: no closing window was shown
launch-check: ok   Q (quit by Apple event): no helper process is left
… the same for "during a slowed quit", with instead of the note:
launch-check: ok   Q (quit by Apple event during a slowed quit): the closing window "Closing Alexandrine Oxiana" was shown two seconds after the quit, while the helpers ran
```

**Q skipped** (the run can still end "all checks passed"):
```
launch-check: note Q (quit by Apple event): not checked: <reason>
launch-check: note Q (quit by Apple event during a slowed quit): skipped, for the reason above
```

**Q failed:**
```
launch-check: FAIL Q (quit by Apple event): the app took the quit (the quit Apple event was sent (…) but the shell neither took the quit nor exited)
launch-check: FAIL Q (…): the quit went the orderly way: … (the quit did not reach the shell's quit handler (no AO_SHELL_QUIT line): the app ended without its orderly path; …)
launch-check: FAILED (N problems)
```

One grep reads it all: `grep -E "launch-check: (ok|FAIL|note) +Q "`. A `not checked` in it means Q did **not** prove FR-731.
- The shell's own `AO_SHELL_QUIT orderly` line is not in the log (M2). Its effect is the `ok … orderly way` line.
- Also watch for: a new crash report in the step's diagnostics; the step's duration (A–F plus about 2 minutes); and `-128` in the osascript detail, which is expected.

## For the owner's hands-on check (only a person at a Mac can see these)
With fast helpers an orderly quit looks almost the same as the old one. To see the difference, quit while the service is busy, for example during an import of a large folder or a running transcription. The orderly way then shows the "Closing Alexandrine Oxiana" window after about 2 seconds, and the app stays in the Dock until the helpers have stopped. The old way vanished at once.

1. **Cmd-Q.** The main window goes, and if busy the closing window shows. The app then quits by itself, once.
2. **Quit from the app menu.** The same.
3. **The Dock's Quit**, from a right-click on the icon. The same. If it vanishes at once instead, the Dock's event carries a quit reason, and the Dock's Quit stays the old way.
4. **Cmd-Q again while the closing window is up.** Nothing changes, and the app still quits by itself.
5. **The closing window's red button.** Nothing changes.
6. **Logging out, or restarting, with the app open.** macOS must NOT report that the app interrupted the logout. The app ends at once, as before (R505 e, decision 30). Next time, the app opens normally and the library is intact.
7. **The standard menu is still there.** About, Hide, Hide Others, Show All, Quit; Edit with Copy, Paste and Select All working in a text field; Window.
8. **After quitting:** reopen the app, and check that the sign-in window's "stay signed in" behaviour is as chosen.

## Only by reading
- All of AppKit's behaviour:
  - that a method added at run time is consulted;
  - that the Dock's Quit and the quit Apple event reach `terminate:`;
  - `currentAppleEvent` and `keyAEQuitReason` at logout;
  - Automation exemption for `aevt/quit`;
  - osascript's addressing by bundle id.
- The real host's timing for M3 and M8.
- Q's composition in `main` (no unit test reaches it).
- M1, M2, M5, M6 and M7 are by reading. M3 is by probe on the model. M4 is by guard removal.

## Noticed outside the change (not this batch's)
- A sign-out while the first build is in flight empties the store before the window exists. The window then appears with the store id it was given at the open. This predates FR-734, and FR-734 neither widens nor narrows it. Worth a line in the list if it is not there.
