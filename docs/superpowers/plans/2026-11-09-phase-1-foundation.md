# Phase 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working local-first desktop research library: portable human-readable library on disk with encryption, governance engine and audit log, drag-and-drop attach, Bulk Import (Zotero, folders, ZIP, BibTeX/RIS/CSL-JSON, Zotero RDF, Calibre), iPhone/camera media import, citations in any CSL style, appearance settings, and library move/reconnect.

**Architecture:** Pure TypeScript domain logic lives in `packages/core` (no I/O). `packages/library` implements every library operation on Node (file system, SQLite index, encryption, importers) on top of `core`. A localhost HTTP service (`apps/library-service`) and a CLI (`apps/cli`) expose `packages/library`; the React UI (`packages/ui`) talks only to the service. A thin Tauri 2 shell (`apps/desktop`) launches the service and the Python media worker (`services/media-worker`) as sidecars and provides native dialogs and drag-and-drop paths.

**Tech Stack:** Node 22 LTS, TypeScript 5 (strict), pnpm 9 workspaces, Vitest, zod, better-sqlite3 (FTS5), yaml, canonicalize (RFC 8785 JCS), uuidv7, citeproc-js + CSL styles/locales, @citation-js/core (+ plugin-bibtex, plugin-ris, plugin-csl), pdfjs-dist, yauzl, @xmldom/xmldom, exiftool-vendored, chokidar, @napi-rs/keyring, Fastify 5, commander, React 18 + Vite + React Testing Library, Playwright, Tauri 2; Python 3.12, FastAPI, uvicorn, pillow, pillow-heif, rawpy, ocrmypdf (tesseract + ghostscript), ffmpeg, pytest.

**Spec:** `docs/superpowers/specs/2026-11-09-research-workbench-design.md` (Phase 1 = Section 11, item 1). Read the spec sections cited in each task.

## Global Constraints

- Node 22 LTS; TypeScript `strict: true`; pnpm 9; Python 3.12. ESM only.
- All entity ids are UUIDv7 strings. All stored timestamps are ISO 8601 UTC (`2026-11-09T19:30:00.000Z`).
- **No absolute paths are stored in any library file or the index**, except a linked file's original location (stored as both `absolutePath` and `libraryRelativePath`). Paths in library files use `/` separators.
- **Originals are never modified.** Edits and derived outputs are new files.
- Derived file names: `<source name> - <kind> - <language or pair> - <tool/model or "human-edit"> - modified <YYYY-MM-DD HHmm>.<ext>` (local time).
- Source folders: `<year or capture date> <primary creator> - <short title> [<short id>]`, short id 4 chars (extended only on collision).
- Encrypted files keep their readable name with `.enc` appended. Encryption: AES-256-GCM, user-held keys; keys never stored in plain form inside the library.
- **Governance fails closed**: any error while evaluating a policy → `deny`. Every decision is written to the audit log.
- Bulk import copies files into the library by default; linked files are flagged.
- Auto-accept confidence threshold for import identification defaults to `0.80`.
- Default interface typeface stack: `'Goudy Old Style', 'Sorts Mill Goudy', Garamond, Georgia, serif` (Sorts Mill Goudy bundled, SIL OFL).
- All text/background token pairs meet WCAG AA 4.5:1 in every theme.
- File writes inside the library are atomic (write `*.tmp-<id>` in the same directory, fsync, rename).
- Library `formatVersion` = `1`. A library with a higher version opens read-only with an explanation.
- Network lookups never send the user's email or personal data; an optional "contact email for polite API pools" setting is empty by default.

## Review Focus

1. **Non-Latin, very long, or oddly-normalized titles in file names** (Arabic/CJK/emoji, 300-character titles, macOS NFD input, Windows reserved names like `CON`) → names stay valid on Windows/macOS/Linux, stay readable, and never collide. Tests in Task 4.
2. **Interruption mid-operation** (crash or unplugged drive during import, encryption, or library move) → no half-written files visible as real data; operation resumes or is cleanly rolled back. Tests in Tasks 9, 13, 18.
3. **The same item arriving twice** (identical PDF in Zotero and in a folder; re-running an import) → one source, not two; re-runs import nothing new. Tests in Tasks 15, 17, 18, 20.
4. **Wrong passphrase or lost key for an encrypted project** → clear error, nothing overwritten, recovery file unlocks it. Tests in Task 9.
5. **Library opened on two computers via a cloud-synced folder, or by an older/newer app version** → second opener is read-only with an explanation; newer format is read-only; no index corruption. Tests in Tasks 10, 12.

---

## Repository Layout

```
package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.workspace.ts  .github/workflows/ci.yml
packages/core/src/          ids.ts  model/  naming.ts  audit.ts  changelog.ts
                            governance/{schema.ts,merge.ts,engine.ts,profiles/*.yaml}
                            import/{identifiers.ts,filename-patterns.ts,confidence.ts,dedupe.ts}
                            citation/{csl-map.ts,render.ts}
packages/library/src/       fs/atomic.ts  crypto/{format.ts,keys.ts}  library.ts registry.ts lock.ts
                            repo/{projects.ts,sources.ts,assets.ts,collections.ts,fieldwork.ts,mutate.ts}
                            index/{db.ts,rebuild.ts,search.ts}  location.ts move.ts reconnect.ts
                            extract/{pdf.ts,epub.ts,mobi.ts,docx.ts,html.ts,exif.ts}
                            lookup/{http.ts,crossref.ts,openalex.ts,openlibrary.ts,loc.ts}
                            import/{resolve.ts,attach.ts,bulk/{scan.ts,batch.ts,run.ts,undo.ts},
                                    refman.ts,zotero-rdf.ts,calibre.ts,zotero-local.ts,zotero-web.ts,
                                    watch.ts,device.ts}
                            export/{bibliography.ts,refman-export.ts}  worker-client.ts
apps/library-service/src/   server.ts  routes/*.ts
apps/cli/src/index.ts
packages/ui/src/            theme/  api/  screens/  components/
apps/desktop/               src-tauri/ (Rust shell), index.html → packages/ui
services/media-worker/      pyproject.toml  ao_worker/{app.py,jobs.py,image_proxy.py,video_proxy.py,ocr.py}  tests/
tests/fixtures/             generators (scripts) + small committed fixtures
e2e/                        Playwright specs
docs/adr/  docs/governance/  scripts/{fetch-csl.mjs,fetch-fixtures.mjs,test-report.mjs}
```

Package names: `@ao/core`, `@ao/library`, `@ao/ui`, `@ao/library-service`, `@ao/cli`, `@ao/desktop`. Tests are colocated as `*.test.ts(x)`.

---

## Milestone A — Workspace and core domain

### Task 1: Monorepo scaffold, CI, plain-language test report

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.github/workflows/ci.yml`, `.editorconfig`, `.gitignore`, `README.md`
- Create: `packages/{core,library,ui}/package.json` + `tsconfig.json`; `apps/{library-service,cli}/package.json` + `tsconfig.json`
- Create: `scripts/test-report.mjs`, `docs/adr/0000-template.md`, `docs/adr/0001-language-split.md`, `docs/adr/0002-local-service-architecture.md`
- Test: `scripts/test-report.test.mjs`

**Interfaces:**
- Produces: root scripts `pnpm test` (all Vitest projects), `pnpm test:py` (pytest in `services/media-worker`), `pnpm e2e`, `pnpm report` → writes `reports/test-report.md`.

- [ ] **Step 1: Write the failing test** `scripts/test-report.test.mjs`: given a Vitest JSON result fixture with 3 passed and 1 failed test (failure in `naming.test.ts › keeps Arabic titles readable`), `buildReport(results)` returns markdown containing `## Summary`, `3 of 4 checks passed`, and a plain-language line `✗ File naming: keeps Arabic titles readable`.
- [ ] **Step 2: Run** `node --test scripts/test-report.test.mjs` — Expected: FAIL (`buildReport` not defined).
- [ ] **Step 3: Implement** `export function buildReport(results: {vitest?: object, pytest?: string /* junit xml */, playwright?: object}): string` in `scripts/test-report.mjs`. Group by test file; map file names to plain-language area names via a table at the top of the file (`naming.test.ts` → "File naming", etc. — add an entry whenever a task adds a test file). CLI entry reads `reports/*.json|xml` and writes `reports/test-report.md`.
- [ ] **Step 4: Run** `node --test scripts/test-report.test.mjs` — Expected: PASS.
- [ ] **Step 5: CI**: `.github/workflows/ci.yml` runs on push/PR: `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm test`, `pnpm test:py`, `pnpm report`, uploads `reports/` as an artifact. ADRs 0001 (TS core + Python worker, spec §2) and 0002 (Node library service as sidecar behind thin Tauri shell; same service will be the local citation service of spec §8.2).
- [ ] **Step 6: Commit** `git commit -m "chore: scaffold monorepo, CI, and plain-language test report"`

### Task 2: Ids and short ids

**Files:** Create `packages/core/src/ids.ts`; Test `packages/core/src/ids.test.ts`

**Interfaces:**
- Produces: `newId(): string` (UUIDv7); `isId(s: string): boolean`; `shortId(id: string, taken: ReadonlySet<string>): string` — 4 lowercase chars from Crockford base32 of the id's last 20 random bits; if taken, extends to 5, 6, … chars from further bits.

- [ ] **Step 1: Tests**: `newId()` matches `/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`; two ids created 2 ms apart sort lexicographically in creation order; `shortId(id, new Set())` has length 4 and only `[0-9a-hjkmnp-tv-z]`; `shortId(id, new Set([shortId(id,new Set())]))` has length 5 and starts with the 4-char value; deterministic for the same input.
- [ ] **Step 2: Run** `pnpm --filter @ao/core exec vitest run src/ids.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** using the `uuidv7` package.
- [ ] **Step 4: Run** same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): ids and short ids`

### Task 3: Domain model schemas

Spec §3.1–3.8, §3.10 (Phase 2+ entities in §3.9 are out of scope).

**Files:** Create `packages/core/src/model/{text.ts,source.ts,asset.ts,anchor.ts,annotation.ts,project.ts,collection.ts,fieldwork.ts,import-batch.ts,index.ts}`; Test `packages/core/src/model/model.test.ts`

