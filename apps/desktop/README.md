# Desktop app (`@ao/desktop`)

The desktop app is a Tauri 2 shell (`src-tauri/`) that shows the built interface in the system web
view, starts the library service (which starts the media worker), hands the interface its
connection, provides native file and folder pickers and dropped-file paths, and stops everything
when it closes (Task 37c, ruling R155). It holds no library logic. How it starts and stops the
service, and the environment it gives it, are in `docs/adr/0013-desktop-shell.md`.

## The shell

- `src-tauri/src/lib.rs`: start-up, the window, closing, signals, the second launch.
- `src-tauri/src/service.rs`: starting the service (token on standard input, ready line, time
  limit), stopping it (closing its standard input, waiting for its process group, forcing).
- `src-tauri/src/helper_env.rs`: the service's allow-listed environment, each name with its reason.
- `src-tauri/src/connection.rs`: the page's connection script and the addresses the window may show.
- `src-tauri/src/paths.rs`: where the helpers are (packaged resources; development overrides in
  debug builds only).
- `src-tauri/src/token.rs`: the access token.
- `src-tauri/src/probe.{rs,js}`: the launch check's in-page probe (debug builds with NODE_ENV=test only).
- `src-tauri/capabilities/main-window.json`: what the page may ask of the shell: listen for events
  (drag and drop) and open a file or folder picker. Nothing else.
- `src-tauri/tauri.conf.json`: the content-security policy, identical to `packages/ui/index.html`'s,
  delivered unchanged (`dangerousDisableAssetCspModification`: Tauri's additions would add hashes to
  the policy and, in `style-src`, switch off `'unsafe-inline'`).

The interface talks to the shell only through `packages/ui/src/desktopShell.ts`.

**The app identifier** `org.alexandrineoxiana.desktop` is defined in one place, `identifier` in
`src-tauri/tauri.conf.json` (JSON takes no comments, so the note is here). It decides the app's data
folder (on a Mac `~/Library/Application Support/org.alexandrineoxiana.desktop`), under which the
shell has the service keep everything (R159): `settings/` (AO_CONFIG_DIR: app settings, pairings,
the outbox), `tools/` and `models/`; and it names the single-instance lock. It is kept for now and
must be confirmed by the owner before the first release: changing it later moves every user's
settings. Without the shell (CLI, tests, the end-to-end harness) the service's own default folder
is unchanged.

Closing holds the single-instance lock until the service and the worker are gone; a second launch
during that time is noted by the first instance, which starts the app again once they are gone.

## Building on Linux

The web view's development libraries (Ubuntu 24.04):

```sh
apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev build-essential pkg-config libssl-dev
```

and Rust 1.97 with cargo. Then:

- `pnpm --filter @ao/desktop run build:linux` builds the library service folder, copies the notices
  the About screen shows (`generated/notices/`, git-ignored), builds the interface, and builds the
  shell (debug; `-- --release` for the release profile). Output:
  `src-tauri/target/debug/alexandrine-oxiana`.
- `pnpm --filter @ao/desktop run launch-check` starts the built shell under `xvfb-run` and checks
  the start, the page reaching the service and the worker, the granted commands, the helpers'
  environment, the second launch, and that no process is left after closing the window, SIGTERM or
  SIGKILL of the shell, and after a service that refuses to start. It needs `xvfb-run` and
  `dbus-daemon`; `ffmpeg` for its audio and video checks. The worker: `AO_DESKTOP_WORKER_BIN`, else
  the packaged worker in `sidecars/`, else the development one (`pnpm setup:py`).
- `pnpm --filter @ao/desktop test`: the launch check's own tests, the Mac build's tests that need no
  Mac (`scripts/build-macos.test.mjs`, `scripts/node-release.test.mjs`), the desktop end-to-end
  harness's unit tests (`e2e/*.test.ts`, Vitest) and the shell's Rust tests.

The steps the Linux and the Mac builds share are in `scripts/build-common.mjs`.

## The desktop end-to-end test (Linux)

