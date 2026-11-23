# Task MAC9 — report (R476)

Branch `mac-tls-certs` in `/home/user/AlexandrineOxiana/.claude/worktrees/mac-tls`, from 567d98d. Commits (not pushed):
- 09c688f (a) the worker's own certificate authorities
- ce0e000 (b) TOOL_DOWNLOAD_UNTRUSTED
- 18c06de (c) the self-check, the smoke test, the Mac workflow step

## (a) The worker's own certificate authorities — 09c688f
- `services/media-worker/ao_worker/fetch.py`: `_ca_file()` (certifi's `where()`, None when certifi is missing) and `tls_context()`: `ssl.create_default_context(cafile=certifi)` then `load_default_certs()` in addition. If certifi's file cannot be read (OSError / SSLError / not installed): `ssl.create_default_context()` and one warning (class name only, no path). `_WatchedHTTPS.__init__` passes `context=tls_context()`, so every download (and `download.py`'s release lookup through `watched_handlers`) uses it. Verification unchanged (CERT_REQUIRED, check_hostname True). The context is built per handler (per download), so it reads the environment of that moment.
- `services/media-worker/pyproject.toml`: `certifi==2026.10.23` declared, with a one-line comment. Verified: 2026.10.23 in the worker's venv and in the fresh build venv this task made (`apps/desktop/.build/venv-default`). Note: PyPI's newest is 2026.11.20 (3 days old); a build venv resolved without the pin would have taken it — the pin holds it at today's resolved version, as ruled.
- Intel pin set `packaging/constraints-macos-x86_64.txt`: no line needed (certifi is a pure-Python wheel; the build drops a direct pin only for packages the constraints file names). `dists.py`/`manifest.py`: unchanged; certifi was already a run-time distribution through `requests` and the built bundle's manifest lists it exactly once (MPL-2.0 licence file included). No test pins the declared-dependency list except the gallery-dl one, which still passes.
- Tests: `tests/test_fetch_tls.py` (new; a throw-away authority and 127.0.0.1 certificate made with `cryptography`, a local HTTPS server). Failed first: the handler's context with SSL_CERT_FILE/SSL_CERT_DIR pointing nowhere had `x509_ca == 0` (`assert 0 > 0`); `tls_context`/`_ca_file` missing for the helper, the "handler uses tls_context" and fallback tests. Passed already (regression guards): a server signed by nobody trusted is refused; the machine's store (SSL_CERT_FILE set to the test authority) is still trusted. The certifi-pin test was written after the pyproject edit (it fails against 567d98d's pyproject, which has no certifi).

## (b) TOOL_DOWNLOAD_UNTRUSTED — ce0e000
- Worker `fetch.py`: `UNTRUSTED_MESSAGE`, `failure_detail(e)` (`URLError/<inner class>` or the class), `untrusted(e)` (SSLCertVerificationError directly or as a URLError's reason), `opening_error(e)` used where opening failed (covers a redirect's new connection, which fails inside the same open). The body-read path raises the new code too when the cause is an SSLCertVerificationError. Other opening failures keep TOOL_DOWNLOAD_FAILED "no connection", detail now `URLError/gaierror`, `URLError/TimeoutError`, `URLError/ConnectionRefusedError`.
- `download.py` `_download_ytdlp`: the `(OSError, ValueError)` branch (where `_latest_tag`'s own HEAD connection fails) raises TOOL_DOWNLOAD_UNTRUSTED for an unverifiable certificate, else TOOL_DOWNLOAD_FAILED with the class-name detail. `_fetch` and the asset download already pass `fetch`'s code through.
- Service `apps/library-service/src/routes/tools.ts` MESSAGES: the ruled sentence, verbatim. Shared `packages/shared/src/api/tools.ts` ToolErrorCode gains the code. UI `packages/ui/src/api/capture.ts` OUTCOME_TEXT: the ruled sentence. Other places: `apps/library-service/src/errors.ts` treats any `TOOL_*` alike (no change needed); the Optional tools screen offers Try again for every failed job (no change needed). No Rust or e2e reference.
- Tests, all failed first for the right reason: worker (`test_fetch_tls.py`: untrusted server → code, message, detail `URLError/SSLCertVerificationError`, no address in the JSON; same after a redirect from plain HTTP; a refused connection → `URLError/ConnectionRefusedError`; the classifier for six exception shapes; an SSLCertVerificationError during the body read; the yt-dlp release lookup → UNTRUSTED); service (`src/tools-routes.test.ts`: the exact sentence and a retry is 202); UI (`src/api/capture.test.ts`: the exact sentence, code known).

## (c) The build proves it — 18c06de
- `packaging/entry.py`: `tls_check()` — fails unless certifi's file exists and, when frozen, lies inside `sys._MEIPASS`; sets SSL_CERT_FILE/SSL_CERT_DIR to `/dev/null/ao-absent/...` (cannot exist), builds `fetch.tls_context()`, restores both exactly (also an unset one), fails on 0 authorities, returns `"<n> authorities from the app's own list"`. `self_check()` adds it as `versions.tls` or `failed.tls`.
- `packaging/smoke_test.py`: a separate check line for `tls` (fails without it), so its output is shown. `build-sidecars.mjs --smoke` (CI's worker-bundle job and the Mac job) exits 1 when the smoke test fails — no change needed. `launch-check.mjs` does not run the self-check (unchanged).
- `.github/workflows/desktop-macos.yml`: the Mac job already ran the self-check through the smoke step, but on `apps/desktop/sidecars/<triple>/` (the bundle that gets copied into the app), not from inside the built `.app`. Added one step after "Launch check A-D": `"$APP_DEBUG/Contents/Resources/ao-worker/ao-worker" --self-check` (same `if:` as the launch checks, 5-minute limit; path as launch-check.mjs locates the app's worker). `build-macos.test.mjs` + `mac-targets.test.mjs`: 45/45.
- Tests `tests/test_packaging_entry.py` (new), all 6 failed first (no `tls_check`): the count line and env restored; the context is read with both variables pointing at absent paths; fails without certifi's file; fails at 0 authorities; frozen with the list outside `_MEIPASS` fails, inside passes; `self_check` reports `tls` and returns 1 on its failure.

### Built bundle (Linux x86_64, `node apps/desktop/scripts/build-sidecars.mjs`, 163 s)
- `ao-worker --self-check`: `ok: true`, `"tls": "118 authorities from the app's own list"`, exit 0. Bundle's `_internal/certifi/cacert.pem` is byte-identical to certifi 2026.10.23's (118 certificates).
- Negative check: with `_internal/certifi/cacert.pem` renamed away, `--self-check` → `ok: false`, `failed.tls: "RuntimeError: the app's own list of certificate authorities is missing"`, exit 1 (file restored after; exit 0 again).
- Smoke test as CI does (`--skip-build --smoke`): 25/27 pass incl. `PASS the downloads trust the app's own certificate authorities, with the machine's default paths absent (R476) — 118 authorities from the app's own list`; the 2 failures are the DNG fixture and the speech clip, absent because `pnpm fetch-fixtures` was not run here (CI runs it). With `--allow-missing dng,clip`: PASSED (25/27, 2 skipped).

### The probe (against the source with the worker's venv; the bundle refuses to run arbitrary scripts, so no simple way)
- Normal environment: `OK 2249 bytes`.
- SSL_CERT_FILE/SSL_CERT_DIR pointing nowhere: `OK 2249 bytes` — NOT `TOOL_DOWNLOAD_UNTRUSTED` as the brief expected. Reason: this machine's proxy does not re-sign huggingface.co; through the tunnel the server presents its real chain (issuer "Amazon RSA 2048 M01"), which certifi trusts. So this run proves (a) on a real download: the same probe on 567d98d's code (checked out into the scratchpad) gives `TOOL_DOWNLOAD_FAILED | no connection | detail: URLError | CERTIFICATE_VERIFY_FAILED`.
- To show (b) on the real download: defaults absent AND certifi's file made unreadable (`_ca_file` patched) → one warning, then `TOOL_DOWNLOAD_UNTRUSTED | the download was refused: the server's certificate could not be verified | detail: URLError/SSLCertVerificationError`.

## Runs
- Worker, whole suite `-m "not slow"`: 214 passed, 1 skipped, 8 deselected. (`ao_worker.__file__` checked: resolves inside this worktree.)
- `@ao/library-service` `src/tools-routes.test.ts`: 19 passed. `@ao/ui` `src/api/capture.test.ts`: 42 passed.
- Typecheck `@ao/shared`, `@ao/ui`, `@ao/library-service`: exit 0 each.
- `node --test apps/desktop/scripts/build-macos.test.mjs apps/desktop/scripts/mac-targets.test.mjs`: 45 passed. `pnpm test:scripts` not run (no script it covers was touched); launch-check not touched.
- `git status --short`: empty. The build venv, PyInstaller work folder and bundle are under `apps/desktop/.build/` and `apps/desktop/sidecars/` (git-ignored; left in place).

## Uncertain / what only a Mac can show
- That the Mac build's Python really has absent default paths on the owner's Mac (the ruling's own NOT SHOWN). The fix works either way; the self-check now proves the app's own list on the Mac build machine with the defaults made absent.
- macOS: `load_default_certs()` on macOS uses OpenSSL's default paths only (not the Keychain), as on Linux — so an inspecting proxy whose authority is only in the Keychain is still refused, now with the new sentence (FR-722, listed not built).
- The new Mac workflow step has not run (no Mac here). It assumes the executable is `Contents/Resources/ao-worker/ao-worker` in the debug app, as launch-check.mjs does.
- The owner's VPN as a cause: if it re-signs TLS, build 9 shows the new UNTRUSTED sentence; if it is the build-path cause, build 9 downloads.
- minor (deferred): no ToolsSetup screen test for the new code (the screen shows the service's sentence and Try again for every failed job, generically).