**Interfaces:**
- Produces (zod schemas + inferred types, exported from `@ao/core`):
  - `MultiText = { variants: Array<{ lang: string /* BCP-47 */, kind: 'original'|'romanized'|'translated', value: string, producedBy?: { by: 'human'|'machine', tool?: string, at: string } }> }`; helpers `primary(t: MultiText): string` (first `original`, else first), `inLang(t, lang): string|undefined`.
  - `SourceType` = `'book'|'chapter'|'article-journal'|'preprint'|'report'|'thesis'|'webpage'|'social-post'|'video'|'audio'|'image'|'dataset'|'field-photo'|'field-video'|'field-recording'|'interview'|'manuscript'|'presentation'|'other'`.
  - `Creator = { family?: string, given?: string, literal?: string, role: 'author'|'editor'|'translator'|'uploader'|'channel'|'photographer'|'interviewer'|'interviewee'|'contributor', handle?: string }`.
  - `Provenance = { captureMethod: 'official_api'|'browser_capture'|'downloader'|'manual_upload'|'zotero_import'|'device_import'|'refman_import'|'calibre_import', capturedAt: string, originalUrl?: string, tool: { name: string, version: string }, fileHashes: Record<string /*assetId*/, string /*sha256 hex*/>, platformSnapshot?: unknown, identification?: { method: string, confidence: number }, importBatchId?: string, externalKeys?: Record<string,string> /* e.g. zoteroKey */, legal: { status: 'public'|'consented'|'restricted'|'unknown', basis?: string }, identifiable: boolean }` — immutable after creation (enforced in Task 12).
  - `Source = { id, projectIds: string[], type: SourceType, title: MultiText, creators: Creator[], container?: MultiText, publisher?: string, issued?: string /* EDTF-lite: YYYY, YYYY-MM, YYYY-MM-DD */, accessed?: string, identifiers: { doi?, isbn?: string[], issn?, url?, platformPostId?, arxiv? }, citationKey: string, caseAttributes: Record<string,string>, provenance: Provenance, collectionIds: string[], tagIds: string[], participantIds: string[], sessionId?: string, createdAt, createdBy, modifiedAt, modifiedBy, folder: string /* library-relative */ }`.
  - `Asset = { id, sourceId, role: 'original'|'derived', kind: string /* e.g. 'pdf','video','image','ocr-text','proxy' */, path: string /* library-relative */, encrypted: boolean, sha256: string, bytes: number, mime: string, linked?: { absolutePath: string, libraryRelativePath: string }, derivation?: { parents: string[], operation: string, provider: string, model?: string, ranAt: 'local'|string /*vendor id*/, params: Record<string,unknown>, at: string, triggeredBy: string }, metadata?: { capturedAt?: string, tzOffset?: string, device?: string, lens?: string, gps?: { lat: number, lon: number, precision: 'exact'|'coarse' }, pairedAssetId?: string } }`.
  - `Anchor` discriminated union on `kind`: `'text-range'|'pdf'|'epub-cfi'|'time-range'|'image-region'|'transcript-segment'` (fields per spec §3.4).
  - `Annotation = { id, sourceId, kind: 'highlight'|'note'|'coded-segment'|'clip'|'screenshot', anchors: Anchor[], body?: string, codeId?: string, codebookVersion?: number, author: string, createdAt: string }`.
  - `Project = { id, name: string, folder: string, createdAt, targetLanguages: string[], encryption: { enabled: boolean, keyId?: string } }`.
  - `Collection = { id, projectId, parentId?: string, name: string }`; `Tag = { id, scope: 'workspace'|string /*projectId*/, name: string, color?: string }`.
  - `Participant = { id, projectId, code: string /* 'P-014' */, details?: Record<string,string> /* identifying, governed */, consentIds: string[] }`; `Session = { id, projectId, date: string, place?: string, participantIds: string[], notes?: string }`; `ConsentRecord = { id, projectId, participantId, documentAssetId?: string, scope: string, date: string, expires?: string, withdrawn?: { at: string } }`.
  - `ImportBatch = { id, projectId, number: number, source: { kind: 'folder'|'zip'|'zotero-local'|'zotero-web'|'zotero-rdf'|'bibtex'|'ris'|'csl-json'|'calibre'|'device'|'attach', location: string }, options: ImportOptions, startedAt, finishedAt?, counts: Record<'created'|'merged'|'skipped'|'failed'|'needsReview', number> }`; `ImportOptions = { fileHandling: 'copy'|'link', structure: 'collections'|'tags'|'none', duplicates: 'merge'|'skip'|'keep-both', ocr: boolean, transcribe: boolean, autoAcceptThreshold: number }` with defaults `{copy, collections, merge, ocr:true, transcribe:false, autoAcceptThreshold:0.8}`.
  - `SourceDraft = Omit<Source, 'id'|'folder'|'createdAt'|'createdBy'|'modifiedAt'|'modifiedBy'|'provenance'|'citationKey'> & { citationKey?: string }` — what importers produce before the repository assigns ids, folder, and provenance.
  - `SourceFile = { formatVersion: 1, source: Source, assets: Asset[], annotations: Annotation[] }` — the `source.json` shape.

- [ ] **Step 1: Tests**: a valid `SourceFile` fixture (Spanish reel with `title.variants` = es original + en translated) parses; `primary()` returns the Spanish string; `inLang(title,'en')` returns the English; an `Asset.path` starting with `/` or containing `\` or `..` is rejected (`LibraryRelativePath` refinement); `issued: '2026-13-01'` is rejected; `ImportOptions` parse of `{}` yields the defaults above.
- [ ] **Step 2: Run** `pnpm --filter @ao/core exec vitest run src/model` — FAIL.
- [ ] **Step 3: Implement** schemas with zod; export a reusable `LibraryRelativePath` refinement.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(core): domain model schemas`

### Task 4: File naming

Spec §4.2, §4.4.

**Files:** Create `packages/core/src/naming.ts`; Test `packages/core/src/naming.test.ts`

**Interfaces:**
- Produces:
  - `sanitizeSegment(s: string, maxBytes = 150): string` — NFC normalize; replace `<>:"/\|?*` and C0/C1 controls with `-`; collapse whitespace; strip trailing dots/spaces; prefix `_` to Windows reserved names (`CON PRN AUX NUL COM1–9 LPT1–9`, case-insensitive, with or without extension); truncate to `maxBytes` UTF-8 bytes on a grapheme boundary (use `Intl.Segmenter`), appending `…` when truncated.
  - `sourceFolderName(input: { dateOrYear?: string, primaryCreator?: string, shortTitle: string, shortId: string }): string` → `"2025 Smith - Title of Article [a1b2]"`; missing date → omitted; missing creator → `"Unknown"`.
  - `originalFileName(sourceName: string, ext: string): string` → `"<sourceName without [id]>.<ext>"`.
  - `derivedFileName(input: { sourceName: string, kind: string, lang?: string, tool: string, modified: Date, ext: string, tz?: string }): string` → `"<base> - ocr - en - tesseract-5 - modified 2026-11-09 1430.txt"`.
  - `withCollisionSuffix(name: string, exists: (n: string) => boolean): string` → appends ` (2)`, ` (3)`, … before the extension.
  - `pseudonymize(text: string, map: ReadonlyMap<string, string> /* '@handle' → 'P-014' */): string` — whole-token replacement, case-insensitive for handles.
  - `encName(name: string): string` → `name + '.enc'`.
  - `NamingTemplates` type + `defaultTemplates`, so templates are configurable per workspace (spec §4.2); the functions above take an optional `templates` argument.

- [ ] **Step 1: Tests** (each a separate `it`):
  - `sourceFolderName({dateOrYear:'2025', primaryCreator:'Smith', shortTitle:'Title of Article', shortId:'a1b2'})` === `'2025 Smith - Title of Article [a1b2]'`.
  - `derivedFileName({sourceName:'2026-03-14 P-014 - Reel - Receta', kind:'transcript', lang:'es', tool:'whisper-large-v3', modified:new Date('2026-11-09T20:02:00Z'), ext:'vtt', tz:'UTC'})` === `'2026-03-14 P-014 - Reel - Receta - transcript - es - whisper-large-v3 - modified 2026-11-09 2002.vtt'`.
  - Arabic title `'الطبخ في البيت'` and Japanese `'家庭料理の記憶'` are preserved unchanged.
  - NFD input `'Cafe\u0301'` becomes NFC `'Café'`.
  - `'CON'` → `'_CON'`; `'a:b?c'` → `'a-b-c'`; `'title. '` → `'title'`.
  - A 300-character title is ≤ 150 UTF-8 bytes, ends with `…`, and does not split an emoji (`'👩‍🔬'` repeated) grapheme.
  - `withCollisionSuffix('x.vtt', n => n === 'x.vtt')` === `'x (2).vtt'`.
  - `pseudonymize('2026-03-14 @maria.cocina - Reel', new Map([['@maria.cocina','P-014']]))` === `'2026-03-14 P-014 - Reel'`.
- [ ] **Step 2: Run** `pnpm --filter @ao/core exec vitest run src/naming.test.ts` — FAIL.
- [ ] **Step 3: Implement** functions as specified. Time formatting via `Intl.DateTimeFormat` with the given `tz` (default: system).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: ADR** `docs/adr/0003-file-naming.md` (scheme, byte limit rationale for 255-byte file names and Windows path limits, pseudonymization). **Commit** `feat(core): human-readable file naming`

### Task 5: Hash-chained audit log

Spec §3.10, §6.3(6).

**Files:** Create `packages/core/src/audit.ts`; Test `packages/core/src/audit.test.ts`

**Interfaces:**
- Produces:
  - `AuditEvent = { seq: number, at: string, actor: string, device: string, action: PolicyAction | 'library.move' | 'library.reconnect' | 'key.unlock' | 'import.batch' | string, entity?: { type: string, id: string }, projectId?: string, decision?: { result: 'allow'|'deny'|'allow_with_conditions', reason?: string, conditions?: unknown[] }, details?: Record<string, unknown>, prevHash: string, hash: string }`.
  - `GENESIS_HASH = '0'.repeat(64)`.
  - `sealEvent(e: Omit<AuditEvent,'hash'|'prevHash'|'seq'>, prev: { seq: number, hash: string } | null): AuditEvent` — `hash = sha256hex(canonicalize(eventWithoutHash))` (RFC 8785 via `canonicalize`).
  - `verifyChain(events: Iterable<AuditEvent>): { ok: true, count: number } | { ok: false, brokenAt: number, reason: 'hash-mismatch'|'prev-mismatch'|'seq-gap' }`.

