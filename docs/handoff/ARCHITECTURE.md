# ARCHITECTURE — current state (Phase 1, end of Task 36)

There was no separate architecture doc before this one. The spec (§2) and the ADRs (`docs/adr/`) remain the design sources.

## Packages and apps
| Path | What it is |
|---|---|
| `packages/core` (`@ao/core`) | Platform-neutral domain model (zod), plus: ids, naming, audit hashing, change log, governance schema/merge/engine/profiles, verification (recheck), import identifiers/dedupe, CSL citation mapping/rendering (citeproc-js, injected style loader) |
| `packages/shared` (`@ao/shared`) | Tiny DOM/Node-free rules shared by service and UI: credential query keys, font-family validation, generic font families |
| `packages/library` (`@ao/library`) | The Node library engine. `repo/` is the governed repository: transactions, audit, sources, assets, fieldwork, review, tombstones, restore, destroy. Also: `crypto/`, `fs/` (atomic writes, shred), `index/` (SQLite FTS5), `location/move/reconnect`, `capture/` (link and profile capture, browser capture, HTML stripper worker), `extract/`, `lookup/` (Crossref/OpenAlex/Open Library/LoC), `import/` (attach, bulk engine, refman, Zotero local and web, Calibre, device, proxies, OCR), `export/` (refman, bibliography, backup, project export), `retention.ts`, `citation/` (custom styles plus a sandboxed worker pool), `worker-client.ts` |
| `services/media-worker` | Python 3.13 HTTP job worker: faster-whisper transcription, yt-dlp/gallery-dl downloads, image/video proxies (location modes), OCR (ocrmypdf), ffmpeg |
| `apps/library-service` | Fastify HTTP service on 127.0.0.1. Thin layer over `@ao/library`, with auth, SSE events, NDJSON streams and a work registry. Routes are in `src/routes/*.ts` |
| `apps/cli` | The `ao` command-line tool: capture, import, export, secrets, verify-audit, rebuild-index |
| `apps/browser-extension` | MV3 extension (Chrome/Edge, Firefox via polyfill): pairing, page capture (screenshot plus inert HTML snapshot), profile-as-you-scroll link collection |
| `packages/ui` (`@ao/ui`) | React plus Vite UI. Themes, tokens and fonts; the API client (fetch-based SSE/NDJSON, token guards); one pushState router composing the Library (T33), Import wizard and Review queue (T35), Governance/Audit/Fieldwork/Move/Missing files (T36) and Appearance screens |
| `apps/desktop` | **Not built yet (Task 37):** Tauri 2 shell with service and worker sidecars |

## Data flow
UI and extension → HTTP (bearer token) → `library-service` → `@ao/library` governed operations. Each operation:
1. evaluates policy (`@ao/core` governance engine);
2. writes a txn marker;
3. writes files (encrypted per project);
4. appends audit and change-log entries;
5. updates the index cache.

Media work (downloads, transcription, proxies, OCR) goes through `worker-client.ts` to the Python worker, with proxy jobs recorded with their source. General job records live only in the search index for now (carried across rebuilds); R31 requires files, and PLAN Task 51 closes the gap.

Progress reaches the UI through SSE `/events` (`library.state`, `job.progress`, `import.progress`, `capture.progress`).

## The library on disk
One portable library folder, which can be moved and reconnected. Layout per spec §4.1:
- `library.json`
- `Projects/<name>/` containing `project.json`, `governance.yaml`, `audit/*.jsonl`, `Sources/<human name>/{source.json(.enc), original/, derived/, annotations.json(.enc)}`, `imports/batch-NNNN/`, `review/`, `protocol/`, `retention/`
- `Backups/`, `Exports/`, `styles/`, `.tmp/`, `.cache/`
- `library.sqlite` (a rebuildable index)

Device-specific settings live in the app config dir and never in the library: approved import folders, watched folders, extension pairings, appearance, researcher name, audit anchors.

## Known gaps (2026-11-11)
- The UI and the service cannot yet be started together: the service accepts only the future desktop shell's origin and a paired extension, and nothing gives the UI its connection (PLAN Milestone J).
- Making a backup is not checked by the policy engine, and a refused library move is not audited (PLAN Tasks 49, 50).
- The UI's data types are written by hand and nothing ties them to the service's responses (PLAN Task 47).
- No media-delivery route exists for a player (PLAN Task 34a).

## External dependencies (the rule is exact pins; the root dev tools use `^` ranges)
- **Node:** fastify, better-sqlite3, parse5 8.0.1, yauzl/yazl, fflate, pdfjs-dist, exiftool-vendored, undici, citeproc-js, turndown, @xmldom/xmldom, @napi-rs/keyring, React 19, Vite 7, msw, playwright, yaml. Watched folders use Node's own `fs.watch` (no watcher library).
- **Python:** faster-whisper, yt-dlp (managed binary), gallery-dl, pillow-heif, rawpy, ocrmypdf.
- **Data:** CSL styles and locales (CC BY-SA 3.0, built by `pnpm fetch-csl`), plus OFL fonts.
