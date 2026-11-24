# RE-7g: R486 C (g), (h) and (i)

- **Worktree:** `.claude/worktrees/re-7d`
- **Branch:** `re-7d-find`, from 77b491e. Not pushed.

| commit | point | files | part |
|---|---|---|---|
| **9ba367f** | (g) A-M1 and A-M2 | `library_window.rs` only | **FR-561** |
| 12dcb45 | (i) B-M2 | `closing.rs` only | FR-297 |
| fe498d6 | (h) B-I1 | `launch-check.mjs` only | FR-297 |

## (g) FR-561: a failed open leaves the window owned by the open whose window it is

### What changed (`apps/desktop/src-tauri/src/library_window.rs`)
- `:1438-1441`: a new field, `Inner.building`. It holds the ticket of the open whose window is being built.
- `:1545-1549`: `open` sets `building` before it builds a window. It does not set it when it re-uses a window, and it does not overwrite a build that is already under way. If two builds are under way, the first one's window is the one that stands.
- `:1580-1592`, the failed-open path:
  - It asks `host.window_exists()` **before** it takes the lock, so no lock is held across a host call.
  - It clears its own `building` entry.
  - It restores the owner as follows:
    - if a window stands, the owner is the one before this open (`before`), and if there was none, the open whose window is being built;
    - if no window stands, there is no owner.
- `:1600-1610`, the shown path: it clears its own `building` entry under the same lock as the `open_still_its_own` check.
- Unchanged: `close_allowed`, `open_still_its_own`, `close_for`, `window_closed`, and the page.

### Tests
- **`a_newer_open_failing_while_an_older_window_is_built_leaves_that_window_to_the_older_open` (`:3614`).** The reviewer's sequence in the stand-in host:
  1. T1 is building.
  2. A ticketless close finds no window, ends T1 and clears the owner.
  3. T1's window stands.
  4. T2 re-uses the window, and its navigation fails.
  5. T1 answers true.
  6. `close_for(T2)` does nothing, and `close_for(T1)` **closes** the window.
  - It failed first: "the older open's close was refused" (1 vs 2).
- **`a_failed_open_leaves_the_window_to_the_open_whose_window_it_is_and_none_when_none_stands` (`:3639`).** This is A-M2.
  - First half: after a hand-over, T2's re-use fails. T2's ticketed close does nothing, and T1's ticketed close closes the window. This half passed on the old code, because the restore already existed. With only the restore of `window_owner` removed, the test fails, as A-M2 asks.
  - Second half: no window stands and a build fails. Neither ticketed close does anything. This half failed first on the old code, which restored the stale owner T1, so `close(T1)` ran `window_closed` (4 vs 3 events).
- **Guard removal.**
  - Without `.or_else(|| g.building.clone())`, the first test fails.
  - Without the restore of `window_owner`, both tests fail.
  - I put the file back after each run.
- **The existing FR-561 tests are unchanged and pass.**

### Needs your ruling (built as ruled; this case is outside the ruling)
- A probe (since removed) shows the same ownerless window **with no newer open at all**:
  1. T1 is building.
  2. The page's ticketless close finds no window, ends T1 and clears the owner.
  3. T1's window stands, and T1 answers **true**.
  4. `close_for(T1)` is refused.
- The probe printed `answered=true exists=true closed=false`.
- R486 g rules only for the failed open. Once the page sends its ticket (R477 b), this simpler case leaves the same window that nothing but the researcher can close.
- I did not fix it. A one-line fix exists: when a build answers and no owner is set, set the owner to that build's ticket. `building` makes this direct.

## (h) B-I1: scenario E's slowed stop is 12 s
- **The change:** `apps/desktop/scripts/launch-check.mjs:1246-1249` now sets `AO_SHELL_TEST_SLOW_STOP_MS` to `"12000"` (it was `"6000"`), with a comment explaining why.
  - The shell caps the stop at 60 s (`lib.rs:519-521`).
  - The check is as strict as before: the page title is still required.
- **Time limits that could depend on the stop's length:**
  - "the quit to begin" (30 s) ends before the sleep.
  - The second launch (60 s) and "relaunch noted" (10 s) do not depend on the stop's length.
  - "the first instance's helpers to stop" (120 s) is ample for 12 s plus the stop.
  - The CI step "Launch check" (`.github/workflows/ci.yml:266-268`) allows 15 minutes; the check takes about 2.5. The job allows 40 minutes.
  - **Nothing had to grow.**
- **Tests:** `launch-check.test.mjs` does not pin the number, so it is unchanged. No unit test can show this. Only the launch check shows it, and I did not run it.

## (i) B-M2: the closing window does not take keyboard focus
- **The change:** `apps/desktop/src-tauri/src/closing.rs:49-52` adds `.focused(false)`, with a comment.
- **The test:** I extended the existing `the_closing_window_is_granted_nothing`, which already reads `open()`'s source (`:148-152`).
  - It now asserts that `open()` contains `.focused(false)` and has no `.visible(` call.
  - It failed first, before the change, at `closing.rs:148`.
  - Whether the window is really shown is seen only by the launch check's `AO_SHELL_CLOSING_WINDOW … visible=` line, which I did not run.