`pnpm e2e -- --desktop-only` (from the repository root; not part of a plain `pnpm e2e`, because it
needs the built app) drives the debug build `build:linux` makes through its real window, by
WebDriver: `tauri-driver` in front of the system's `WebKitWebDriver`. One scenario
(`e2e/desktop.e2e.ts`): the library chooser; the first-use Optional tools dialog ("Not now"); a
library at a typed folder and a project; a PDF attached with "Choose files…" through the native GTK file dialog; the
source listed; the stored copy, the untouched original and the audit entries on disk; the window
closed as its close button does; no process of the app left; nothing under the real home folder
created or modified. Its results are in `pnpm report` under
"The desktop app end to end".

- Each run gets a private Xvfb display and D-Bus session bus, and its home, settings, data and
  libraries under one temporary folder (`e2e/desktop.ts`, `e2e/lifetime.ts`). Every process it
  starts (Xvfb, the bus and the session services it starts, such as dconf and the portals, the
  drivers, the app and its helpers, xdotool) gets HOME and the XDG folders there, and each is
  started in its own process group. The `run` fixture (`e2e/fixtures.ts`) stops all of them,
  unmounts the document portal and removes the folder however the test ends, a time-out included,
  and saves the app's output and the clean-up's own notes (`e2e/test-results/*/shell-output.txt`)
  when the test did not pass or the clean-up left something; a last sweep at process exit covers a
  run that was never torn down. The app runs without its test mode: no
  NODE_ENV, no probe. It starts its own service with its own token, which the test never sees; what
  the service wrote is read from disk.
- The native file dialog is the real one. WebDriver cannot reach it, so the test finds it on the
  display by its title and types the file's path into it with `xdotool` (Ctrl+L, the path, Return).
  Only the person's key presses are made by the test.
- Closing: the test sends the window the window manager's close message (`WM_DELETE_WINDOW`, `e2e/x11.ts`).
  WebDriver's own "close window" is not used, because WebKitWebDriver kills the app's process the
  moment its last window closes.
- Not covered: the native folder picker ("Choose folder…"): the library is created at a folder typed
  into the chooser, because the GTK folder chooser completes a typed path with a trailing "/" and
  Return then opens the folder instead of choosing it; a file dropped from another program (an OS drag
  and drop cannot be made under Xvfb); and the macOS app (there is no WebDriver for the Mac web view).
- **If a run was killed.** A test runner killed outright (SIGKILL, or a crashed terminal session)
  runs no clean-up at all, so its run stays behind: Xvfb, the bus and its portals, the drivers, the
  app with its service and worker, a FUSE mount of the document portal, and the run's folder in the
  temporary folder. Nothing in the test process can prevent that. The next run finds such leftovers
  (a run folder whose owning test process is gone) and stops with a list of them, before starting
  anything. When no desktop test is running, remove them with:

  ```sh
  # 1. stop every process of an earlier run (each carries its run folder in its environment)
  for p in $(grep -l "ao-desktop-e2e-" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3); do kill -KILL "$p"; done
  # 2. unmount the document portals' file systems, then remove the run folders
  for m in $(awk '$2 ~ /ao-desktop-e2e-/ {print $2}' /proc/self/mounts); do fusermount3 -u -z "$m"; done; rm -rf "${TMPDIR:-/tmp}"/ao-desktop-e2e-*
  ```
- The real home folder is checked before and after the run, but only where this run's programs
  would write (GTK's and dconf's settings, the portals' stores, WebKitGTK's and the app's folders;
  `HOME_WATCHED` in `e2e/desktop.ts`), so other programs of a person's session can run alongside.
  That the run's processes use no other place in the real home is checked per process: each has HOME
  and every XDG folder inside the run's folder.
- The WebDriver client is `e2e/webdriver.ts`, a few W3C commands over `fetch`; the published clients
  bring in packages under licences other than MIT, Apache-2.0 and BSD. Playwright (`@playwright/test`
  1.63.0, Apache-2.0) is only the test runner; no browser of its own is started.

