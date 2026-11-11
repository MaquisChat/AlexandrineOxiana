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
| `service.mjs` | the service and every pure-JavaScript dependency, bundled by esbuild (0.28.2, the version the workspace already had through tsx and Vite; now a pinned dev dependency of the service) |
| `workers/` | the citation sandbox and HTML cleaner worker scripts |
| `migrations/` | the SQL migrations |
| `csl/` | `styles.zip`, `locales/`, the CSL notice and licence, the CPAL-1.0 text |
| `node_modules/` | packages kept outside the bundle, unmodified, with their runtime dependencies, for this platform and architecture only: `better-sqlite3`, `@napi-rs/keyring`, `pdfjs-dist` (with `@napi-rs/canvas`), `exiftool-vendored` (with `exiftool-vendored.pl`), `citeproc`, `file-type` |
| `licences/` | `THIRD-PARTY-NOTICES.md` (every npm package in the folder, its version, licence and whether bundled or copied), each package's licence files, the typefaces' OFL texts (R100), the CSL and citeproc-js notice and licences |
| `build-info.json` | platform, architecture, libc, the Node version and ABI it was built with, the native module files |
| `START.txt` | how to start it |

Every non-code file is found through one resolver, `packages/library/src/resources.ts`. Running from
source it finds them where they always were; in the built folder (the build defines
`__AO_BUNDLE__`) it finds them only inside the folder and reports a missing one in plain words,
without a path. The native modules and the other kept packages are found by Node's own module
resolution from `service.mjs`, in the folder's `node_modules/`. The build refuses a bundle that
loads a module through a computed name (a bundler cannot follow it); such a package is kept
outside the bundle instead (`file-type`).

**The documented way to start the folder** (also in its `START.txt`):

```
node --max-old-space-size=512 service.mjs
```

run with the folder as the working directory or by its full path, with the Node 22 release the
folder was built with (`build-info.json`). The access token is passed as the service reads it
(standard input once Task 37b lands, R98); `AO_WORKER_BIN` names the packaged media worker
(Task 37d), which is not part of this folder. The service prints `AO_SERVICE_READY port=<n>` when
it listens and stops cleanly on SIGTERM.

The smoke run (`pnpm --filter @ao/library-service run smoke`, and a CI step on Linux) builds the
folder, copies it to an empty temporary folder outside the repository, starts it exactly like
that, with a test-only guard preloaded that makes the repository unreachable, and over HTTP creates
a library and a project, attaches a PDF and a photo, renders a citation with a bundled and with an
imported style, cleans an HTML snapshot and searches; it checks that every native module mapped
into the process and the running ExifTool come from the copied folder, and that nothing is left
running after SIGTERM.

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
  file in the app (V8 needs the JIT entitlements in either case).
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
- `dist/` is not committed; CI builds and smoke-runs the folder on Linux on every push.
- Revisit if Node's single executables gain native-module and multi-file support that removes the
  extraction and signing steps, or if the app moves to a different shell.
