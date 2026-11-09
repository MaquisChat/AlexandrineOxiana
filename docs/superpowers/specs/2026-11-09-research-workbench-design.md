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
- **SearchProvider** — the search side of a capture provider (e.g., YouTube search, OpenAlex query, TikTok Research API query); returns candidate items without capturing them. Used by research watches and agents (Section 5.7).
- **AgentProvider** — the language model behind research agents (Section 5.7); declares where it runs (local model / named cloud vendor, with BAA/DPA status) so governance can decide what it may see.
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

### 3.9 Research watches, agent runs, and candidates

- **Research watch** — a saved, scheduled search definition (Section 5.7): brief, queries per language, sources, schedule, screening criteria, budget, project.
- **Agent run** — one execution of a watch or agent: start/end, provider and model, prompt version, every query issued, results returned, decisions made, cost. Stored for audit and reproducibility.
- **Candidate** — a found item awaiting the researcher's decision in the Research Inbox: link, preview metadata, which run found it, relevance score and the agent's stated reason, and the researcher's decision (accepted / rejected with reason / snoozed). Accepted candidates become Sources through the normal capture pipeline.

### 3.10 Audit event

Append-only, hash-chained (each event includes the hash of the previous one). Fields: actor, device, action, entity, project, governance decision and reason, timestamp.

---

## 4. Library on disk: portable, human-readable files

**Principle:** the files are the durable record; the database is a rebuildable index.

### 4.1 Layout