It needs, besides the built app (Ubuntu 24.04 package names):

```sh
apt-get install -y webkit2gtk-driver xvfb dbus xdotool
cargo install tauri-driver --version =2.1.0 --locked   # or set TAURI_DRIVER to its path
```

and the media worker as the launch check finds it (`pnpm setup:py` is enough). CI runs the build,
`cargo test`, the launch check and this scenario in the `desktop` job of `.github/workflows/ci.yml`:
on `main`, on manual runs, and on working-branch pushes that change `apps/desktop/**`,
`apps/library-service/scripts/**`, `services/media-worker/packaging/**` or the workflow.

To run the debug shell by hand:

```sh
AO_DESKTOP_NODE=$(command -v node) \
AO_DESKTOP_SERVICE_DIR=$PWD/apps/library-service/dist/library-service \
AO_DESKTOP_WORKER_BIN=<a packaged worker, or a script that runs the development one> \
apps/desktop/src-tauri/target/debug/alexandrine-oxiana
```

## The helpers' build

- `scripts/build-sidecars.mjs` builds the packaged media worker for the machine it runs on (Task
  37d): `apps/desktop/sidecars/ao-worker-<target triple>/` with the executable `ao-worker`, its
  `_internal/` folder and `sidecar-manifest.json`. `--smoke` also runs its smoke test. See
  "Packaging" in `services/media-worker/README.md`.
- `pnpm --filter @ao/desktop build:sidecars` and `smoke:sidecars` are shortcuts for it.

`.build/` (build venvs, PyInstaller's work files) and `sidecars/` (the output) are git-ignored.
The target triple follows Tauri's sidecar names (`aarch64-apple-darwin`, `x86_64-apple-darwin`,
`x86_64-unknown-linux-gnu`). The Mac build is below; signing with a Developer ID is Task 37g.

## Building for macOS

Two downloads, each built on its own GitHub Mac (R133): **Apple Silicon** on `macos-15` and
**Intel** on `macos-15-intel`. Both need macOS 15.0 or later. They are signed ad hoc, not with a
Developer ID (R151), so a Mac asks once before opening them (below).

**Not yet run.** The workflow and the build script were written and checked on Linux (Task 37f); the
first run on a Mac is the first time any of it meets macOS. What could not be checked is listed in
the Task 37f report under "Unverified until the first Mac run".

### What the workflow does

`.github/workflows/desktop-macos.yml` ("Desktop (macOS)") runs only when started by hand or when a
version tag (`v1.2.3`) is pushed, never on a branch push: Mac minutes are billed at ten times Linux
minutes. For each architecture it:

1. installs the pinned tools: Node.js (the release in `macos/pins.json`), pnpm, Python 3.13,
   Rust 1.97 and tauri-cli (`pins.json`), with caches keyed on the lock files;
2. runs `scripts/build-macos.mjs --debug-app`: the pinned Node.js release (downloaded from
   nodejs.org and checked against the SHA-256 in `pins.json` before use), the library service folder
   (built by that Node, with darwin native modules), the packaged worker (the Intel one on its own
   pin set, `services/media-worker/packaging/constraints-macos-x86_64.txt`), the notices and licence
   texts, the interface, then Tauri's bundler for the `.app`; it copies Node, the service folder and
   the worker into `Contents/Resources` (`src-tauri/tauri.macos.conf.json`; where
   `src-tauri/src/paths.rs` looks), signs the app as `macos/signing.json` says (today ad hoc), fails
   if any program or library in it needs a macOS newer than 15.0, and makes the disk image
   `dist-macos/Alexandrine-Oxiana-<version>-<apple-silicon|intel>.dmg` with its `.sha256`;
3. checks it on the runner: the packaged worker's smoke test (with Homebrew's ffmpeg and tesseract,
   which the app itself does not ship), the launch check A–E on the debug build of the app (the same
   bundle layout; only a debug build reports what the check reads), and check R on the release app
   run from the mounted disk image: its service and worker start from the app's own resources, the
   service listens on 127.0.0.1 and refuses a request without its token, and nothing is left after
   the app is stopped;
