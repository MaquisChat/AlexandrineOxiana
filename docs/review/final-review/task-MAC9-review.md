# Task MAC9 (R476): review

Reviewed: `mac-tls-certs`, `567d98d..18c06de`, worktree `.claude/worktrees/mac-tls`.

## Verdict: APPROVED WITH SMALL POINTS

Nothing found that would stop the fix working on a Mac or make the Mac build fail. The one build risk is the one every change to `pyproject.toml` brings (Minor 1).

## What I ran
- `tests/test_fetch_tls.py` and `tests/test_packaging_entry.py` with the worker's venv: 24 passed.
- Mutation probes on `ao_worker/fetch.py`. The file was copied aside and restored after each probe. Each mutation made 2 tests fail:
  - M1, `load_default_certs()` removed: `test_the_machines_store_is_still_trusted` and the body-read test failed.
  - M2, `_WatchedHTTPS` back on the default context: `test_the_download_handler_uses_tls_context` and one other test failed.
  - M3, `check_hostname = False` added to the context: `test_tls_context_holds_the_apps_own_list_and_verifies` and one other test failed.
- At the end, `git status --short` printed nothing.

## Findings

### Critical
None.

### Important
None.

### Minor
1. **The Mac build re-resolves every unpinned transitive dependency.** Files: `.github/workflows/desktop-macos.yml:199` and `apps/desktop/scripts/build-sidecars.mjs:142-151`.
   - Both the cache key and the venv stamp hash `pyproject.toml`. Build 9 therefore creates a new build venv and installs from PyPI again.
   - On arm64 there is no constraints file, so transitive packages such as onnxruntime, ctranslate2, tokenizers, huggingface_hub, urllib3 and pikepdf take today's newest versions within their ranges.
   - The ruling's "no other version changing" holds only for the declared pins.
   - Evidence that this is probably harmless: the implementer built a fresh Linux venv today, and its self-check and smoke test pass (25/27; the 2 failures are fixtures that were not fetched). That covers the licence manifest too.
   - Not shown: a new Mac-only wheel.
   - Direction: after build 9, compare its `sidecar-manifest.json` artefact with build 8's.
2. **The capture sentence is not the ruled sentence.** File: `packages/ui/src/api/capture.ts:237`.
   - The interface's capture list uses its own wording ("A tool could not be downloaded because … from the Optional tools screen.").
   - R476 (b) gives one sentence. It is verbatim only in the service (`apps/library-service/src/routes/tools.ts:26-27`, checked word for word).
   - The UI wording is defensible because it follows the style of the neighbouring entries and points to the screen. The coordinator should confirm it or ask for the ruled text.
3. **No test checks a wrong host name.** File: `tests/test_fetch_tls.py`.
   - Host-name checking is held only by `check_hostname is True` (line 131, which M3 caught). No test connects to the 127.0.0.1 certificate under another name.
   - A mismatch raises `SSLCertVerificationError`, so the code would correctly give `TOOL_DOWNLOAD_UNTRUSTED`. The behaviour itself is not tested.
4. **No ToolsSetup screen test for the new code.** The implementer already deferred this. I read the code and it is generic: `ToolsSetup` shows the service's message and offers Try again for every failed job.

## Checked and sound

### certifi on a Mac
- `certifi.where()` uses `importlib.resources.as_file(files("certifi")/"cacert.pem")`.
- In a frozen PyInstaller 6 bundle the resource reader gives a real path under `_internal/certifi/`, so `as_file` returns that path and makes no temporary copy.
- The Linux bundle has `_internal/certifi/cacert.pem`, and the implementer's self-check passed the `is_relative_to(_MEIPASS)` test.

### Packaging and signing
- `stageResources` copies the whole bundle with `cpSync(..., {recursive, verbatimSymlinks})` (`build-macos.mjs:98`).
- `tauri.macos.conf.json` maps `Resources/ao-worker`.
- Signing touches only Mach-O files plus `xattr -cr`. Nothing drops or moves `.pem` data.

### Python's `ssl` on macOS
- `create_default_context(cafile=…)` skips the default store, so the explicit `load_default_certs()` call is needed.
- On non-Windows, `load_default_certs()` is only `set_default_verify_paths()`.
- OpenSSL 3's `X509_STORE_set_default_paths_ex` ignores load failures and calls `ERR_clear_error()`. Missing paths therefore do not raise. The Linux run with absent paths confirms this.
- `load_default_certs()` does not read the Keychain. That gap is FR-722, listed and not built.

### Every connection the worker makes
- Every downloader builds its opener from `watched_handlers`: `fetch.download`, `open_watched`, and `download.py:175`, which is yt-dlp's release lookup. The checksum list goes through `fetch.download`.
- `_WatchedHTTPS` subclasses `HTTPSHandler`, so `build_opener` adds no default HTTPS handler. `https_open` passes `context=self._context`.
- A redirect's second connection goes through the same handler.
- Speech models are loaded with `local_files_only=True`.
- Nothing calls `urlopen` directly.
- Child programs' environment is unchanged.

### Verification is not weakened
- Every path keeps `CERT_REQUIRED` and `check_hostname`, including the fallback, which is `create_default_context()`.
- There is no `CERT_NONE` and no unverified context anywhere.
- A server signed by an untrusted authority is still refused, and a test covers it.

### The Mac workflow step
- `APP_DEBUG` is job-level env, a path relative to the checkout root.
- The `run:` line is single-quoted YAML around a double-quoted path, which handles the space in the app's name.
- The path matches `RESOURCE_LAYOUT.worker` and the Tauri mapping. Its `if:` matches the launch checks.
- The same `--self-check`, including `tls`, already runs in the smoke step on the identical bundle before staging. Inside the app it differs only by ad-hoc signing, and launch checks A-D already run that worker from the app.

### Dependencies and licences
- Nothing in the Intel constraints file mentions certifi or requests, so there is no conflict. `requests==2.34.2` wants `certifi>=2017.4.17`.
- certifi was already in the manifest through `requests`.

### The self-check's `tls` item
- The environment is restored in `finally`, including variables that were unset before.
- It cannot give a false PASS:
  - With both variables pointing under `/dev/null/`, the build machine's default file contributes 0 authorities.
  - The hash-dir lookup is lazy, so it is not counted.
  - So `n > 0` is possible only if certifi's file loaded.
  - The fallback path gives 0 and fails.

### The new code end to end
- `TOOL_DOWNLOAD_UNTRUSTED` reaches the service's `MESSAGES` through `toolFailure`, and is in the shared type and in the UI's `KNOWN_OUTCOME_CODES`.
- `errors.ts` treats every `TOOL_*` code alike.
- The error detail names classes only, never an address.

## Judged by reading only (no Mac)
- PyInstaller's frozen resource reader on macOS. It is the same code as on Linux.
- That the OpenSSL of the Mac runner's Python ignores missing default paths. It is the same OpenSSL 3 code, and the build's own self-check proves it on the runner.
- That the new workflow step passes.
