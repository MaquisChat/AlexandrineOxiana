# Desktop app (`@ao/desktop`)

The desktop app will be a Tauri shell that starts the library service and the media worker as
helper programs ("sidecars"). The shell does not exist yet. So far this folder holds only the
build of the helpers:

- `scripts/build-sidecars.mjs` builds the packaged media worker for the machine it runs on (Task
  37d): `apps/desktop/sidecars/ao-worker-<target triple>/` with the executable `ao-worker`, its
  `_internal/` folder and `sidecar-manifest.json`. `--smoke` also runs its smoke test. See
  "Packaging" in `services/media-worker/README.md`.
- `pnpm --filter @ao/desktop build:sidecars` and `smoke:sidecars` are shortcuts for it.

`.build/` (build venvs, PyInstaller's work files) and `sidecars/` (the output) are git-ignored.
The target triple follows Tauri's sidecar names (`aarch64-apple-darwin`, `x86_64-apple-darwin`,
`x86_64-unknown-linux-gnu`). The shell itself (37c), the library service running outside the
repository (37a), the Mac build workflow (37f) and signing (37g) are other tasks.
