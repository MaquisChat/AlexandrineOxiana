# Alexandrine Oxiana — Social Science Research Workbench: Design Spec

- **Date:** 2026-11-09
- **Status:** Draft for review
- **Scope of this document:** Whole-system architecture and foundations, plus the phased roadmap. Each phase gets its own implementation plan; Phase 1 is planned first.

---

## 1. Purpose and intended outcome

A research workbench for social scientists that combines the strengths of Zotero (capture, metadata, citation), Obsidian (linked notes, plain files), and Scrivener (long-form writing support), and adds web-video capture, transcription, translation, qualitative coding, and explicit, verifiable data governance.

**Primary user (initially):** a single researcher, working across languages, studying both social media discourse (Instagram, YouTube, later TikTok) and literature (books, journal articles, websites), and writing long-form work.

**Priority workflows for the first build:**
1. **Social media discourse research** — capture posts and videos with full provenance, transcribe, translate, code, cite.
2. **Literature + writing** — import from Zotero, capture articles/books/web pages, annotate, code, cite in Word/Obsidian/Scrivener.

**Later workflows (designed for now, built later):** presentation/short-video excerpting at scale, collaboration with other researchers, a full qualitative analysis suite, native mobile.

**Success criteria for the first build:**
- Any source can be captured or imported, retrieved later, and its origin and handling proven.
- Any source, annotation, or coded segment can be cited in any CSL style, with precise locators (page, timestamp).
- Video from YouTube and Instagram can be captured, transcribed, and translated, with all text searchable in every language.
- Every project runs under an explicit, per-project data-governance configuration, and can produce a verification report.
- The library is a portable folder of human-readable files that survives the loss of the database.

**Maintainer context:** the owner has limited coding experience and will direct the work, later collaborating with experienced programmers. Therefore: conventional technology, plain-text configuration, thorough documentation (including Architecture Decision Records), and tests that report results in plain language. Foundations are built to professional standards; features on top start simple and are extended later.

---

## 2. Architecture

**Approach:** one TypeScript core shared by several shells, plus a Python media worker.

```
                ┌───────────────────────── core (TypeScript) ─────────────────────────┐
                │ data model · governance engine · audit log · citation engine (CSL)  │
                │ coding/codebook · change log (sync) · provider interfaces           │
                └───────┬──────────────┬───────────────┬──────────────┬──────────────┘
                        │              │               │              │
                  desktop (Tauri)   web app        server          integrations
                  local library     (browser,      (Node+Postgres  (browser extension,
                  SQLite + files    mobile PWA)     + object store) Word, Obsidian,
                        │                               │            Scrivener)
                        └──────── media-worker (Python) ┘
                          runs locally and/or on server, as governance permits
```

### 2.1 Components

| Component | Responsibility | Depends on |
|---|---|---|
| `core` | Domain model, governance engine, audit log, citation engine, codebook/coding, change log, provider interfaces. No UI, no I/O beyond injected adapters. | — |
| `desktop` | Primary workspace. Tauri shell kept thin; UI is the shared web UI. Owns the local library folder (SQLite index + file store), the local citation service, and launches the local media worker. | core, ui, media-worker |
| `ui` | Shared React interface used by desktop and web. | core |
| `web` | Browser access to synced projects; installable as a mobile PWA. | core, ui, server |
| `server` | Sync, accounts, object storage, server-side media worker; later collaborators. Self-hostable or cloud. | core |
| `media-worker` | Python service: yt-dlp download, metadata extraction, OCR, language detection, transcription (faster-whisper / cloud), translation (NLLB/Marian / cloud), media proxies (HEIC→JPEG, RAW→JPEG, ProRes→MP4). Job queue with progress and retry. | — (called via a documented HTTP/JSON job API) |
| `integrations` | Browser capture extension, Word Office Add-in, Obsidian plugin, Scrivener scan tool. Talk to the local citation service. | core (via service API) |

### 2.2 Extension points (stable interfaces)

These interfaces are the main way future programmers add capability without changing the core:

- **CaptureProvider** — `canHandle(input) → bool`, `capture(input, project) → CaptureResult` (source draft, assets, provenance).
- **ProcessingProvider** — transcription, translation, OCR, de-identification; declares where it runs (local / named cloud vendor) and whether a BAA/DPA exists, so governance can decide.
- **ExportTarget** — Word, Obsidian, Scrivener, REFI-QDA, BibTeX/RIS/CSL-JSON, quote card, clip.
- **AnalysisModule** (Phase 6) — read-only consumers of coding data (inter-rater reliability, co-occurrence, case comparison).

