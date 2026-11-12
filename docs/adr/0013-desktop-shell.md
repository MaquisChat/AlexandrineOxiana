# 0013. How the desktop app ships the library service

- **Status:** Proposed
- **Date:** 2026-11-11

## Context

The desktop shell (Tauri 2, Task 37c) starts the library service as a helper process (ADR 0002).
Until now the service only ran from inside the repository, with `tsx` and the workspace's
`node_modules`. Task 37a makes it run from a folder that can be shipped. The service needs, besides
its code:

- two worker-thread scripts: the citation style sandbox (R88, R89) and the HTML snapshot cleaner (R101);
- the index's SQL migrations;
- the citation style bundle and locales, with their CC BY-SA 3.0 licence and notice (R86), and the
  citeproc-js package with its CPAL-1.0 notice (R124, R129);
- three native modules, built for one Node ABI, platform and architecture: `better-sqlite3`
  (the index), `@napi-rs/keyring` (the OS keychain) and `@napi-rs/canvas` (pdf.js's optional
  geometry and canvas support in Node);
- ExifTool, which `exiftool-vendored` runs as a Perl script with the system Perl (ADR 0014, risk R5).

The memory ceiling `--max-old-space-size=512` (R64, R96) is a Node start-up flag; the program cannot
set it for itself. The Mac app is built for Apple Silicon and for Intel, as two downloads (ADR 0014),
so everything native exists per architecture anyway.

Two ways to ship it were considered:

