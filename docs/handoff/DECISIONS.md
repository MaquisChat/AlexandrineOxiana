# DECISIONS — key choices

The full numbered log of 119 binding rulings is in `docs/handoff/LEDGER.md`. Each entry there records its cost if wrong. Architecture decision records are in `docs/adr/0001–0012`. This page summarises the most important choices.

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
- The search index is a disposable cache. Encrypted-project content is kept only in in-memory TEMP tables (R30). Review items, jobs and batches persist in files (R31).

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
- The citeproc-js licence choice is still open for the user (R87).