### 2.3 Sync model (hybrid from the start)

- Every change is recorded in an append-only **change log** (operation, entity ID, field, value, author, device, timestamp, project). All entities use globally unique IDs (UUIDv7) from day one.
- Sync exchanges change-log entries and files between devices and the server.
- **Governance filters sync:** each project's residency setting determines which entries and files may leave the device and to which destination. A *local-only* project syncs nothing (optionally not even its existence).
- **Conflicts** are resolved field-by-field (last-writer-wins per field with full history retained); true conflicts on rich text (notes, memos, transcript edits) keep both versions for the user to choose.
- Designed and recorded in Phase 1; server sync switched on in Phase 5.

---

## 3. Data model

All entities carry: `id` (UUIDv7), `created_at`, `created_by`, `modified_at`, `modified_by`, `project_ids`.

### 3.1 Workspace and Project

- **Workspace** — the library root; contains projects.
- **Project** — has a governance configuration (Section 6), a codebook (Section 7), members (initially one), residency and encryption settings, and an IRB/protocol record.
- A source may belong to several projects. When it does, **the strictest applicable governance rule wins** for that source.

### 3.2 Source

One item of evidence.

- **Type** (mapped to CSL types): book, chapter, journal article, preprint, report, thesis, web page, social post, video, audio, image, dataset, field photo, field video, field recording, interview, other.
- **Bibliographic fields:** creators with roles (author, editor, translator, uploader, channel, photographer, interviewer, interviewee), title, container (journal, book, website, platform), publisher, dates (issued, accessed, captured), identifiers (DOI, ISBN, ISSN, URL, platform post ID, Zotero key, citation key).
- **Multilingual fields:** every text field can hold multiple variants, each tagged with a BCP-47 language code and a kind: `original`, `romanized`, `translated`; translated variants record who/what produced them.
- **Provenance (immutable once captured):** original URL, capture timestamp, capture method (`official_api`, `browser_capture`, `downloader`, `manual_upload`, `zotero_import`, `device_import`), tool and version, file hashes (SHA-256), raw platform metadata snapshot (counts, handles, comments as captured), legal/consent status, identifiability flags.
- **Case attributes:** free key–value fields (e.g., speaker, region, demographic group) used for later case comparison.
- **Citation key:** stable, human-readable (e.g., `smith2025title`), preserved from Zotero/Better BibTeX on import.

### 3.3 Asset

A stored file.

- **Original assets:** the file as captured/imported; never modified.
- **Derived assets:** transcripts, translations, OCR text, viewing proxies, de-identified copies, thumbnails, excerpts. Each records its **derivation**: parent asset(s), operation, provider, model/version, where it ran (local / vendor), parameters, timestamp, and who triggered it. This derivation chain is evidence for the verification report.
- Human edits to derived text (transcript corrections, user translations) create new versions; machine output is never lost.

### 3.4 Anchor

A precise location inside an asset. Kinds: text range (character offsets + quote + context), PDF page + rectangles, EPUB CFI, time range (start/end ms), image region (rectangle/polygon), transcript segment(s). Anchors on translations link to the corresponding anchor in the original-language text.

### 3.5 Annotation

Points to one or more anchors. Kinds: highlight, note, coded segment, clip, screenshot. Records author, timestamp, and (for coded segments) the codebook version.

### 3.6 Fieldwork entities

- **Participant** — pseudonymous code (e.g., `P-014`), optional identifying details (governed), consent records.
- **Session** — a fieldwork event (date, place, participants), linking field media and field notes.
- **Consent record** — form/document, scope, date, expiry, withdrawal status.

### 3.7 Collections and tags

- **Collection** — hierarchical (parent → child) grouping of sources within a project. A source may be in several collections. Zotero collections and imported folder structures map here.
- **Tag** — free label, scoped to the workspace or to a project, with optional color. Tags are distinct from qualitative codes (Section 7): tags organize the library; codes are analytic and attach to anchors.

### 3.8 Import batch

Every bulk import (Section 5.4) is recorded as an **import batch**: source of import, options chosen, start/end time, counts, per-item results, and the governance decisions applied. Every source, asset, collection, and tag created by the batch references its batch id, so the batch can be reported on or undone as a unit.