### Declarations read (in `~/.cargo/registry/src/index.crates.io-*/`; the versions are those in `Cargo.lock`)
- **tauri 2.12.5:**
  - `src/webview/webview_window.rs:584-590`: `WebviewWindowBuilder::focused(bool)` sets both the window builder's `focused` and the webview builder's `focused`. The doc says "Whether the window will be initially focused or not."
  - `src/window/mod.rs:887` is the window builder's version.
- **tauri-runtime 2.12.2:**
  - `src/window.rs:349-352`: `WindowBuilder::focused`.
  - `src/webview.rs:684-689`: `WebviewAttributes::focused` sets `focus`.
- **tauri-runtime-wry 2.12.3:**
  - `src/lib.rs:774`: the default is `focused(true)`.
  - `:1017-1018` maps it to tao's `with_focused`.
  - `:4739` passes it to wry's `WebViewBuilder::with_focused`.
- **wry 0.57.2:** `src/lib.rs:1465-1470`: `with_focused`. Its doc says "macOS / Android / iOS: Unsupported."
- **tao 0.37.2:**
  - `src/window.rs:551-560`: `with_focused`. Its doc says "Android / iOS: Unsupported."
  - **Linux,** `src/platform_impl/linux/window.rs`:
    - `:88-90`: the GTK window is built with `accept_focus(focusable && focused)`, so false here.
    - `:225-229`: `show_all()` runs when `visible` is true, whatever the focus.
    - `:231-244`: `accept_focus` is turned back on after the first draw.
    - So the window is shown and does not take focus. It can still be focused by a click.
  - **macOS,** `src/platform_impl/macos/window.rs:604-611`: when `visible`, the window gets `orderFront` instead of `makeKeyAndOrderFront`. It is shown, put in front, and not made the key window.

### On a Mac (by reading only)
- The closing window is ordered to the front but does not become the key window, and it does not use tao's activation hack (`window_activation_hack`, which applies to the focused path only).
- If the app is not active (after a SIGTERM or logout, or when the researcher has switched apps), it may still appear behind other apps' windows, as before.
- WKWebView ignores wry's `with_focused`, so only the window-level setting takes effect.
- `is_visible()` should still report true. Only the Mac launch check (scenario F) can confirm it.

## Runs (nice -n 10)
- `cargo test --lib`:
  - Before: 132.
  - The new tests against the old code: 3 failed for the reasons above.
  - At the end: **134 passed, 0 failed**.
- `node --test apps/desktop/scripts/launch-check.test.mjs`: **49 passed, 0 failed**.
- Not run, as the brief says: `build:linux`, the launch check, and the end-to-end runs.
- `apps/desktop/src-tauri/target` is deleted. `git status --short` is empty.

## R489: a window built after its open was closed belongs to that open (commit c8cb276, FR-561, `library_window.rs` only)

### What changed
- `library_window.rs:1599-1615`, the path an open takes once its window is shown:
  - It asks `host.window_exists()` before it takes the lock.
  - Under the lock, if the window stands and has no owner, the owner becomes this open's ticket.
  - It then checks `open_still_its_own` as before.
- If the window already has an owner, that owner is kept, so an overtaken open still answers false.

### The test
- **`a_window_built_after_its_open_was_closed_is_that_open_s_and_its_ticketed_close_closes_it` (`:3647`).** It is the probe written as a test:
  1. An open is building its window.
  2. A ticketless close finds no window, ends the open (one "closed" event) and clears the owner.
  3. The window is built, and the open answers true.
  4. Another ticket's close does nothing.
  5. The open's own ticketed close **closes** the window.
- It failed first: "the open's ticketed close was refused" (1 vs 2).
- The existing FR-561 tests are unchanged and pass.

### The opposite danger (an overtaken build taking the window): not found
The owner is taken only when it is None while the window stands. A newer open sets the owner to its own ticket, under the lock, before it builds or re-uses the window. It loses the owner only in these cases:
- **`window_closed`.** The window is then gone. If the newer open re-used the window, its navigation to the destroyed window fails. Either way, no window stands for the older open to take.
- **Its own failed open (R486 g).** The owner then goes back to the open whose window stands: the one before, or the build under way. If no window stands, the owner is None, and a window that stands later can only be the older build's own.

While a newer open is in flight or has succeeded, the owner is that open's ticket. The older open therefore answers false and takes nothing.

### One residue, by reading only
Two builds with the same label could overlap only after the older ticket was ended. In tauri 2.12.5, `manager/window.rs:66-72` refuses a second label in `prepare_window`. That is checked before the build, so this needs both builds to pass the check before either window is registered. If the OLDER build then completes first while the newer open is still in flight:
- The older open answers false, because the newer open owns the window.
- That clears `building`.
- If the newer build then fails, the window that stands, which is the older build's, is left with no owner.

No newer window is ever closed by mistake. I judge this unreachable and did not build anything for it.

### Runs
- `cargo test --lib`: **135 passed, 0 failed**. I rebuilt `target` for this and deleted it again afterwards.
- `git status --short`: empty.
