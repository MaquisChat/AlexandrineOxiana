# Task MAC5: report

Worktree `.claude/worktrees/ci-flake`, branch `ci-find-runner-flake`. Two commits on top of 4352d7b. Nothing was pushed, and `apps/desktop/mac-build-request.json` was not touched.
- `08ebaf5`: the launch check's Mac diagnostics and their tests.
- `8fc3d17`: the workflow's upload of the crash reports, with a test that checks the step.

## 1. Diagnostics (apps/desktop/scripts/launch-check.mjs)

### When they run
They run on macOS only, and only when the shell has exited before its service was ready.
- **Scenarios A, B and C:** in `upAndProbed`'s catch. They do not run when the shell itself reported `AO_SHELL_FAILED`.
- **Scenario R:** in `releaseCheck`'s catch, when the app exited before its service started.

They run before the error is thrown, so they print before the failure that the check already reports. Nothing runs when the check passes, and nothing runs on Linux: `diagnoseMacCrash` returns at once unless `MAC`, and `macCrashDiagnostics` returns false unless `platform === "darwin"`. The platform can be injected for the tests.

### What they print
- **(a) The crash report.** `startShell` lists `~/Library/Logs/DiagnosticReports` before each start; it uses `os.homedir()`, which is the runner's real home, not the shell's HOME. After the failure the check looks every second, for up to 40 s, for the newest new `alexandrine-oxiana*.ips` or `*.crash` file. It prints the file's path, then:
  - the exception type, signal, codes and subtype;
  - the termination reason;
  - the crashed thread's number and up to 60 of its frames (image, symbol, `+symbolLocation`, image offset);
  - up to 40 names of loaded images.

  If the file cannot be parsed, or parses with no frames, it prints the first 250 lines raw. If no report appears in time, it prints one line saying so.
- **(b) lldb.** It runs `lldb --batch -o run -k "thread backtrace all" -k "image list -b" -k quit -- <binary>`, with the run's own environment and arguments: `startShell` now keeps `env`, `shell` and `args` on the run object. The limit is 90 s, and at most 400 lines are printed. A missing lldb, a time-out or a failure to launch is reported in one line. Afterwards `stopAppProcesses()` cleans up.
  - Debug app (A–C): always.
  - Release app (R): only when no crash report came. This is how I read "only when the app at hand is a debug build or lldb is all there is".
- **(c) Context, printed once per process.** It runs `sw_vers`, `plutil -p Info.plist`, `codesign -d --entitlements - -v` (both streams), `otool -L` and `ls -la` of MacOS, Resources and Frameworks. Each has a 20 s limit, at most 80 lines are printed, and a failure is one note line.

### Safety
- Every step is wrapped in try/catch, and every command goes through `spawnSync` with a timeout and SIGKILL.
- No result, problem list or exit code is touched.
- The worst-case extra time is about 40 s + 90 s + 5×20 s. That fits the A step's 20-minute limit and R's 10-minute limit.

### Workflow
- Both launch-check steps have `if: !cancelled() && steps.build.outcome == 'success'`. R therefore still runs after A fails (run 6 showed exactly that), so the diagnostics will appear in both logs.
- New step "Upload the crash reports": artifact `mac-crash-reports` from `~/Library/Logs/DiagnosticReports/*`, `if-no-files-found: ignore`, pinned to `upload-artifact@ea165f8…` (v4.6.2), placed after R.
- **Differs from the brief:** the step uses `if: ${{ !cancelled() }}`, not `always()`. An existing test (`build-macos.test.mjs`, "saves the caches…") forbids `always()` in this workflow. I did not loosen that test.
- The artifact name has no matrix suffix. That is fine while there is only the Apple Silicon build, but it would collide if Intel were switched back on.

## Tests
- `node --test apps/desktop/scripts/launch-check.test.mjs`: 36 pass, 0 fail. The 11 new tests failed first, on the missing exports. They cover:
  - capping lines;
  - choosing the newest new report;
  - parsing `.ips`, including the 60-frame and 40-image caps and the unreadable or no-frames fallback;
  - that nothing at all happens on linux or win32, checked with fakes;
  - the lldb arguments, environment and limit;
  - the one-line notes when lldb is missing, times out or cannot launch;
  - the context printed once;
  - that the release app skips lldb when a report exists;
  - that nothing throws when everything fails.
- `build-macos.test.mjs` has one new test for the upload step: 33 pass.
- `pnpm --filter @ao/desktop test`: node 107 pass, vitest 78 pass, `cargo test` ok (124 pass). The first attempt stopped in `cargo test` because `packages/ui/dist` had not been built in this worktree; that is unrelated to this change. It passed after `pnpm --filter @ao/ui run build`.
- `test:scripts` does not list launch-check, so it was not run.
- **Not run:** the Linux launch check (`pnpm --filter @ao/desktop run launch-check`). This worktree has no built shell (`src-tauri/target/debug/alexandrine-oxiana`) and no built service folder. The new code is unreachable on Linux, by the platform guard and the tests.
- **Only a Mac can show:**
  - whether the real `.ips` layout matches the sample (the raw fallback covers it if not);
  - whether lldb may launch the ad-hoc-signed app;
  - whether ReportCrash writes a report within 40 s.

