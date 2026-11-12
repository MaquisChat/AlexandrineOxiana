# 0015. Third-party licence texts travel with the app

- **Status:** Accepted
- **Date:** 2026-11-12

## Context

The desktop app ships other people's software: Rust crates compiled into the shell, npm packages in
the interface and in the service folder, the Node.js program beside the service (ADR 0013), the
Python packages and native libraries of the packaged media worker, typefaces (R100), the citation
styles and citeproc-js (R86, R124, R129). The About screen already lists their licences (R159 c).
Most of those licences (MIT, BSD, ISC, Apache-2.0, MPL-2.0 and others) also require the licence text
and the copyright notices to accompany a distribution. Until Task 37j, the texts of the shell's
crates, the interface's packages and Node.js shipped nowhere, and two service packages had texts
typed into the repository.

## Decision

Every build that ships third-party code collects the licence texts of what it ships at build time,
from the packages' own files, into one readable file per part:

| Part | Made by | File | Where it ships |
| --- | --- | --- | --- |
| Rust crates linked into the shell | `apps/desktop/scripts/notices.mjs` | `shell-crates-LICENCES.txt` | in the interface (About screen) |
| npm packages of the interface | the same | `interface-npm-LICENCES.txt` | the same |
| Node.js and what it bundles | the same | `node-LICENCES.txt` | the same |
| npm packages of the service folder | `apps/library-service/scripts/build.mjs` | `licences/THIRD-PARTY-LICENCES.txt` | in the service folder; a copy in the interface |
| Python packages and native libraries of the worker | `services/media-worker/packaging/manifest.py` | `licenses/THIRD-PARTY-LICENCES.txt` | in the worker folder; a copy in the interface |
| Typefaces; citation styles and citeproc-js | (files in the repository) | the OFL texts; `NOTICE.md`, CC BY-SA 3.0, CPAL-1.0 | in the interface and the service folder, as before |

The rules, the same in the JavaScript (`apps/desktop/scripts/licence-texts.mjs`) and the Python
(`services/media-worker/packaging/licence_texts.py`) builds:

1. **Texts come from the package.** The crate's source in the cargo registry (its top-level
   `LICENSE*`, `COPYING*`, `NOTICE*`, `COPYRIGHT*`, `AUTHORS*` files and its Cargo.toml
   `license-file`), the npm package's folder, the wheel's dist-info licence files, Node's own
   `LICENSE`. Nothing is downloaded beyond what the builds already download.
2. **A package that ships no text** is named in its file's "No licence text shipped by the package"
   section and gets the standard text of each identifier it declares, from `licences/standard/`:
   SPDX texts copied unmodified from one tagged release, each with its source and checksum in that
   folder's README. A text is never typed in or made up from an identifier. The only other source
   allowed is a text from the same project that a build names (the napi-rs platform binaries take
   their parent package's LICENSE). A Python wheel whose metadata gives no usable identifier may
   give it in its own SBOM (tokenizers).
3. **Fail closed.** A shipped package with no licence identifier, or with one for which there is
   neither a shipped text nor a standard text, fails the build with the package named.
4. **Each identical text once.** Texts are grouped by their wording without their copyright lines;
   every distinct copyright line of every copy is kept with the group, and the group names every
   package (and file) that uses it.
5. **Only what ships.** For the shell: the normal-dependency closure for the build's target, without
   build and dev dependencies and without proc-macro crates or what only they need (they run inside
   the compiler). MPL-2.0 parts name where their source is.

The About screen's "Full licence texts" section shows each file on request through `UserText`. The
files are separate chunks of the interface, loaded only when the person asks: they are never in the
main bundle and do not slow start-up.

**Node.js.** The service folder must run with the Node release that built it (ADR 0013), so the
generator takes the `LICENSE` of the release of the Node that runs it (or of `--node <program>`):
the official archives have it at the top of the release folder (`<release>/LICENSE` beside
`bin/node`, or beside `node.exe` on Windows). Node's `LICENSE` covers Node.js and every library it
bundles (V8, OpenSSL, ICU, libuv, and the rest), so it is shipped unchanged. The Mac build (Task 37f)
obtains it the same way: it installs the pinned Node release from the official archive
(`node-v<version>-darwin-<arch>.tar.gz`, checked against the release's `SHASUMS256.txt`), copies
`bin/node` into the app's resources, and runs `notices.mjs --node <release>/bin/node`, which reads
`<release>/LICENSE` from the same archive; no other download is needed. The generator fails if the
file is not there.

## Consequences

- A release carries the notices its licences require, and a new dependency without a licence, or
  without a text the builds can find, stops the build instead of shipping silently.
- The interface grows by the size of the texts (about 0.8 MB before the worker's file, compressed about 110 kB), all in
  chunks that load only on request.
- Some things are visible but not solved here, and are listed for the owner's licence review (Task
  56): native libraries the worker's PyInstaller build takes from the build machine whose licence
  nothing in the bundle states; Rust crates statically linked inside wheels (tokenizers, for one)
  whose texts their wheels do not carry; and the standard texts used for packages that ship none,
  which carry the SPDX placeholders instead of the package's own copyright line.
- Adding a standard text means copying it from the same SPDX release and recording its checksum.