- [ ] **Step 1: Tests**: chain of 3 sealed events verifies `{ok:true,count:3}`; changing `events[1].details` → `{ok:false, brokenAt:1, reason:'hash-mismatch'}`; deleting event 1 → `brokenAt:2`, `reason:'prev-mismatch'` or `'seq-gap'`; key order in `details` does not change the hash.
- [ ] **Step 2: Run** `pnpm --filter @ao/core exec vitest run src/audit.test.ts` — FAIL.
- [ ] **Step 3: Implement** (`node:crypto` is not allowed in core — use `@noble/hashes/sha256` so core stays platform-neutral).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(core): hash-chained audit events`

### Task 6: Change log and field-level merge

Spec §2.3. Sync is designed now, switched on in Phase 5.

**Files:** Create `packages/core/src/changelog.ts`; Test `packages/core/src/changelog.test.ts`

**Interfaces:**
- Produces:
  - `Change = { id: string /*uuidv7*/, at: string, author: string, device: string, projectId: string, entity: { type: 'source'|'asset'|'annotation'|'collection'|'tag'|'participant'|'session'|'consent'|'project', id: string }, op: 'create'|'update'|'delete', field?: string /* JSON pointer */, value?: unknown, prev?: unknown }`.
  - `diffToChanges(before: object|null, after: object|null, meta: Omit<Change,'id'|'op'|'field'|'value'|'prev'>): Change[]` — one `update` per changed leaf field (arrays treated as leaf values).
  - `RICH_TEXT_FIELDS: ReadonlySet<string>` = `/body`, `/notes`, `/details` (memos/notes; extended in later phases).
  - `mergeConcurrent(local: Change[], remote: Change[]): { applied: Change[], conflicts: Array<{ field: string, entity: Change['entity'], local: Change, remote: Change }> }` — per entity+field: last writer wins by `(at, device)`; for `RICH_TEXT_FIELDS` concurrent edits (both after the common ancestor) produce a conflict keeping both.

- [ ] **Step 1: Tests**: changing `title` and `issued` yields exactly 2 update changes with correct `field` pointers; concurrent edits to `/issued` → later `at` wins, no conflict; concurrent edits to `/body` → 1 conflict containing both values, neither applied; delete vs update on same entity → delete wins and is reported in `conflicts`.
- [ ] **Step 2–4:** Run (`vitest run src/changelog.test.ts`) FAIL → implement → PASS.
- [ ] **Step 5: ADR** `docs/adr/0004-ids-and-change-log.md`. **Commit** `feat(core): change log and field-level merge`

---

## Milestone B — Governance

### Task 7: Governance configuration, profiles, and strictest-wins merge

Spec §6.2–6.4.

**Files:**
- Create: `packages/core/src/governance/schema.ts`, `merge.ts`, `profiles/{irb,gdpr,hipaa,dmp}.yaml`, `profiles/index.ts`
- Create: `docs/governance/README.md`, `docs/governance/{irb,gdpr,hipaa,dmp}.md` (plain language, for an IRB office)
- Test: `packages/core/src/governance/merge.test.ts`

**Interfaces:**
- Produces:
  - `Profile = 'irb'|'gdpr'|'hipaa'|'dmp'`; `PartialGovernance` = deep-partial of `GovernanceConfig`.
  - `ResidencyKind = 'device'|'removable'|'network'|'cloud_folder'|'own_server'|'cloud'`.
  - `ProcessingOp = 'ocr'|'image_proxy'|'video_proxy'|'metadata_lookup'|'transcription'|'translation'|'agent'`.
  - `GovernanceConfig` (YAML shape of `governance.yaml`):
    ```yaml
    profiles: [irb, gdpr]                 # any of irb | gdpr | hipaa | dmp
    residency: { allowed: [device, removable] , approvedCloudFolders: [] }   # e.g. ["onedrive:university-tenant"]
    processing: { ocr: [local], image_proxy: [local], video_proxy: [local], metadata_lookup: [crossref, openalex, openlibrary, loc], transcription: [local], translation: [local], agent: [local] }
    vendors: []                           # [{ id: deepl, baa: false, dpa: true, region: eu }]
    identifiability: { containsIdentifiable: true, pseudonymizeFileNames: true, deidentifiedExportsOnly: true }
    consent: { requireStatus: true, requireLegalBasis: true }
    retention: { rawDataDestroyAfter: null }          # ISO date or null
    audit: { enabled: true }
    encryption: { atRest: required }                  # required | optional | off
    sharing: { locationMetadata: coarsen }            # keep | coarsen | strip
    captureMethods: [manual_upload, zotero_import, refman_import, calibre_import, device_import]
    protocol: { number: null, approvedFrom: null, expires: null, platforms: [], populations: [], languages: [], requireBeforeCapture: false }
    dmp: { repository: null, formats: [], metadataStandard: null, embargoUntil: null }
    exceptions: []                        # [{ control: "processing.translation", value: [local, deepl], reason: "...", by: "...", at: "..." }]
    ```
  - `parseGovernance(yamlText: string): GovernanceConfig` (zod-validated, errors list the offending key path).
  - `PROFILE_MINIMUMS: Record<Profile, PartialGovernance>` loaded from the YAML files:
    - `hipaa`: `encryption.atRest: required`; `residency.allowed ⊆ [device, removable, network, own_server]` (cloud folders only if in `approvedCloudFolders`); processing vendors must have `baa: true`; `audit.enabled: true`; `sharing.locationMetadata: strip`.
    - `gdpr`: `consent.requireLegalBasis: true`; `audit.enabled: true`; vendors must have `dpa: true`.
    - `irb`: `protocol.requireBeforeCapture: true`; `identifiability.pseudonymizeFileNames: true`; `audit.enabled: true`.
    - `dmp`: `dmp.repository`, `dmp.formats` must be non-empty; `retention.rawDataDestroyAfter` must be set.
  - `effectivePolicy(cfg: GovernanceConfig): { policy: GovernanceConfig, violations: Array<{ control: string, required: unknown, actual: unknown, profile: Profile }> }` — strictest wins: lists intersect; requirement booleans OR; `encryption` order `required > optional > off`; `locationMetadata` order `strip > coarsen > keep`; dates take the earliest. A looser value is allowed only if `exceptions` has an entry for that control with non-empty `reason`; otherwise it is a `violation` and the stricter value is used.

- [ ] **Step 1: Tests**: `profiles:[hipaa]` with `encryption.atRest: optional` and no exception → policy `required`, 1 violation `{control:'encryption.atRest', profile:'hipaa'}`; same with an exception carrying a reason → policy `optional`, 0 violations; `irb+gdpr` combination sets both `requireBeforeCapture` and `requireLegalBasis`; `dmp` without `repository` → violation; `processing.translation: [local, deepl]` with vendor `deepl {baa:false}` under `hipaa` → `deepl` removed from the effective list; YAML with unknown key `encyption` → parse error naming `encyption`.
- [ ] **Step 2–4:** Run `vitest run src/governance/merge.test.ts` FAIL → implement → PASS.
- [ ] **Step 5: Docs**: each `docs/governance/<profile>.md` explains, in plain language, every control the profile sets and why, plus "what the verification report will show". **Commit** `feat(core): governance config, compliance profiles, strictest-wins merge`

### Task 8: Policy engine

Spec §6.1, §6.3, §4.4, §5.3 (location).

**Files:** Create `packages/core/src/governance/engine.ts`; Test `packages/core/src/governance/engine.test.ts`

**Interfaces:**
- Consumes: `effectivePolicy` (Task 7), `AuditEvent` shape (Task 5).
- Produces:
  - `PolicyAction = 'capture'|'process'|'store'|'sync'|'view'|'export'|'share'|'delete'|'move'`.
  - `PolicyRequest = { action: PolicyAction, projectId: string, actor: string, now: string, capture?: { method: Provenance['captureMethod'], platform?: string }, process?: { op: ProcessingOp, provider: string /* 'local' | vendor id */ }, store?: { identifiable: boolean, hasLocation: boolean, legalBasis?: string }, move?: { destination: ResidencyKind, cloudFolderId?: string }, export?: { identifiable: boolean, hasLocation: boolean }, sync?: {} }`.
  - `Condition = { type: 'encrypt' } | { type: 'pseudonymize-names' } | { type: 'location', mode: 'coarsen'|'strip' } | { type: 'deidentified-only' }`.
  - `PolicyDecision = { result: 'allow' } | { result: 'deny', reason: string } | { result: 'allow_with_conditions', conditions: Condition[] }` plus `warnings: string[]` on every variant.
  - `evaluate(cfg: GovernanceConfig, req: PolicyRequest): PolicyDecision` — never throws; any internal error → `{ result:'deny', reason:'Policy could not be evaluated: <message>' }`.
- Rules (each a test):
  - `capture`: method ∉ `captureMethods` → deny "Capture method <m> is not enabled for this project"; `protocol.requireBeforeCapture` and no `protocol.number` → deny; `now > protocol.expires` → deny "Protocol expired on <date>"; within 30 days of expiry → allow + warning "Protocol expires in N days"; `platform` set and not in `protocol.platforms` (when non-empty) → deny "outside approved protocol scope".
  - `process`: provider not in `processing[op]` → deny naming the op and provider.
  - `store`: `encryption.atRest === 'required'` → condition `encrypt`; `identifiable && pseudonymizeFileNames` → `pseudonymize-names`; `hasLocation && locationMetadata !== 'keep' && encryption.atRest === 'off'` → deny "Location data requires encryption or locationMetadata: keep"; `identifiable && consent.requireLegalBasis && !legalBasis` → deny "Record a legal basis for identifiable data before storing it".
  - `export`: `identifiable && deidentifiedExportsOnly` → `deidentified-only`; `hasLocation` → `location` with mode from policy (none when `keep`).
  - `move`: destination ∉ `residency.allowed` and not (`cloud_folder` with `cloudFolderId ∈ approvedCloudFolders`) → deny "Destination <kind> is not permitted for project <name>".
  - `sync`: Phase 1 → deny "Sync is not enabled in this version".
  - `delete`, `view`, `share`: allow (refined in later phases).

- [ ] **Step 1: Tests**: one `it` per rule above with exact reason strings; a config object with `residency` set to a non-array (forced through `as any`) → deny starting with `'Policy could not be evaluated'`.
- [ ] **Step 2–4:** Run `vitest run src/governance/engine.test.ts` FAIL → implement → PASS.
- [ ] **Step 5: ADR** `docs/adr/0005-governance-checkpoint.md`. **Commit** `feat(core): fail-closed policy engine`

---

## Milestone C — Library on disk

### Task 9: Atomic writes, encryption format, and keys

Spec §6.3(7), §4.4, §4.5 (keys).

**Files:** Create `packages/library/src/fs/atomic.ts`, `crypto/format.ts`, `crypto/keys.ts`; Test `packages/library/src/crypto/crypto.test.ts`, `packages/library/src/fs/atomic.test.ts`

**Interfaces:**
- Produces:
  - `writeFileAtomic(path: string, data: Uint8Array|string): Promise<void>`; `copyFileAtomic(src: string, dest: string, opts?: { transform?: (r: Readable) => Readable }): Promise<{ sha256: string, bytes: number }>` (hash computed over the *plaintext* stream); `cleanupTempFiles(dir: string): Promise<number>` removes `*.tmp-*` older than 1 hour.
  - Encrypted file format v1 (`format.ts`): header `"AOENC1"` (6 bytes) ‖ keyId (16 bytes, UUID bytes) ‖ baseNonce (12 bytes) ‖ chunkSize u32 BE (= 1 MiB); then chunks, each AES-256-GCM over ≤1 MiB plaintext with nonce = baseNonce XOR (u64 BE chunk index in last 8 bytes) and AAD = `header ‖ u64 chunkIndex ‖ u8 isFinal`; each chunk = ciphertext ‖ 16-byte tag. Exports `encryptStream(key: Uint8Array, keyId: string): Transform`, `decryptStream(getKey: (keyId: string) => Uint8Array): Transform`, `readKeyId(path: string): Promise<string>`.
  - Keys (`keys.ts`): project data key = 32 random bytes. `wrapKey(dataKey, passphrase): Promise<WrappedKey>` with scrypt (N=2^17, r=8, p=1) → AES-256-GCM wrap; `WrappedKey = { keyId, kdf: { name:'scrypt', N, r, p, salt: base64 }, nonce: base64, wrapped: base64 }`; `unwrapKey(w: WrappedKey, passphrase): Promise<Uint8Array>` throws `WrongPassphraseError`; `createRecoveryFile(dataKey, keyId): { recoveryCode: string /* 24 words or 32-char base32 groups */, file: WrappedKey }` (wrapped with the recovery code); `KeyRing` in-memory store of unlocked keys, cleared on lock/app exit. Wrapped keys are stored in `<Project>/keys/project-key.json` (wrapped only).

- [ ] **Step 1: Tests**:
  - round-trip of 0 B, 1 B, exactly 1 MiB, and 3.5 MiB plaintexts;
  - flipping one byte in chunk 2 → `decryptStream` errors; truncating the final chunk → errors (final-flag check);
  - wrong passphrase → `WrongPassphraseError`, and the key file on disk is byte-identical afterwards;
  - recovery code unwraps the same data key;
  - `writeFileAtomic`: a simulated crash (stub `rename` to throw) leaves the original file unchanged and only a `*.tmp-*` file, which `cleanupTempFiles` removes once older than 1 hour (inject clock).
- [ ] **Step 2–4:** Run `pnpm --filter @ao/library exec vitest run src/crypto src/fs` FAIL → implement with `node:crypto` → PASS.
- [ ] **Step 5: ADR** `docs/adr/0006-encryption.md` (format, KDF parameters, why chunked). **Commit** `feat(library): atomic writes, chunked AES-GCM files, key wrapping`

### Task 10: Library create/open, registry, lock, format version

Spec §4.1, §4.5 (lock, multiple libraries).

**Files:** Create `packages/library/src/library.ts`, `registry.ts`, `lock.ts`; Test `packages/library/src/library.test.ts`

**Interfaces:**
- Produces:
  - `library.json` = `{ libraryId: string, name: string, formatVersion: 1, createdAt: string, locationHistory: Array<{ at: string, hint: string /* hostname + basename only, never full path */ }> }`.
  - `createLibrary(root: string, name: string, deps: Deps): Promise<Library>`; `openLibrary(root: string, deps: Deps): Promise<Library>` where `Library = { id, name, root, mode: 'read-write'|'read-only', readOnlyReason?: 'locked-by-other-device'|'newer-format'|'offline', close(): Promise<void> }`; creates `Projects/`, `Exports/`, `Backups/`, `.cache/`, `.tmp/`.
  - `Deps = { clock: () => Date, deviceId: string, hostname: string, pid: number, isPidAlive: (pid:number)=>boolean, appConfigDir: string }`.
  - Lock (`lock.ts`): `<root>/.lock` JSON `{ deviceId, hostname, pid, openedAt, heartbeatAt }`, heartbeat every 30 s; another device's lock is stale if `heartbeatAt` older than 120 s; same host + dead pid → stale. `acquireLock(root, deps): Promise<{ acquired: true } | { acquired: false, holder: LockInfo }>`.
  - Registry (`registry.ts`): `<appConfigDir>/libraries.json` = `Array<{ libraryId, name, lastKnownPaths: string[] /* most recent first, max 5 */, lastOpenedAt }>`; `registerLibrary`, `listLibraries`, `recordLocation(libraryId, path)`, `forgetLibrary`.

- [ ] **Step 1: Tests**: create then open → same `libraryId`, `mode:'read-write'`; second `openLibrary` from a different `deviceId` while the lock is fresh → `mode:'read-only'`, `readOnlyReason:'locked-by-other-device'`; same after advancing clock 121 s with no heartbeat → `read-write`; `formatVersion: 2` → `read-only`, `'newer-format'`; registry keeps max 5 paths, most recent first; `library.json` contains no absolute path (assert it does not contain `root`).
- [ ] **Step 2–4:** Run `vitest run src/library.test.ts` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(library): create/open library, registry, device lock`

### Task 11: Repository — projects, sources, assets, collections, tags, fieldwork, with governance + audit + change log

Spec §3, §4.1, §4.3, §4.4, §6.1.

**Files:** Create `packages/library/src/repo/{mutate.ts,projects.ts,sources.ts,assets.ts,collections.ts,fieldwork.ts,audit-store.ts}`; Test `packages/library/src/repo/repo.test.ts`