## 2. New, Mac-specific code on the start-up path since 14da33e (read only)

Order of start-up: `run()` sets up `tauri::Builder`. Tauri runs `setup` at the event loop's `Ready` on macOS (tauri 2.12.5 app.rs:1443). `setup` spawns `launch()` on its own thread, and `launch()` starts the service at lib.rs:164. Everything below runs before that line.

1. **lib.rs:154 → library_window.rs:1816 `at_start` → 1798 `renew` → 1804 `renew_closed` → 2101 → 2197 `remove_data_stores` (macOS only).**
   - With a fresh HOME there is no device file, which is always the case in the launch check, so this runs on every launch-check start.
   - It calls `block_on(app.fetch_data_store_identifiers())`, then `remove_data_store(id)` for each id.
   - Tauri passes both to the main thread (app.rs:433-480; tauri-runtime-wry lib.rs:3201). There wry 0.57.2 (wkwebview/mod.rs:1384-1440) calls `WKWebsiteDataStore fetchAllDataStoreIdentifiers:` with a block2 `RcBlock` whose argument is typed `NonNull<NSArray<NSUUID>>` and dereferenced without a check, and then `removeDataStoreForIdentifier:completionHandler:`.
   - This is unsafe Objective-C on the main thread, about 1 s after start, and it has never run on a Mac. **It could segfault.**
2. **lib.rs:150-153: `configure`, `empty_inbox`; library_window.rs:2060 `close_window_and_wait`; `read_device`/`write_device`/`new_store_id`.** These are safe Rust: files, `getrandom`, and a `get_webview_window` lookup when no window exists yet. A failure would be a Rust panic, which prints in a debug build and gives SIGABRT, not SIGSEGV. **Unlikely.**
3. **lib.rs:405-417: `invoke_handler` with 7 commands; build.rs app manifest; capabilities; `app.manage(shell)` in setup.** The ACL is generated at build time and the code is platform-neutral; an error would be a panic. **Unlikely.**
4. **Cargo.toml: `reqwest 0.13.5` with native-tls.** On macOS this brings `security-framework 3.7.0` / `-sys 2.17.0` and links Security.framework. Nothing calls it at start-up, and those crates have no load-time initialisers that I know of. No existing crate changed version in Cargo.lock; only crates were added (foreign-types, hyper-tls, native-tls, openssl*, schannel, security-framework*, tokio-native-tls, vcpkg, zeroize, rustls-pki-types). **Low.**
5. **Info.plist: `NSFileProviderDomainUsageDescription` (a string); tauri.conf.json: CSP `connect-src 'self'`.** These only take effect when a file-provider folder is read or the page loads. **Not at start-up.**
6. **grant.rs: `Picker::default()` in `Shell::default()`.** This is a plain struct. grant.rs has no Objective-C, no bookmarks and no `unsafe`. **Not a suspect.**
7. **service.rs: `ServiceInput`.** It wraps the service's stdin in `Arc<Mutex>`; it is safe Rust and runs at, not before, the start. **Not a suspect.**

### The three likeliest suspects (suspicion, not finding)
1. **`fetchAllDataStoreIdentifiers` reached from `Library::at_start`** (lib.rs:154 → library_window.rs:2197; wry wkwebview/mod.rs:1384). Reasons:
   - it is the only new native, unsafe, Mac-only call before the service starts;
   - it runs on every fresh-HOME start, at the right moment;
   - the block dereferences an unchecked `NonNull` array;
   - a SIGSEGV with no Rust panic text points to native code.
2. **`removeDataStoreForIdentifier:completionHandler:`** on the same path (wry mod.rs:1414), if the fetch returns any ids. Alternatively, WebKit's data-store API used before any WKWebView or website data store exists in the process, which is the same call site seen from WebKit's side.
3. **Newly linked Security.framework / security-framework 3.7.0** (via reqwest native-tls). This is the only other Mac-specific change that is present at start-up, but nothing calls it before the service starts, so it is far less likely.

The lldb backtrace or the crash report from the next build should settle which, if any, of these it is.

## The fix (R457)

Commit `1df473b`, on top of 35e6e35. One commit; the crash diagnostics are unchanged.

