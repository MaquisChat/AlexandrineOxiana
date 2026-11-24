# KG-6 third look: edb3690 (N1) and 9704f93 (N2), R514

Reviewer: adversarial review of `git diff 0a17de2..9704f93` on `kg-6-shell`. No product code changed, nothing committed.

**Verdict: approve with small points.**
- No deadlock found. No freeze at quit found.
- The hold now ends on the main thread, in the same turn as `load_url`. The new test fails without the change.
- The points below are all Minor. Two of them concern wording; one (m1) is an older path of the same kind as N1.

## What I ran (shared `CARGO_TARGET_DIR`, `nice -n 15`)

| Run | Result |
| --- | --- |
| `cargo test --locked --lib` | `test result: ok. 143 passed; 0 failed` |
| Mac type-check (`--target aarch64-apple-darwin --tests`, clang-18 / llvm-ar-18) | `Finished dev profile`, no warning |
| `node --test apps/desktop/scripts/launch-check.test.mjs` | `# tests 64`, `# pass 64`, `# fail 0` |
| Scratch revert: the old release put back after `moved` (`library_window.rs` ~:1643), with the new signature kept | `an_old_page_s_event_before_the_waiting_open_s_navigation_is_issued_starts_no_fetch` FAILS with `left: [("fedcba98…", "https://publisher.example/article/1.pdf")]` (142 passed, 1 failed). Restored with `git checkout --`. |
| `node -e` probe of `quitSummaryLine([{A passed}], {reached: true, error: "spawn failed"})` | `launch-check: scenario Q result: ran (1 of 1 runs …)` (see m3) |

Housekeeping:
- `git status --short` is empty.
- No `git stash` was used.
- Nothing was refused by a permission check.
- Not run: `build:linux`, the launch check, end-to-end runs.

## Every `navigate` call site

| Call site | Caller's thread | What it holds while it waits | Verdict |
| --- | --- | --- | --- |
| `Library::open` → `host.navigate(&url, issued)` (`library_window.rs:1634`) | A plain `std::thread` that `detached` (`lib.rs:285-296`) starts inside `spawn_blocking`. It is never the main thread and never the async runtime. | **Nothing.** Every `self.lock()` guard in `open` is scoped and dropped before the call: the first block ends at :1595, and the `waited` block's `g` ends at :1623. The `built` Condvar wait is over by then. The ticket and `window_owner` are state, not locks; no other thread blocks on them. `building` is never this ticket on the re-use path, because `building` is set only on the build path. | **Safe.** The `issued` closure takes `inner` on the main thread. No off-main thread holds `inner` while it waits for the main thread (see "Reverse direction" below). |
| `TauriHost::navigate` → `w.navigate(url)` inside the task (`:2221`) | The main thread, as a `Message::Task`. | Nothing. tauri-runtime-wry 2.12.3 `handle_user_message`: `Message::Task(task) => task()` (`lib.rs:3182`) holds no `windows` RefCell borrow. On the main thread, `send_user_message` (:263-273) calls `handle_user_message` → `WebviewMessage::Navigate` → `load_url` (:3690-3694) synchronously. | **Correct.** The navigation is issued in that turn, and `issued()` runs right after. |
| `on_new_window` → `w.navigate(target)` (`:2165`) | A spawned thread. It posts and does not wait. | Nothing. | No deadlock. But it is a hold gap: see **m1**. |
| `library_probe::watch` → `window.navigate(page)` (`:2437`) | A spawned thread, debug builds and test mode only. It posts and does not wait. | Nothing. | Not affected. |
| `FakeHost::navigate` (`:3405`) | The test thread. | Nothing. | It models the order, not the blocking: see **m4**. |

### Reverse direction: can the main thread wait on the caller?

Main-thread code that touches `Library`:
- `page_shown`, `page_loaded`, `download_requested`, `page_retitled` (from `on_page_load`, `on_download` and `on_document_title_changed`, `:2146-2190`).
- `window_closed` (on `Destroyed`).

Each takes `inner` briefly and blocks on nothing. Their host calls are posts that wait for no answer: `set_title`; `emit` via `emit_to` → eval; `start_fetch` → async spawn. Calls that wait on the main thread are all made with `inner` free:
- `take_pdf` calls `current_url` (`w.url()` waits for the main thread) **before** it takes the lock (:1821).
- `renew` calls `close_window_and_wait`, and `renew_closed` calls `remove_data_stores` (posts and `recv`s), outside the lock (:1949-1960).
- `create_window` (`build()` waits for the main thread) runs in `open` with no lock.

