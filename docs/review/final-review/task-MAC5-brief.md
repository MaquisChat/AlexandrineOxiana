# Task MAC5 — the Mac app crashes at start-up on GitHub's Mac machine: make the next build say WHERE

This brief stands alone. Read the common brief first, all of it: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-fix-common.md` (tests first; one commit per point; NEVER use `git stash`; the commit trailers it gives).

## What happened
The project is a desktop app (Tauri 2: a Rust shell in `apps/desktop/src-tauri`, which starts a local Node service and a Python worker as helpers). Its Mac build runs on GitHub Actions (`.github/workflows/desktop-macos.yml`, runner `macos-15`, Apple Silicon); nobody here has a Mac. After building, the workflow runs `node apps/desktop/scripts/launch-check.mjs --app "<the .app>"`, first on the DEBUG app, later on the RELEASE app taken from the disk image.

In run 6 (commit 4352d7b, 18 November 2026) everything built, and then:
```
launch-check: ok   the main window's capability grants exactly the expected commands, the watched-folder chooser included
launch-check: shell …/target/debug/bundle/macos/Alexandrine Oxiana.app/Contents/MacOS/alexandrine-oxiana
launch-check: worker: packaged, in the app's resources
launch-check: A (closed normally): the shell exited before the service was ready        ← two seconds after the start
launch-check: ok   no process of the app is left at the end
--- the shell's output (end) ---
(empty)
```
and for the release app: `launch-check: the app exited (SIGSEGV) before its service started:` with `--- processes under the shell --- (none)` and again no output. So the shell dies by a segmentation fault within about two seconds of starting, before it has started its service, and prints nothing.

The last Mac build that passed this check was commit 14da33e (12–13 November). Since then `apps/desktop/src-tauri` gained about 6,000 lines that have NEVER run on a Mac: `src/library_window.rs` (4,777 lines: a second window in which a researcher signs in to their library's website; cookies, a separate data store, downloads), `src/grant.rs` (390 lines: remembered folder grants for watched folders — security-scoped bookmarks on a Mac), changes in `src/lib.rs` (164 lines) and `src/service.rs` (210), 8 new lines in `Info.plist`, `build.rs`, the capabilities, and new crates (`Cargo.toml`, `Cargo.lock`). See `git diff --stat 14da33e HEAD -- apps/desktop/src-tauri`.

The full log of the failed Mac job (3,556 lines) is at
`/tmp/claude-0/-home-user-AlexandrineOxiana/ac3b5cb4-f467-5f83-9948-4e7d2e34f036/scratchpad/mac-build5.log`
(the two launch checks are at about lines 3386–3413 and 3460–3475; strip colour codes with `sed -E 's/\x1b\[[0-9;]*m//g'`; do not print the whole file).

## What I need — two things, and NO fix

### 1. Diagnostics in the launch check (Mac only), so that the next build's log shows where it crashes
In `apps/desktop/scripts/launch-check.mjs` (read it whole first, and its tests `launch-check.test.mjs`): on macOS (`process.platform === "darwin"`), whenever the shell exits before its service is ready or dies by a signal (both messages above), print — BEFORE the script exits with the failure it already reports, and without changing any exit code or any behaviour on Linux:
- **(a) the system's crash report.** macOS writes one a few seconds after a crash to `~/Library/Logs/DiagnosticReports/` (a file whose name starts with the process name, here `alexandrine-oxiana`, ending `.ips`; older systems `.crash`). Note the files there before the app is started; after the failure wait up to 40 seconds for a NEW one; print its path and then, from it: the exception type and codes, the termination reason, the crashed thread's number and its frames (for each: the image's name, the symbol, the offset — at most 60 frames), and the list of loaded images' names (at most 40). An `.ips` file is ONE line of JSON (a header) followed by a JSON document (the body: `exception`, `termination`, `faultingThread`, `threads[n].frames[]` with `imageIndex`, `symbol`, `symbolLocation`, `imageOffset`, and `usedImages[]` with `name`, `path`); parse it in a pure function with a unit test on a small sample you write from that description, and — because the real format may differ in a detail — if parsing fails, or yields no frames, print the first 250 lines of the file as they are. If no report appears in time, say so.
- **(b) a debugger's backtrace of the DEBUG app** (it has symbols): run the shell's binary once more under `lldb --batch -o "run" -k "thread backtrace all" -k "image list -b" -k "quit" -- "<binary>"` with the SAME environment and arguments the launch check itself uses to start the shell (read how it starts it: home folder, settings, any `AO_*` variables — reuse that code, do not copy values), a 90-second limit, and print at most 400 lines of its output. Only when the app at hand is a debug build or lldb is all there is — decide by trying: if `lldb` is not on the PATH, cannot launch the process, or times out, say so in one line and go on. After it, make sure no process of the app is left (the check already has a way to do that: use it).
- **(c) cheap context, once:** `sw_vers`; `plutil -p "<app>/Contents/Info.plist"`; `codesign -d --entitlements - -v "<app>"` (both streams); `otool -L "<binary>"`; `ls -la "<app>/Contents/MacOS" "<app>/Contents/Resources" "<app>/Contents/Frameworks"` (missing folders are fine). Each capped at 80 lines, each failure reported in one line and never fatal.
Everything printed goes through the script's existing way of printing (the `launch-check:` lines) or as clearly delimited blocks (`--- crash report ---` … `--- end ---`). The whole addition must be unable to turn a passing check into a failing one, or to hang it: every external command has a time limit and is wrapped; nothing here runs when the check passes.

Check the workflow (`.github/workflows/desktop-macos.yml`): the debug launch check's step and the release one (the step that mounts the disk image and runs the check from it) — will your output appear in both? If a later step would be skipped because the first failed, say so; do not restructure the workflow beyond what is needed to see the diagnostics (for instance `if: always()` on a step that uploads `~/Library/Logs/DiagnosticReports/*` as an artifact named `mac-crash-reports` — add that upload step; pin the action exactly as the file's other uses of `actions/upload-artifact` are pinned).

Tests first where a test is possible (the `.ips` parser; the "new file since the start" selection; the line caps; that nothing of this runs when `process.platform` is not `darwin` — inject the platform). Run `node --test apps/desktop/scripts/launch-check.test.mjs`, `pnpm --filter @ao/desktop test`, and `pnpm test:scripts` if the file is in its list. The Linux launch check itself must still pass: `pnpm --filter @ao/desktop run launch-check` needs a built Linux app — if `apps/desktop/src-tauri/target` holds one, run it; if not, say that you could not and why.

### 2. By reading only: what is new, Mac-only, and runs at START-UP
List every code path that (i) is new or changed since 14da33e, (ii) runs between the process's start and the moment the service is started (read `src/lib.rs`'s `run`/`setup`, `src/service.rs`, and what they call in `grant.rs` and `library_window.rs`; Tauri plugin registrations; `build.rs`; `tauri.conf.json`; `Info.plist`; the capabilities), and (iii) is Mac-specific (`cfg(target_os = "macos")`, `objc2`/`core-foundation`/`cocoa`/`block2` calls, `unsafe`, raw pointers, `NSURL`, bookmarks, `WKWebsiteDataStore`, cookie stores, the keychain) or comes from a crate added or upgraded since 14da33e (`git diff 14da33e HEAD -- apps/desktop/src-tauri/Cargo.toml`, and the notable version changes in `Cargo.lock`). For each: file and line, what it does, and why it could or could not segfault at start-up. Then name the three most likely suspects, in order, with your reasons — clearly marked as suspicion, not finding. Do NOT change any of that code.

## Where and how
Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/ci-flake`, branch `ci-find-runner-flake`, at 4352d7b (dependencies installed). EVERY shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/ci-flake &&`. Do not push. Do not touch `apps/desktop/mac-build-request.json` (the coordinator requests the build). No installs. Commits: one for the diagnostics and their tests, one for the workflow's upload step if you add it.

## Report
Write `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task-MAC5-report.md`: what the diagnostics print and when; the tests and their results; what you could not run here; the list of part 2 and the three suspects. No file dumps.

Final message to me, at most 180 words: head commit, the tests' results, whether the diagnostics will show in both launch checks, the three suspects in one line each, anything uncertain.
