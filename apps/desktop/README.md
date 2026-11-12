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
- `pnpm --filter @ao/desktop test`: the launch check's own tests and the shell's Rust tests.

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
`x86_64-unknown-linux-gnu`). The Mac build workflow (37f), signing (37g) and the desktop
end-to-end test (37h) are other tasks.