**Interfaces:**
- Consumes: Tasks 2–10.
- Produces:
  - `Repo` (one per open library): `repo = await openRepo(library, keyRing)`.
  - Projects: `createProject(input: { name: string, governanceYaml: string, encryption: { enabled: boolean, passphrase?: string } }): Promise<{ project: Project, recoveryCode?: string }>` writes `Projects/<name>/{project.json, governance.yaml, keys/project-key.json?, audit/0001.jsonl, changes/<YYYY-MM>.jsonl}`; `unlockProject(projectId, passphraseOrRecovery)`; `lockProject(projectId)`; `isUnlocked(projectId)`.
  - Every mutation goes through `mutate<T>(projectId: string, req: PolicyRequest, fn: (tx: Tx) => Promise<T>): Promise<T>` which: evaluates policy (deny → throws `PolicyDeniedError` with `reason`, still audited); applies `conditions` (exposed on `tx.conditions`); writes files atomically; appends `Change[]` to `changes/<YYYY-MM>.jsonl`; appends sealed `AuditEvent` to `audit/<NNNN>.jsonl` (rotate at 10,000 events); updates the index (Task 12) last. Read-only library → throws `ReadOnlyLibraryError` before any write.
  - Sources: `createSource(projectId, draft: SourceDraft, files: Array<{ path: string, role:'original', handling:'copy'|'link' }>, opts: { provenance: Provenance }): Promise<SourceFile>` — allocates shortId, builds folder name (pseudonymized and/or `.enc` per conditions), copies (or encrypts) files into `original/`, writes `source.json` (or `source.json.enc` + updates `<Project>/manifest.json` with non-identifying `{ id, type, issuedYear, folder, files }`); `updateSource(projectId, id, patch)` (rejects any change to `provenance` with `ImmutableProvenanceError`); `deleteSource`; `getSource`; `addDerivedAsset(projectId, sourceId, input: { fromPath: string, kind, lang?, tool, ext, derivation })` → names with `derivedFileName`, never overwrites.
  - Collections/tags: `createCollection(projectId, name, parentId?)`, `moveCollection`, `deleteCollection` (sources keep existing, membership removed); `createTag(scope, name, color?)`; workspace tags stored in `<root>/tags.json`, project collections/tags in `project.json`; `setMembership(projectId, sourceId, { collectionIds?, tagIds? })`.
  - Fieldwork: `createParticipant(projectId, { code?: string /* auto P-001 sequence */, details? })`, `createSession`, `createConsent`, `linkSourceToFieldwork(projectId, sourceId, { participantIds?, sessionId? })`. Participant `details` live only inside `project.json` when unencrypted is disallowed: if `identifiability.containsIdentifiable` and encryption is enabled they are stored in `fieldwork.json.enc`.
  - Pseudonym map (handle → participant code) stored in `keys/pseudonyms.json.enc` (requires encryption; if identifiable + pseudonymize without encryption, creating the project fails with a governance violation message).
- [ ] **Step 1: Tests**:
  - create unencrypted project + source with a PDF → folder `Sources/2025 Smith - Title of Article [xxxx]/original/2025 Smith - Title of Article.pdf`, `source.json` parses as `SourceFile`, one `capture`/`store` audit event chain verifies, change log has the create entries;
  - encrypted project → `source.json.enc` exists, `source.json` does not, file ends `.pdf.enc`, `manifest.json` contains no title text, decrypting yields the original bytes;
  - identifiable source with handle `@maria.cocina` and pseudonym map → no file or folder name under the project contains `maria`;
  - denied capture (method not enabled) → throws `PolicyDeniedError`, no source folder exists, audit has a `deny` event;
  - `updateSource` changing `provenance.capturedAt` → `ImmutableProvenanceError`;
  - two `addDerivedAsset` calls in the same minute → second file gets ` (2)` and the first is unchanged;
  - read-only library → `createSource` throws `ReadOnlyLibraryError` and nothing is written;
  - every path stored in `source.json` passes `LibraryRelativePath`.
- [ ] **Step 2–4:** Run `vitest run src/repo` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(library): governed repository with audit and change log`

### Task 12: SQLite index, full-text search, rebuild from folder

Spec §4.3.

**Files:** Create `packages/library/src/index/{db.ts,rebuild.ts,search.ts}`, `index/migrations/0001.sql`; Test `packages/library/src/index/index.test.ts`

**Interfaces:**
- Produces:
  - `openIndex(root: string): IndexDb` (better-sqlite3, WAL, `library.sqlite`); tables: `projects, sources, assets, collections, tags, source_collections, source_tags, participants, sessions, consents, import_batches, review_items, jobs, meta(key,value)`; FTS5 table `source_text(source_id, project_id, title_all, creators, container, extracted_text, tokenize='unicode61 remove_diacritics 2')`; `title_all` concatenates every title variant (all languages).
  - `indexSource(db, sf: SourceFile, extractedText?: string)`, `removeSource(db, id)`.
  - `search(db, q: { text?: string, projectId?: string, types?: SourceType[], collectionId?: string, tagIds?: string[], limit?: number, offset?: number }): { total: number, items: SourceRow[] }`; `SourceRow = { id, projectId, type: SourceType, title: string /* primary variant */, creatorsText: string, issuedYear?: string, folder: string, needsReview: boolean, locked: boolean }`.
  - `rebuildIndex(root: string, keyRing: KeyRing, onProgress?: (done:number,total:number)=>void): Promise<{ indexed: number, lockedProjects: string[], errors: Array<{ folder: string, message: string }> }>` — drops and recreates the DB, walks `Projects/*/Sources/*/source.json(.enc)`; locked encrypted projects are indexed from `manifest.json` only (no titles) and listed in `lockedProjects`.
  - `isIndexStale(root, db): Promise<boolean>` — compares `meta.lastChangeId` with the newest entry across `changes/*.jsonl`.
- [ ] **Step 1: Tests**: search for an English translated title finds the Spanish source; search `cafe` finds `Café`; delete `library.sqlite`, `rebuildIndex` → same search results and counts as before; a corrupt `source.json` in one folder → reported in `errors`, other sources indexed; locked project → in `lockedProjects`, its sources have type and year but no title; after an extra change appended to the change log, `isIndexStale` → true.
- [ ] **Step 2–4:** Run `vitest run src/index` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(library): SQLite index, multilingual search, rebuild from folder`

### Task 13: Move library (copy → verify → switch)

Spec §4.5 (in-app move).

**Files:** Create `packages/library/src/location.ts`, `move.ts`; Test `packages/library/src/move.test.ts`

**Interfaces:**
- Produces:
  - `classifyLocation(path: string, env: { homeDir: string, platform: NodeJS.Platform, mounts: Array<{ path: string, removable: boolean, network: boolean }> }): { kind: ResidencyKind, cloudFolderId?: string }` — cloud-folder patterns: macOS `~/Library/Mobile Documents/com~apple~CloudDocs` → `icloud`; `~/Library/CloudStorage/OneDrive-*` → `onedrive:<suffix>`; `~/Library/CloudStorage/Dropbox*` or `~/Dropbox` → `dropbox`; `~/Library/CloudStorage/GoogleDrive-*` or `G:\My Drive` → `googledrive:<account>`; Windows `%USERPROFILE%\OneDrive*` → `onedrive:<suffix>`; mounts flagged removable/network → `removable`/`network`; else `device`.
  - `planMove(lib: Library, destRoot: string, env): Promise<{ perProject: Array<{ projectId, name, decision: PolicyDecision }>, totalBytes: number, fileCount: number }>`.
  - `executeMove(lib, destRoot, opts: { excludeProjectIds: string[], onProgress }): Promise<{ newRoot: string, verified: true }>` — writes `<dest>/.move-journal.json` `{ fromHint, filesDone: string[] }` so a rerun resumes; copies every file with `copyFileAtomic`; verifies sha256 of every copied file against the source; on any mismatch → throws `MoveVerificationError` and leaves the source untouched; on success: switches the registry path, writes audit event `library.move` (from/to hints, projects, verification result) in every moved project, removes the journal.
  - `deleteOldCopy(oldRoot: string, confirmToken: string)` — only callable with the token returned by a successful `executeMove`.
  - Excluded projects: stay in the old library folder, which remains a registered library (`<name> (remaining projects)`).
- [ ] **Step 1: Tests**: `classifyLocation` for each pattern above; move of a library with 2 projects → all hashes match, registry points to the new root, old root still intact; injected corruption of one destination file → `MoveVerificationError`, registry unchanged; interrupt after 50% (throw from progress callback), rerun → completes and copies only remaining files (assert copy count); HIPAA project + OneDrive destination → `planMove` decision deny, `executeMove` with that project excluded succeeds and the HIPAA project remains in the old library.
- [ ] **Step 2–4:** Run `vitest run src/move.test.ts` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(library): governed, verified, resumable library move`

### Task 14: Reconnect, missing files, offline, placeholders

Spec §4.5 (reconnection, offline, placeholders).

**Files:** Create `packages/library/src/reconnect.ts`; Test `packages/library/src/reconnect.test.ts`

**Interfaces:**
- Produces:
  - `findLibrary(libraryId: string, searchRoots: string[], opts: { maxDepth: 4, signal?: AbortSignal }): AsyncIterable<{ path: string }>` — yields folders containing a `library.json` whose `libraryId` matches. `defaultSearchRoots(env)` = mounted volumes + known cloud folder roots + home.
  - `reconnect(path: string, expectedId: string, deps): Promise<{ library: Library, integrity: IntegrityReport, rebuilt: boolean }>` — verifies id (mismatch → `WrongLibraryError`), format version, runs `checkIntegrity(sample: 0.05 | 'full')`, rebuilds index if missing/stale, records location + audit `library.reconnect`.
  - `checkIntegrity(lib, sample): Promise<IntegrityReport>`; `IntegrityReport = { checked: number, missing: Array<{ assetId, path }>, mismatched: Array<{ assetId, path }>, placeholders: Array<{ assetId, path }> }`.
  - `relinkMissing(lib, searchDir: string): Promise<{ relinked: number, stillMissing: number }>` — matches by sha256 first, then by file name + size; copies found files back to their library path (or updates `linked` paths).
  - `isPlaceholder(path): Promise<boolean>` — POSIX heuristic `stat.size > 0 && stat.blocks === 0`; on Windows always false in Phase 1 (documented limitation in ADR); `hydrate(path)` reads the file fully to trigger download, reporting progress.
  - `watchAvailability(lib, onChange: (state: 'online'|'offline') => void): () => void` — polls `library.json` existence every 5 s; offline → library mode becomes `read-only` with `readOnlyReason:'offline'`; online → re-acquires lock and returns to previous mode.
- [ ] **Step 1: Tests**: library renamed on disk → `findLibrary` finds it under a search root; wrong library at path → `WrongLibraryError`; deleted `library.sqlite` → `rebuilt:true`; a removed asset appears in `missing`, `relinkMissing` with a folder containing a renamed copy (same hash) restores it; a fake placeholder (stubbed stat) appears in `placeholders` not `missing`; availability watcher flips to offline when the root is renamed and back when restored (fake timers), and writes during offline throw `ReadOnlyLibraryError`.
- [ ] **Step 2–4:** Run `vitest run src/reconnect.test.ts` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(library): reconnect, integrity check, relink, offline mode`

---

## Milestone D — Identification and import

### Task 15: Identifier detection, file-name patterns, confidence, duplicates (pure core)

Spec §5.4 steps 3–5.

**Files:** Create `packages/core/src/import/{identifiers.ts,filename-patterns.ts,confidence.ts,dedupe.ts}`; Test `packages/core/src/import/import.test.ts`

**Interfaces:**
- Produces:
  - `findIdentifiers(text: string): { dois: string[], isbns: string[], arxiv: string[] }` — DOI regex `10\.\d{4,9}/[^\s"<>]+` with trailing punctuation trimmed and lowercased; ISBN-10/13 with checksum validation, normalized to ISBN-13; arXiv `\d{4}\.\d{4,5}(v\d+)?` and old-style `[a-z\-]+/\d{7}`.
  - `parseFileName(name: string, patterns?: FileNamePattern[]): { creator?: string, year?: string, title?: string } | null`; built-in patterns in order: `Author - Year - Title`, `Author_Year_Title`, `Author (Year) Title`, `Author Year Title`; `FileNamePattern = { id: string, regex: string /* named groups creator, year, title */ }` (user-definable).
  - `Evidence = { method: 'reference-metadata'|'embedded'|'identifier+lookup'|'sidecar'|'filename'|'filename+lookup'|'lookup-title-match'|'none', titleSimilarity?: number }`.
  - `scoreConfidence(e: Evidence): number` — `reference-metadata` 0.90; `identifier+lookup` 0.97; `sidecar` 0.85; `embedded` with title+creator 0.70 (title only 0.55); `filename` 0.50, `filename+lookup` 0.50 + 0.30 × titleSimilarity if similarity ≥ 0.9; `none` 0.20.
  - `normalizeTitle(t: string): string` (NFKD, strip diacritics, lowercase, remove punctuation, collapse spaces); `titleSimilarity(a, b): number` (token-set ratio, 0–1).
  - `findDuplicate(candidate: DupKey, existing: Iterable<DupKey & { sourceId: string }>): { sourceId: string, reason: 'same-file'|'same-doi'|'same-isbn'|'fuzzy', certainty: 'certain'|'likely' } | null` where `DupKey = { sha256s: string[], doi?: string, isbns?: string[], title?: string, firstCreatorFamily?: string, year?: string }`; fuzzy = similarity ≥ 0.92 and same first-creator family (normalized) and |year diff| ≤ 1 → `likely`.
- [ ] **Step 1: Tests**: DOI in `"https://doi.org/10.1000/xyz123)."` → `10.1000/xyz123`; ISBN `0-306-40615-2` → `9780306406157`; invalid checksum ignored; `parseFileName('Okafor - 2024 - Feeding the Feed.pdf')` → `{creator:'Okafor', year:'2024', title:'Feeding the Feed'}`; custom pattern `^(?<year>\d{4})_(?<creator>[^_]+)_(?<title>.+)$` works; `scoreConfidence({method:'filename+lookup', titleSimilarity:0.95})` === 0.785; same sha256 → `same-file/certain`; `"Feeding the Feed: Food Media"` vs `"Feeding the feed – food media"` same author/year → `fuzzy/likely`.
- [ ] **Step 2–4:** Run `pnpm --filter @ao/core exec vitest run src/import` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(core): identifiers, filename patterns, confidence, duplicate detection`

