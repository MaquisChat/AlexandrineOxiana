# Task MAC7 — report

Worktree `.claude/worktrees/ci-flake`, branch `ci-find-runner-flake`, from a9f6768. Not pushed. Three commits, one per point of part 2:

- `5b1289b` launch check: the report server keeps what it saw and prints it when the item fails
- `79acb01` probe: reports its progress to `/progress/<step>` (a channel that does not depend on navigation)
- `50e6f87` shell: in test mode prints the sign-in window's navigations, page loads and address, and opens the check's page itself when no page started within 10 s; the check prints that trace and fails the item if the fallback was needed

No fix of the cause (part 3): reading does not prove it. See below.

## Part 1: the cause, as far as reading goes

**What the Mac log shows.** The FAIL line (08:17:38.508) comes 120.05 s after "the page opened the sign-in window" (08:15:38.461). So the check waited its whole limit, and the server's `got` stayed `undefined` the whole time: no request to `/report` arrived at all. An unreadable `/report` sets `got = null`, which would have ended the wait at once. Nothing on the shell side reacted either: there was exactly one `AO_SHELL_LIBRARY opened`, no browser was opened, and the window stayed open.

**The path the probe has to take.** The main window's probe opens the window at `https://127.0.0.1:<port>/sign-in` (`library_probe::open_address`). The check's server speaks plain HTTP, so the TLS handshake fails. Nothing else in the design brings the window to `/page`. The probe gets there only by running in the error page that replaces the failed address (its `proto !== "http:"` branch then calls `location.replace(cfg.page)`). On Linux I ran the new check with a debug build of this branch, printing the trace by force. WebKitGTK commits an error page at the https address (`page-load started https://…/sign-in`), the probe runs there with `location.protocol` = `about:` (`/progress/script-about`, then `/progress/error-page`), and it goes on to `/page`. The whole run takes about 150 ms. The server sees two TLS greetings, which it logs as `HPE_INVALID_METHOD`.

**Ruled out by the code or the log**
- *The probe is not installed for this window on a Mac.* wry 0.57.2 `wkwebview/mod.rs:595` sets `shares_controller` to false for a window the shell builds, because it gets a new `WKWebViewConfiguration` (:253–259, `using_existing_config` false). :700–701 then installs every initialization script through `init` (:850–861) as a `WKUserScript` with `AtDocumentStart` and `forMainFrameOnly` = true (tauri `initialization_script` sets `for_main_frame_only: true`, `webview/mod.rs:943–951`). The data store by identifier (:273–285) and `incognito` choose only the `WKWebsiteDataStore`; neither touches the user content controller. A page served over http does not change that either.
- *The shell's navigation policy refuses `/page` or `/report`.* `navigation_allowed` allows `http` and `https` on every platform. wry's Mac `navigation_policy` (navigation.rs) passes every frame's URL to it, and tauri-runtime-wry `lib.rs:4821–4826` lets an unparseable URL through.
- *The report arrived in a form the server did not read.* The 120 s timing rules this out, as said above. The report's address is about 1.2 KB (1,157 characters on Linux), far below Node's 16 KB header limit.

**Remaining, most likely first**
1. **The probe never ran on the Mac, because WKWebView shows no error page for a failed first load.** wry's Mac navigation delegate implements only seven methods (`class/wry_navigation_delegate.rs:50–100`: policy for an action and for a response, commit, finish, two download methods, process terminated). It has no `didFailProvisionalNavigation`/`didFailNavigation` and loads no page of its own. wry's own comment at `wkwebview/mod.rs:1441–1443` says the WKWebView URL "is nil … after a failed initial navigation". With no committed document there is nothing for a user script to run in, so nothing ever goes to `/page` and nothing reports. Everything in the log is consistent with this. What reading cannot reach is WebKit itself: that WKWebView commits no stock error page is Apple's behaviour, not code I can read here. So it is very likely, but not proven.
2. **The probe ran, but each attempt waited out its 10 s limit.** There are 25 attempts and `fetch.ipc`, so up to 260 s, which is more than 120 s. The arithmetic does not rule this out, and the code does not show why IPC from a remote page would stay silent on a Mac (on Linux every refusal is back in about 2 ms). The next build's `/progress/<n>-<outcome>` requests, timed by the server, settle it.
3. Less likely, and not ruled out by reading: the report navigation is refused by App Transport Security for a navigation (as opposed to a `fetch`), or by WebKit for a navigation a script started without a user gesture. The next build would show `navigation http://…/report allowed`, then no `/report` request, then `/progress/report-still-here`.

**Does the window itself behave differently on a Mac?** Yes, in one way the code proves. When a load fails (no network, a DNS or TLS error, a server that is down), WebKitGTK shows its own error page, while on a Mac the researcher sees a blank window (or the previous page stays), with no message, and the shell hears nothing. Neither wry nor tauri reports a load failure on any platform. `library_window.js` runs on a Mac through the same `WKUserScript` mechanism that runs Tauri's own scripts, and those demonstrably run on the Mac (the main window's probe reported). For an https page that loads, I see no reason in the code for it not to run in the sign-in window. That script follows a page's `citation_pdf_url` once per session, so that the shell fetches the PDF. It has not yet been observed in the sign-in window on a Mac. If the fallback is used and the probe then reports from `/page`, that shows the window's initialization scripts run there.