### 3.9 Audit event

Append-only, hash-chained (each event includes the hash of the previous one). Fields: actor, device, action, entity, project, governance decision and reason, timestamp.

---

## 4. Library on disk: portable, human-readable files

**Principle:** the files are the durable record; the database is a rebuildable index.

### 4.1 Layout

```
<Library>/
  library.sqlite                      # index; rebuildable
  Projects/
    Instagram Discourse 2026/
      project.json                    # project metadata
      governance.yaml                 # human-readable governance config
      codebook.json                   # versioned codebook
      audit/                          # hash-chained audit log segments
      Sources/
        2025 Smith - Title of Article [a1b2]/
          source.json                 # full source metadata, provenance, annotations, codes
          original/
            2025 Smith - Title of Article.pdf
          derived/
            2025 Smith - Title of Article - ocr - en - tesseract-5 - modified 2026-11-09 1430.txt
        2026-03-14 @handle - Reel - Short caption [c3d4]/
          source.json
          original/
            2026-03-14 @handle - Reel - Short caption.mp4
          derived/
            2026-03-14 @handle - Reel - transcript - es - whisper-large-v3 - modified 2026-11-09 1502.vtt
            2026-03-14 @handle - Reel - translation - es-to-en - nllb-200 - modified 2026-11-09 1510.vtt
            2026-03-14 @handle - Reel - translation - es-to-en - human-edit - modified 2026-11-10 0912.vtt
  Exports/
  Backups/
```

### 4.2 Naming rules

- **Source folders:** `<year or capture date> <primary creator> - <short title> [<4-char short id>]`. The short id guarantees uniqueness without hurting readability.
- **Derived files:** `<source name> - <kind> - <language or pair> - <tool/model or "human-edit"> - modified <YYYY-MM-DD HHmm>.<ext>`. **Every derived file includes its date modified in the name.** Edits create a new dated file rather than overwriting, so version history is visible in the file system.
- Names are sanitized for Windows, macOS, and Linux (illegal characters replaced, length capped, Unicode normalized NFC). Non-Latin titles are kept in their original script; a romanized fallback is used only where a file system cannot store them.
- Templates are configurable per workspace.

### 4.3 Portability guarantees

- Each source folder's `source.json` contains everything needed to reconstruct that source (metadata, provenance, annotations, codes, memos, derivation records).
- **"Rebuild library from folder"** regenerates `library.sqlite` from the files.
- Copying a project folder to another machine and opening it restores the project.

### 4.4 Governance interaction with file names

- In projects flagged as containing identifiable data, the governance engine **pseudonymizes file and folder names** (e.g., `@handle` → `P-014`), keeping the mapping in an encrypted key file.
- Encrypted files keep their readable name with `.enc` appended (e.g., `… modified 2026-11-09 1502.vtt.enc`).
- When encryption is enabled, `source.json` is encrypted too; the project keeps an unencrypted, non-identifying `manifest.json` (IDs, types, dates, file names) so that structure remains readable.

---

## 5. Capture, import, and media pipeline

### 5.1 Capture and import providers

| Provider | Method | Phase |
|---|---|---|
| **Drag-and-drop attach** | Drop PDFs, EPUBs, images, audio, video onto the library or a source. Extract embedded metadata and DOIs/ISBNs from text; propose a match or create a new source; hash, store, encrypt per rules; provenance `manual_upload`. Optional OCR for scanned PDFs. | 1 |
| **Zotero import** | From the local Zotero data folder or the Zotero Web API: items, collections, tags, notes, attachments, PDF annotations, citation keys (incl. Better BibTeX). Provenance `zotero_import`. Also Zotero export. Runs through the Bulk Import tool (Section 5.4). | 1 |
| **Bulk Import** | Mass import of Zotero libraries, folders of files, ZIP archives, BibTeX/RIS/CSL-JSON exports, and Calibre libraries (Section 5.4). | 1 |
| **DOI lookup** | Crossref / OpenAlex metadata. | 1 |
| **ISBN lookup** | Open Library, Library of Congress; WorldCat where available. | 1 |
| **Device media import** | iPhone and camera photos/video (Section 5.3). | 1 |
| **Web page** | Browser extension or pasted URL; full snapshot (HTML + rendered PDF/image), readable text, metadata via Zotero's open-source translators; optional Internet Archive save request. | 2 |
| **YouTube** | Official YouTube Data API for metadata and captions where permitted; media download via yt-dlp as a separate, per-project-enableable method. | 2 |
| **Instagram** | Official Graph API for owned/managed accounts; oEmbed for public metadata; browser-extension "capture what I'm viewing" and yt-dlp fallback for other public posts, labeled as non-API capture in provenance. | 2 |
| **Legitimate access chain** | Institutional EZproxy + OpenURL link resolver; open-access lookup (Unpaywall, OpenAlex, CORE, Semantic Scholar, arXiv/SSRN/SocArXiv, PubMed Central, DOAJ, DOAB); books via HathiTrust, Internet Archive/Open Library (incl. controlled digital lending), Project Gutenberg, Google Books previews; interlibrary-loan request generator. | 5 |
| **TikTok** | Research API slot + browser capture mode. | 6 |