### Task 16: Metadata extractors and lookup clients

Spec §5.1 (DOI/ISBN lookup), §5.4 step 3.

**Files:** Create `packages/library/src/extract/{pdf.ts,epub.ts,mobi.ts,docx.ts,html.ts,exif.ts,index.ts}`, `packages/library/src/lookup/{http.ts,crossref.ts,openalex.ts,openlibrary.ts,loc.ts}`; Create `tests/fixtures/generate.mjs` (builds PDFs with pdf-lib incl. one with DOI on page 1 and one image-only "scanned" page, an EPUB with OPF metadata, a DOCX with core.xml, an HTML page with `citation_*` meta tags, a MOBI with EXTH title/author) and `scripts/fetch-fixtures.mjs` (downloads pinned CC0 camera fixtures — a DNG and a CR3 from raw.pixls.us — verifying sha256); Test `packages/library/src/extract/extract.test.ts`, `packages/library/src/lookup/lookup.test.ts`

**Interfaces:**
- Produces:
  - `extractMetadata(path: string, mime: string): Promise<Extracted>`; `Extracted = { title?: string, creators?: Creator[], issued?: string, language?: string, identifiers: { dois: string[], isbns: string[], arxiv: string[] }, text?: string /* first 3 pages/sections, max 20,000 chars */, needsOcr?: boolean /* PDF with < 50 chars text on page 1 */, media?: { capturedAt?, tzOffset?, device?, lens?, gps?, durationSec?, width?, height?, contentIdentifier? } }`. PDF via `pdfjs-dist` (Info dict + XMP); EPUB via `yauzl` + OPF (`dc:title`, `dc:creator`, `dc:date`, `dc:identifier`, `dc:language`); MOBI/AZW3 via EXTH records 100 (author), 503 (title), 104 (ISBN), 106 (date); DOCX `docProps/core.xml`; HTML `<title>`, Highwire `citation_*`, Dublin Core, OpenGraph; images/video via `exiftool-vendored` (`CreateDate`/`DateTimeOriginal`, `OffsetTimeOriginal`, `Make`+`Model`, `LensModel`, `GPSLatitude/Longitude`, `ContentIdentifier` / QuickTime `com.apple.quicktime.content.identifier`).
  - `HttpClient` (`http.ts`): `getJson(url, opts: { cacheKey: string, ttlDays: 30 })` with on-disk cache in `<Library>/.cache/lookups/`, per-host rate limit (Crossref 5 req/s, OpenAlex 5 req/s, Open Library 1 req/s, LoC 1 req/s), 3 retries with backoff on 429/5xx, user agent `AlexandrineOxiana/<version> (+https://github.com/maquiscatta-sys/AlexandrineOxiana)`; contact email appended only if the user set it.
  - `lookupDoi(doi): Promise<LookupResult|null>` (Crossref `https://api.crossref.org/works/{doi}`, fallback OpenAlex `https://api.openalex.org/works/doi:{doi}`); `lookupIsbn(isbn)` (Open Library `https://openlibrary.org/isbn/{isbn}.json` + author records; fallback LoC SRU — implementer confirms current endpoint and records it in `docs/adr/0007-metadata-sources.md`); `searchTitle(title, creator?)` (OpenAlex search). `LookupResult = { title, creators, issued, container?, publisher?, type: SourceType, identifiers, provider: string }`.
  - Every lookup call is made only after `evaluate({action:'process', process:{op:'metadata_lookup', provider}})` allows it; a denied provider is skipped (not an error).
- [ ] **Step 1: Tests** (lookups use recorded HTTP fixtures via `undici` MockAgent; no live network in tests): PDF with DOI on page 1 → `identifiers.dois[0]`; scanned PDF → `needsOcr:true`; EPUB title/creator/ISBN; MOBI title/author; HTML `citation_title`; HEIC/DNG fixtures → `capturedAt`, `device`; `lookupDoi` maps a recorded Crossref response to `type:'article-journal'` with 2 creators; second call served from cache (MockAgent asserts one request); 429 then 200 → succeeds after retry; denied `crossref` → falls back to OpenAlex.
- [ ] **Step 2–4:** Run `vitest run src/extract src/lookup` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(library): metadata extractors and governed lookup clients`

### Task 17: Resolution pipeline and single-file attach

Spec §5.1 (drag-and-drop attach), §5.4 step 3.

**Files:** Create `packages/library/src/import/{resolve.ts,attach.ts}`; Test `packages/library/src/import/attach.test.ts`

**Interfaces:**
- Consumes: Tasks 11, 12, 15, 16.
- Produces:
  - `resolveItem(input: { path: string, mime: string, referenceMetadata?: Partial<SourceDraft>, sidecarPaths?: string[] }, ctx: { projectId, policy, patterns }): Promise<Resolution>`; `Resolution = { draft: SourceDraft, confidence: number, evidence: Evidence, candidates: LookupResult[] /* up to 3 for review */, needsOcr: boolean }` — order exactly as spec §5.4 step 3 (reference metadata → embedded → identifiers(+lookup) → sidecar → filename (+lookup) → title search); stops when confidence ≥ 0.9.
  - `attachFiles(projectId: string, paths: string[], opts?: { toSourceId?: string }): Promise<Array<{ path: string, outcome: 'created'|'attached'|'duplicate'|'needs-review'|'failed', sourceId?: string, reason?: string }>>` — for a drop on the library (no `toSourceId`): resolve, dedupe, create source with provenance `manual_upload` when confidence ≥ threshold, else create with `needs-review` flag in the review table; drop on a source → adds files as originals to that source; MIME sniffed with `file-type`; directories dropped are delegated to Bulk Import (Task 18) and return outcome `'failed'` with reason `'Use Bulk Import for folders'` from this function.
- [ ] **Step 1: Tests**: drop a PDF with a DOI (recorded lookup) → `created`, `provenance.identification.confidence` ≥ 0.9, title from Crossref; drop the same PDF again → `duplicate` with the first `sourceId`; drop `conference_slides.pdf` with only an embedded title → `needs-review`; drop onto an existing source → asset added under `original/`; project denying `manual_upload` → `failed` with the policy reason.
- [ ] **Step 2–4:** Run `vitest run src/import/attach.test.ts` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(library): metadata resolution and drag-and-drop attach`

### Task 18: Bulk Import engine (folders, ZIP, batches, review, resume, report, undo)

Spec §5.4 (wizard steps 2–7, options), §3.8.

**Files:** Create `packages/library/src/import/bulk/{scan.ts,batch.ts,run.ts,undo.ts,report.ts}`; Test `packages/library/src/import/bulk/bulk.test.ts`

**Interfaces:**
- Produces:
  - `ImportSourceAdapter` interface (implemented here for `folder`/`zip`, and by Tasks 19–21): `{ kind: ImportBatch['source']['kind'], scan(signal): AsyncIterable<ScanItem> }`; `ScanItem = { key: string /* stable per item, used for resume and incremental import */, files: Array<{ path: string, mime: string, bytes: number }>, referenceMetadata?: Partial<SourceDraft>, folderPath?: string[] /* for structure mapping */, annotations?: Annotation[] /* e.g. Zotero */, notes?: string[], externalKeys?: Record<string,string> }`.
  - `dryRun(projectId, adapter): Promise<ScanSummary>`; `ScanSummary = { items: number, byType: Record<string, number>, totalBytes: number, likelyDuplicates: number, alreadyImported: number, unreadable: Array<{ path, reason }> }` — nothing written.
  - `startBatch(projectId, adapter, options: ImportOptions): Promise<BatchHandle>`; `BatchHandle = { batchId, pause(), resume(), cancel(), progress: AsyncIterable<{ done, total, current?: string }> }`. Journal `Projects/<p>/imports/batch-<NNNN>/journal.jsonl` (one line per finished item `{ key, outcome, sourceId?, reason? }`); `resumeBatch(projectId, batchId)` skips keys already in the journal. Items resolved with confidence ≥ `autoAcceptThreshold` are created; below → `review_items` row (`status:'pending'`, resolution + candidates); duplicates follow `options.duplicates` (`merge` adds files + missing fields to existing source, recording `mergedInto` in the journal with the pre-merge `SourceFile` snapshot path for undo). Folder structure → collections (created per path segment) or tags. ZIP via `yauzl`, extracted to `<Library>/.tmp/batch-<id>/`, deleted at end. Post-processing: queue OCR jobs (Task 22) when `options.ocr && needsOcr`.
  - Review: `listReview(batchId)`, `decideReview(itemId, decision: { action: 'accept', draft?: SourceDraft } | { action: 'accept-candidate', index: number } | { action: 'merge', sourceId } | { action: 'skip' } | { action: 'keep-both' })`, `bulkEditReview(itemIds, patch: { type?: SourceType, tagIds?: string[], collectionId?: string })`.
  - `batchReport(batchId): Promise<ImportReport>` written to `imports/batch-<NNNN>/report.md` and `.json` (counts by outcome, failures with reasons, pending review, governance decisions); audit event `import.batch`.
  - `undoBatch(projectId, batchId): Promise<{ removedSources: number, revertedMerges: number }>` — deletes sources/assets/collections/tags created by the batch, restores merge snapshots; audited.
- [ ] **Step 1: Tests** (fixture folder of 20 generated files in nested folders + 1 ZIP + 1 corrupt PDF + 1 duplicate):
  - `dryRun` counts match and nothing is written (library tree unchanged);
  - batch run → created + needsReview + duplicates + failed totals equal items; nested folders become nested collections; corrupt PDF in report failures with reason;
  - `options.fileHandling:'link'` → asset has `linked` with both paths and the file is not copied;
  - interrupt after 7 items (cancel), `resumeBatch` → final counts identical to an uninterrupted run, no duplicate sources;
  - running the same batch source again → 0 created, all `duplicate`;
  - `undoBatch` → library source count back to the pre-import value and merged source restored to its snapshot;
  - 10,000 synthetic items (metadata-only `ScanItem`s, no files) finish in < 120 s on CI and memory stays < 500 MB (`process.memoryUsage().rss` sampled).
- [ ] **Step 2–4:** Run `vitest run src/import/bulk` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(library): bulk import engine with review, resume, report, undo`

### Task 19: Reference-manager exports and Calibre

Spec §5.4 (BibTeX/RIS/CSL-JSON, Zotero RDF, Calibre).

**Files:** Create `packages/library/src/import/{refman.ts,zotero-rdf.ts,calibre.ts}`; Test `packages/library/src/import/refman.test.ts`

**Interfaces:**
- Produces `ImportSourceAdapter`s: `bibtexAdapter(path)`, `risAdapter(path)`, `cslJsonAdapter(path)` (all via `@citation-js/core` + plugins; `file` fields resolved relative to the export file; citation keys preserved), `zoteroRdfAdapter(path)` (`@xmldom/xmldom`; maps `bib:Article`, `bib:Book`, `bib:BookSection`, `z:Attachment` + `link:link` paths, `dc:subject` → tags, `z:Collection` → `folderPath`), `calibreAdapter(libraryDir)` (copies `metadata.db` to `.tmp` and opens read-only; joins `books`, `authors` via `books_authors_link`, `identifiers`, `tags` via `books_tags_link`, `data` for format files at `<path>/<name>.<format lower>`). Provenance methods: `refman_import` (BibTeX/RIS/CSL-JSON/RDF), `calibre_import`.
- [ ] **Step 1: Tests**: committed small fixtures (`tests/fixtures/refman/{sample.bib,sample.ris,sample.json,sample.rdf}`, generated `calibre/metadata.db` via a fixture script creating the subset schema) → each adapter yields the expected `ScanItem` count, titles, creators, citation keys (`okafor2024feeding`), and resolved file paths; a BibTeX entry with a missing file path yields the item with an `unreadable` note, not a crash.
- [ ] **Step 2–4:** Run `vitest run src/import/refman.test.ts` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(library): BibTeX, RIS, CSL-JSON, Zotero RDF and Calibre importers`