```
<Library>/
  library.json                        # library identity (library id, format version); no secrets
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
- **All paths stored inside the library are relative to the library root.** No absolute paths are stored in the database, `source.json`, or any other library file (the only exception is the path of a *linked* file outside the library, Section 5.4, which is stored both absolute and relative-to-library and can be relinked). The library is identified by the **library id** in `library.json`, never by its location.

### 4.4 Governance interaction with file names

- In projects flagged as containing identifiable data, the governance engine **pseudonymizes file and folder names** (e.g., `@handle` → `P-014`), keeping the mapping in an encrypted key file.
- Encrypted files keep their readable name with `.enc` appended (e.g., `… modified 2026-11-09 1502.vtt.enc`).
- When encryption is enabled, `source.json` is encrypted too; the project keeps an unencrypted, non-identifying `manifest.json` (IDs, types, dates, file names) so that structure remains readable.

### 4.5 Moving the library and reconnecting to it

The library must be movable between storage locations and storage media — internal disk, another folder, external drive/SSD/USB, network storage (NAS/SMB), a cloud-synced folder (iCloud Drive, OneDrive, Dropbox, Google Drive), or the project's own sync server/cloud storage — **either from inside the app or by moving the folder outside the app**.

**Moving inside the app ("Move library…")**

1. Choose a destination: a folder on any mounted storage, a cloud-synced folder, or (Phase 5) the sync server / an S3-compatible cloud bucket.
2. **Governance check per project:** the destination must satisfy each project's residency rules (e.g., a HIPAA or local-only project may not be moved into a consumer cloud-synced folder unless that destination is listed as approved). If some projects are not permitted, the user may exclude them (they stay at, or are moved to, a permitted location) or cancel.
3. **Copy → verify → switch:** files are copied (resumable if interrupted), every file's hash is verified at the destination, the app switches to the new location, and only then — after explicit confirmation — is the old copy deleted. Nothing is deleted if any verification fails.
4. The move is recorded in the audit log (from, to, projects, verification result) and appears in the verification report as a change of storage location.

**Moving outside the app (reconnection)**

- The app remembers each library's id and last known locations. On startup, if the library is not at its last known location, the app shows **"Library not found"** with options:
  - **Locate library…** — browse to the library folder (or its `library.json`);
  - **Search for library** — scan mounted drives and common cloud-synced folders for a `library.json` with the matching library id;
  - **Open a different library** or **create a new one**.
- **On reconnect** the app verifies the library id, checks the format version, runs an integrity check (structure and a sample of file hashes; full check optional), rebuilds `library.sqlite` from the files if it is missing or out of date (Section 4.3), and records the new location in the audit log.
- **Partially moved or missing files** are listed in a **missing-files report**; the user can point to a folder where the app searches for them by hash and name and relinks them. Linked (non-copied) files outside the library are relinked the same way.
- **Removable or network storage that is temporarily unavailable:** the app shows the library as *offline* rather than failing, prevents edits that would be lost, and reconnects automatically when the drive or network returns.

**Encryption keys** are never stored in plain form inside the library. After a move or reconnect, encrypted projects require the user's key/passphrase (or key-recovery file) to open, so a moved or copied library remains protected.

**Cloud-synced folders and multiple devices**

- A **lock file** in the library records which device has it open. If another device holds the lock, the app opens the library read-only and explains why, avoiding database corruption from two devices writing through a file-sync service at once.
- "Online-only"/placeholder files (iCloud, OneDrive, Dropbox on-demand files) are detected and downloaded on demand, with a clear status, rather than treated as missing.
- For true simultaneous multi-device use, the app recommends the built-in sync server (Section 2.3), which is designed for it; a cloud-synced folder is supported for storage and moving between machines.

**Multiple libraries:** the app can register and switch between several libraries (e.g., one per grant, or one on an encrypted external drive for sensitive fieldwork).

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
| **Social media link capture (downloader)** — *first-order method* | Paste a post, reel, short, video, playlist, or profile URL from YouTube, Instagram, or TikTok; media, captions/subtitles, thumbnails, and the platform's metadata JSON are saved via yt-dlp (video) and gallery-dl (photos, carousels, highlights). Can use the researcher's own logged-in browser session for content visible only when signed in. | 1 |
| **Browser capture** — *first-order method* | Browser extension (Chrome/Edge/Firefox) "capture what I'm viewing": post media, caption, handle, timestamp, engagement counts, full-page screenshot and HTML snapshot; profile pages captured as the researcher scrolls. | 1 |
| **YouTube official API** (optional) | YouTube Data API for metadata and captions where permitted; YouTube Researcher Program where approved. For projects whose protocol requires official routes. | 2 |
| **Instagram official API** (optional) | Graph API for owned/managed accounts; Business Discovery for public business/creator accounts; Meta Content Library where approved. | 2 |
| **Legitimate access chain** | Institutional EZproxy + OpenURL link resolver; open-access lookup (Unpaywall, OpenAlex, CORE, Semantic Scholar, arXiv/SSRN/SocArXiv, PubMed Central, DOAJ, DOAB); books via HathiTrust, Internet Archive/Open Library (incl. controlled digital lending), Project Gutenberg, Google Books previews; interlibrary-loan request generator. | 5 |
| **TikTok official API** (optional) | Research API (requires approved academic access). | 2 |
| **Profile archive** | Whole YouTube channel, Instagram profile, or TikTok profile captured by downloader/browser as a set of linked sources, with incremental re-capture and removed-item tracking (Phase 1); scheduled monitoring and official-API routes (Phase 2) (Section 5.5). | 1 / 2 |
| **Website archive** | Crawl a whole website within defined scope; full-page screenshot of every page plus a replayable WACZ web archive (Section 5.6). | 2 |

**Out of scope by decision:** integrations with shadow libraries (e.g., Anna's Archive, LibGen). Files a user already holds can always be attached manually.

**Platform terms:** downloader and browser capture are the primary methods because the researcher needs them immediately and they work for any public content the researcher can see. They may conflict with platform terms of service, and using the researcher's own logged-in session puts that account at some risk if a platform detects automated access. Capture methods are therefore separate, individually enableable per project, shown with a one-time explanation when enabled, and always recorded in provenance (method, tool, and tool version), so the researcher and their IRB make an explicit, documented choice. The capture tools update independently of the app because sites change often; failed or partial captures are kept and labeled with the reason (login required, rate limited, removed, geo-blocked, extractor error).

### 5.2 Media pipeline (Python worker)

1. **Store original** — hash, encrypt if required, record provenance.
2. **Detect language** — per segment, handling code-switching.
3. **Transcribe** (Phase 1) — local faster-whisper by default with voice-activity detection; cloud providers (e.g., OpenAI, Deepgram, Google) only if governance permits. Output: timestamped segments with per-segment language, confidence scores, and **hallucination flags** (Section 5.8); speaker diarization where available (Phase 2).
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

### 5.5 Profile archive (Instagram, TikTok)

Captures an entire public profile as a structured, citable collection.

**Input:** a profile URL or handle, a target project, and options.

**What is captured**

- **Profile snapshot:** display name, bio, links, avatar, follower/following/post counts, verification status — stored as a dated snapshot, so repeated captures show how the profile changed over time.
- **Every post visible on the profile:** photos, carousels, reels/videos, captions, posting dates, hashtags, mentions, location tags, engagement counts as captured, and (Instagram) story highlights where visible.
- **Comments (optional, off by default):** comments are third-party personal data; enabling them sets the identifiability flag and requires that the project's protocol covers it.
- Each post becomes its own **Source** (so it can be transcribed, translated, coded, and cited individually), all grouped under a **profile collection** with a profile-level Source record. Provenance records the profile capture job and method for every item.

**Options:** date range, content types (posts / reels / highlights), metadata-only or full media, media quality, maximum number of items, include comments.

**Capture methods** (chosen per project and recorded in provenance, Section 5.1):

| Platform | Primary route (Phase 1) | Optional official route (Phase 2) |
|---|---|---|
| Instagram | Downloader (gallery-dl for posts, carousels, reels, highlights; yt-dlp for reels) with incremental archive; browser-extension capture of the profile as the researcher views it | Graph API for owned/managed accounts; Business Discovery API for public business/creator accounts; Meta Content Library where approved |
| TikTok | Downloader (yt-dlp profile pages) with incremental archive; browser-extension capture | Research API (approved academic access) |
| YouTube | Downloader (yt-dlp channel/playlist pages) with incremental archive | YouTube Data API; YouTube Researcher Program where approved |

**Incremental capture and monitoring**

- Re-running a profile archive fetches only new items and refreshes the profile snapshot.
- Optional **scheduled monitoring** (e.g., weekly) for profiles in the project's approved scope.
- Items that have disappeared from the platform are marked **"no longer available on platform (first noticed <date>)"**; the archived copy is kept or destroyed according to the project's retention rules. Edited captions are recorded as new versions.

**Safeguards (enforced by the governance engine)**

- Profile-level collection must be within the project's protocol scope (platforms, populations, date range). Profiles flagged as possibly belonging to minors trigger a protocol check before capture.
- Only content visible to the researcher is captured. The tool does **not** bypass private accounts, access controls, login walls, or platform anti-automation measures, and does not use accounts other than the researcher's own.
- Conservative rate limits; the job pauses and backs off automatically when the platform signals rate limiting, rather than retrying aggressively.
- Jobs are resumable, show progress, and produce a capture report (items captured, skipped, failed, and why), written to the audit log.

### 5.6 Website archive (whole-site capture and screenshots)

Captures an entire website, or a defined part of it, both as images and as a replayable archive.

**Input:** a start URL, a target project, and scope rules.

**Scope rules:** same domain only / include subdomains / path prefix only; link depth; maximum pages; include and exclude URL patterns; whether to include linked PDFs, images, audio, and video; optional time limit. A **dry run** estimates page count and storage before capture.

**Per page:**

- **Full-page screenshot** of the entire scroll height (PNG, plus a paginated PDF), at one or more viewports (desktop, tablet, phone).
- HTML snapshot, readable text (indexed for search in all languages), page metadata, and outgoing links.
- Lazy-loaded content is triggered by automatic scrolling; cookie/consent banners can be auto-dismissed (recorded in provenance); pages are rendered in a real browser engine (Chromium via Playwright) so dynamic sites capture correctly.

**Whole crawl:**

- A **WACZ web archive** (the open WARC-based standard used by the Internet Archive and Webrecorder) of the entire crawl, replayable inside the app exactly as the site appeared, and openable in other archival tools.
- A **site map view** of the captured pages; each page is individually citable by its original URL with the archive date.
- **Re-capture over time** of the same site, with a comparison view of what changed between snapshots (text changes and screenshot comparison).

**Data model:** a website archive is a Source of type *website snapshot* with one child Source per page (each with its screenshot, HTML, text, and WACZ reference as assets), grouped in a collection.

**Safeguards:**

- `robots.txt` is respected by default; overriding it requires a recorded justification and appears in the verification report.
- Polite crawling: limited concurrency and delay between requests; the crawler identifies itself with a descriptive user agent.
- Sites requiring login can be captured only with the researcher's own credentials, held in the operating system's keychain and never stored in the library.
- Governance checks apply before capture (protocol scope, identifiability flag for sites containing personal data, residency for where the archive is stored).

### 5.7 Research watches and research agents

Ongoing, automated discovery of new sources — articles, books, web pages, and new videos and posts on social media — delivered to a **Research Inbox** for the researcher to accept or reject.

**Two layers**

1. **Watches (deterministic, no AI required).** Saved searches that run on a schedule (hourly / daily / weekly) against SearchProviders and report new results since the last run:
   - **Literature:** OpenAlex, Crossref, Semantic Scholar, arXiv/SSRN/SocArXiv, PubMed, publisher RSS/table-of-contents feeds, new works by followed authors, new citations of key works ("cited by" alerts).
   - **YouTube:** keyword/channel/playlist search via the YouTube Data API, with language, region, and date filters (subject to API quota).
   - **Instagram:** monitored profiles (Section 5.5); hashtag search via the official Hashtag Search API where available (business-account requirement and limits on how many hashtags can be queried per week, so hashtags are chosen deliberately); browser-assisted checks of hashtag/explore pages as the researcher views them.
   - **TikTok:** keyword/hashtag/account queries via the Research API (with approved access); monitored profiles.
   - **Websites:** re-capture of archived sites and pages with change detection (Section 5.6); RSS/Atom feeds.
2. **Research agents (AI-assisted, optional).** A language-model agent works from a written **research brief** (research question, concepts, inclusion/exclusion criteria, languages, populations, platforms, date range) and uses the watches' SearchProviders as tools to:
   - **expand queries across languages and vocabularies** (synonyms, slang, transliterations, hashtags in each target language), shown to the researcher for approval before use;
   - **screen** new results against the inclusion/exclusion criteria, giving each a relevance score and a short stated reason (and, for video, screening on title, description, captions, or a transcript if governance permits);
   - **snowball**: follow references and citations of accepted literature, related channels/accounts of accepted creators, and recurring hashtags — proposing them as new watch terms rather than adding them silently;
   - **deduplicate** against the library and across platforms (reposts, re-uploads);
   - **summarize** each run into a digest ("12 new candidates; 3 strongly relevant; new hashtag emerging: …").

**Human in the loop (default)**

- Agents and watches **never add sources to the library by themselves**: they place candidates in the **Research Inbox**. The researcher accepts (which triggers normal, governance-checked capture), rejects (with an optional reason, which the agent uses to improve later screening), or snoozes.
- Optional per-watch automation: auto-capture **metadata only** for candidates above a confidence threshold; full media capture of human-subjects content always requires the researcher's acceptance unless the project's protocol explicitly allows automatic collection.
- Inbox views: by watch, by platform, by relevance; bulk accept/reject; digest notifications in the app (email optional).

**Governance and ethics**

- Every agent and watch action passes the governance checkpoint (Section 6): searching a platform must be within protocol scope; the agent's model provider is a processing location, so **restricted projects can require a local model** or a vendor with a BAA/DPA, and can limit the agent to non-identifiable metadata.
- Agents act only through the defined SearchProviders and capture pipeline — they do not post, message, follow, like, or interact with anyone on any platform, do not use accounts other than the researcher's own, and do not bypass access controls or rate limits.
- **Reproducibility and audit:** every run records the model, prompt and brief versions, each query issued, results returned, scores, and decisions. A **search log export** documents the search strategy, and a **PRISMA-style flow report** (records identified, deduplicated, screened, included, excluded with reasons) supports systematic and scoping reviews and methods sections.
- **Cost controls:** per-watch and per-project budgets (runs per period, token or currency limits), cost estimate before enabling, and automatic pause when a budget is reached.

**Where agents run**

- **Phase 2:** on the desktop while the app is open (missed runs catch up on next launch).
- **Phase 5:** additionally on the sync server for always-on monitoring, subject to residency rules.
- **AgentProvider** is provider-agnostic. The default cloud provider is Claude (via the Anthropic API, using tool use for the search tools; default model Claude Opus 5.5, with the option to choose a smaller, cheaper model for high-volume screening). Local open models (e.g., via Ollama) are supported for projects that must keep all processing on-device.

**Integration with external AI assistants (MCP server)**

- The app exposes the library through a **Model Context Protocol (MCP) server**, so external AI assistants and agent tools (e.g., Claude Desktop, Claude Code, or other MCP clients) can search the library, read permitted metadata and text, propose candidates to the Research Inbox, and fetch citations.
- Access is per project and read-mostly by default; writes are limited to adding Inbox candidates and notes. All access is governed and audited like any other actor, and identifiable data is never exposed beyond what the project's sharing rules allow.

### 5.8 Verification recheck (hallucination check)

Every time metadata is filled or changed by anything other than the researcher typing it — capture, import, lookup, OCR, transcription, translation, or (later) an agent — an automatic **recheck** runs before the item is accepted. Its purpose is to catch invented, mismatched, or unsupported values ("hallucinations") from AI models, heuristics, or wrong lookup matches.

**Field-level evidence.** Each metadata field records where its value came from (embedded file metadata, a named lookup service, the platform's metadata JSON, the captured page, the file name, an AI model, Zotero/reference import, or the user) and, where possible, the supporting quote or JSON path.

**Checks (per field):**

- **Grounding:** the value must be traceable to captured evidence — e.g., a title appears in the document's first pages or the platform caption; an author's family name appears in the document or a second source; a post date equals the platform's timestamp; a handle and post ID equal those in the platform JSON and the URL.
- **Cross-source agreement:** values from two independent sources are compared (e.g., Crossref vs. the PDF's text; downloader JSON vs. the browser-captured page). Disagreement is a **conflict**.
- **Identifier integrity:** DOIs must resolve and the resolved record's title must match the document; ISBNs must pass checksum and match the looked-up title.
- **AI-produced values** (from any language model) must carry a supporting quote that is found in the evidence; otherwise they are **unverified**. Machine translations are labeled as such and never treated as fact about the source.

**Statuses:** *verified* (grounded or confirmed by two sources), *single-source* (one trustworthy source, acceptable), *unverified*, *conflict*, *user-confirmed*. Any *unverified* or *conflict* field sends the item to the review queue regardless of its confidence score, and the field is visibly badged until resolved. The researcher can run "Recheck" on any item or on a whole project at any time.

**Transcripts and translations:** transcription segments are checked for known speech-recognition hallucination patterns — text produced over silence or music (no-speech probability vs. voice-activity detection), repetition loops, very low confidence, and stock phrases speech models are known to invent (e.g., "thanks for watching" over silence). Flagged segments are highlighted for review and never silently cited; translations with anomalous length ratios or untranslated spans are flagged the same way.

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

## 8A. Interface appearance and typography

The interface is customizable per user, from a single **Appearance** settings page. Settings are stored per user and device (optionally synced) as a human-readable theme file, so themes can be shared with collaborators or created by them.

### 8A.1 Theme

- **Light, dark, and follow system** (default: follow system), plus a **high-contrast** variant of each.
- All colors are defined as named **design tokens** (background, surface, text, muted text, lines, accent, status colors, code colors). Light and dark are two token sets; users can adjust the accent color or load a custom theme file. The UI never uses hard-coded colors, so every screen supports every theme.
- **Qualitative-code colors** come from palettes that remain distinguishable for common color-vision deficiencies and in both light and dark themes; users can assign custom colors per code.
- Every theme is checked automatically for text contrast (WCAG AA minimum: 4.5:1 for body text); a custom theme that fails is flagged before it is applied.

### 8A.2 Typeface

- **Default interface typeface: Goudy Old Style.** Goudy Old Style is a commercial font. The app uses the user's installed copy when present (it ships with some editions of Microsoft Office and is available for purchase); otherwise it falls back to **Sorts Mill Goudy**, a free (SIL Open Font License) revival bundled with the app, and then to Garamond/Georgia.
- **Separately configurable typefaces** for: interface, reading view (PDF/EPUB/web text reflow), transcripts and translations, notes and memos, and monospace (file names, hashes, citation keys). Any font installed on the system, any bundled open font, or a user-supplied font file (TTF/OTF/WOFF2) may be chosen.
- **Multilingual fallback:** each typeface choice has a per-script fallback chain (e.g., Noto Sans/Serif families for Cyrillic, Greek, Arabic, Hebrew, Devanagari, CJK, and others), so text in any language renders correctly even when the chosen typeface lacks those characters. Right-to-left scripts are laid out correctly in transcripts, translations, and annotations.
- **Size and spacing:** global text size scale, line spacing, and interface density (comfortable / compact). Optional readability fonts (e.g., Atkinson Hyperlegible, OpenDyslexic) offered as presets.

### 8A.3 Export appearance

Quote cards, screenshots with captions, clips with burned-in subtitles, and verification reports have their own **export style** (typeface, colors, layout), independent of the interface theme, so that presentation materials stay consistent regardless of the user's working theme. Export styles can be saved as presets.

### 8A.4 Accessibility

Full keyboard navigation, screen-reader labels, reduced-motion setting, and visible focus indicators in all themes. Font and theme choices never reduce functionality.

---

## 9. Reliability, errors, and data safety

- Originals never modified; all changes are new versions/derived assets.
- Encrypted, versioned local backups; one-click full project export in open formats (CSL-JSON, REFI-QDA, Markdown, original files, `source.json`).
- Sync conflicts: field-level merge; true rich-text conflicts keep both versions for the user.
- Platform failures (rate limits, downloader breakage, expired auth) shown clearly with retry; partial captures kept and labeled incomplete.
- Governance fails closed.
- Database corruption/loss recoverable via "Rebuild library from folder".
- Library moved, renamed, or on a disconnected drive: "Library not found" / offline handling and reconnection (Section 4.5); no data loss or crash.

---

## 10. Testing

- **Unit tests** for core: governance rules (each profile × each action), citation output against reference outputs for major styles (APA, Chicago, MLA, ASA, Harvard), file-naming rules (including non-Latin scripts and OS limits), audit hash-chain integrity, change-log conflict resolution.
- **Fixture projects** with synthetic data for each compliance profile, generating sample verification reports.
- **Import fixtures:** sample Zotero library, sample iPhone (HEIC, Live Photo, HEVC) and camera (RAW, MP4) files, sample PDFs/EPUBs.
- **Library move/reconnect tests:** in-app move with interruption and resume, hash verification failure (old copy kept), move blocked by residency rules, reconnect after an external move/rename, rebuild of a missing index, missing-file relinking, drive disconnect/reconnect, lock-file behavior with two devices, cloud placeholder files.
- **Watch and agent tests:** watches run against mocked SearchProviders (new-since-last-run detection, deduplication, quota handling, schedule catch-up); governance denials for out-of-scope platforms and for cloud models in restricted projects; budget limits and auto-pause; run-log completeness; PRISMA-flow counts. **Agent screening is evaluated** against a set of items the researcher has already accepted/rejected, reporting how often the agent's screening matches the researcher's decisions (precision and recall), so agent quality is measured rather than assumed.
- **Profile and website archive tests:** against local test fixtures (mock profile pages and a test website) — scope rules, depth and page limits, robots.txt handling, full-page screenshots of long and lazy-loading pages, WACZ validity and replay, incremental re-capture, detection of removed items, rate-limit backoff, resume after interruption.
- **Bulk import tests:** metadata-resolution order and confidence scoring, duplicate detection and merge policies, interrupt-and-resume, incremental Zotero re-import, batch undo, and a large synthetic library (10,000+ items) for performance.
- **End-to-end tests** driving the real app: import → capture → transcribe → translate → code → cite → export.
- **Theme and typography tests:** every screen rendered in light, dark, and high-contrast themes; automated contrast checks; font fallback rendering for non-Latin scripts and right-to-left text.
- **Plain-language test report** generated after each build so the owner can confirm what works without reading code.

---

## 11. Build phases

Each phase ends with something usable and has its own implementation plan.

1. **Foundation** — core data model; governance engine + audit log; portable human-readable library on disk with encryption; desktop shell; drag-and-drop attach (PDF/EPUB/any file, OCR optional); collections and tags; **Bulk Import tool** (Zotero, folders, ZIP, BibTeX/RIS/CSL-JSON, Calibre; review queue; batch undo; watched folder) and **Zotero import/export**; DOI/ISBN lookup; **iPhone and camera media import**; citation engine and bibliography export; **capture fast track: downloader and browser capture of YouTube, Instagram, and TikTok posts, videos, playlists, and whole profiles (incremental, removed-item tracking), local transcription with hallucination flags, a capture command-line tool usable before the full interface, and the browser extension**; **verification recheck** of all filled metadata and transcripts (Section 5.8); "Rebuild library from folder"; **appearance basics** (light/dark/system theme, design tokens, Goudy Old Style default typeface with fallbacks, multilingual font fallback, text size); **move library** (to any folder, drive, network storage, or cloud-synced folder) and **reconnect after an external move**; multiple libraries. Change log recorded (sync designed, not yet active).
2. **Capture & media** — web page snapshots; **website archive** (whole-site crawl, full-page screenshots, WACZ); optional official-API capture (YouTube Data API/Researcher Program, Instagram Graph/Meta Content Library, TikTok Research API); scheduled profile monitoring; translation (manual trigger with optional automation); speaker diarization; multilingual transcript viewer/editor; cross-language search; **research watches** (literature, YouTube, Instagram profiles/hashtags, websites), the **Research Inbox**, and **research agents running on the desktop** (research brief, multilingual query expansion, screening, snowballing, digests, search log and PRISMA-style report).
3. **Annotation & coding** — highlights on PDF/EPUB/web/video timeline/images; codebook; coding; memos; retrieval; REFI-QDA export/import.
4. **Writing integrations** — Word add-in, Obsidian plugin, Scrivener scan; quote cards, screenshots, clip export.
5. **Hybrid & agents** — always-on watches and research agents on the server, **MCP server** for external AI assistants; sync server (including moving a library or project to server/S3-compatible cloud storage), web app, installable mobile PWA (incl. phone photo/video upload), verification reports, legitimate access chain (EZproxy, OA lookup, ILL).
6. **Later** — custom theme files and per-area typefaces, export style presets (if not completed earlier), collaborators, roles and comments; analysis suite (IRR, co-occurrence, case comparison); native mobile; AI features (semantic search, auto-tagging, summarization, theme discovery).

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
| Transcription/translation trigger | Manual per item, optional per-project automation; transcription in Phase 1, translation in Phase 2 |
| Social media capture | Downloader (yt-dlp, gallery-dl) and browser capture are first-order methods in Phase 1 for YouTube, Instagram, TikTok; official APIs optional in Phase 2 |
| Verification recheck | Automatic recheck after any non-user metadata fill; field-level evidence and statuses; unverified/conflict fields force review; transcript hallucination flags |
| Shadow libraries | Not supported; legitimate access chain + manual attach instead |
| Zotero import | Phase 1 priority |
| File naming | Human-readable; derived files include date modified; database rebuildable from files |
| Appearance | Light/dark/system + high contrast; token-based theming; default typeface Goudy Old Style (installed copy, else Sorts Mill Goudy); per-area typefaces, multilingual fallback; separate export styles |
| Library location | Movable across folders, drives, network and cloud storage, in the app (copy → verify → switch, governance-checked) or outside it (reconnect by library id); relative paths only |
| Device media | iPhone and camera photos/video supported in Phase 1 |
| Research watches & agents | Watches, Research Inbox and desktop-run AI research agents in Phase 2; server-side always-on runs and MCP server in Phase 5; human acceptance required by default; governed model provider (local model option); full run logs, search-strategy export, PRISMA-style report; budgets |
| Profile archive | Whole YouTube, Instagram, and TikTok profiles (Phase 1, downloader/browser) as linked, citable sources; incremental capture, monitoring, removed-item tracking; comments off by default; no bypass of access controls |
| Website archive | Phase 2; scoped whole-site crawl; full-page screenshots per page at chosen viewports; WACZ archive; robots.txt respected by default; re-capture with change comparison |
| Bulk import | Phase 1; Zotero, folders, ZIP, reference-manager exports, Calibre; copy files into library by default (link optional, flagged); batch undo |
| Collections and tags | Added to data model (hierarchical collections; workspace/project tags), distinct from qualitative codes |
