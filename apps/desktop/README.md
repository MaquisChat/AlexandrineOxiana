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
- `pnpm --filter @ao/desktop test`: the launch check's own tests, the desktop end-to-end harness's
  unit tests (`e2e/*.test.ts`, Vitest) and the shell's Rust tests.

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
  and saves the app's output (`e2e/test-results/*/shell-output.txt`) when it did not pass; a last
  sweep at process exit covers a run that was never torn down. The app runs without its test mode: no
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
`x86_64-unknown-linux-gnu`). The Mac build workflow (37f) and signing (37g) are other tasks.