### Task 20: Zotero local import (incremental, annotations, citation keys)

Spec §5.4 (Zotero specifics), §5.1.

**Files:** Create `packages/library/src/import/zotero-local.ts`, `tests/fixtures/zotero/build-fixture.mjs` (creates `zotero.sqlite` with the subset of the Zotero 7 schema used: `libraries, items, itemTypes, fields, itemData, itemDataValues, creators, itemCreators, creatorTypes, collections, collectionItems, tags, itemTags, itemNotes, itemAttachments, itemAnnotations, deletedItems, itemRelations, relationPredicates` + `storage/<KEY>/<file>`; optional `better-bibtex.sqlite` with `citationkey(itemKey, citationKey)`); Test `packages/library/src/import/zotero-local.test.ts`

**Interfaces:**
- Produces: `zoteroLocalAdapter(dataDir: string, opts?: { libraryId?: number /* default user library 1 */ }): ImportSourceAdapter` — copies `zotero.sqlite` (and `better-bibtex.sqlite` if present) to `<Library>/.tmp/` before opening read-only; skips `deletedItems`; maps item types → `SourceType` via a table in the file; creators with roles; collection hierarchy → `folderPath`; tags (with colors from settings when present) → tags; notes HTML → Markdown (`turndown`) attached as `Annotation{kind:'note'}`; stored attachments → files at `storage/<key>/<path minus 'storage:'>`; linked attachments → files with `fileHandling` forced to `link` unless the user chose copy; `itemAnnotations` (highlight/note/image with `position` JSON) → `Annotation` with `Anchor{kind:'pdf'}`; citation key: BBT DB → `Citation Key:` line in Extra → generated `family+year+firstTitleWord`; `externalKeys.zoteroKey` and `zoteroVersion` stored; `ScanItem.key = 'zotero:' + itemKey`; related items recorded in `externalKeys.related` for later linking; `dateAdded`/`dateModified` preserved in provenance details.
  - Incremental: re-run skips items whose `zoteroKey` exists in the project with the same `zoteroVersion`; changed versions update metadata fields (never provenance) and add new attachments.
- [ ] **Step 1: Tests** (fixture with 6 items, 2 nested collections, 1 deleted item, 1 linked attachment, 1 PDF with 2 annotations, BBT key on one item): 5 items imported; nested collections recreated; annotation anchors have page numbers; BBT key used; the Extra-field key used on another item; bump one item's version and title in the fixture DB → re-run imports 0 new sources and updates 1 title; source DB file is byte-identical after import (opened only as a copy).
- [ ] **Step 2–4:** Run `vitest run src/import/zotero-local.test.ts` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(library): incremental Zotero local import with annotations and citation keys`

### Task 21: Zotero Web API import, Zotero/refman export, watched folder, CLI

Spec §5.1 (Zotero export), §5.4 (Web API, watched folder, command-line tool).

**Files:** Create `packages/library/src/import/{zotero-web.ts,watch.ts}`, `packages/library/src/export/refman-export.ts`, `packages/library/src/secrets.ts`, `apps/cli/src/index.ts`; Test `packages/library/src/import/zotero-web.test.ts`, `packages/library/src/import/watch.test.ts`, `packages/library/src/export/refman-export.test.ts`, `apps/cli/src/cli.test.ts`

**Interfaces:**
- Produces:
  - `secrets.ts`: `getSecret(name)`, `setSecret(name, value)`, `deleteSecret(name)` via `@napi-rs/keyring` (service `AlexandrineOxiana`); never written to the library.
  - `zoteroWebAdapter(opts: { libraryType: 'user'|'group', libraryId: string, apiKeySecretName: string }): ImportSourceAdapter` — Zotero API v3 `https://api.zotero.org/{users|groups}/{id}/items?format=json&include=data&limit=100&start=N` with `Zotero-API-Key` header, honours `Backoff`/`Retry-After`; collections via `/collections`; files via `/items/{key}/file`; incremental via `?since=<lastLibraryVersion>` stored in project import settings.
  - `exportRefman(projectId, sourceIds: string[], format: 'csl-json'|'bibtex'|'ris'): Promise<string>` (citation-js; preserves citation keys); passes `evaluate({action:'export'})` and applies `deidentified-only` by excluding identifiable sources with a note.
  - `watchFolder(projectId, dir, options: ImportOptions): { stop(): void }` — chokidar, `awaitWriteFinish: { stabilityThreshold: 2000 }`; each new file → `attachFiles`; items below threshold go to the review queue; settings persisted in `project.json.watchedFolders`.
  - CLI `ao` (commander): `ao library create <path> --name`, `ao library open <path>`, `ao import <path> --project <name> [--link] [--structure collections|tags|none] [--duplicates merge|skip|keep-both] [--dry-run]`, `ao import zotero [--data-dir <dir> | --web user:<id>|group:<id>] --project <name>`, `ao rebuild-index`, `ao verify-audit --project <name>`, `ao export --project <name> --format bibtex|ris|csl-json`. Exit code 0 on success, 2 on governance denial, 1 otherwise; human-readable output by default, `--json` for machines.
- [ ] **Step 1: Tests**: Web API with MockAgent: paginates 150 items across 2 pages, honours `Backoff: 2` (fake timers), incremental `since` request on re-run; export BibTeX round-trips through `bibtexAdapter` with identical keys; identifiable source excluded from export when `deidentifiedExportsOnly`; watcher imports a file written in 3 chunks only once, after stability; CLI `ao import <fixtureDir> --dry-run --json` prints a `ScanSummary` JSON and exits 0; denied import exits 2 with the reason on stderr.
- [ ] **Step 2–4:** Run `vitest run src/import/zotero-web.test.ts src/import/watch.test.ts src/export && pnpm --filter @ao/cli exec vitest run` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat: Zotero Web API import, reference export, watched folder, CLI`

---

## Milestone E — Media worker and device media

### Task 22: Python media worker (job API, image/video proxies, OCR)

Spec §2.1 (media-worker), §5.3 (proxies), §5.1 (OCR).

**Files:** Create `services/media-worker/{pyproject.toml,ao_worker/__init__.py,app.py,jobs.py,image_proxy.py,video_proxy.py,ocr.py,location.py}`, `services/media-worker/tests/{test_api.py,test_image_proxy.py,test_video_proxy.py,test_ocr.py,conftest.py}`, `services/media-worker/README.md`; Create `packages/library/src/worker-client.ts` + test `worker-client.test.ts`

**Interfaces:**
- Produces (HTTP, JSON, bound to `127.0.0.1`, header `Authorization: Bearer <token>` from env `AO_WORKER_TOKEN`; port from `AO_WORKER_PORT`):
  - `POST /jobs` body `{ type: 'image.proxy'|'video.proxy'|'pdf.ocr', input: string /* absolute temp path */, output: string, params: object }` → `202 { id }`.
  - `GET /jobs/{id}` → `{ id, type, status: 'queued'|'running'|'done'|'failed'|'cancelled', progress: 0..1, result?: { output: string, meta: object }, error?: { code, message } }`; `POST /jobs/{id}/cancel`; `GET /health` → `{ ok: true, versions: { python, pillow, pillow_heif, rawpy, ffmpeg, ocrmypdf, tesseract } }`.
  - `image.proxy` params `{ maxEdge: 2560, quality: 85, location: 'keep'|'coarsen'|'strip' }`: HEIC/HEIF (pillow-heif), DNG/CR2/CR3/NEF/ARW/RAF/ORF (rawpy postprocess with camera white balance), JPEG/PNG → JPEG with orientation applied; output EXIF keeps capture time/device; GPS per `location` (`coarsen` = round to 1 decimal place ≈ city level; `strip` removes GPS IFD).
  - `video.proxy` params `{ maxHeight: 1080, crf: 23, location }`: ffmpeg → H.264/AAC MP4, `-movflags +faststart`; `strip`/`coarsen` handled via `-map_metadata -1` plus re-writing permitted tags (creation_time, coarsened `location` when coarsen); progress parsed from `-progress pipe:1`.
  - `pdf.ocr` params `{ languages: ['eng'] }`: `ocrmypdf --skip-text --output-type pdf --sidecar <output>.txt`; result meta `{ sidecarText: string path, pages: int }`.
  - Max 2 concurrent jobs; jobs are in-memory (the Node side owns persistence).
  - `worker-client.ts`: `WorkerClient.submit(projectId, job): Promise<JobResult>` — first calls `evaluate({action:'process', process:{op: 'image_proxy'|'video_proxy'|'ocr', provider:'local'}})` (deny → throws `PolicyDeniedError`, audited); decrypts encrypted inputs to `<Library>/.tmp/` first, polls every 500 ms, encrypts outputs per conditions, deletes temp files in `finally`; `jobs` table row per job so pending jobs are resubmitted on next launch.
- [ ] **Step 1: Tests (pytest)**: API rejects missing/invalid token with 401; HEIC fixture (generated in `conftest.py` with pillow-heif, embedding GPS 40.7128, -74.0060) → JPEG ≤ 2560 px, `coarsen` → GPS 40.7, -74.0, `strip` → no GPS IFD; DNG fixture → JPEG produced; a 3-second generated MOV (ffmpeg testsrc with location tag) → MP4 H.264, `strip` removes location; image-only PDF (generated with reportlab text rendered as image) → OCR sidecar contains the rendered word; cancel moves a running job to `cancelled`. **Tests (vitest)** for `worker-client.ts` with a stub HTTP server: encrypted input is decrypted to `.tmp` and the temp file is gone after completion (also after failure).
- [ ] **Step 2: Run** `pnpm test:py && pnpm --filter @ao/library exec vitest run src/worker-client.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** same — PASS.
- [ ] **Step 5: Commit** `feat(worker): media worker with image/video proxies and OCR`

### Task 23: iPhone and camera media import

Spec §5.3.

**Files:** Create `packages/library/src/import/device.ts`; Test `packages/library/src/import/device.test.ts`

**Interfaces:**
- Consumes: Tasks 11, 16, 18, 22.
- Produces: `deviceAdapter(dir: string): ImportSourceAdapter` — accepts any folder (SD card `DCIM/`, iCloud/AirDrop export folder, Image Capture or Windows Photos import folder); recognized extensions per spec §5.3; groups HEIC/JPEG + MOV with identical `contentIdentifier` into one `ScanItem` (Live Photo: still `original` + video `original` with `metadata.pairedAssetId` set both ways); also pairs RAW+JPEG with the same base name and capture time into one item; source type `field-photo` / `field-video` / `field-recording` (M4A/WAV/MP3); title = `"<capture date> <device model> - <original file name stem>"`; creator = `{ literal: '<researcher display name>', role: 'photographer' }`; provenance `device_import`; `store` decision with `hasLocation` drives conditions; after creation, queues `image.proxy`/`video.proxy` jobs with the project's `locationMetadata` mode and records derivations (proxies named via `derivedFileName` kind `proxy`).
  - `importDeviceFolder(projectId, dir, opts: ImportOptions & { sessionId?: string, participantIds?: string[] })` — wraps `startBatch` and links all created sources to the given session/participants.
- [ ] **Step 1: Tests**: fixture folder (generated HEIC+MOV pair sharing a content identifier, a DNG+JPEG pair, a standalone MP4, an M4A, and an exact duplicate HEIC) → 4 sources (live photo, raw+jpeg, video, audio), duplicate skipped by hash; live photo source has 2 originals cross-linked; GPS present + project `locationMetadata: coarsen` + encryption on → original stored encrypted, proxy JPEG GPS rounded to 1 decimal; same with encryption off → `store` denied with the Task 8 reason and reported in the batch failures; `sessionId` link present on all created sources.
- [ ] **Step 2–4:** Run `vitest run src/import/device.test.ts` FAIL → implement → PASS (worker stubbed with the Task 22 test stub).
- [ ] **Step 5: Commit** `feat(library): iPhone and camera media import with location governance`

