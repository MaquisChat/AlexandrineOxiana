# Task 54 — whole-branch review, part WB7 (desktop shell, browser extension, media worker)

Reviewer 7 of 7. Checkout `.claude/worktrees/agent-a0328b7cc1ec55b55` (branch `wb-review`, 7b81976). Read-only; one probe (a Python script run with the worker's existing `.venv/bin/python -I`, kept in the session scratchpad, not in the repository; deleted). No cargo runs, no installs, no suites. `git status --short` in the checkout shows nothing of mine.

## What I read

End to end:
- `apps/desktop/src-tauri`: `Cargo.toml`, `tauri.conf.json`, `tauri.macos.conf.json`, `Info.plist`, `build.rs`, `capabilities/main-window.json`, the generated permissions, `src/lib.rs`, `connection.rs`, `token.rs`, `helper_env.rs`, `paths.rs`, `grant.rs` (code part), `service.rs` (code part), `library_window.rs` lines 1–2260 (all non-test code), `library_window.js`.
- `apps/browser-extension`: `manifest.json`, `package.json`, `vite.config.ts`, `scripts/build.mjs`, `src/background.ts`, `api.ts`, `find.ts` (sending part, 150–540), `find-protocol.ts`, `find-tab.ts`, `find-tab-entry.ts`, `content/index.ts`, `content/entry.ts`, `content/profile-scroll.ts`.
- `services/media-worker`: `pyproject.toml`, `ao_worker/__main__.py`, `app.py`, `jobs.py`, `download.py`, `ocr.py`, `video_proxy.py`, `image_proxy.py`, `location.py`, `transcribe.py`, `toolpins.py`, `unpack.py`, `packaging/entry.py`, `packaging/constraints-macos-x86_64.txt`; `tools.py` and `fetch.py` in their install/which/run/redirect parts.
- The seams on the service side: `packages/library/src/worker-client.ts` (job run, decrypt, publish, rewritePaths, startWorker, workerEnv), `capture/link-capture.ts` 470–560, `import/proxies.ts` + `extract/exif.ts` `checkProxyLocation`, `app-settings.ts` `ensurePrivateDir`, `apps/library-service/src/auth.ts` (pairing store), UI `serviceConnection.ts`, `SnapshotFrame.tsx`, the UI's blob URL uses.

Sampled only: `library_window.rs` tests (2260–4777), `service.rs`/`grant.rs`/`paths.rs` tests, `probe.rs`/`probe.js`/`library_probe.js` (debug-only, checked they are `cfg(debug_assertions)` and test-mode gated), `Popup.tsx` (grepped for sinks and messages), the extension's extractors/screenshot, `hallucination.py`, worker tests, `packaging/manifest.py`/`smoke_test.py`/`licence_texts.py`.

## Findings

### Critical
None.

### Important

**I1 — the image proxy carries the photo's free-text JPEG/GIF comment into the "strip" and "coarsen" copies.**
`services/media-worker/ao_worker/image_proxy.py:122-144`. `img.save(tmp, "JPEG", exif=…, **extra)` passes an explicit `exif` but no `comment`; Pillow 13's JPEG writer takes `comment = info.get("comment", im.info.get("comment"))` (`.venv/.../PIL/JpegImagePlugin.py:808`), and `ImageOps.exif_transpose` / `convert` copy `im.info`. So a source's COM marker (or a GIF comment) is written into the proxy whatever the location mode. Probe (Pillow 13.0.0, the worker's own `image_proxy.run`, `location: "strip"`, a JPEG with GPS EXIF, XMP with GPS and `comment=b"Participant Jane Roe, 12 Elm Street"`):
```
comment: b'Participant Jane Roe, 12 Elm Street'
xmp present: False
gps ifd: {}
raw contains Jane: True contains GPSLatitude: False
```
GPS and XMP are removed correctly; the comment survives. The module's own contract (line 23: "Tags carried over: device and capture time only (no serial numbers, owner names or maker notes)") is not met, and under R83 / R90 c the strip/coarsen proxy is the form of located media that goes into exports. The service's re-check (`extract/exif.ts:221 locationTagsMatch`) looks only at location-named tags, so it passes. No test covers it (`tests/test_image_proxy.py` checks GPS and ICC only). The ICC profile is also kept on purpose (`test_icc_profile_is_kept`); its description strings are usually harmless, but it is the same class of carried-over metadata.
Direction: build the saved image's metadata from nothing but the kept EXIF (pass `comment=b""` or clear `img.info` before saving), decide the ICC question explicitly, and add a test with a COM marker under each mode.

**I2 — the shipped media worker's Python dependencies are not pinned exactly.**
`services/media-worker/pyproject.toml:13-23`: `numpy>=2.1,<3` is a range, the build backend is `setuptools>=69`, and the whole transitive closure that goes into the bundle (ctranslate2, onnxruntime, tokenizers, huggingface_hub, pikepdf, lxml, cryptography, pypdfium2, pdfminer.six, …) is resolved by pip at build time (`apps/desktop/scripts/build-sidecars.mjs`; the only constraints file is the Intel one, and it pins five packages). There is no lock file and no `--require-hashes`. Two Mac builds a week apart can ship different native libraries, and a hijacked release of any transitive package would be taken silently. The standing rule (CLAUDE.md, the common brief: "dependencies pinned exactly") is not met for the one component that ships native code from PyPI. FR-319 (checking that the build environment and the bundle hold the same versions) is related but is not this point.
Direction: a per-platform hashed lock (e.g. `pip-compile --generate-hashes` or `uv lock`) for the bundle's closure, installed with `--require-hashes`; `numpy` pinned to one version.

### Minor

**M1 — the service believes the worker's list of produced files without checking it against what it published.** `packages/library/src/capture/link-capture.ts:490-491, 539` take `meta.files`, `meta.infoJson`, `meta.comments` from the worker's answer; `worker-client.ts` `rewritePaths` (≈787) rewrites only paths under the job's `out` folder and leaves any other absolute path as it is; `result.files` (what `publish` actually moved) is not compared. A path outside the job's folder named by the worker would be read and copied into the library as an original. The worker lists only its own `out` folder today (`download.py:425-439`), so this is defence in depth (check 3). Direction: keep only entries of `meta.*` that are in `result.files`.

**M2 — for the file-output jobs the worker's scratch folder sits inside the folder the service publishes wholesale.** `jobs.py:128` puts the workdir at `Path(job.output).parent / ".work-<id>"`; for `video.proxy` and `pdf.ocr` the service's output is `<tmp>/out/<name>` (`worker-client.ts:476-478`, `DIR_OUTPUTS` = transcribe and download only), so the workdir (TMPDIR of ffmpeg / ocrmypdf, which hold copies of the decrypted input) is `<tmp>/out/.work-<id>`, and `publish` moves every regular file under `out` into the library. The worker removes it before it reports `done` (`jobs.py:314`, `rmtree(ignore_errors=True)`), so nothing leaks today; a failed removal or a late write by a stray grandchild would be published as output. Direction: put the workdir beside `out`, not in it.

**M3 — the main window may be navigated top-level to an app-origin `blob:` document, which then receives the token.** `connection.rs:51-56` allows `blob:` whose inner origin is the app's, for every frame including the top one; `init_script_for` (`connection.rs:30-39`) sets `__AO_SERVICE__` whenever `location.origin` is the app's, which is true for `blob:tauri://localhost/…`. Only the `SnapshotFrame` iframe needs `blob:`. I found no path that navigates the top frame to a blob (the picture blobs go into `<img>`, new windows are denied, drops are taken by Tauri), so this is hardening: a blob made from a service answer of an unexpected type would run at the app's origin with the token and the IPC.

**M4 — the extension's token is readable from content-script contexts.** `api.ts:150-152` keeps the pairing in `storage.local`, whose default access level includes content scripts; the extension injects content scripts into arbitrary pages (capture, find-tab). Only a compromised page renderer could use that, but `storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` (Chrome; Firefox has no equivalent) would close it. R110 asks only for local, not sync, so this is hardening.

**M5 — the background's message guards have no test.** `background.ts:271-324` (`isPopup`, `isOwnContentScript`, `validTab`, `validId`, the overlay messages limited to the sender's own tab) decide which context may start a capture, a profile send or a PDF send; no test imports `background.ts` (grep of `src/*.test.ts`, `e2e/`), so deleting any guard fails nothing. `find.ts`'s port guard is tested (`find.test.ts:664`).

**M6 — the device file's sign-in host list is unbounded, and once it no longer fits every new library start is refused.** `library_window.rs:1505-1513` appends each new library host and, with "Stay signed in" on (macOS), refuses the start when `write_device` fails; `write_device` (`:1266-1270`) fails once the text passes `DEVICE_MAX_BYTES` (4096), i.e. after roughly 100–150 distinct sign-in hosts. The open answers false with no event saying why, until a sign-out. Rare; direction: cap or drop the oldest, or say why.

**M7 — `POST /tools/update` runs outside the tools lane.** `app.py:223-227` runs `download.update_tools()` in the request thread; it can replace the managed yt-dlp (`--update-to stable`, or `_download_ytdlp`) while a `tool.install`/`tool.update`/`tool.remove` job of the video downloader runs in the tool lane, and neither path takes `tools._lock("yt-dlp")` (`tools.py:470-474, 556-563`). Each write is atomic or yt-dlp's own, so the result is one of the two versions; the answers can disagree with what is on disk.

**M8 — the worker's shell-free subprocess calls take ffmpeg input formats unrestricted.** `video_proxy.py:135, 186` limit protocols to `file` (and `pipe`) but not the input format: a "video" that is in truth a playlist-type file can make ffmpeg read other local files into the proxy (the classic HLS/concat local-read pattern). Recent ffmpeg narrows the HLS probe; I could not run ffmpeg here (see "could not verify"). Direction: refuse playlist/concat demuxers (`-f` from the probed container, or `-allowed_extensions`/a format whitelist).

## The specific checks

**1. Every Tauri command and every extension message handler: who can call it, worst use.**
Yes, checked. Tauri: seven app commands, each declared in `build.rs` (so Tauri generates and enforces an `allow-*` permission), granted only by `capabilities/main-window.json` (`windows: ["main"]`, `local: true` — remote origins excluded); each command also checks `window.label() == "main"` itself (`grant.rs:122`, `library_window.rs:1491, 1674, 1756, 1843, 1857, 1878`). The sign-in window (label `library`, remote pages) is granted nothing and gets no connection script. Worst case from a compromised main page: open an https address in the system browser (`/usr/bin/open`/`xdg-open`, one argument, no shell; `library_window.rs:1887-1913`), open the sign-in window at an https address, start one fetch per ticket into the inbox (the file only waits in the review queue, R301), pick a folder (the path never reaches the page), sign out. Core permissions granted: event listen/unlisten and `dialog:allow-open` only. A remote page in the sign-in window can cause at most one fetch per open ticket (a load at a PDF-looking address or a download request), fetched under all of `fetch_pdf`'s rules, never from a sign-in address, handed over only while its ticket is current.
Extension: `runtime.onMessage` (own extension only; no `externally_connectable`, no `onMessageExternal`), split into popup-only messages (`isPopup`: own id and the popup page's URL) and two overlay messages accepted only from the extension's own content script in a top frame and acting on the sender's tab only; `onConnect` accepted only for the sending under way, own id, the injected tab, frame 0, once (`find.ts:342-359`). A web page cannot reach either (its scripts cannot see the isolated world; the overlay's buttons are in a closed shadow root). Worst use by a page during a profile run it is the subject of: it controls which links are on the page, which the service limits to post/video URLs (R116).

**2. Any secret reaching a log, a process argument list, an inherited environment or a wide-permission file.**
No, as far as read. The service token is made from the OS random source (`token.rs`), written only on the service's stdin (`service.rs:226`) and into the main window's init script (origin- and top-frame-guarded); `env_clear` plus an allow-list for the service (`helper_env.rs`, NEVER_PASSED includes the token names and NODE_OPTIONS); the shell prints no token even in test mode. The worker's token travels on stdin (`worker-client.ts:963-976`); the worker refuses it in env/argv (`__main__.py:91-104`), moves fd 0 to /dev/null so no tool inherits the pipe, and gives children an allow-listed env without the token (`jobs.py:45-51`). Logs: worker URLs logged without query/fragment, cookie options never logged, error details redacted (`download.py:85-110`); the sign-in window module formats no cookie, address, ticket or path (Debug impls blank them). Files: device file 0600 atomic with O_NOFOLLOW (`library_window.rs:1266-1300`), inbox 0700 owner-checked, part files 0600 O_EXCL|O_NOFOLLOW; the settings folder is chmod 0700 by the service (`app-settings.ts:26-35`); pairings stored as token hashes, 0600. Cookies of the sign-in window are read in memory only. Hardening only: M3, M4.

**3. The worker: each job kind from the service's request to the result in the library — is the result checked before it is believed?**
Partly. Common path: the service makes `<Library>/.tmp/worker-<id>/` 0700, decrypts an encrypted input into `in/` 0600, the worker writes into `out/`, the service moves (or encrypts) every regular file found there (symlinks skipped by `Dirent.isFile`) and rewrites paths in `meta`.
- `image.proxy` / `video.proxy`: the output is re-read with ExifTool and its location tags checked against the mode before it is recorded (`import/proxies.ts:326`, `exif.ts:213-261`) — yes for location; not for other metadata (I1).
- `audio.transcribe`: the store takes `transcript.vtt`/`segments.json` by base name from `result.files` (`transcript-store.ts:41`) — tied to what was published; contents parsed as text/JSON.
- `capture.download`: the file lists in `meta` are taken as given (M1); the info JSON is stripped (`stripSnapshot`) before it leaves the work folder.
- `pdf.ocr`: the worker opens its own output with pikepdf to count pages; the sidecar text comes back in `meta`.
- tool installs: every pinned download is checked by size and SHA-256 before unpacking; zips unpacked with traversal/link/duplicate/size refusals (`unpack.py`); executables made 0755 only after verification; yt-dlp checked against its release's SHA2-256SUMS (ADR 0009, R126).

**4. Dependencies: not pinned exactly, or fetched at run time.**
Cargo: every crate `=`-pinned, `Cargo.lock` committed — yes. Extension and desktop `package.json`: exact — yes. Worker: no (I2). Fetched at run time, by the researcher's action only (R156): yt-dlp latest (+ `--update-to stable`, its own updater), deno 2.9.8, ffmpeg 9.0.2, tessdata, gallery-dl 1.32.19 wheel, speech models at fixed revisions — all but yt-dlp pinned by URL, size and SHA-256 (`toolpins.py`); yt-dlp by the same release's checksum list (integrity against corruption, not against the publisher; accepted by ADR 0009). Redirects restricted to listed hosts, never https→http (`fetch.py:120-140`). A speech model on disk is loaded with `local_files_only=True` (`transcribe.py:69`).

## Checked and sound

- Token hand-over: init script only for the exact app origin and top frame (and the Rust tests run it in Node for foreign origins); UI deletes `__AO_SERVICE__` after reading; main-window navigation limited to the app origin; new windows denied; devtools only in debug builds.
- Debug-only machinery (`probe.rs`, `library_probe`, `AO_DESKTOP_*` overrides, `test_mode`) is behind `cfg(debug_assertions)`; a release build ignores the override variables.
- Grant and file-grant lines: serde_json-encoded, one line, length-bounded, refused for relative/NUL/non-UTF-8 paths; written under the same lock as the pipe's close.
- `fetch_pdf`: https every hop, manual redirects ≤5, each hop resolved by the shell and checked against private/loopback/link-local/transition ranges, connection pinned to the checked address and the answer's peer compared, no proxy/cookie store/cache, cookies recomputed per hop (RFC 6265 host-only/domain/path/secure/expiry), `%PDF-` sniff, size and time limits, Referer reduced.
- Sign-in window store: own data store on macOS, ephemeral elsewhere; emptied at start (after a crash), at quit unless kept, at sign-out only once the window is gone (R361).
- Worker launch refusals (token in env/argv, tty, timeout, bad shape); `hmac.compare_digest`; 127.0.0.1 only; every route authorised first; 1 MB body limit; job ids are UUIDs; all subprocess calls are argv lists without a shell, URLs after `--`; children in their own session, killed as a group on cancel and at shutdown.
- `unpack.py`: absolute, `..`, backslash, drive-letter, link/special, encrypted and case-duplicate members refused; byte count enforced while writing; `realpath` containment.
- Video `strip`: only the first video and audio streams mapped (data streams such as GPS telemetry dropped), global/stream metadata and chapters removed; coarsen writes only a recomputed ISO 6709 value.

## Mac-only parts nothing here has run (stated plainly)

`window_store` with `data_store_identifier` and `remove_data_stores` (WKWebsiteDataStore), `store_can_stay` / "Stay signed in", the Safari-form User-Agent's acceptance by publishers, `/usr/bin/open`, the `Info.plist` ATS and File Provider keys, `tauri.macos.conf.json` bundling of node/service/worker, the single-instance socket, process-group stop without a subreaper on macOS, the worker's `_strip_quarantine`, yt-dlp's `--cookies-from-browser` against the Keychain, the PyInstaller bundle's `-m ocrmypdf|gallery_dl` dispatch, and the extension in real Chrome/Edge/Firefox on a Mac.

## Could not verify

- M8: whether the bundled ffmpeg 9.0.2 still auto-probes a playlist demuxer from a file named `.mp4`/`.mov` (needs ffmpeg; none here). A probe with a crafted file would settle it.
- Whether yt-dlp's `--update-to stable` verifies a signature beyond its checksum list in the version installed (needs the binary and network).
- Whether Tauri 2.12.5 injects its IPC bridge into the remote sign-in window and refuses there every command, including the internal channel commands (read: no capability names that window; a runtime probe of the release build is the proof — the debug launch check's `library_probe.js` covers the app's own commands).
- The real worker bundle's contents (FR-320 still holds).