Off-main code that holds `inner` (`send_if_current` → `send` to the grant pipe, `emit`; `set_stay` / `open` → `write_device`) waits on no main-thread answer. So two waits cannot cross.

No `Condvar` wait happens on the main thread: `built.wait_while` exists only in `open`.

### `on_main_thread()`

- It compares `std::thread::current().id()` with `Config.main_thread`.
- That ID is captured in `.setup` (`lib.rs:436`). Tauri 2.12.5 runs `setup` from `RuntimeRunEvent::Ready` inside `run_return` (`app.rs:1423-1443`), on the event-loop thread. That is the process's main thread on macOS (AppKit) and on Linux (GTK).
- It is the same thread tauri-runtime-wry treats as `main_thread_id`.
- Before `configure` it answers false. That is harmless: `open` is never on the main thread, and an unconfigured `run_on_main_thread` from the main thread would run inline anyway (`send_user_message`'s own check).
- The inline branch is unused in practice.

## The loop gone or busy

- **`run_on_main_thread` refused** (the proxy's channel is closed): it returns `Err`, and `navigate` returns false.
- **Task accepted, loop then ends:** `Wry::run_return(mut self, …)` consumes the runtime. The event loop and its queue are dropped when it returns, which drops the task and its `tx`, so `recv` gets `Err` and answers false.
  - Even if a platform kept the queue alive, a blocked open thread cannot hold the process. `lib.rs` calls `std::process::exit` right after `run_return` (`lib.rs:528-531`) and does not join that thread.
  - Nothing at quit waits for an open: `at_quit` → `close_window_and_wait` polls `window_exists` for at most 5 s, and `stop_helpers` is independent.
- **Main thread busy for a while:** only the open's own promise waits (as it already did for `create_window`'s `build()`). The open holds no lock. So `close_library_window` (→ `close_window`, a post), `sign_out` (`close_window_and_wait` from its own detached thread) and `take_pdf` all go ahead. Their main-thread tasks queue behind the navigation task in FIFO order.
- `recv()` has no time limit, unlike `start_webkit`'s `recv_timeout(10 s)` (:2540). I found no path where the main thread stays alive yet never runs or drops the task. A time limit is optional hardening, not a needed fix.

## The rule itself (N1)

How the old page's events reach `library_window.rs`:
- `on_page_load` (`page_shown`, then `page_loaded` on `Finished`) and `on_download` (`download_requested`) are called synchronously by wry from WebKit's delegates or signals on the main thread.
- Neither is re-queued. Each takes `inner` and reads `waiting` directly.
- Every such event the main thread handles before the navigation task is therefore held.
- The task issues `load_url` and clears `waiting` in the same turn, with no event dispatch in between.

**This meets R514's rule** for page loads and downloads.

## Findings

### Critical
None.

### Important
None.

### Minor

**m1. A new-window request of the old page can still land after the open's navigation** (`library_window.rs:2158-2168`). Older than these commits; outside the load/download hold.
- The old page's `target=_blank` link or `window.open` reaches `on_new_window` on the main thread, possibly **before** the navigation task, while the hold is still on.
- The callback spawns a thread that **posts** `w.navigate(target)`. That post can be queued after the open's task. The window then leaves the open's own address for the old page's target, and that target's `Finished` is fetched under the new ticket.
- This is an old-page event delivered before the navigation was issued whose effect is not held. It is the same kind of gap as N1.
- It needs the old page to open a new window inside the short wait, so the chance is small. The coordinator may accept it as a remark. If it is to be closed: in `on_new_window`, drop the target while `Library::waiting` holds (read under the lock on the main thread), or do the navigation in a main-thread task that checks the same.

**m2. The comment's claim about WebKit holds for macOS, but the documented WebKitGTK behaviour is different** (`library_window.rs:1627-1631`). The comment says a new navigation cancels the old load, "which then never reports 'finished'".
- **WKWebView (macOS):** a cancelled navigation ends in `didFail(Provisional)Navigation`. wry reports `Finished` only from `didFinishNavigation` (wry 0.57.2 `wkwebview/navigation.rs:53-61`). The claim holds.
- **WebKitGTK (Linux):** its documentation says `load-failed` is followed by `load-changed` with `WEBKIT_LOAD_FINISHED`. wry maps that to `PageLoadEvent::Finished` with `webview.uri()` (`webkitgtk/mod.rs:489-495`). An old load cancelled by `load_uri` can therefore report "finished" after the hold ended.
  - It reports at the URI current at that moment, which after `load_uri` is most likely the open's own address. The likely effect is a fetch of the open's own address, which is harmless.
  - I could not show this here.
- Proposed wording: on Linux, a cancelled old load may still report "finished", at the address the window then has.

**m3. `quitSummaryLine` ignores `error` once any run has an outcome** (`launch-check.mjs:216-228`, `:1625`).
- The case: Q's second run throws **before** its `try` (`scenario(name)` or `startShell`, :1540-1545). Then `q.outcomes = [first run passed]` and `ended` is set.
- The probe printed `scenario Q result: ran (1 of 1 runs …)`. That is "ran" for a check in which a run of Q threw, and "1 of 1" instead of "of 2".
- The check still exits 1 (`main().catch`), so no failure is hidden. But it is against R514's "never claims 'ran' for a run that threw".
- Fix: when `error` is set and fewer outcomes than runs were recorded, answer `FAILED (scenario Q did not finish: …)`. Alternatively, open the inner `try` before `scenario` and `startShell`.
- Two smaller points in the same area:
  - `if (threw)` (:1610) and `ended === undefined` (:1625) treat a thrown falsy value as "no throw". A boolean flag is more robust. Theoretical only.
  - In the outer `finally`, the line is printed after `stopAppProcesses()` and `rmSync`. If either threw, the line would be lost. Printing it first in the `finally` costs nothing.

**m4. The fake host keeps the order but not the blocking, and the test's comment describes the old real host** (`library_window.rs:3405-3416`, `:4012-4016`).
- `FakeHost::navigate` with `defer_issue` returns `true` **before** `issued` runs. The trait now says "the call answers once that is done" (:1391-1392). The real host's open does not answer until the navigation is issued.
- The test's comment, "Those arrive after the open has answered and before the navigation is issued", describes the pre-edb3690 host.
- The test still proves what matters: the hold is tied to `issued`, not to `navigate` returning. The scratch revert confirms it. But the state it builds (open answered, hold still on) cannot happen with the real host.
- Fix: one sentence in the comment, or a note on `defer_issue` that it breaks the trait's "answers once done" on purpose.

**m5. "On every path" excludes failures before the scenarios** (`launch-check.mjs:1278-1312`).
- `q` is created just before the outer `try`. A throw in set-up prints no Q line: a missing program, `leftoverSearchWorks`, `stopAppProcesses`, `startBus`.
- This meets R514's words, which speak of a scenario that throws or an earlier scenario that fails, so it is a remark.

### N2 checks that hold
- The prefix `launch-check: scenario Q result:` is written once; a test asserts it. The crash-diagnosis line (`launch-check: Q (…)`) and the skip lines (`launch-check: skip Q …`) do not match.
- An earlier scenario that throws gives `not reached (…: <first line>)`. A run that throws inside its `try` is `failed` with `it did not finish: …`. A throw before any run gives `FAILED (scenario Q did not finish: …)`.
- On Linux there is no closing line, as before.
- The README matches.
- The wiring in `main` (outer `catch`/`finally`) has no unit test, because it needs the real app. I judged it by reading.

### Failed navigation (attack point 4)
- `issued` is not called when `w.navigate` fails, or when the window is gone (`self.window()` is `None`). `navigate` answers false.
- `open` then takes the `!shown` branch (:1648-1670): it clears the ticket, gives the window back to its owner, and answers **false**.
- `waiting` is left as the old ticket, but `Self::waiting` needs `waiting == ticket` (:1781-1783), and the ticket is now `None`. Every later fetch is then refused anyway, with `NoTicket`, until the next `open` overwrites `waiting` (:1577).
- So no fetch is held for ever.
- Behaviour is the same as before edb3690.

## What I could only judge by reading
- WebKit's own order for cancelled loads on both platforms (m2), and whether WKWebView can deliver a download decision for the old page after `loadRequest`.
- That `setup` and the event loop share one thread on a real Mac.
- The tao and tauri queue being dropped at the end of `run_return`. This is moot because of `process::exit`.
- The N2 wiring in `main`.
- Whether `startShell` or `scenario` can throw in practice (m3).