---

## Milestone F — Citations

### Task 24: CSL bundle, Source → CSL mapping, rendering

Spec §8.1.

**Files:** Create `scripts/fetch-csl.mjs` (downloads pinned commits of `citation-style-language/styles` and `citation-style-language/locales` tarballs, verifies sha256, writes `packages/core/csl/styles.zip` + `locales/`), `packages/core/src/citation/{csl-map.ts,render.ts,styles.ts}`; Test `packages/core/src/citation/citation.test.ts` + snapshots in `packages/core/src/citation/__snapshots__/`

**Interfaces:**
- Produces:
  - `toCslItem(sf: SourceFile, opts: { citationLanguage: string /* e.g. 'en' */, translatedTitles: 'append'|'off', script: 'original'|'romanized' }): CslItem` — type map: `book→book, chapter→chapter, article-journal→article-journal, preprint→article (genre 'Preprint'), report→report, thesis→thesis, webpage→webpage, social-post→post, video→motion_picture (medium 'Video'), audio→song (medium 'Audio'), image→graphic, dataset→dataset, field-photo→graphic (genre 'Field photograph'), field-video→motion_picture (genre 'Field video'), field-recording→interview|document (genre 'Field recording'), interview→interview, manuscript→manuscript, presentation→speech, other→document`; creators by role (`uploader`/`channel` → `author` with handle as literal when no name; `photographer` → `author`); `container-title` = platform for social/video; `URL`, `DOI`, `ISBN`, `accessed`, `issued` as date-parts; title per `script`; when `translatedTitles:'append'` and the original title's language ≠ `citationLanguage` and a translated variant in `citationLanguage` exists → `title = "<original> [<translated>]"` (ADR records this choice); participant-coded creators render the participant code, never `details`.
  - `listStyles(query?: string): Array<{ id: string, title: string }>`; `loadStyle(id)`; custom styles importable via `addCustomStyle(xml: string): string /* id */` stored in `<Library>/styles/`.
  - `renderCitation(items: Array<{ item: CslItem, locator?: string, label?: 'page'|'chapter'|'section'|'paragraph'|'figure'|'timestamp' }>, styleId: string, format: 'text'|'html'|'rtf', lang = 'en-US'): string`; `renderBibliography(items: CslItem[], styleId, format, lang): string` (citeproc-js `CSL.Engine`).
  - `locatorFromAnchor(a: Anchor): { locator: string, label } | undefined` — pdf → page (1-based), time-range → `mm:ss–mm:ss` (`h:mm:ss` over an hour) with label `timestamp`.