## Part 2: what the next build prints, and where

When the item fails, these lines follow the FAIL line (`launch-check.mjs`, scenario A):
- `launch-check:   the report server saw N things:`, then one line per event with its time since the server started: `a connection`, `a request it could not read as HTTP (HPE_…; a TLS greeting reads so)`, or `GET /path (query of N characters)`. The query's content is never kept. Or `the report server saw nothing (no connection at all)`.
- `launch-check:   the shell said of the sign-in window (N):`, then each `AO_SHELL_LIBRARY_TRACE` line without its prefix. Or `the shell said nothing of …`.

Probe steps (`library_probe.js`; requests sent with `no-cors` and `keepalive`): `script-<scheme>`, `error-page`, `start`, `<n>-<denied|allowed|error|no-answer|no-IPC>` after each of the 25 attempts, `raw`, `report-<length>`, and `report-still-here` (sent 3 s after a report navigation that has not left the page).

Shell lines (`library_window.rs`, `library_probe` module; debug builds, test mode, probe switch set):
- `AO_SHELL_LIBRARY_TRACE navigation <addr> allowed|refused`
- `page-load started|finished <addr>`
- `address after 10 s: <addr>` or `none (<error>)`
- `fallback: no page started in 10 s; the shell opens the check's page`, after which the shell navigates the window to `/page`. The check then fails the item ("no page started … reached it only through the shell's fallback" or "… reported nothing even there"), so the evidence never turns into a pass by itself.

R325 forbids an address in any line the shell prints. So only the check's own addresses (127.0.0.1 at the report address's port) and `about:` are printed, by scheme, host, port and path; any other address is printed by its scheme alone. The existing printing test is extended, not loosened. A load failure's error text cannot be printed with platform-independent hooks, because neither crate exposes one. What shows a failed load instead is a navigation that was allowed, no page load after it, and `address after 10 s: none (… URL is nil)`. Mac-only delegate code would be needed for the error text, and I judged it not worth a blind compile.

Expected log if (1) holds: `navigation https://127.0.0.1:P/sign-in allowed`, no page load, `address after 10 s: none (…)`, `fallback …`, the server showing one or more unreadable greetings and then `GET /page`, `/progress/script-http`, and so on.

## APIs used, read in the exact versions (all platform-independent; nothing Mac-only was added)
- tauri 2.12.5 `src/webview/webview_window.rs:266` `on_navigation<F: Fn(&Url) -> bool + Send + 'static>`; `:421` `on_page_load<F: Fn(WebviewWindow<R>, PageLoadPayload<'_>) + Send + Sync + 'static>`; `:1008` `initialization_script`; `:2506` `url(&self) -> crate::Result<Url>`; `:2511` `navigate(&self, url: Url)`.
- tauri 2.12.5 `src/webview/mod.rs:118` `PageLoadPayload::url() -> &Url`; `:123` `event() -> PageLoadEvent`.
- tauri-runtime-wry 2.12.3 `src/lib.rs:4821` (navigation) and `:4959` (page load).
- wry 0.57.2: Mac `wkwebview/navigation.rs` (commit → `Started`, finish → `Finished`), `wkwebview/mod.rs:778` `url()` and `:1441` `url_from_webview`; WebKitGTK `webkitgtk/mod.rs:489–494` (`load-changed`), `:826–840` (user scripts, `TopFrame`, `Start`).
- `cargo check` passes on Linux in debug and release (the release one after touching the file, so that it really rechecked); `cargo build` and the Linux launch check pass.

## Tests
- `node --test apps/desktop/scripts/launch-check.test.mjs`: 44/44. The new tests are the report server (a real server with HTTP requests and a TLS greeting), the probe run in a `vm` stand-in page (outside page, error page, outcomes), and the trace with its fallback. The probe tests failed first on the old probe (3 failures).
- Rust: new `the_sign_in_windows_trace_names_scheme_host_port_and_path_never_the_query`. Extended `a_release_build_has_neither_…` (no `AO_SHELL_LIBRARY_TRACE`, no `traced`, the plain `.on_navigation(navigation_allowed)` in a release build) and `nothing_of_a_cookie_address_ticket_or_path_is_printed` (the probe module's prints are pinned exactly). Changed: the probe-config assertion in `the_probe_reports_only_to_the_checks_own_loopback_address` now also expects `progress`.
- `pnpm --filter @ao/desktop test`: node 115/115, vitest 78/78, cargo 125/125.
- The Linux launch check with this branch's debug shell: all checks passed. The worker was the integration checkout's venv Python, through a scratch script (nothing in that checkout changed). The service folder was built in the worktree (it is gitignored).

## Possible Mac compile risks
Low. All new code goes through the platform-independent tauri APIs above, which compile here. The one assumption that depends on the platform is that `tauri::WebviewWindow` is `Send` when moved into the watcher thread. The code already does this with windows from `get_webview_window` in spawned threads.

Recommended fix once confirmed (not done): show the probe its page without relying on an error page, for example by opening the window at the check's page directly. And, for researchers, consider a Mac load-failure page; that needs a hook wry does not offer.