1. **A single executable** (Node's "single executable applications", or a third-party packager):
   one file holding Node and the bundled script.
2. **The Node program beside the bundle:** the official Node binary, unchanged, plus a folder with
   the bundled service and its files, started as `node <flags> service.mjs`.

## Decision

Ship **the Node program beside the bundle** (option 2).

The build (`pnpm --filter @ao/library-service run build`, `apps/library-service/scripts/build.mjs`)
makes `apps/library-service/dist/library-service/`:

| Path | What |
| --- | --- |
| `service.mjs` | the entry point (`scripts/launcher.mjs`): refuses to start if `NODE_OPTIONS`, `NODE_PATH` or `NAPI_RS_NATIVE_LIBRARY_PATH` is set (R153) or if `build-info.json` names another platform, architecture, C library or Node ABI; empties Node's global module folders; then loads `main.mjs` |
| `main.mjs` | the service and every pure-JavaScript dependency, bundled by esbuild (0.28.2, the version the workspace already had through tsx and Vite; now a pinned dev dependency of the service) |
| `workers/` | the citation sandbox and HTML cleaner worker scripts |
| `migrations/` | the SQL migrations |
| `csl/` | `styles.zip`, `locales/`, the CSL notice and licence, the CPAL-1.0 text |
| `node_modules/` | packages kept outside the bundle, unmodified, with their whole runtime dependency closure, for this platform and architecture only: `better-sqlite3` and `@napi-rs/keyring` (native), `pdfjs-dist` (loads its worker module by path; with the native `@napi-rs/canvas`), `exiftool-vendored` (finds `exiftool-vendored.pl` by package resolution), `citeproc` (CPAL: shipped unmodified, loaded by the sandbox worker), `file-type` (imports `strtok3` by a computed name). Plus stub packages for names a shipped file may load that are not part of the build (the napi-rs binaries of other platforms, `supports-color` for `debug`): each throws `MODULE_NOT_FOUND`, as a missing module would, so Node never looks outside the folder |
| `licences/` | `THIRD-PARTY-NOTICES.md` (every npm package in the folder, its version, licence and whether bundled or copied), each package's licence files, the typefaces' OFL texts (R100), the CSL and citeproc-js notice and licences |
| `build-info.json` | platform, architecture, libc, the Node version and ABI it was built with, the native module files |
| `START.txt` | how to start it |

Every non-code file is found through one resolver, `packages/library/src/resources.ts`. Running from
source it finds them where they always were; in the built folder (the build defines
`__AO_BUNDLE__`) it finds them only inside the folder and reports a missing one in plain words,
without a path. The native modules and the other kept packages are found by Node's own module
resolution from the bundle, in the folder's `node_modules/`.

**The folder loads code only from itself (R153).** A `require` or `import` that misses in
`<folder>/node_modules` would make Node go on looking in parent folders, `~/.node_modules`,
`~/.node_libraries` and `NODE_PATH`, so a file planted there would run inside the service. The build
therefore checks every package name any shipped file can load: each must be a builtin, a copied
package or a stub, and every load by a computed name must be on a list with its reason (the
napi-rs override variable, bindings' path to its own `.node`, exiftool-vendored's `.pl` package,
file-type's `strtok3`, pdf.js's own worker module); otherwise the build fails. The launcher also
empties Node's global folders. Three variables can still redirect loading and cannot be undone from
inside the program: `NODE_OPTIONS` (applied before any of our code runs), `NODE_PATH` and
`NAPI_RS_NATIVE_LIBRARY_PATH`. The launcher refuses to start when any is set, which stops a careless
launcher but not a preload already applied; so **whoever starts the folder must give it an
allow-listed environment, never its own** (the desktop shell, Task 37c). The service uses only:
`PATH`, `HOME`, `TMPDIR` (`TEMP`/`TMP` on Windows), `LANG` and `LC_*`, `TZ`, `AO_SERVICE_PORT`,
`AO_CONFIG_DIR`, `AO_LIBRARY`, `AO_WORKER_BIN` or `AO_NO_WORKER`, and, passed on to the media worker,
`AO_MODELS_DIR`, `AO_TOOLS_DIR`, `TESSDATA_PREFIX`, `XDG_*`, the proxy variables and
`SSL_CERT_FILE`/`SSL_CERT_DIR` when needed. It must not be given `NODE_OPTIONS`, `NODE_PATH`,
`NAPI_RS_NATIVE_LIBRARY_PATH` or `AO_SERVICE_TOKEN`.

**The documented way to start the folder** (also in its `START.txt`):

```
node --max-old-space-size=512 service.mjs
```

run with the folder as the working directory or by its full path, with the Node 22 release the
folder was built with (`build-info.json`), and the allow-listed environment above. The access token
is written on standard input as one line (R98); the service refuses to start if `AO_SERVICE_TOKEN`
is set or if it is given any argument. `AO_WORKER_BIN` names the packaged media worker
(Task 37d), which is not part of this folder. The service prints `AO_SERVICE_READY port=<n>` when
it listens and stops cleanly on SIGTERM or at the end of its standard input (R155).

The smoke run (`pnpm --filter @ao/library-service run smoke`, and a CI step on Linux) builds the
folder, copies it to an empty temporary folder outside the repository, plants a module that leaves
a marker file under every package name the build reports (and some generic optional ones) in the
home folder's `.node_modules` and `.node_libraries` and in a `node_modules` of the folder's parent,
starts it exactly like that (token on standard input), with a test-only guard preloaded that makes
the repository unreachable and refuses any module resolved from outside the folder, and over HTTP creates
a library and a project, attaches a PDF and a photo, renders a citation with a bundled and with an
imported style, cleans an HTML snapshot and searches; it checks that every native module mapped
into the process and the running ExifTool come from the copied folder, that nothing is left
running after SIGTERM and that no planted module was loaded. It then starts the folder with
`NODE_PATH` pointing at more planted modules and checks that it refuses to start and loads none.

### Why not a single executable

- **Native modules.** A single executable cannot load a `.node` file from inside itself; it has to
  write each one to disk first and load it from there. That is a second copy of every native
  module per launch (or a cache folder to manage and keep trustworthy), and on macOS a file
  written at run time is not covered by the app's signature.
- **Code signing on macOS (ADR 0014).** The app's code must be signed with our Developer ID,
  with the hardened runtime, and notarised. A single executable is made by injecting a blob into a
  copy of the Node binary, which breaks Node's signature; the result must be re-signed, and the
  injection step is one more thing that can go wrong in the Mac build. Beside the bundle, the
  official Node binary and each `.node` file are signed once with our identity like every other
  file in the app (V8 needs the JIT entitlements in either case). Until Developer ID signing
  arrives (R151: the first Mac builds of Task 37f are ad-hoc signed; Developer ID in Task 37g), the
  same holds for the ad-hoc signature, which injection breaks just the same.
- **Worker threads and ES modules.** Node 22's single executables take one CommonJS script; the
  two worker-thread scripts and pdf.js's own worker module are separate files and would have to be
  extracted or embedded in other ways.
- **Size.** About the same either way: the Node binary (roughly 100 MB unpacked on macOS) is
  shipped once in both. The folder measured 93 MB on Linux x64 (73 MB of it `node_modules/`,
  mostly the canvas library and ExifTool; 15 MB citation styles).
- **Start-up time.** The bundle needs no TypeScript compilation at start: on the (shared, loaded)
  build machine it reported ready in about 2.3 to 2.7 s, against 5.0 to 5.5 s for the same service
  from source with `tsx`. A single executable's code cache would save little more than that.
- **The memory ceiling** is a start-up flag in both cases; with Node beside the bundle the shell
  passes it on the command line, where it is visible and testable.

### How the shell starts and stops it (Task 37c, R155)

The Tauri shell (`apps/desktop/src-tauri`) starts **one** helper, this folder; the service starts
the media worker itself, as it always has.

- **Where the helpers are.** In a packaged app: `<resources>/node/node`, `<resources>/library-service/`
  and `<resources>/ao-worker/ao-worker` (the worker is optional; without it the service runs with
  `AO_NO_WORKER=1`). A debug build may instead be given `AO_DESKTOP_NODE`, `AO_DESKTOP_SERVICE_DIR`
  and `AO_DESKTOP_WORKER_BIN` in its own environment; a release build ignores them (R153). Copying
  the three into the bundle's resources is the Mac build's step (Task 37f).
- **The start.** `node --max-old-space-size=512 <folder>/service.mjs`, working directory the folder,
  in its own process group, with `env_clear()` and then only: `PATH` (the tools folder's `bin`
  first; only absolute entries kept), `HOME`, `USER`, `LOGNAME`, `TMPDIR`/`TEMP`/`TMP`, `LANG`,
  `LANGUAGE`, `LC_*`, `TZ`, `XDG_*`, `DBUS_SESSION_BUS_ADDRESS` (the keychain on Linux), the proxy
  variables in both letter cases, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `TESSDATA_PREFIX`, and the
  shell's own settings `AO_SERVICE_PORT=0`, `AO_CONFIG_DIR`, `AO_TOOLS_DIR` and `AO_MODELS_DIR`
  (`settings/`, `tools/` and `models/` in the shell's app data folder, so the app settings, pairings,
  the outbox and the tools are all in one place, R159) and `AO_WORKER_BIN` (or `AO_NO_WORKER=1`). Never `NODE_OPTIONS`, `NODE_PATH`,
  `NAPI_RS_NATIVE_LIBRARY_PATH` or any token or passphrase variable (`src/helper_env.rs`, each name
  with its reason). Not passed: `AO_LIBRARY`. Without the shell (CLI, tests, the end-to-end harness)
  the service's default settings folder is unchanged.
- **The token.** 32 bytes from the operating system's random source, as 64 hexadecimal characters,
  new on every launch, written as one line on the service's standard input, and otherwise only in
  the page's initialization script; never on disk, in a log or on a command line.
- **Ready.** The shell waits up to 60 s for `AO_SERVICE_READY port=<n>`; otherwise it stops the
  service and shows an error window with the service's own plain sentence (or a plain one of its
  own, any path in it replaced) and exits non-zero: when the window is closed, or by itself after
  10 minutes unanswered; the failure is on standard error at once. No app window is opened before
  the service is ready.
