# KG-6, second look: the fix round of R511 (17ba47b..0a17de2)

Scope: the six commits e10b54b, 81f561f, 3761ad9, f947a7e, d9a0dae and 0a17de2. I read them against Ruling R511 and the implementer's `task-KG6-fix-report.md`.

**Verdict: APPROVE WITH SMALL POINTS.** Nothing is Critical or Important. There are 3 Minor points.
- One of them (N1, M3) is a place where the built rule is **weaker than R511's words**. I rate it Minor, but the coordinator should rule on it: accept it as it is, or have the hold end on the main thread, as described below.

## What I ran (shared `CARGO_TARGET_DIR`, `nice -n 15`)

| Run | Result |
| --- | --- |
| `cargo test --locked --lib` | `test result: ok. 142 passed; 0 failed` |
| Mac type-check (`--target aarch64-apple-darwin --tests`, clang-18 / llvm-ar-18) | `Finished dev profile`, no warning |
| `node --test apps/desktop/scripts/launch-check.test.mjs` | `# tests 64`, `# pass 64`, `# fail 0` |
| My first probe again (`probe_kg6b::p2_first_page_under_second_ticket`) | `jobs: []`: no fetch under the waiting open's ticket. Closed. |
| New probe `p3_old_page_event_after_navigation_sent` (the real host's order, see N1) | `jobs: [("fedcba98…", "https://publisher.example/article/1.pdf")]` |
| M4 scratch edit: `notify_all` removed from the success path | 5 tests FAIL with "the waiting open never answered within a minute (its wake-up was lost)", about 2 minutes in all; no hang. Restored. |
| M3 scratch edit: `Self::waiting(&g)` removed from `page_loaded` | `a_page_of_the_window_an_open_waits_for_…` FAILS (141 passed, 1 failed). Restored. |

- The probes and scratch edits were removed, with `git checkout -- library_window.rs`.
- No leftover test process.
- `git status --short` is empty.
- Not run: `build:linux`, the launch check, end-to-end runs.
- Nothing was refused by a permission check.

## Findings

### Critical
None.

### Important
None.

### Minor

**N1 (M3; `library_window.rs` ~:1624-1632). The hold ends when the navigation is sent, not "once the window shows the open's own address" as R511 says. The residual window is wider than the report's "microseconds".**
- How the real host behaves:
  - The waiting open runs on the command's own thread. `TauriHost::navigate` calls `WebviewWindow::navigate`, which reaches tauri-runtime-wry's `navigate` (`lib.rs:1604-1610`) and then `send_user_message`. Off the main thread, that only **posts** `WebviewMessage::Navigate` through the event loop's proxy and returns `Ok`.
  - `webview.load_url` runs later, on the main thread, when the loop reaches it (`:3690-3694`, in tao's `cleared` pass).
  - The hold is released as soon as the post returns.
  - The old page's "load finished" (`on_page_load`) and a download it asks for (`on_download`) are delivered **on the main thread** by WebKit's delegates. Any such event the main thread handles before it reaches the posted navigation still arrives **after** the hold ended. It is then fetched under the new ticket.
  - The window is how long the main thread takes to reach the queued message. That is usually milliseconds, and longer when the main thread is busy, for example while the first page is loading. It is not microseconds.
  - Once `load_url` has run, WebKit cancels the old navigation, and no "finished" for it follows.
- Probe `p3`: an old-page `page_loaded` delivered after the second open answered produces a fetch of the first open's PDF under TICKET2.
- Nothing is attached without confirmation, so the harm stays as small as the review first said. But R511's stated condition ("a fetch starts only once the window shows the open's own address") is not what is built.
- I accept the implementer's reason against matching the exact address: a proxy login or `doi.org` redirects, and an exact match would hold those for the ticket's whole life.
- **Direction that meets the ruling without that cost:** clear the hold on the main thread, in the same task that runs the navigation. For example, `TauriHost::navigate` uses `run_on_main_thread`. There `WebviewWindow::navigate` takes `send_user_message`'s main-thread path and calls `load_url` at once. Clear `waiting` right after, under the controller's lock, and have the waiting open wait for that task to be done.
  - Everything the window delivers after that is either the new navigation's, or a cancelled old load, which never reports "finished".
  - A redirected address is not held.
- Or the coordinator may accept the built rule with its true window stated.

**N2 (M2; `launch-check.mjs` :1597-1598, :1607-1609). The closing line is not printed on every path, and `grep "launch-check: Q "` is not unique.**
- **An exception in Q.** For example, `upAndProbed` throws: the shell could not start, or a time-out waiting for the page.
  - Q's `finally` records that run as **"passed"**, because nothing was pushed to `problems`.
  - The exception then leaves `main` before the closing line (:1608).
  - `main().catch` prints `launch-check: <error>` on standard error, and the check exits 1.
  - So there is no `Q …` line at all, and the "passed" outcome is wrong, though never printed.
- **An exception in an earlier scenario (A–F).** Q never runs and there is no Q line. The check fails anyway, which is acceptable, but "on every path" does not hold.
- **A failure an earlier scenario only records** (pushed to `problems`): Q still runs. The closing line is printed, then `FAILED (N problems)`. That is correct.
- **The grep.** When M6's diagnosis runs, it prints `launch-check: Q (quit by Apple event): the shell exited (…); what macOS can say follows`. `grep "launch-check: Q "` then returns two lines.
- Direction:
  - print the closing line from the outer `finally`, counting a run that threw as "failed" (or "not completed");
  - give the grep as `grep -E "launch-check: Q (ran|SKIPPED|FAILED)"`, or make the closing line's prefix unique.

**N3 (M2; a remark).** "SKIPPED in part" names the skipped run and its reason (`1 of 2 runs checked; Q (quit by Apple event during a slowed quit): <reason>`). That is clear. The other mixed case, the first run skipped and the second "for the reason above", reads as a plain `Q SKIPPED (<first reason>)`. That is right. Nothing to do.

## Per point

**M1: holds.**
- `stopBySigterm` is one function. B's SIGTERM branch now calls it (:1386), and so does Q's `skip` (:1548). It is not a copy.
- **B is stricter than before.** Before, B asserted only `stopped?.how === "clean"`. A shell that stopped its helpers cleanly but never exited within 120 s still PASSED B, and was then killed. Now B FAILS it.
- **Can that hit a right app?**
  - B's stop is not slowed. The orderly stop is seconds; the worst case (95 s grace plus `at_quit`) stays inside 120 s.
  - Q's skip in the slowed run inherits `AO_SHELL_TEST_SLOW_STOP_MS=10000`, about 10 s more. That is inside 120 s.
  - The release check R already had the same kind of limit.
  - I see no right-app failure.
- **Can the check still pass over a hung app?**
  - A hook that blocks the main thread: SIGTERM's thread calls `app.exit`, which needs the main loop, so the shell never ends. The time-out then gives `sigtermStopProblems` a problem, Q FAILS, and the outcome is "failed".
  - A hang after the quit line: Q's check path waits 150 s, and "exited timeout" is a FAIL.
  - The not-running skip (before any event) also gets B's checks.
- The note says what the shell printed after the event, read before SIGTERM. That is correct.

**M2: holds**, apart from N2.
- A Mac skip is now `launch-check: skip Q (…): <reason>`, and the second run's skip is `skip … for the reason above`.
- There is one closing line on a Mac: `Q ran: n of 2 …`, `Q SKIPPED (…)`, `Q SKIPPED in part (…)` or `Q FAILED (…)`.
- A failure wins over a skip.
- The unit tests cover every case.

**M5: holds.**
- The line is printed inside the existing `#[cfg(target_os = "macos")]` block, under `#[cfg(debug_assertions)] if test_mode()`. So it appears on a Mac, in debug builds, in test mode only.
- The release-seam test `a_release_build_has_neither_…` is extended: the release text has no `AO_SHELL_QUIT_HOOK`.
- In A–F on the Mac the new line parses to `{kind: "quit-hook"}`. Every other check looks up its own kinds (`run.find`/`all`), and `libraryTrace` reads its own prefix, so the line changes nothing there.
- In Q, a hook "not installed" is named as the failure, and a missing hook line is itself a problem.
- One existing fixture gained the hook event. No assertion was loosened.

**M6: holds.**
- The crash diagnosis runs when the shell ended without a quit line, or by a signal, and not on a time-out (`quitCrashSuspected`). It runs before the failure is reported.
- `diagnoseMacCrash` wraps everything in `try {} catch {}` (:925-931), so it cannot throw and hide the FAIL line.
- After a signal the exit now shows as the signal name, where before it showed `null`.

**M4: holds.**
- The waiting open's answer comes through a channel read with `recv_timeout(60 s)`.
- With the wake-up removed, five tests fail by the time limit (checked above), instead of hanging the suite.

**M3: partly holds.** See N1.
- My probe `p2` is closed: nothing is fetched while the open waits, by page load or by download, and the test fails without the guard.
- The hold is cleared when the waiting open builds the window itself, and also after its navigation succeeds.
- Ownership, tickets and owners are unchanged.
- `take_pdf`, the researcher's own press, is not held. While the window still shows the other row's page, that press would fetch that page. That is the researcher's explicit act on what they see. I accept it.

## Nothing else moved
- **Linux:** the only `lib.rs` change sits inside the Mac block. The quit path is as before.
- **The menu** is untouched.
- **The ownership rules** (R472, R489, R491 B): `waiting` is never read by `open`, `close_for`, `window_closed` or the owner logic. Each open sets it again, so a stale value cannot carry into another ticket: `waiting(g)` requires `waiting == ticket`.
- The counts match the report: 142, 64, no warnings.

## For the Mac build to watch (the "Launch check A-D" step, which runs A–F and Q)

1. **The closing line:** `grep -E "launch-check: Q (ran|SKIPPED|FAILED)"`. Exactly one of these:
   ```
   launch-check: Q ran: 2 of 2 runs quit the app by Apple event and were checked
   launch-check: Q SKIPPED (<reason>): the Mac's own Quit was not checked
   launch-check: Q SKIPPED in part (1 of 2 runs checked; Q (quit by Apple event during a slowed quit): <reason>)
   launch-check: Q FAILED (<labels>): see its FAIL lines above
   ```
   - Only `Q ran: 2 of 2` proves FR-731 by the Apple event.
   - No Q line at all means the check threw first: read its last line, on standard error (N2).
2. **A pass**, per run:
   ```
   launch-check: ok   Q (quit by Apple event): the quit went the orderly way: the helpers stop cleanly and the shell exits 0 (quit hook installed; osascript answered | osascript said execution error: … (-128))
   launch-check: note Q (quit by Apple event): the helpers stopped within two seconds: no closing window was shown
   launch-check: ok   Q (quit by Apple event): no helper process is left
   launch-check: ok   Q (quit by Apple event during a slowed quit): the quit went the orderly way: … (quit hook installed; …)
   launch-check: ok   Q (quit by Apple event during a slowed quit): the closing window "Closing Alexandrine Oxiana" was shown two seconds after the quit, while the helpers ran
   launch-check: ok   Q (quit by Apple event during a slowed quit): no helper process is left
   ```
3. **A skip** now also proves a clean SIGTERM stop:
   ```
   launch-check: ok   Q (quit by Apple event), stopped by SIGTERM instead: an orderly stop (exit 0, stop clean)
   launch-check: ok   Q (quit by Apple event), stopped by SIGTERM instead: no helper process is left
   launch-check: skip Q (quit by Apple event): <reason>; the shell printed nothing after the event was sent
   launch-check: skip Q (quit by Apple event during a slowed quit): for the reason above
   ```
4. **A hang at the quit** now fails:
   ```
   launch-check: FAIL Q (quit by Apple event), stopped by SIGTERM instead: an orderly stop (… the shell did not end within 120 s of SIGTERM …)
   launch-check: FAIL Q (quit by Apple event): the app ended after the quit could not be judged (… it may hang at the quit …)
   ```
5. **The hook:**
   - the ok line's detail must start `quit hook installed;`;
   - `the shell's quit hook was not installed` means a tao/AppKit change refused it;
   - `the quit did not reach the shell's quit handler` together with an installed hook means AppKit does not consult a method added at run time. That is the one thing only a Mac shows.
6. **A crash block in Q** (`launch-check: Q (…): the shell exited (…); what macOS can say follows (Task MAC5)`) means the shell died at the quit: read its report.
7. **B** (`launch-check: ok   B (shell stopped with SIGTERM): an orderly stop (exit 0, stop clean)`) now also requires the shell to end within 120 s.
8. **The step's duration:** about A–F plus 2 minutes. A diagnosis or a 120 s SIGTERM wait adds time only on failure.

**For the owner's hands-on check:** unchanged from the first review. Also, for FR-734: open a sign-in window and, while it is still appearing, open another (for example "Test" on Your library). One window appears, at the second address, and no PDF from the first page is offered for the second row.