- [ ] **Step 1: Tests**: snapshot citations + bibliography entries for 6 fixture sources (journal article, book, chapter, YouTube video, Instagram reel by `P-014` in Spanish with English translation, field photo) in `apa`, `chicago-author-date`, `modern-language-association`, `american-sociological-association`, `harvard-cite-them-right` — snapshots are reviewed by a human against the style guides before first commit (note in the test file header); APA reel bibliography contains `Receta de la abuela, sin filtros [Grandma’s recipe, no filters]` and `Instagram`; time-range anchor 38–46 s → `0:38–0:46`; romanized option uses the `romanized` variant for a Russian title; `listStyles('chicago')` returns > 3 styles.
- [ ] **Step 2–4:** Run `node scripts/fetch-csl.mjs && pnpm --filter @ao/core exec vitest run src/citation` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(core): CSL citations with multilingual titles and timestamp locators`

### Task 25: Bibliography export, copy-as-citation, backups, project export, retention

Spec §8.3 (Universal row), §9 (backups, open-format project export), §6.3(5) (retention & destruction).

**Files:** Create `packages/library/src/export/{bibliography.ts,backup.ts,project-export.ts}`, `packages/library/src/retention.ts`; Test `packages/library/src/export/bibliography.test.ts`, `packages/library/src/export/backup.test.ts`, `packages/library/src/retention.test.ts`

**Interfaces:**
- Produces: `citeSources(projectId, refs: Array<{ sourceId: string, anchor?: Anchor }>, styleId, format: 'text'|'html'|'rtf'): Promise<string>`; `exportBibliography(projectId, selection: { sourceIds: string[] } | { collectionId: string } | { tagId: string }, styleId, format: 'html'|'rtf'|'text', dest?: string): Promise<{ content: string, path?: string }>` writing to `<Library>/Exports/<project> - bibliography - <style> - modified <YYYY-MM-DD HHmm>.<ext>`; both run `evaluate({action:'export'})`, exclude/annotate identifiable sources under `deidentified-only`, and are audited.
  - `backupProject(projectId, opts?: { keep: number /* default 10 */ }): Promise<{ path: string }>` → `Backups/<project> - backup - modified <YYYY-MM-DD HHmm>.zip` (`.zip.enc` when the project is encrypted, using the project key); prunes to the newest `keep`; `restoreBackup(path, destRoot)` restores into a new project folder (never over an existing one). Automatic daily backup when the app is open (setting, default on).
  - `exportProjectOpenFormats(projectId, dest: string): Promise<{ path: string }>` → folder with `sources.csl.json`, `sources.bib`, one Markdown file per source (metadata, notes, annotations), `source.json` files, and original files (decrypted only after an `export` decision; identifiable sources follow `deidentified-only`).
  - `retentionDue(projectId, now): Promise<Array<{ sourceId, assetIds: string[] }>>` — raw originals of identifiable sources when `retention.rawDataDestroyAfter <= now`; `destroyRaw(projectId, assetIds, by: string): Promise<{ certificatePath: string }>` — deletes the files (overwrite-then-unlink), marks the assets `destroyed` in `source.json`, writes `Projects/<p>/retention/destruction-<YYYY-MM-DD HHmm>.json` (asset ids, sha256s, paths, time, actor) and an audit event; the UI (Task 30) shows due items and requires explicit confirmation.
- [ ] **Step 1: Tests**: APA bibliography for a collection of 3 is alphabetically ordered and written to `Exports/` with the dated name; RTF output starts with `{\rtf1`; export from a project with `deidentifiedExportsOnly` omits identifiable sources and the result notes `1 source withheld by project policy`; audit contains the export event; backup of an encrypted project is `.zip.enc`, restore yields byte-identical `source.json` contents, and 12 backups prune to 10; open-format export contains `sources.bib` that round-trips through `bibtexAdapter`; `retentionDue` lists an asset once the date passes, `destroyRaw` removes it, writes a certificate with its sha256, and the audit chain still verifies.
- [ ] **Step 2–4:** Run `vitest run src/export src/retention.test.ts` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(library): bibliography export, backups, open-format export, retention`

---

## Milestone G — Service, interface, desktop

### Task 26: Local library service (HTTP API)

Spec §8.2 (local service), §2.1.

**Files:** Create `apps/library-service/src/{server.ts,auth.ts,errors.ts,routes/{libraries.ts,projects.ts,sources.ts,import.ts,review.ts,governance.ts,audit.ts,fieldwork.ts,citations.ts,appearance.ts,jobs.ts}}`; Test `apps/library-service/src/server.test.ts`

**Interfaces:**
- Consumes: all of `@ao/library`.
- Produces (Fastify, `127.0.0.1`, port from `AO_SERVICE_PORT` or 0 → printed as `AO_SERVICE_READY port=<n>` on stdout; bearer token from `AO_SERVICE_TOKEN`; JSON; errors `{ error: { code, message, reason? } }` with codes `POLICY_DENIED` (403), `READ_ONLY` (409), `LIBRARY_OFFLINE` (503), `WRONG_PASSPHRASE` (401), `NOT_FOUND` (404), `VALIDATION` (400)):
  - Libraries: `GET /libraries`, `POST /libraries` `{path,name}`, `POST /libraries/open` `{path}` → includes `mode`, `readOnlyReason`; `POST /libraries/locate` `{libraryId}` (streams found paths as NDJSON); `POST /libraries/reconnect` `{path, libraryId}`; `POST /libraries/move/plan` `{dest}`, `POST /libraries/move` `{dest, excludeProjectIds}` (NDJSON progress), `POST /libraries/move/delete-old` `{token}`; `GET /libraries/integrity`, `POST /libraries/relink` `{searchDir}`; `POST /libraries/rebuild-index`; `GET /events` (SSE: `library.state`, `job.progress`, `import.progress`).
  - Projects: `GET/POST /projects`, `POST /projects/:id/unlock` `{secret}`, `POST /projects/:id/lock`.
  - Sources: `GET /projects/:id/sources?text&type&collection&tag&limit&offset`, `GET/PATCH/DELETE /projects/:id/sources/:sid`, `POST /projects/:id/attach` `{paths, toSourceId?}`; collections/tags CRUD under `/projects/:id/collections`, `/tags`.
  - Import: `POST /projects/:id/import/dry-run` `{adapter: {kind, ...}}`, `POST /projects/:id/import` `{adapter, options}` → `{batchId}`, `POST /imports/:batchId/{pause|resume|cancel|undo}`, `GET /imports/:batchId/report`, `GET /imports/:batchId/review`, `POST /review/:itemId/decide`, `POST /review/bulk-edit`; watched folders `GET/POST/DELETE /projects/:id/watched-folders`.
  - Governance: `GET/PUT /projects/:id/governance` (YAML text in/out; `PUT` returns `effectivePolicy` violations and rejects loosening without a reason), `GET /projects/:id/audit?limit&before`, `GET /projects/:id/audit/verify`.
  - Fieldwork: CRUD `/projects/:id/{participants,sessions,consents}`, `POST /projects/:id/device-import` `{dir, options, sessionId?, participantIds?}`.
  - Citations: `GET /styles?q`, `POST /cite` `{projectId, refs, style, format}`, `POST /bibliography` `{projectId, selection, style, format}`, `POST /export/refman`.
  - Appearance: `GET/PUT /settings/appearance` (stored in `<appConfigDir>/appearance.json`, per user and device).
- [ ] **Step 1: Tests** (Fastify `inject`): no token → 401; create library → open → create project → attach fixture PDF → search returns it; denied capture → 403 `POLICY_DENIED` with the reason; read-only library → 409 `READ_ONLY`; `PUT` governance loosening HIPAA encryption without a reason → 400 listing the violation; `GET /audit/verify` → `{ok:true}`; `POST /cite` returns an APA string.
- [ ] **Step 2–4:** Run `pnpm --filter @ao/library-service exec vitest run` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(service): local library HTTP service`

### Task 27: UI foundation — theme tokens, typefaces, appearance settings

Spec §8A.

**Files:** Create `packages/ui/{package.json,vite.config.ts,index.html}`, `packages/ui/src/{main.tsx,App.tsx,api/client.ts,theme/{tokens.css,themes.ts,fonts.css,contrast.ts,AppearanceProvider.tsx},screens/AppearanceSettings.tsx}`, `packages/ui/public/fonts/SortsMillGoudy-{Regular,Italic}.woff2` + `OFL.txt`; Test `packages/ui/src/theme/contrast.test.ts`, `packages/ui/src/screens/AppearanceSettings.test.tsx`

**Interfaces:**
- Produces:
  - Tokens (CSS custom properties) per theme `light | dark | light-hc | dark-hc`: `--bg --surface --surface-2 --ink --ink-2 --ink-3 --muted --line --line-soft --line-strong --chip --accent --accent-ink --on-accent --accent-soft --ok --ok-soft --ok-ink --warn-soft --warn-ink --amber-ink --deny --violet-soft --violet-ink` (light/dark values from the approved mockup canvas; HC variants derived to ≥ 7:1 for body text). No hard-coded colors in components (lint rule: stylelint `color-no-hex` outside `tokens.css`).
  - Code color palette: 12 colors distinguishable under deuteranopia/protanopia/tritanopia simulations (ΔE2000 ≥ 15 between any pair under each simulation), with light and dark variants.
  - `AppearanceSettings = { theme: 'system'|'light'|'dark', highContrast: boolean, accent?: string, fonts: { interface: FontChoice, reading: FontChoice, transcript: FontChoice, notes: FontChoice, mono: FontChoice }, textScale: 0.875|1|1.125|1.25|1.5, lineSpacing: 1.3|1.5|1.8, density: 'comfortable'|'compact', reducedMotion: 'system'|'on'|'off' }`; `FontChoice = { family: string, source: 'bundled'|'system'|'user-file', file?: string }`; default `interface/reading/notes` = Goudy stack (Global Constraints), `mono` = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`; presets include `Atkinson Hyperlegible` and `OpenDyslexic` (bundled, OFL).
  - `fontStack(choice: FontChoice): string` appends per-script fallbacks: `'Noto Serif', 'Noto Sans', 'Noto Naskh Arabic', 'Noto Sans Hebrew', 'Noto Sans Devanagari', 'Noto Serif CJK SC', 'Noto Serif CJK JP', 'Noto Serif CJK KR', 'Hiragino Mincho ProN', 'Songti SC', 'Apple SD Gothic Neo', 'Microsoft YaHei', 'Yu Mincho', 'Malgun Gothic', 'Segoe UI Historic', serif`.
  - `<AppearanceProvider>` applies `data-theme`, font stacks, scale, density to `document.documentElement`; follows `prefers-color-scheme` and `prefers-reduced-motion` when set to system; all user-entered and source text rendered with `dir="auto"`.
  - `contrastRatio(fg: string, bg: string): number` (WCAG 2.x relative luminance).
- [ ] **Step 1: Tests**: for each theme, every text token (`--ink*`, `--muted`, `--accent-ink`, `--ok-ink`, `--warn-ink`, `--amber-ink`, `--deny`, `--on-accent` on `--accent`) on `--bg`, `--surface`, and its own soft background has `contrastRatio ≥ 4.5` (HC themes ≥ 7); code palette ΔE check passes; Appearance screen: choosing Dark sets `data-theme="dark"`, choosing Inter changes `--font-interface`, the default interface stack starts with `'Goudy Old Style', 'Sorts Mill Goudy'`; a custom theme accent that fails contrast shows the warning "This accent color is too low-contrast for text" and is not applied.
- [ ] **Step 2–4:** Run `pnpm --filter @ao/ui exec vitest run src/theme src/screens/AppearanceSettings.test.tsx` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(ui): themes, Goudy typeface defaults, appearance settings`

### Task 28: UI — library, sources, drop zone, search, citations

Spec §4.5 (not-found/offline/read-only states), §5.1 (attach), §8.1 (copy citation). Layout follows mockup screens 1 and 5.

**Files:** Create `packages/ui/src/screens/{LibraryChooser.tsx,LibraryNotFound.tsx,Library.tsx,SourceDetail.tsx,UnlockProject.tsx}`, `packages/ui/src/components/{ProjectNav.tsx,CollectionTree.tsx,TagList.tsx,SourceTable.tsx,DropZone.tsx,SearchBox.tsx,CitePanel.tsx,StatusBanner.tsx,JobsIndicator.tsx}`; Tests colocated `*.test.tsx`

**Interfaces:**
- Consumes: service API (Task 26) via `api/client.ts` (`createClient(baseUrl, token)` with typed methods mirroring routes and an `events()` SSE subscription).
- Produces: screens wired to the API; `DropZone` accepts `onPaths(paths: string[])` (the desktop shell supplies OS file paths; the e2e browser build injects paths through the same prop); `StatusBanner` variants `read-only (locked by <hostname>)`, `read-only (newer format)`, `offline — reconnecting when <volume> returns`, `index rebuilding N/M`; `CitePanel` style picker (search over `GET /styles`), format, copy button using `navigator.clipboard`.
- [ ] **Step 1: Tests** (RTL + MSW mocking the service): chooser lists registered libraries; not-found screen shows Locate / Search / Wait / Open different, and "Search" renders found paths as they stream; library screen lists projects with profile badges, nested collections, tags, sources; typing in search calls `GET …/sources?text=` (debounced 250 ms); dropping paths calls `attach` and shows per-file outcomes (`needs review` links to the review queue); read-only banner disables the drop zone and edit buttons; Copy citation copies the API's string; encrypted locked project shows `UnlockProject` and a wrong passphrase shows "That passphrase didn't unlock this project. Nothing was changed." 
- [ ] **Step 2–4:** Run `pnpm --filter @ao/ui exec vitest run src/screens src/components` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(ui): library, sources, drop zone, search, citation panel`

### Task 29: UI — Bulk Import wizard and review queue

Spec §5.4. Layout follows mockup screen 4.

**Files:** Create `packages/ui/src/screens/import/{ImportWizard.tsx,StepSource.tsx,StepScan.tsx,StepReview.tsx,StepOptions.tsx,StepRun.tsx,StepReport.tsx}`, `packages/ui/src/screens/import/ReviewQueue.tsx`; Tests colocated

**Interfaces:**
- Consumes: import/review routes (Task 26).
- Produces: 7 steps exactly as spec §5.4 (Source → Scan → Identify → Review → Options → Run → Report & undo; Identify runs as part of Scan/Run progress); source choices: Folder, ZIP, Zotero (local data folder auto-detected at `~/Zotero` / `%USERPROFILE%\Zotero`, or Web API with key entry stored via `setSecret`), BibTeX/RIS/CSL-JSON/Zotero RDF file, Calibre library, Camera/phone folder (routes to device import with session/participant pickers); options default to copy, collections, merge, OCR on, transcription off; review queue with side-by-side preview, candidate list, bulk Set type / Add tag / Move to collection, per-item Accept / Edit / Merge / Skip / Keep both; report with Undo import (confirmation dialog naming the counts).
- [ ] **Step 1: Tests**: walking all steps with MSW posts the expected bodies (copy/collections/merge defaults); dry-run summary rendered with the four counts; selecting 3 review items and "Set type → Report" posts one bulk-edit; Pause/Resume buttons call the routes; Undo shows "Remove 1,284 imported sources and restore 3 merged sources?" and calls undo on confirm; Link-in-place option shows the flag warning text "Linked files are outside encryption and retention control and will be flagged in reports."
- [ ] **Step 2–4:** Run `vitest run src/screens/import` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(ui): bulk import wizard and review queue`

### Task 30: UI — governance, audit log, fieldwork, move library

Spec §6 (Phase 1 parts: settings, profiles, exceptions, audit; the verification report is Phase 5), §5.3 fieldwork, §4.5 move. Layout follows mockup screen 3.

**Files:** Create `packages/ui/src/screens/{GovernanceSettings.tsx,AuditLog.tsx,Fieldwork.tsx,MoveLibrary.tsx,MissingFiles.tsx}`; Tests colocated

**Interfaces:**
- Produces: Governance screen with profile toggles, one card per control (9 controls) showing value + which profile requires it, editing via form controls and "View governance.yaml" raw editor; loosening a profile-required value opens "Record a reason" (required text) and saves an exception; violations from `PUT` shown inline. Protocol record: number, dates, approved scope, and approval documents attached by drop (stored under `<Project>/protocol/`, encrypted when the project is). Retention: list from `retentionDue` with "Destroy raw data" requiring typed confirmation, then shows the certificate. Audit log: paged table + "Verify integrity" button showing `48,211 events — hash chain intact` or the broken position. Fieldwork: participants (auto codes), sessions, consent records (attach consent document via drop). Move library: destination picker → per-project plan with allow/deny reasons → exclude-or-cancel choice → progress → verification result → "Delete old copy" confirmation. Missing files report with "Search a folder…" → relink results.
- [ ] **Step 1: Tests**: toggling HIPAA shows encryption forced to required with "Required by HIPAA"; attempting to set encryption Optional prompts for a reason and the PUT body contains the exception; audit verify shows the broken position for a mocked failure; move plan with one denied project lists the reason and offers "Move the other projects only"; delete-old button stays disabled until verification succeeded.
- [ ] **Step 2–4:** Run `vitest run src/screens/GovernanceSettings.test.tsx src/screens/AuditLog.test.tsx src/screens/Fieldwork.test.tsx src/screens/MoveLibrary.test.tsx src/screens/MissingFiles.test.tsx` FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(ui): governance settings, audit log, fieldwork, move library`

### Task 31: Desktop shell, packaging, end-to-end tests

Spec §2.1 (desktop), §10 (end-to-end tests, plain-language report).

**Files:** Create `apps/desktop/{package.json,src-tauri/{Cargo.toml,tauri.conf.json,src/main.rs,capabilities/default.json}}`, `apps/desktop/scripts/build-sidecars.mjs` (Node SEA build of `@ao/library-service`; PyInstaller one-dir build of the media worker bundling ffmpeg, tesseract, ghostscript per platform), `e2e/{playwright.config.ts,phase1.spec.ts,fixtures.ts}`, `docs/adr/0008-desktop-shell.md`, `README.md` (user-facing: install, first run, where the library lives)

**Interfaces:**
- Produces: Tauri app that on launch generates two random 256-bit tokens, starts both sidecars on free ports (reads `AO_SERVICE_READY port=`), exposes Tauri commands `get_service_info() -> { baseUrl, token }`, `pick_folder()`, `pick_files(filters)`, and forwards OS drag-and-drop file paths to the UI (`tauri://drag-drop` event); stops sidecars on exit; single-instance. No library logic in Rust.
- E2E (Playwright, runs the UI dev build in Chromium against a real service + worker started by `fixtures.ts` with a temp library): one scenario per spec success criterion in Phase 1:
  1. create library → create IRB+GDPR project with encryption → recovery code shown once;
  2. attach a PDF with a DOI → source appears with Crossref title (recorded HTTP via service-level mock env `AO_LOOKUP_FIXTURES`) → copy APA citation;
  3. bulk import fixture Zotero data dir → collections recreated → review 1 item → report → undo → re-import;
  4. device import HEIC+MOV Live Photo → one source, proxy displayed, GPS coarsened;
  5. switch to dark theme and Inter → persisted after reload;
  6. move library to another temp dir → verified → old copy deleted; rename library folder outside the app → relaunch shows Library not found → Search finds it → reconnect;
  7. delete `library.sqlite` → reopen → index rebuilt, search works;
  8. render titles in Arabic, Hebrew, Chinese, Japanese, Korean, Devanagari, Greek, Cyrillic — assert `dir` is `rtl` for Arabic/Hebrew and capture screenshots into `reports/screens/` for human review.
- [ ] **Step 1: Write** `e2e/phase1.spec.ts` with the 8 scenarios.
- [ ] **Step 2: Run** `pnpm e2e -- --trace off` — Expected: FAIL until shell/fixtures exist.
- [ ] **Step 3: Implement** the Tauri shell, sidecar build script, and e2e fixtures; `pnpm --filter @ao/desktop tauri build` produces installers for the host OS.
- [ ] **Step 4: Run** `pnpm e2e -- --trace off && pnpm report` — Expected: all scenarios PASS; `reports/test-report.md` lists every area with ✓.
- [ ] **Step 5: Commit** `feat(desktop): Tauri shell with sidecars, packaging, and Phase 1 end-to-end tests`

---

## Spec coverage map (Phase 1)

| Spec item | Task(s) |
|---|---|
| §2.1 components (core, desktop, ui, media-worker, local service) | 1, 22, 26–31 |
| §2.2 extension points (CaptureProvider via `ImportSourceAdapter`, ProcessingProvider via worker job types + governance `process`, ExportTarget via export modules) | 16, 18, 22, 25 |
| §2.3 change log, UUIDv7, conflict rules (designed) | 2, 6, 11 |
| §3.1–3.8, 3.10 data model | 3, 11 |
| §4.1–4.4 portable library, naming, rebuild, pseudonymized names, `.enc`, manifest | 4, 9, 11, 12 |
| §4.5 move, reconnect, offline, lock, placeholders, multiple libraries, keys | 9, 10, 13, 14, 28, 30 |
| §5.1 Phase 1 providers (attach, Zotero import/export, Bulk Import, DOI/ISBN, device media) | 16–23 |
| §5.3 iPhone and camera media | 16, 22, 23 |
| §5.4 Bulk Import | 18–21, 29 |
| §6.1–6.4 governance (verification report is Phase 5) | 5, 7, 8, 11, 26, 30 |
| §8.1 citation engine; §8.3 universal exports | 24, 25, 28 |
| §8A appearance (themes, Goudy default, per-area fonts, fallbacks, accessibility basics) | 27, 28 |
| §6.3(5) retention & destruction certificates | 25, 30 |
| §9 reliability (originals never modified, backups, open-format export, fail closed, rebuild) | 9, 11, 12, 14, 25 |
| §10 testing + plain-language report | 1, every task, 31 |
| §12 documentation (READMEs, ADRs, governance docs) | 1, 4, 6, 7, 8, 9, 16, 24, 31 |

**Deliberately not in Phase 1** (per spec §11): web capture, YouTube/Instagram, transcription/translation, annotation UI and coding, writing integrations, sync server, verification report, research watches/agents. Also deferred: GDPR data-subject request tools (Phase 5, alongside the verification report, once annotations and transcripts exist to search) and face/voice/username de-identification of media (Phase 2, with the media pipeline). The data model and governance hooks for all of these are in place.