- **Standard input is the life line (R155 rule 3).** The service keeps reading its standard input
  after the token line and treats its end as "shut down cleanly", exactly like SIGTERM; it writes
  the worker's own token on the worker's standard input the same way, and the worker does the same.
  So a shell that crashes or is killed leaves no service, and a service that is killed leaves no
  worker. Anyone starting the folder by hand keeps the pipe open (`{ printf '%s\n' "$TOKEN"; cat; } | node …`).
- **Closing.** When the last window closes (or on SIGTERM, SIGINT, SIGHUP) the shell closes the
  service's standard input and waits until no process of the service's process group is left (on
  Linux it is the "child subreaper", so the orphaned worker is reaped by it), for up to 95 s, which
  is more than the service's own forced exit (90 s); then it kills the group. The exit is held back
  until then, so the single-instance lock (released when the event loop ends) stays held while the
  helpers stop: a second launch during closing starts no second service; the first instance notes
  it and starts the app again once its helpers are gone.

## Consequences

- The shell ships two things per architecture: a Node 22 binary and this folder. The folder must be
  built on (or for) the same platform, architecture and Node ABI as the Node it runs with; the Mac
  workflow (Task 37f) builds it on each of the two Mac runners with the pinned Node version and
  checks `build-info.json` against the Node it packages.
- Every `.node` file in `node_modules/` and the Node binary must be signed with our identity in the
  Mac build (Task 37f). ExifTool stays a Perl script run by the system Perl (ADR 0014, risk R5).
- A new dependency that loads files by a path relative to its own source, or a module by a computed
  name, either goes through `resources.ts` or is added to the kept packages in the build script; the
  build's check and the smoke run catch the cases they can see.
- The desktop shell (Task 37c) starts the service with an allow-listed environment built from the
  list above, never its own (R153), and writes the token on standard input; the service starts the
  worker (R155). A new environment variable the service needs is added to that list here, in
  START.txt and in `apps/desktop/src-tauri/src/helper_env.rs`.
- A dependency that loads a package the folder does not contain fails the build until the package
  is copied or a stub with a reason is added; the smoke run's planted modules catch what a static
  scan of `require`/`import` cannot see (an aliased `require`).
- `dist/` is not committed; CI builds and smoke-runs the folder on Linux on every push.
- Revisit if Node's single executables gain native-module and multi-file support that removes the
  extraction and signing steps, or if the app moves to a different shell.