4. uploads the disk image and its SHA-256 as the run's artefacts, and writes the sizes and checksums
   in the run's summary.

On a Mac with the same tools, `pnpm --filter @ao/desktop run build:macos` does step 2 by hand;
`node scripts/build-macos.mjs --dry-run [--arch arm64|x64]` prints the steps on any system.

**Launch check scenarios on a Mac** (`scripts/launch-check.mjs --app <debug .app>`): A (normal close,
the page reaching the service and the worker, the granted commands, the helpers' environment, the
second launch), B (SIGTERM), C (SIGKILL: the service sees its standard input close) and D (a service
that refuses to start) are expected to work as on Linux: they use only the shell's own test output,
standard input and signals. E (opened again while closing) depends on the single-instance plugin on
macOS and is the least certain. On a Mac the processes are read with `ps` instead of `/proc`, there
is no virtual display or D-Bus (the runner has a logged-in desktop session), and the helpers'
environment is read with `ps -E`.

### Starting it by hand (on the GitHub website)

1. Open the repository on github.com and click **Actions** (top of the page).
2. In the list on the left, click **Desktop (macOS)**.
3. Click **Run workflow** (on the right, above the list of runs). Under "Use workflow from", choose
   the branch to build; under "Which downloads to build", choose **both**, **apple-silicon** or
   **intel**. Click the green **Run workflow** button.
4. The run appears in the list after a few seconds. A cold run takes roughly an hour per
   architecture (estimate); the two run side by side.

### Where the downloads appear

Open the finished run (click its name in the list). At the bottom of its **Summary** page, under
**Artifacts**, are `alexandrine-oxiana-macos-apple-silicon` and `alexandrine-oxiana-macos-intel`.
Each downloads as a `.zip` holding the disk image (`.dmg`) and its SHA-256. They are kept for 30
days. Which one: Apple menu > About This Mac: "Chip: Apple M…" means Apple Silicon, "Processor:
…Intel…" means Intel.

### Opening the unsigned app the first time ("Open Anyway", R151)

1. Double-click the `.zip`, then the `.dmg`, and drag **Alexandrine Oxiana** onto **Applications**.
2. Open it from Applications. macOS says it cannot check the app for malicious software. Click
   **Done** (not "Move to Trash").
3. Open **System Settings > Privacy & Security** and scroll down to **Security**. Next to the
   message that Alexandrine Oxiana was blocked, click **Open Anyway**, confirm with your password or
   Touch ID, then click **Open**.

This is needed once per download. From then on the app opens normally. On macOS 15 the older way
(Control-click the app, then Open) no longer skips this step.

### For Task 37g (signing and notarisation): written down, not enabled

`macos/signing.json` is the only place to change: `identity` (or the `APPLE_SIGNING_IDENTITY`
variable from a secret, with the certificate imported into a keychain by the workflow),
`hardenedRuntime: true`, and an entitlements file per part. With an identity every Mach-O file is
signed inside out, each with a secure timestamp. The entitlements each part is expected to need
under the hardened runtime (to be confirmed by trying, not added in advance):

- **the shell** (`app`): none expected; the web view's JavaScript runs in the system's own WebKit
  processes.
- **Node.js** (`node`): `com.apple.security.cs.allow-jit` for V8's compiler; possibly
  `com.apple.security.cs.allow-unsigned-executable-memory`. Not
  `com.apple.security.cs.disable-library-validation` while every `.node` file is signed with our
  Team ID, and never `com.apple.security.cs.allow-dyld-environment-variables` (R153).
- **the worker** (`worker`): none at first; `com.apple.security.cs.allow-unsigned-executable-memory`
  only if a ctypes or cffi callback fails (ADR 0014).

Apple expects code in `Contents/MacOS`, `Contents/Frameworks` or `Contents/Helpers`, not in
`Contents/Resources`, where the helpers are today (`src-tauri/src/paths.rs`); if notarisation or the
signature check refuses that, the helpers move and `paths.rs` with them.
