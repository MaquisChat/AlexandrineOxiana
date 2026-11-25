# Phase 2 ("capture and media") — fact-finding

Code read on `main` (`.claude/worktrees/main-merge`, 4aa916c). Facts marked *(gk)* are general knowledge, not found in the repository.

## A. Today

Social-media capture, local transcription and single-page browser capture are built, governed and audited. No Phase 2 item exists beyond the hooks named below.

- **Links** (Capture screen, `ao capture`, extension): YouTube, Instagram and TikTok posts, videos, playlists and profiles through yt-dlp and gallery-dl (`packages/library/src/capture/`). Each capture stores the media, subtitles, thumbnail and cleaned platform JSON, with provenance and tool version. Plain web pages are refused here (R116).
- **Profiles:** incremental re-capture, dated profile snapshots, removed-item marks (R43, R44), rate-limit back-off.
- **Extension** (Chrome, Edge, Firefox): any page gives a full-page PNG and a script-stripped HTML snapshot (type `webpage`), shown only in `SnapshotFrame`. No readable text, no PDF rendering, no page resources.
- **Worker:** faster-whisper with voice-activity detection, per-window language and hallucination flags. Also proxies, ocrmypdf OCR and downloads. Jobs live in a sealed journal (`job-journal.ts`).
- **Transcript viewer:** synced player, flags, human-edit versions, re-transcribe.
- **First-use downloads (R126):** speech models (tiny about 75 MB to large-v3 3.1 GB), yt-dlp with deno, gallery-dl and ffmpeg. **OCR has no Mac download.** tesseract is "unavailable" unless already installed (`toolpins.py`).
- **Search:** FTS5 (`unicode61`, CJK bigrams) over titles, creators, OCR text and the newest transcript. Snapshot text is not indexed.
- **Unproven on a real Mac:** "that a tool now installs on the owner's own Mac" (R494, after build 8 could download nothing, R476). I found no record of a real capture, transcription or extension capture by the owner (Task 55). Behind an inspecting proxy, downloads can fail (FR-722).

## B. Items

Format per item: spec · builds on · missing · outside tools · constraints · size.

**1. Web page snapshots.** §5.1 (Phase 2): "full snapshot (HTML + rendered PDF/image), readable text, metadata via Zotero's open-source translators; optional Internet Archive save request." · Builds on `browser-capture.ts`, `SnapshotFrame`, html-strip. · Missing: capture of a pasted address in the app, readable text, PDF, translators, indexing. · Tools: Playwright with Chromium (about 150 MB, Apache/BSD, local, first-use); translators AGPL *(gk)*. · Constraints: R41, R101/R105/R109, R116. · **Medium.**

**2. Whole-site archive.** §5.6: a scoped crawl, a "full-page screenshot of every page", a WACZ "replayable inside the app exactly as the site appeared", re-capture comparison, robots.txt. · Builds on item 1, the job journal, import batches. · Missing: all of it. · Tools: Playwright; warcio or py-wacz (Apache/MIT); ReplayWeb.page (AGPL) *(gk)*. · **Replay needs scripts and a service worker, which R101 and the snapshot CSP forbid.** · **Large.**

**3. Official platform interfaces.** §5.1 and §5.5: YouTube Data API; Instagram Graph, Business Discovery or Meta Content Library; TikTok Research API, "for projects whose protocol requires official routes." · Builds on provenance value `official_api` and keychain secrets (R78). · Missing: the clients. · Network only; the researcher needs approvals, keys and quota. · **Medium per platform.**

**4. Scheduled monitoring.** §5.5: "Optional scheduled monitoring (e.g., weekly) for profiles in the project's approved scope." · Builds on profile capture and the Zotero scheduler (`apps/library-service/src/zotero-sync-scheduler.ts`). · Constraints: R43, R44, protocol expiry. · **Small.**

**5. Translation.** §5.2: "Local NLLB/Marian by default; DeepL, Google, or LLM translation if permitted. Each translated segment links to its source segment." · Builds on governance op `translation: ["local"]`, `translated` text variants (`core/src/model/text.ts`), derivations. · Missing: worker job, models, UI, §5.8 translation flags. · **NLLB is CC-BY-NC (non-commercial), refused by R218.** Marian/OPUS-MT are CC-BY, about 300 MB per language pair, and run on CTranslate2, already in the worker *(gk)*. · **Medium.**

**6. Speaker separation.** §5.2: "speaker diarization where available (Phase 2)." The spec says nothing more. · Missing: all of it. · pyannote has MIT code but its models are gated behind an account token *(gk)*. · Constraints: identifiability, participant codes (R117). · **Small–medium.**

**7. Multilingual transcript editor.** §11 "viewer/editor"; §3.4: translation anchors link to the original. · Builds on `TranscriptViewer.tsx` and `transcript-store.ts`. · Missing: side-by-side translation, editing languages and speakers. · **Medium.**

**8. Cross-language search.** §5.2: "full-text search across all languages, originals and translations." · Builds on FTS5 (`index/load.ts`). · Missing: indexing translations and snapshot text. · Constraint: R30. Semantic search is Phase 6. · **Small** after item 5.

**9. Research watches.** §5.7: "Saved searches that run on a schedule … against SearchProviders and report new results since the last run". Covers literature, YouTube, Instagram, TikTok, websites and RSS; records in §3.9. · Builds on Find's Crossref and OpenAlex search, runner and queue (`packages/library/src/find/`), and the scheduler. · **None of §2.2's provider interfaces exist.** · R14 exempts only four metadata services. · **Medium–large.**

**10. Research Inbox.** §5.7: watches and agents "never add sources to the library by themselves"; accept, reject with a reason, snooze; PRISMA-style report. · Builds on the review queue and its guards (R371). · **Medium.**

**11. Desktop agents.** §5.7: brief, query expansion "shown to the researcher for approval", screening, snowballing, budgets, run logs, a local-model option; §10 asks for measured precision and recall. · Builds on governance op `agent: ["local"]` only. · Needs a cloud language-model API (the spec names one) or a local model of several GB. · Constraints: BAA/DPA, "limit the agent to non-identifiable metadata". · **Large.**

## C. Dependencies

The provider interfaces and a shared scheduler come first. Then: 1 before 2; 5 before 7 and 8; 6 before 7; 3 before the social watches; 9 and 10 before 11. A Chromium first-use tool serves 1 and 2.

## D. Owner's decisions

1. Whether any cloud service may be used (translation, agents, speech). Defaults are local.
2. Whether to replay archived sites in the app (against R101), or to show screenshots and text only.
3. Translation models, given NLLB's licence.
4. Which official platform interfaces, and who holds the approvals.
5. Whether agents belong in Phase 2, and their budgets.
6. Gated diarization models.
7. A roughly 150 MB Chromium download.
8. Watches only while the app is open (spec) or a background helper.
9. Phase 2 or the Windows app first (PLAN §10 lists Windows first).
10. Mac OCR (tesseract CI build owed, R133).

## E. Contradictions

- SPEC B.3 and PLAN §9.8 call the licence open. R218 settled AGPL-3.0-or-later.
- The outline says "editor", yet the viewer is built.
- The outline omits the agents' duties (PRISMA, search log, budgets, evaluation), site comparison, Internet Archive, translators, translation flags, the provider interfaces and the §3.9 model.
- Extension page capture already exists, though §5.1 dates web pages to Phase 2.
- The MCP server is Phase 5.

## F. Not found

No ADR or ruling on any Phase 2 item. No owner live-capture results. No repository facts on translation, diarization or crawl tools.
