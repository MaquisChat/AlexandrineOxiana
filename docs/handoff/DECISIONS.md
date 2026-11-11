# DECISIONS — key choices

The full numbered log of binding rulings (R1–R119 from the first build; R120 onward added at the 2026-11-11 checkpoint) is in `docs/handoff/LEDGER.md`. Each entry there records its cost if wrong. Architecture decision records are in `docs/adr/0001–0012`. This page summarises the most important choices.

## User decisions

| Decision | Alternatives | Why |
|---|---|---|
| Hybrid local + cloud from day one | Local-only first | Cloud and collaboration come later; retrofitting is costly |
| Per-project governance with IRB, GDPR, HIPAA and DMP profiles, strictest rule wins, and a verification report | Global settings only | Ethics boards need explicit, auditable per-study rules |
| No Anna's Archive or LibGen; legitimate access chain plus a manual attach drop zone | Shadow-library integration | Legal and ethical risk |
| Zotero import is a first-build priority | Later phase | The user's existing library |
| Copy files into the library by default | Link files in place | Portability and encryption; linking is refused in encrypted projects (R24) |
| Browser and downloader capture first-order, transcription in pass 1, recheck after every metadata fill | Later phases | The user needed capture immediately; reduces AI-hallucinated metadata |
| HIPAA projects may use approved cloud folders | Local only | User's choice |
| Files outside the expected folders need approval (option 2, R67); approving a folder covers its subfolders (R115) | Trust export paths / never attach | Prevents silently pulling unrelated personal files into a project |
| Build in parallel where independent (R95) | Strictly sequential | Saves time |

## Main technical choices (ruling numbers in brackets)

### Storage and crash safety
- Human-readable file names, using UUIDv7 ids plus short ids, within 255 bytes (ADR 0003, 0004).
- Chunked AES-256-GCM encryption with scrypt-wrapped keys and a recovery code (ADR 0006).
- A write-ahead transaction marker plus an audit commit gives crash safety; rollback happens on open (R26).
- A hash-chained audit log with a device anchor. Tampering is detected; a missing anchor on a device that wrote to the log counts as a failure (R81, R82).
- The search index is a disposable cache. Encrypted-project content is kept only in in-memory TEMP tables (R30). R31 requires review items, jobs and batches to persist in files. Today review items (`review/pending.jsonl`) and import batches (batch folders) do, and proxy jobs are recorded with their source, but general job records live only in the search index and are carried across rebuilds (`packages/library/src/index/rebuild.ts`, `CARRIED_TABLES`). PLAN Task 51 closes the gap.

### Import
- Parsers are written in-house, linear-time and size-capped. citation-js was rejected because of stack overflow, whole-file abort and a network dependency (R65–R70).
- Calibre and Zotero databases are copied and opened read-only with `trusted_schema=OFF`, with checks for real tables, generated columns and super-journals (R72, R75, R77).
- Zotero incremental update changes only fields the user hasn't edited. Deleted-here tombstones are kept and fail closed (R72–R76).

### Location and privacy
- Original files are never modified. Proxies use keep, coarsen or strip, are verified by re-reading their EXIF, and always use the stricter of the queued and current policy. A located file in a coarsen or strip project requires encryption (R83–R85).
- Participant codes are immutable and retired codes are never reused. Withdrawing consent flags linked sources for review and never deletes them (R97, R117, R119).
- Citations show participant codes only; unknown codes fail closed (R86–R89).

### Service and capture
- The service binds 127.0.0.1 only. It uses a bearer token (constant-time compare), validates Host and Origin, never accepts tokens in query strings, gives the extension a separately scoped token, and pairs with a 6-digit code (R96, R98).
- HTML snapshots are cleaned in a pooled worker using parse5: run to a fixpoint, pre-scan limits applied, CSP added as the first head child. They are shown only in a sandboxed iframe (R101, R104, R107).
- Library moves pause all background work through a work registry, wait for in-flight writes, and resume afterwards (R99, R102, R106).

### Interface and external code
- Theme colours come from tokens only, enforced by lint. Goudy Old Style is used when installed, with Sorts Mill Goudy (OFL) as fallback. High-contrast themes are ≥7:1. The 12 code colours keep the same hue across themes and are always shown with a shape and a name (R100, R103, R105, R109).
- citeproc-js is used under CPAL-1.0 (R124, 2026-11-11). The project's own licence is not chosen yet, and AGPL-3.0 stays possible. What CPAL requires is in ADR 0012.

## Checkpoint decisions, 2026-11-11

| Decision | Alternatives | Why |
|---|---|---|
| macOS first, Apple Silicon and Intel as two downloads unless Task 37e shows one combined app is practical; Windows after Phase 1 (R122) | Windows in Phase 1; Apple Silicon only | Scope is Phase 1 in detail. Cost if wrong: Intel packaging may prove impractical for the worker's speech and image libraries; 37e finds out before 37f depends on it |
| `main` is the approved state (created at 0ad6506) and changes only with the owner's approval; work happens on the working branch (R123) | Working directly on `main` | Recorded in R123 without further reasons; cost if wrong is none to the product |
| citeproc-js is used under CPAL-1.0; the project's own licence is left open, AGPL-3.0 likely later; no LICENSE file and nothing published until the owner decides (R124) | AGPL-3.0 now; choose the project licence now | citeproc-js is dual-licensed and the owner holds the rights in the project's own code, so AGPL-3.0 stays possible. Cost if wrong: a missing attribution display or notice at first release; re-checked at Task 56 |
| Backups are governed and audited, kept in `<Library>/Backups/` under the manifest; a second backup location is decided when sync is designed (R125) | A second location built in Phase 1 | Under the manifest, destruction under retention can find and certify them. Cost if wrong: until then a backup does not survive losing the drive that holds the library; the owner was told to copy the library folder elsewhere by hand |
| Optional tools are chosen and downloaded on first use, not bundled (R126); exiftool stays bundled and required | Bundling ffmpeg, tesseract and ghostscript (the original Task 37) | Replaces the original bundling. Cost if wrong: first use needs a network connection |
