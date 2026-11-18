# FR-A4 (R361) report

Status: DONE. Branch `fr-a4-signout`, commit 110708a, in `/home/user/AlexandrineOxiana/.claude/worktrees/agent-a43a7756acd4b0b1a`. Not pushed.

## What changed
- `apps/desktop/src-tauri/src/library_window.rs:1798-1806`: `renew` is now the wait (`close_window_and_wait`) followed by `renew_closed` (:1804), which does the emptying exactly as before. `at_start` and `at_quit` still call `renew`, so they are unchanged.
- `library_window.rs:1842` `sign_out`: it closes the window and waits. If `host.window_exists()` is still true afterwards, it returns false: no store is removed, no new id is made, nothing is written, the sign-in hosts and "Stay signed in" are kept. If the window has gone, it calls `renew_closed(host, stay)` as before.
- `apps/desktop/README.md` ≈ line 153: one clause on this case.
- `lib.rs` is untouched: `sign_out_of_library` already passes the bool through. `Cargo.lock` is unchanged.

## The page
`sign_out_of_library` answers false. The "Your library" screen (`packages/ui/src/screens/YourLibrary.tsx:101,576`) then says "Signing out did not work. Close the sign-in window and try again." That is true here, and it keeps the window marked as possibly open. The page is not changed.

## Quit and start-up
- Quit: `closing` is set before `at_quit`, so `stopping()` is true. That refuses `open`, and `page_loaded`, `download_requested` and `take_pdf` start no fetch. The process then exits. So forgetting the hosts there opens no hole.
- Start-up: `at_start` runs before any window can exist, because `open` is refused while `device` is None. Nothing is left open to fail to close.

## Tests
- The new test is `a_sign_out_whose_window_does_not_close_keeps_the_sign_in_hosts_and_does_not_complete` (:3813). It runs on both forms (can_stay false and true).
- The fake host gained `close_refused`.
- It failed first at the sign_out assertion ("the sign-out did not complete (can_stay false)"). It passes now.
- The existing tests are untouched and green.

## Runs
- `cargo test --locked`: 124 passed. Final line: `test result: ok. 0 passed; ... (doc-tests)`.
- `pnpm --filter @ao/desktop test`: 78 vitest tests and 124 Rust tests passed. Final line: the doc-tests' `test result: ok. 0 passed`.
- `build:linux`: `build:linux: done: …/target/debug/alexandrine-oxiana`.
- `launch-check`: `launch-check: all checks passed`.
- `e2e` with `AO_E2E_SYSTEM_SETUP=1`, run once: `10 passed (3.3m)`.
- Mac `cargo check --tests`: `Finished dev profile ... in 2m 57s`.

## The machine
- Before the e2e run, `/var/lib/ao-e2e-library-standin` was absent. It was still absent after.
- `sha256sum /etc/hosts /etc/ssl/certs/ca-certificates.crt` and `ls -la /usr/local/share/ca-certificates` were identical before and after (`diff` empty).