### What changed
- **library_window.rs, the Mac `remove_data_stores` (:2197).** It now calls a new `start_webkit(app)` first. If that returns false, it returns false without touching WebKit, which is the existing failure path.
- **The new `start_webkit` (:2231, `cfg(target_os = "macos")`):**
  - It checks a static `AtomicBool` ("once"), then posts a closure with `app.run_on_main_thread`.
  - On the main thread the closure takes `objc2::MainThreadMarker::new()` and calls `unsafe { objc2_web_kit::WKWebsiteDataStore::defaultDataStore(mtm) }`. The retained store is released on the same thread.
  - The launch thread waits at most 10 s (`recv_timeout`). The flag is set only after a success.
  - The comment at that place gives the crash's stack and why the order matters.
  - `library_window::Config::main_thread` is only a `ThreadId` and cannot run a closure, so Tauri's `run_on_main_thread` is used with a channel for the wait. The callers never run on the main thread: `TauriHost::remove_data_stores` already refuses the main thread.
- **Order:** unchanged. `at_start` still empties the store before `token`/`service::start` (lib.rs:154).
- **Cargo.toml:** new `[target.'cfg(target_os = "macos")'.dependencies]` with `objc2 = "=0.6.5"` and `objc2-web-kit = { "=0.3.2", default-features = false, features = ["std", "WKWebsiteDataStore"] }`. Both crates are already resolved through wry, with the same versions and a superset of these features (checked with `cargo metadata --locked --filter-platform aarch64-apple-darwin`).
  - **Cargo.lock:** only the two names `"objc2"` and `"objc2-web-kit"` are added to ao-desktop's own dependency list. No new package and no version change, and the `--locked` metadata passes.

### Paths to the class methods
The only caller of `fetch_data_store_identifiers`/`remove_data_store` is the Mac `remove_data_stores` (:2197), so the guard there covers all three paths into it:
- `Library::at_start` → `renew` → `renew_closed` (start-up, lib.rs:154);
- `Library::at_quit` → `renew` (quit, lib.rs:458);
- `Library::sign_out` → `renew_closed` (the `sign_out_of_library` command, lib.rs:322).

`renew_closed` (:1804) calls `host.remove_data_stores()` → `TauriHost::remove_data_stores` (:2101) → the Mac `remove_data_stores`.

### Declarations read (registry sources, exact lock versions)
- `objc2-web-kit-0.3.2/src/generated/WKWebsiteDataStore.rs:36-38`: `pub unsafe fn defaultDataStore(mtm: MainThreadMarker) -> Retained<WKWebsiteDataStore>`. It has no extra `cfg`. The module is behind feature `WKWebsiteDataStore` (`generated/mod.rs:584-586`, re-exported at `:2069-2070`) and reaches the crate root through `pub use self::generated::*` (`src/lib.rs:23`).
- `objc2-0.6.5/src/main_thread_marker.rs:230`: `pub fn new() -> Option<Self>`. It is re-exported as `objc2::MainThreadMarker` (`src/lib.rs:143`).
- `tauri-2.12.5/src/app.rs:496`: `AppHandle::run_on_main_thread<F: FnOnce() + Send + 'static>(&self, f: F) -> crate::Result<()>`.
- For the cause: `wry-0.57.2/src/wkwebview/mod.rs:1384-1440` (fetch and remove need the main thread and a running loop) and `tauri-2.12.5/src/app.rs:433-480`.

### (b) When the emptying fails or does not answer
- **Failure.** `renew_closed` still makes a new store id (`new_store_id`), writes the device file and sets it in memory. It returns `removed && written`, so false, and `at_start`'s result is ignored at lib.rs:154. Start-up then goes on and the service starts. The old stores stay on disk, but nothing uses them, because the next sign-in window is built with the new id (`open`, :1502-1503, `create_window` → `window_store` → `data_store_identifier(new id)`): a new, empty store.
- **No device state.** If `new_store_id` fails, the device state stays `None` and `open` refuses (:1502). So no sign-in window can open on a store that was not emptied, or at least not on one that was not replaced; the old store is not reachable through the window.
- **No answer.** There is no existing time bound on the answers. `block_on(fetch_data_store_identifiers())` and `remove_data_store(id)` await their oneshot without a timeout; only the in-use error is retried, 5 × 300 ms. If WebKit never answers, the launch thread waits for ever and the service never starts (the launch check would time out at 120 s). I flag this for a ruling and did NOT change it. The new step itself is bounded (10 s, then false, and WebKit is not asked).

### (c) Tests and what cannot be checked here
- `pnpm --filter @ao/desktop test`: node 107 pass, vitest 78 pass, cargo 124 pass. The Linux build compiles; the new code is macOS-only and is not compiled here.
- CI runs no clippy or `cargo check` for the shell.
- I did not try `cargo check --target aarch64-apple-darwin`, as asked. The Rust target is installed, but there is no Apple SDK here.
- Only the Mac can show:
  - that it compiles;
  - that `+defaultDataStore` really initialises WebKit's main run loop, as R457 assumes;
  - the Linux desktop scenarios (the sign-in window's ten), which I did not run here.