**Out of scope by decision:** integrations with shadow libraries (e.g., Anna's Archive, LibGen). Files a user already holds can always be attached manually.

**Platform terms:** non-API capture of social media may conflict with platform terms of service. Capture methods are therefore separate, individually enableable per project, and always recorded in provenance, so the researcher and their IRB make an explicit, documented choice.

### 5.2 Media pipeline (Python worker)

1. **Store original** — hash, encrypt if required, record provenance.
2. **Detect language** — per segment, handling code-switching.
3. **Transcribe** — local faster-whisper by default; cloud providers (e.g., OpenAI, Deepgram, Google) only if governance permits. Output: timestamped segments, speaker diarization where available, confidence scores.
4. **Translate** — to the project's target language(s). Local NLLB/Marian by default; DeepL, Google, or LLM translation if permitted. Each translated segment links to its source segment and timestamps.
5. **Human review** — edit transcripts/translations or add a human translation alongside the machine one; versions kept.
6. **Index** — full-text search across all languages, originals and translations.

**Triggering:** **manual per item by default**, with an optional per-project automation setting (e.g., "auto-transcribe new videos", "auto-translate to English"), off by default. Automated jobs pass the same governance checks.

**Jobs** run in a queue with progress, cancel, retry, and a recorded failure reason. Partial results are kept and labeled.

### 5.3 iPhone and camera media

- **Import routes:** camera/SD card folders (DCIM), iPhone via cable (as a device folder / Image Capture), AirDrop or iCloud Photos export folder, and direct upload from the phone through the mobile web app (Phase 5).
- **Formats:** HEIC/HEIF, JPEG, PNG, Apple ProRAW/DNG, camera RAW (CR2/CR3, NEF, ARW, RAF, ORF), HEVC/H.264 in MOV/MP4, ProRes; Live Photos kept as a linked still + video pair. Audio: M4A, WAV, MP3.
- **Originals untouched;** viewing proxies (JPEG/MP4) generated as derived assets.
- **Metadata extracted:** capture time with time zone, device make/model, lens, exposure, GPS, orientation (EXIF/XMP/QuickTime atoms).
- **Location is sensitive:** per project, governance keeps, coarsens (to city level), or strips GPS in derived and exported copies; originals keep it only if residency/encryption rules allow.
- **Fieldwork linking:** field media link to sessions, participants, consent records, and field notes; cited as the researcher's own field material.
- **Deduplication** by file hash.

### 5.4 Bulk Import tool

A wizard (and an equivalent command-line tool for experienced collaborators) for importing whole libraries at once.

**Import sources**

- **Zotero:** local data folder (reads a *copy* of `zotero.sqlite`, so Zotero may stay open and is never modified), Zotero Web API (personal and group libraries), or Zotero export files (Zotero RDF, CSL-JSON, BibTeX with files).
- **Folder:** recursive scan of a folder and its subfolders, including ZIP archives. File types: PDF, EPUB, MOBI/AZW3 (metadata only), DOCX, HTML, images, audio, video — including iPhone/camera folders (handled per Section 5.3).
- **Reference-manager exports:** BibTeX, RIS, CSL-JSON (e.g., Mendeley, EndNote, Paperpile), with linked files resolved where paths are present.
- **Calibre library:** reads `metadata.db` / `metadata.opf` and book files.

**Wizard steps**

1. **Choose source and target project.** The target project's governance applies from the start (e.g., if online lookup is not permitted, no titles/DOIs leave the device; if identifiability rules apply, file names are pseudonymized on import).
2. **Scan (dry run; nothing changes).** Inventory: item count, file types, total size, likely duplicates (within the import and against the existing library), items already imported, unreadable/encrypted files.
3. **Identify each item.** Metadata resolution in order, stopping when confident:
   1. existing reference metadata (Zotero, BibTeX/RIS, Calibre),
   2. embedded file metadata (PDF Info/XMP, EPUB OPF, EXIF),
   3. DOI/ISBN/arXiv ID found in the first pages of text (OCR if needed and enabled),
   4. sidecar files next to the item (`.bib`, `.ris`, `.opf`, `.json`),
   5. file-name patterns (e.g., `Author - Year - Title`, `Author_Year_Title`; user-definable),
   6. online lookup (Crossref, OpenAlex, Open Library) — only if governance permits.
   Each result receives a **confidence score** and records which method produced it (stored in provenance).
4. **Review.** Items above a confidence threshold are accepted automatically; the rest go to a review queue with side-by-side file preview, candidate matches, and bulk editing (e.g., set type, add tag, assign collection to a selection).
5. **Options (per import):**
   - **File handling: copy into the library (default)** or link in place. Linked files are outside encryption and retention control; they are marked as linked, and the verification report flags them.
   - **Structure:** folders → collections (default), folders → tags, or ignore folder structure.
   - **Duplicates:** detection by identical hash, same DOI/ISBN, or fuzzy match on title + first creator + year; policy **merge** (add files/metadata to existing source), **skip**, or **keep both**; uncertain matches go to review.
   - **Post-processing queues:** OCR for scanned PDFs; transcription for audio/video (off by default, consistent with manual triggering).
6. **Run.** Background job with progress, pause/resume, and checkpointing so it survives crashes and restarts. Streams items rather than loading everything into memory; parallel file processing; online lookups rate-limited and cached. Designed for libraries of tens of thousands of items.
7. **Report and undo.** An **import report** (counts by outcome, failures with reasons, items still needing review, governance decisions applied) is saved to the project and written to the audit log. Because each import is a batch (Section 3.8), **the whole batch can be undone** in one action (sources, files, collections, and tags created by that batch are removed; merges into pre-existing sources are reverted).

**Zotero specifics**

- Imports collection hierarchy, tags (including colored tags), notes (HTML → Markdown), stored and linked attachments, Zotero-reader annotations (highlights, notes, image annotations) as anchors and annotations, Better BibTeX citation keys, related-item links, and item dates added/modified.
- Preserves Zotero item keys, enabling **incremental re-import**: running the import again brings in only new or changed items, so the researcher can keep using Zotero during the transition.

**Watched folder (optional)**

A folder that is monitored; files dropped into it are imported automatically into a chosen project with saved options. Items below the confidence threshold wait in the review queue.

---

## 6. Governance engine and compliance

### 6.1 Single policy checkpoint

Every action — `capture`, `process`, `store`, `sync`, `view`, `export`, `share`, `delete` — calls the governance engine with the actor, project, entity, and action context. It returns:

- `allow`
- `deny` with a human-readable reason
- `allow_with_conditions` (e.g., "export only the de-identified copy", "process locally only")

Every decision is written to the audit log. **Fail closed:** if a policy cannot be evaluated, the action is denied.

### 6.2 Compliance profiles

Human-readable YAML files, reviewable by an IRB office: **University IRB**, **GDPR**, **HIPAA**, **Funder DMP**, **Custom**. A project can combine profiles; the strictest rule wins. Users may tighten any setting; loosening a profile-required setting requires a recorded justification and appears as an exception in the verification report.

### 6.3 Controls (all configurable per project)

1. **Data residency** — local only / sync to own server / sync to a named cloud region.
2. **Processing location** — per operation: local only, or a named list of permitted vendors (with BAA/DPA status recorded).
3. **Identifiability & de-identification** — flag sources/participants as identifiable; redact usernames, blur faces, alter/remove voices in derived copies; keep de-identified copies separate from raw originals; pseudonymize file names.
4. **Consent & provenance** — public / consented / restricted status, legal basis, capture method.
5. **Retention & destruction** — scheduled flagging or deletion of raw data (e.g., "raw video destroyed 3 years after study end"), producing a destruction certificate.
6. **Audit log** — append-only, hash-chained.
7. **Encryption** — at rest (per-file, AES-256-GCM) and in transit; user-held keys; key-recovery file the user stores separately.
8. **Sharing & export rules** — what collaborators may see (e.g., de-identified only), what may be exported or published in clips/quote cards, location-metadata handling.
9. **Protocol record** — IRB protocol number, approval documents, approved scope (platforms, populations, date range), approval and expiry dates; warnings when capture falls outside approved scope or after expiry.

### 6.4 Profile-specific behavior

- **GDPR:** legal basis per data category; data-subject request tools (find all data about a person → export or erase, with erasure logged); records of processing.
- **HIPAA:** encryption mandatory; cloud processing only via vendors marked as having a BAA; minimum-necessary export defaults.
- **Funder DMP:** planned repository, formats, metadata standard, embargo, and deposit-readiness checks.
- **University IRB:** protocol record required before capture of human-subjects data; scope and expiry enforcement.

### 6.5 Verification report

On demand per project: a **signed PDF plus machine-readable JSON** listing:

- active profiles and settings over time (with change history),
- evidence of enforcement per control: processing locations from derivation records, encryption status of every asset, retention/destruction certificates, consent coverage, sync destinations,
- audit-log integrity verification (hash-chain check),
- exceptions, overrides, and their justifications.

The report states explicitly that it **attests to the controls configured and enforced by the software**, and is **not a legal certification** of compliance with any regulation.

---

## 7. Qualitative coding

### 7.1 First build (Phase 3)

- **Codebook per project:** hierarchical codes with definition, inclusion/exclusion criteria, examples, color; **versioned**, with change history.
- **Coding any anchor:** text passages (PDF, EPUB, web), video/audio time ranges linked to transcript lines, image regions, and passages in translations (linked back to the original-language text).
- **Memos** on codes, segments, sources, and the project.
- **Retrieval:** all segments for a code (or combination) across all source types, with citations and locators.
- **REFI-QDA export/import** (interchange with NVivo, ATLAS.ti, MAXQDA).
- Coding data is governed like any other data (residency, sharing).

### 7.2 Designed for the later analysis suite (Phase 6)

Every coded segment records **coder identity, timestamp, and codebook version**; sources and participants carry **case attributes**. Inter-rater reliability (Cohen's kappa, Krippendorff's alpha), co-occurrence matrices, frequencies, and case comparison will be added as read-only **AnalysisModules** with no change to stored data.

---

## 8. Citations, writing integrations, and excerpts

### 8.1 Citation engine

- CSL via citeproc-js; the full Zotero style repository bundled; custom styles importable.
- Locators: page, chapter, section, paragraph, figure, timestamp (`12:34–13:02`). Citations created from annotations or coded segments carry their locator automatically.
- Multilingual: original-script, romanized, and translated titles rendered per style rules.
- Social media and video citation per APA/MLA guidance (platform, handle, post ID, date, timestamp).
- Field material cited as the researcher's own (photographer/recorder, date, place — subject to governance).

### 8.2 Local citation service

The desktop app runs a local, authenticated service that integrations call to search, cite, and fetch bibliographies. It applies governance (e.g., refuses to emit quoted text from restricted sources into an unapproved destination).

### 8.3 Integrations (Phase 4)

| Tool | Design |
|---|---|
| **Word** | Office Add-in (Windows, Mac, Word Online): search, insert citation, bibliography, change style; citations stored as live fields so a style change reformats the document. |
| **Obsidian** | Plugin: search and insert `[@citekey]` citations; auto-generated literature notes (one Markdown note per source with metadata, highlights, codes, memos), synced both ways. Pandoc-compatible. |
| **Scrivener** | Scrivener has no plugin API; use its supported workflow: insert `{Author, Year, @key}` placeholders (via copy or quick-search hotkey); after compile, the scan tool converts placeholders in RTF/DOCX to formatted citations and bibliography. BibTeX/CSL-JSON export for Pandoc users. |
| **Universal** | Copy-as-citation, clipboard hotkey; exports BibTeX, RIS, CSL-JSON, REFI-QDA. |

### 8.4 Excerpts for presentations and short videos

From any anchor: **quote card** (text + citation), **screenshot** with citation caption, **video clip** with optional burned-in subtitles (original or translated). Each excerpt ships with a citation sidecar file and is a derived asset with date-modified naming. Governance can require de-identified versions (blurred faces, removed handles, stripped location).

---

## 9. Reliability, errors, and data safety

- Originals never modified; all changes are new versions/derived assets.
- Encrypted, versioned local backups; one-click full project export in open formats (CSL-JSON, REFI-QDA, Markdown, original files, `source.json`).
- Sync conflicts: field-level merge; true rich-text conflicts keep both versions for the user.
- Platform failures (rate limits, downloader breakage, expired auth) shown clearly with retry; partial captures kept and labeled incomplete.
- Governance fails closed.
- Database corruption/loss recoverable via "Rebuild library from folder".

---

## 10. Testing

- **Unit tests** for core: governance rules (each profile × each action), citation output against reference outputs for major styles (APA, Chicago, MLA, ASA, Harvard), file-naming rules (including non-Latin scripts and OS limits), audit hash-chain integrity, change-log conflict resolution.
- **Fixture projects** with synthetic data for each compliance profile, generating sample verification reports.
- **Import fixtures:** sample Zotero library, sample iPhone (HEIC, Live Photo, HEVC) and camera (RAW, MP4) files, sample PDFs/EPUBs.
- **Bulk import tests:** metadata-resolution order and confidence scoring, duplicate detection and merge policies, interrupt-and-resume, incremental Zotero re-import, batch undo, and a large synthetic library (10,000+ items) for performance.
- **End-to-end tests** driving the real app: import → capture → transcribe → translate → code → cite → export.
- **Plain-language test report** generated after each build so the owner can confirm what works without reading code.

---

## 11. Build phases

Each phase ends with something usable and has its own implementation plan.

1. **Foundation** — core data model; governance engine + audit log; portable human-readable library on disk with encryption; desktop shell; drag-and-drop attach (PDF/EPUB/any file, OCR optional); collections and tags; **Bulk Import tool** (Zotero, folders, ZIP, BibTeX/RIS/CSL-JSON, Calibre; review queue; batch undo; watched folder) and **Zotero import/export**; DOI/ISBN lookup; **iPhone and camera media import**; citation engine and bibliography export; "Rebuild library from folder". Change log recorded (sync designed, not yet active).
2. **Capture & media** — browser capture extension and web snapshots; YouTube; Instagram; media worker (transcribe, translate; manual trigger with optional automation); multilingual transcript viewer/editor; cross-language search.
3. **Annotation & coding** — highlights on PDF/EPUB/web/video timeline/images; codebook; coding; memos; retrieval; REFI-QDA export/import.
4. **Writing integrations** — Word add-in, Obsidian plugin, Scrivener scan; quote cards, screenshots, clip export.
5. **Hybrid** — sync server, web app, installable mobile PWA (incl. phone photo/video upload), verification reports, legitimate access chain (EZproxy, OA lookup, ILL).
6. **Later** — collaborators, roles and comments; analysis suite (IRR, co-occurrence, case comparison); TikTok; native mobile; AI features (semantic search, auto-tagging, summarization, theme discovery).

---

## 12. Documentation for future collaborators

- `README.md` per package with plain-language purpose, how to run, how to test.
- `docs/adr/` — Architecture Decision Records for each foundational choice (language split, Tauri, SQLite + files-as-truth, UUIDv7 + change log, governance checkpoint, CSL, encryption scheme, file-naming scheme).
- `docs/governance/` — plain-language explanation of each compliance profile and control, suitable for sharing with an IRB office.

---

## 13. Decisions recorded in brainstorming

| Decision | Choice |
|---|---|
| Priority workflows | Social media discourse + literature/writing |
| Deployment model | Hybrid from the start (local-first library + sync server) |
| Architecture | TypeScript core + Tauri desktop + web + Node server + Python media worker |
| Code style | Conventional, well-documented; foundations professional-grade, features start simple |
| Governance | All nine controls, per project; IRB, GDPR, HIPAA, DMP profiles; verification report |
| Qualitative coding | Core coding in first build; full analysis suite later, designed for now |
| Transcription/translation trigger | Manual per item, optional per-project automation |
| Shadow libraries | Not supported; legitimate access chain + manual attach instead |
| Zotero import | Phase 1 priority |
| File naming | Human-readable; derived files include date modified; database rebuildable from files |
| Device media | iPhone and camera photos/video supported in Phase 1 |
| Bulk import | Phase 1; Zotero, folders, ZIP, reference-manager exports, Calibre; copy files into library by default (link optional, flagged); batch undo |
| Collections and tags | Added to data model (hierarchical collections; workspace/project tags), distinct from qualitative codes |
