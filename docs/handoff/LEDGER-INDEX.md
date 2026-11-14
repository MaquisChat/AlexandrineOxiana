# Ledger ruling index (one line per ruling in `docs/handoff/LEDGER.md`; made at the 2026-11-11 checkpoint. The ledger ends before the R118 integration commits, which the git log shows done.)
[OPEN] = assigns work to an unbuilt task (34, 37, final review, later, Phase 2+) or records an owner decision still owed, and nothing later in the ledger shows it done.

R1 (Task 1, ledger line 27): pnpm 10 / Python 3.13 locally; CI pins pnpm 10 and Python 3.12+3.13 matrix.
R2 (Task 1, line 28): SDD workspace (ledger) excluded via .git/info/exclude, not .gitignore. (PLAN.md §3 reverses this: ledger goes into git.)
R3 (Task 11, line 29): createSource opts carry provenance, fieldEvidence, verification, availability; recheck only from Task 16 on.
R4 (Task 3, line 30): identifiers.platform (youtube|instagram|tiktok|other) added for (platform, postId) dedupe.
R5 (Task 12, line 31): review_items table columns fixed (id, project, batch, source, kind, status, payload_json, created_at).
R6 (Task 12, line 32): sources table dedupe columns (platform, post id, doi, isbn13, sha256s) + findSourceBy in index/search.ts.
R7 (Task 15, line 33): Task 15 creates scripts/fetch-fixtures.mjs, sha256-pinned (LibriSpeech, CC0 DNG); Task 21 adds CR3.
R8 (Task 16, line 34): LookupEvidence type defined in verify/evidence.ts.
R9 (Task 18, line 35): profile capture records importBatchId (kind profile-capture); undo-of-profile test moved to Task 23.
R10 (Task 5, line 52): AuditEvent.action typed string; Task 8 narrows.
R11 (Task 5, line 53): verifyChain.brokenAt is 0-based position; reports should also print seq.
R12 (Task 5/11, line 54): external audit anchor per project in app-config; mismatch warns + audits. [OPEN] Phase 5 signed checkpoints.
R13 (Task 5, line 56): nested undefined inside audit decision/entity throws; callers omit keys.
R14 (Task 7, lines 62, 68): metadata lookup services exempt from vendor/BAA/DPA declaration; owner confirmed 2026-11-09.
(user decision, line 63): HIPAA projects may use approvedCloudFolders; public cloud still not allowed.
R15 (Task 7, line 64): governance exceptions need value, by, at; loosen only to approved value.
R16 (Task 8, line 69): protocol dates are inclusive calendar dates in researcher's tz; before approvedFrom → deny.
R17 (Task 8, line 70): callers of evaluate must pass system tz.
R18 (Task 9, line 75): wrapKey(dataKey, passphrase, keyId, opts) with keyId in AAD; async createRecoveryFile.
R19 (Task 9, line 76): key files and unencrypted identifiable files written 0600; writeFileAtomic gets mode.
R20 (Task 9, line 77): cleanupTempFiles matches only *.tmp-<hex>.
R21 (Task 10, line 80): unwritable root → read-only 'not-writable'; lost lock → read-only + onLockLost; ~1.5 s settle wait.
R22 (Task 11, line 84): repository IndexSink port called last in mutate; Task 12 implements.
R23 (Task 11, line 85): manifest.json must not contain titles/names; folder names stay readable unless pseudonymized.
R24 (Task 11/23, line 86): LinkedRelativePath allows '..'; linking refused in projects requiring encryption at rest.
R25 (Task 11, line 87): encrypted projects seal change-log lines; workspace-tag changes in <root>/changes/.
R26 (Task 11, line 88): write-ahead txn marker; openRepo rolls back markers lacking a committed audit event; assorted hardening.
R27 (Task 11/36, line 89): invalid/skipped txn markers persist; 'resolve pending write' UI action. (Done: R118 g, commit 41f5308 — roll back OR keep by user choice.)
R28 (Task 11, line 93): torn final audit line not committed; trimmed with warning+event; audit failure at open never rejects openRepo (recoveryPending).
R29 (Task 11, line 94): round-4 torn-line extensions accepted (read omits incomplete line, conservative blocking).
R30 (Task 12, line 98): encrypted-project index content only in in-memory TEMP schema while unlocked; secure_delete; raw-bytes test.
R31 (Task 12, line 99): review_items/import_batches/jobs must persist in files (sealed if encrypted); DB tables are rebuildable caches. [OPEN] jobs journal never built (code: rebuild.ts carries jobs table).
R32 (Task 12, line 100): encrypted projects keep readable (pseudonymized) folder titles; raw-bytes test masks them.
R33 (Task 13, line 106): move rules: residency on realpath+typed path, uncertain → strictest, MOVED.json, journal phases, split mode, pending deletions in appConfigDir.
R34 (Task 14, line 107): findLibrary flags MOVED.json copies and ranks them below live copies.
R35 (Task 14, line 113): relinkMissing skips locked encrypted projects and outside-library linked files.
R36 (Task 18, line 118): includeComments must extend worker capture.download params.
R37 (Task 16, line 123): evidence counts only if it agrees with draft; grounding minimum-length rules.
R38 (Task 16, line 124): full ordered creator lists; strict user-confirmed; FieldVerification.current.
R39 (Task 16, line 125): literal-name, identifier-set, near-match and precision rules for verification.
R40 (Task 16, line 129): recheck never keeps user-confirmed over integrity conflict; draft ⊆ evidence ids; AI date components.
(Task 16 breaker ruling, line 133): masthead-label false-day fix carried into Task 17.
R41 (Task 17, line 136): signed/CDN URL key stripping; legal basis per category + per-capture override + LEGAL_BASIS_REQUIRED; capture audited at authorization.
R42 (Task 17/18, line 138): more snapshot key-strip words; re-evaluate capture right before store.
R43 (Task 18, line 141): any maxItems disables removed detection; listing-scoped checks; comments always need legal basis.
R44 (Task 23, line 142): undo of profile batch forgets its post ids; never recapture deliberately deleted posts.
R45 (Task 23, line 144): undoBatch finds sources by provenance importBatchId; stale running batches shown interrupted.
R46 (Task 19, line 147): extra CLI protocol flags; ao recheck persists; paused profile run exits 4.
R47 (Task 19, line 151): AO_RATE_LIMIT_WAIT_MS honoured only under NODE_ENV=test/VITEST (test-only switch precedent).
R48 (Task 20, line 153): identification deviations accepted (hasTitle/hasCreator, user patterns first).
R49 (Task 20, line 154): ISBN-10 needs label; arXiv validation; canonical DOI/ISBN dedupe; ReDoS vetting at definition time.
R50 (Task 21, line 158): lookup cache never leaks encrypted content (memory-only for sensitive); extractor zip/size limits; no embedded content execution.
R51 (Task 21, line 159): ADR 0011; capturedAtSource flagging; LoC plain HTTP never for sensitive. [OPEN] LoC address unverified on real network (PLAN §7).
R52 (Task 21, line 160): LoC skipped for sensitive lookups; LookupContext fail-closed sensitive:true; scan caps and timeouts.
R53 (Task 22, line 164): auto-accept threshold 0.9; identifier+lookup 0.97 only with agreeing local title; review persisted per R31.
R54 (Task 22, line 165): attach deviations; GPS → hasLocation; PDF Info dates never fill issued.
R55 (Task 22, line 166): unconfirmed identifiers never written/used for dedupe; grounding; linear regexes.
R56 (Task 22, line 167): attach fails closed on GPS under coarsen/strip until Task 27 (superseded by R83).
R57 (Task 22, line 168): text-only identifiers never auto-accepted; refuse hook hardened; GPS detection fails closed.
R58 (Task 22, line 169): exact normalized title needed to confirm file-derived identifiers; exiftool errors → readFailed. [OPEN] governance-load warnings to surface on Task 36 screen (not shown done).
R59 (Task 23, line 172): bulk import reuses attach rules; index dedupe keys; ZIP limits; regex vetter + 50 ms watchdog.
R60 (Task 23, line 173): write-path performance changes allowed only if R26 crash-safety holds.
R61 (Task 23, line 174): undo keeps used tags/collections and user edits; serialised batch allocation.
R62 (Task 23, line 175): performance changes kept with TxnLog/change-log fixes.
R63 (Task 23, line 177): import-item keys stored as HMAC with per-batch secret; test:scale separate sequential script.
R64 (Task 23, line 178): [OPEN] Task 37: service Node runs with --max-old-space-size≈512; Task 34/36 pseudonymisation flags (done for titles/collections/tags in Task 35; list items from R69/R75/R77 not shown done).
R65 (Task 24, line 180): adapter input caps, linear parsing, RDF DOCTYPE refused, Calibre read-only copy, stable keys.
R66 (Task 24, line 181): own parsers (citation-js rejected); missing attached file never loses the reference (metadata-only).
R67 (Task 24, line 183): OWNER DECISION "option 2": files outside declared roots need explicit approval.
R68 (Task 24, line 184): BibTeX budgets, Calibre caps, unsupported files dropped with notes, report labels without paths.
R69 (Task 24, line 185): approved import folders in device app settings (0600, per library); 1252 fallback; batch.json location flagged for pseudonymisation review.
R70 (Task 24, line 187): export record cap 200k; realpath re-checks at copy; Calibre generated/virtual tables refused.
R71 (Task 24, line 188): RDF element cap 500k; streaming SAX RDF [OPEN] deferred/later.
R72 (Task 25, line 190): Zotero local import: private DB copy, caps, note sanitising, annotations, incremental update rules.
R73 (Task 25, line 191): deleted-here Zotero items tombstoned, not re-imported; several Zotero features deferred.
R74 (Task 25, line 193): tombstone/annotation hardening; [OPEN] annotation full-text indexing assigned to "Task 32" (which became UI foundation) — never done.
R75 (Task 25, line 194): hot-journal handling, virtual tables, note link escaping, citation-key order; BBT Loki store deferred.
R76 (Task 25, line 195): mergedExternalKeys outside provenance; provenance immutability guard.
R77 (Task 25, line 197): crafted super-journal refused (victim-file test). [OPEN] Zotero keys/citekeys listed for pseudonymisation review.
R78 (Task 26, line 200): Zotero Web (keyring-only key), own export writers, watched folders in device settings, CLI conventions.
R79 (Task 26, line 201): Zotero storage hosts allowlist UNVERIFIED; free-space check; network guard in tests. [OPEN] real-download check (Task 55).
R80 (Task 26, line 202): since only after full success; version-conditional paging; BibTeX brace export.
R81 (Task 26, line 203): verify-audit no-heal mode; watched-folder hardening; single per-project store queue.
R82 (Task 26, line 205): anchor-missing never silent; bulk re-checks duplicates in its queue turn. Anchor-rollback+truncation undetectable (accepted).
R83 (Task 27, line 208): located originals stored per decision, proxies apply location mode; replaces R56; jobs per R31; proxy GPS verified.
R84 (Task 27, line 209): device-import deviations; [OPEN] failed proxy jobs surfaced in UI (Task 34); researcherName setting (done 0ad6506).
R85 (Task 27, line 210): proxy jobs use stricter current mode; coarsen/strip projects need encryption for located originals.
R86 (Task 28, line 214): citeproc pinned, platform-neutral core, CSL CC BY-SA notice shipped, custom styles governed; [OPEN] snapshots PENDING HUMAN REVIEW (owner).
R87 (Task 28, line 215): extra bibliographic fields; platform CSL mapping; citeproc-js licence CPAL-1.0/AGPL-3.0 USER DECISION before distribution [OPEN until R120+ records owner's CPAL choice].
R88 (Task 28, line 217): fresh engine state per render; name scrubbing; custom styles sandboxed. [OPEN] governance wiring of participant codes in Tasks 32/36 only partly done (R90a).
R89 (Task 28, line 219): macro cap 1M backstop; sandbox pool (2 workers, timeouts).
R90 (Task 29, line 222): (a) citations/bibliography governed; (b) backups: zipped, sealed, manifest-based pruning, restore into new project (audited), backupIfDue; (c) open export rules; (d) retention destruction + certificate. Backup creation itself not stated as governed.
R91 (Task 29, line 223): backups >2 GB must work; normal pruning unlinks without overwrite (accepted); restore remaps ids.
R92 (Task 29, line 224): Zip64 backups; 'backup-failed' warning, never silent; restore remaps; export .partial; corrupt manifest fails closed.
R93 (Task 29, line 225): restore remaps importBatchId; jobs table is a DB cache per R31; [OPEN] Project.timeZone set via Task 33/36 settings (not shown done).
R94 (Task 29, line 226): sealed backups resolved on unlock, rename-safe matching; export partial sweep rules.
R95 (schedule, line 227): OWNER DECISION: parallel worktrees; order T30 → {31,32} → {33,35,36} → T34 → T37.
R96 (Task 30, line 230): service security: 127.0.0.1, constant-time token, Host check, Origin only shell/paired extension, no query tokens; carry-overs. [OPEN] --max-old-space-size for Task 37 sidecar.
R97 (Task 30, line 231): route deviations accepted; fieldwork update/withdraw for Task 36 (done).
R98 (Task 30, line 232): loosening detection; exact credential query-key filter; the service token on standard input: done in Task 37b (the worker's token follows in Task 37c); /proc mkdir spin deferred.
R99 (Task 30, line 233): governance PUT with base hash/409; batch registry; shutdown pauses; move quiesce; backupIfDue on open/unlock; browser capture stripping.
R100 (Task 32, line 235): mockup tokens, fonts pinned/OFL; [OPEN] user-file fonts loaded via service/desktop (Tasks 33/37); no tokens in URLs.
R101 (Task 30/33/34, line 236): parse5 stripping; [OPEN] binding for Task 34: archived HTML only in sandboxed frame, never in app webview.
R102 (Task 30, line 237): move gate 503; ndjson disconnect handling; single move guard.
R103 (Task 32, line 238): code palette by hue family; [OPEN] codes never by colour alone (name + glyph) in Task 34/35 UI.
R104 (Task 30, line 241): mXSS fixpoint stripping; stored snapshots carry CSP meta; strip pool limits.
R105 (Task 32, line 242): settings PUT serialised; colour lint; font stacks; client URL/token guards; app CSP text; SnapshotFrame for 33/34; palette refit.
R106 (Task 30, line 243): one work registry for all background work; move waits for in-flight mutations.
R107 (Task 30, line 245): linear pre-scan tokenizer, strip time/queue budgets; snapshot CSP default-src 'none'.
R108 (Task 30, line 246): stopped work restarts on its own root; locked → 423; shared font-name rule.
R109 (Task 32, line 248): app CSP style-src 'unsafe-inline'; snapshot CSP frame-src 'none'; colour-scan coverage; failed-save state; service imports @ao/shared.
R110 (Task 31, line 250): extension MV3 minimal permissions, token in storage.local, user-click only, no URL tokens.
R111 (Task 31, line 251): extension token without Origin only on GET /projects; POST /capture/browser/links.
R112 (Task 31, line 252): inert snapshot document; byte-measured bodies; per-suite run-e2e flags.
R113 (Tasks 33/35/36, line 257): per-task API/route modules; UI rules (tokens, UserText, a11y, no innerHTML, SnapshotFrame, citations via service). [OPEN] applies to Task 34.
R114 (Task 33, line 261): StatusBanner maps every warning kind; profiles in GET /projects; wait loop; single ndjson.
R115 (Task 35, line 262): folder approval covers subfolders; scan snapshot; id validation; pooled review loading; modal focus.
R116 (Task 31/integration, line 264): links route needs browser_capture AND downloader; caller queue limits; post/video URLs only.
R117 (Task 36, line 266): participant codes immutable and retired; withdrawal flags all links; consent/protocol document rules. [OPEN] FileDrop Tauri path handling (Task 37).
R118 (integration, line 269): pushState single router; single ndjson; service additions a–g (done per git log 085a8fb..41f5308).
R119 (Task 36, line 271): detached consent assets never relinked silently; no attach over existing form.

Unnumbered carry-overs still open (line 260/267/270/272): secrets route for Zotero web key; Zotero data-folder auto-detect route; review-queue file preview route; @ao/core subpath exports for governance; consent-form detach button (verify); tx.copyFile streaming byte cap. [OPEN]
Final-review flags: line 111 (completeMove re-hash), line 134 (Task 16 verification minors), line 212 (Task 27 minors). [OPEN]
R204 (2026-11-13): Zotero sync and cloud-drive folders planned beside the reader; one-way, nothing deleted here, off until turned on; local folder only, never read a file not downloaded; one branch for all of it.
R205 (2026-11-13): reader R7 after re-review — page regions only where drawn; the lock question never fails open; "Project not found"; error kind for not-a-PDF; focus hand-over however the limit is reached; softness above 220% on Retina recorded for the owner's Mac check.
R206 (2026-11-13): Zotero account sync plan accepted (Z1–Z12); conflicts go to review; gone-from-Zotero is a mark; three file hosts (files.zotero.net kept); undo of a sync pauses it; per-computer settings; R197 closed.
R207 (2026-11-13): cloud-drive watched folders plan accepted (W1–W10); folder approved only through the shell's chooser (R98/R155 changed for one line shape); register in the library; never read before the local check; /usr/bin/stat; 1 GB download cap; no cloud folders on Windows yet.
R208 (2026-11-13): cloud folders W1 after review — on macOS "local" rests only on the flag (every file asked); compressed flag; W1 returns what it judged; calls that never answer (one per folder, 16 threads); refuse the whole cloud-storage area.
R209 (2026-11-13): reader R8 after review — a 423 on the list ends the reader; "changed" only when the quote is not contained in the touched text items (no verdict for vertical text, short quotes, no text); underline contrast; onPageText, --hl-edge and the temporary region accepted.
R210 (2026-11-13): Zotero sync — the remembered version is held back only by passing failures, not by a back-off that was waited out or by permanent, noted outcomes.
R211 (2026-11-13): reader R8 — the "changed" rule gathers text rectangle by rectangle (columns, footnote marks); item boxes at least the font size; rectangles on blank paper of a text page are changed.
R212 (2026-11-13): Zotero Z2 after review — a resumed batch records the lowest version read; what a complete scan is; absence alone never makes an item gone (a second, complete key list at the same version); honest notes.
R213 (2026-11-13): cloud folders W2 after review — fs.watch accepted, chokidar removed; sidecars like any file; every open guarded; one watcher per tree on macOS; stuck folders stay stuck; the re-check once a minute.
R214 (2026-11-13): Zotero Z2 — the key list whole by its own evidence, at any version; a full run without it is not finished and records no version.
R215 (2026-11-13): Zotero sync — the key list is taken before the downloads; a full run not finished for lack of it says so (carried by Z4).
R216 (2026-11-13): reader R9 after review — "Discard this note?" stands (R192 e); nothing pressed dropped; annotation groups; the list sorts itself; measured heights; no author for now. D22 opened (importer writes the OS user name as author).
R217 (2026-11-13): cloud folders W3 after review — the register covers every file the library holds; deleted stays deleted (undo included); watchId required; links never followed; torn line survived; time-only changes write nothing.
R218 (2026-11-13): the project's licence is AGPL-3.0-or-later (the owner's choice; the repository to be made public); the dependency rule becomes "nothing incompatible with AGPL-3.0-or-later is shipped".
R219 (2026-11-13): cloud folders W4 after review — the fetch never follows a link; the agreed size reserved in the device record; a pause never loses a register line; nothing confirmed, nothing fetched; wording.
R220 (2026-11-13): reader R12 after review — the list row says whether a source has a readable PDF (no request per row); the filter covers every group; the route asks the annotations once; a dropped search is said.
R221 (2026-11-13): cloud folders W4 — one folder feeds one project (refused when added); a not-local file of size 0 is never fetched under an allowance; a 0-byte confirmation is none. Task R3a: the annotation update's reading inside the queue's turn.
R222 (2026-11-13): reader R12 after its second review — the route forgets the annotations it handed on; the list row carries `hasReadablePdf` from what the light read already parses; words not held without a file; dropped words said once.
R223 (2026-11-13): reader R10 after review — pdf.js's blank-space guard on the text layer; the selection read only after a press that began on a page; the refusal over undrawn pages stands with new words; a highlight made under R12's filter shows at once (after R12 merges).
R224 (2026-11-13): Zotero Z5 after review — a back that also changed counts in both; an undo never restores a mark whose batch is undone; the report counts what this run marked; local-importer sources are not marked by account sync (accepted); an annotation may have no author (accepted); D23 opened (own annotations carry the computer's account name).
R225 (2026-11-13): find-and-acquire plan settled (F1–F20) — a second line shape `file-grant` on the service's pipe; `acquireMethods` allowed by default; the queue in `<Project>/find/queue.jsonl`; fixed file hosts, other free copies as links (openable in the app's window); `Asset.acquired`; reqwest with the system's encryption; held files at most 20.
R226 (2026-11-13): find-and-acquire F3 after review — restore knows every line-sealing purpose, declared in one place (closes defect D24: an encrypted project with a watch register could not be restored); nothing unreadable is destroyed by compaction; reads cannot change the library; compaction by share of superseded lines.
R227 (2026-11-13): cloud folders W7 — the governed change of a watched folder's label and collection is built in the library; 16 file threads in every way of starting; `FolderNotAnsweringError` exported.
R228 (2026-11-13): find-and-acquire F2 after review — a title without its subtitle makes the app sure only for a book, with nothing unexplained and two content words or a matching typed year; a one-character CJK family name counts only as its own run; a number or negation is never the allowed unexplained word; the 429 budget reading accepted, bounded.
R229 (2026-11-13): reader R10 — a drag must end on a page: let go elsewhere, nothing is stored and the researcher is told; the toolbar closes when the selection changes.
R230 (2026-11-13): find-and-acquire F3 after its second review — one line-reading routine for read and compaction; compaction when dead lines outnumber live and are at least 64; restore copies unreadable queue and watch-register lines through and counts them.
R231 (2026-11-13): find-and-acquire F2 after its second review — an untyped number in the subtitle means ask; the OpenAlex pause ends by the next midnight UTC; ordinals and multi-letter roman numerals are numbers; a non-matching word beside the family name reads as another person.
R232 (2026-11-13): find-and-acquire F3 — compaction checks before writing that its new content holds the same live entries and every carried line, or writes nothing.
R233 (2026-11-13): cloud folders W7 after review — a stopped watch holds no claim on its folder (engine fix); redeeming a grant and stopping a watch are time-limited so the queue moves on; a changed collection reaches the running watch; a grant is spent by any request that names it; containment check fixed for names starting with ".."; a stored folder is watched only at its chosen real path.
R234 (2026-11-13): cloud folders W7 after its second review — one outstanding file-system call per folder whatever is pressed; the time limit covers the folder's calls only and the governed write is awaited; a folder no longer where it was chosen is "not set up".
R235 (2026-11-13): cloud folders W9 — the source's screen does not download a changed file; it says the new version is not on this Mac and keeps the button; A9 of the plan records W7 as built.
R236 (2026-11-13): Zotero Z6 after review — a field Zotero cleared is kept here and counted; only the newest Zotero evidence per field is a claim; "confirmed" never stays on a value the researcher did not confirm; the undo question and report rows for conflicts; renamed collections by Zotero's key.
R237 (2026-11-13): find-and-acquire F4 after review — find records stored under the project's own rules like every import; every awaited call time-limited and stopAll always settles; unexpected errors fail the entry in words; a partial answer never completes a record by itself; the duplicate check asks the index.
R238 (2026-11-13): Zotero Z6 after its second review — the researcher's evidence settles a Zotero conflict only if newer than Zotero's; the local Zotero importer also keeps a field Zotero cleared.
R239 (2026-11-13): cloud folders W9 after review — the detail screen re-reads the source after a file was added; no button for may-have-changed; focus rules; the action route answers "already-there" when nothing was added.
R240 (2026-11-13): reader R11 after review — the reader's ending cleans up the click wait and the announcer; one shared function makes a highlight; one note or toolbar open at a time; one read-only sentence for the reader; the keyboard selection stops at the drawn pages with its own sentence.
R241 (2026-11-13): cloud folders W8 after review — summaries and the list carry a sequence number from the service and the screen orders by it; focus to the folder's heading when a control disappears; the download dialog sends exactly the size it showed.
R242 (2026-11-13): Zotero Z7 — a batch's origin is set at its start (bulk/run.ts) so the runner finds its own batch; reason "sync-undone"; a device notice for damaged sync settings; the import route's check is Z8's.
R243 (2026-11-13): reader R11 — while a note is open a mouse selection keeps its selection and focus (copying into the note works) and opens no toolbar; the reader's read-only sentence said once.
R244 (2026-11-13): Zotero Z7 after review — an unconfirmed full scan is "finished with problems: deletions-unconfirmed"; an unresumable own batch is ended and the next run starts afresh; a settings file from a newer version is left untouched; settings writes serialised.
R245 (2026-11-13): find-and-acquire F5 — the runner's acts check inside their turn that it is not closed and stopAll waits for them; an entry not in the queue is 404; an unreadable find-screen settings file is replaced by the next change.
R246 (2026-11-13): Zotero Z7 after its second review — an incomplete incremental run keeps fullDone (reason "changes-incomplete"); a batch is ended as unresumable only on a refusal certain to repeat.
R247 (2026-11-13): find-and-acquire F5 after review — unlock always resumes (the runner's index gate holds work back); "being rebuilt" vs "needs a rebuild" said truly; the lookup client writes no cache after the library's lock is released and never recreates its folder; a creation inside a turn finishes before the lock goes.
R248 (2026-11-13): Zotero Z8 — the key check checks the saved key only; a batch summary carries its origin and Zotero library; reasons "batch-ended" and "library-closed" with true sentences; a successful key check clears the key-refused pauses.
R249 (2026-11-13): find-and-acquire F7 (end to end, slice 1) uses the existing recorded lookup answers (R47/R130): no `AO_FIND_STANDIN`, no change to the lookup client; a stand-in is decided at F14.
R250 (2026-11-13): Zotero Z8 after review — one Zotero library is read by one import or sync at a time in the open library, whatever the project, claimed before the first wait; the run in progress is not in the history; a status line names a cause only when its record shows it; the words for the counts; a sync's batch cannot be paused or resumed through the import routes.
R251 (2026-11-13): cloud folders, defect D25 (found by W10) — the engine keeps whether a changed file's new version is on this computer; the answer's `local` becomes `presence` (local / not-downloaded / unknown); the screen says what is known; fix is Task W11, merged before W10's last round.
R252 (2026-11-13): Zotero Z8 round 3 — a sync refused because its library is taken leaves the runner's own record (one optional check passed to the runner; no record-writing door for the service); the claim is taken at every place a Zotero Web batch is made to run, the service's own resume included.
R253 (2026-11-14): find-and-acquire F6 — the Library screen gets the one link "Find and acquire" beside "Capture" (the off-limits list is opened for that line); App.tsx with the route and its import.
R254 (2026-11-14): find-and-acquire F10 as reported — arXiv's limit moves into the lookup client; notes that F11's brief (the rules' `free_copy` check before any free-copy service; the empty download folder removed) and F12's brief (the OpenAlex key to OpenAlex only; no contact e-mail in the shared client's User-Agent) must carry.
R255 (2026-11-14): cloud folders W10 after review — the two checks (no folder path in any request; nothing written into the folder) are made able to fail, each with a self-test; the tests say what they prove; they wait for the button before pressing it.
R256 (2026-11-14): find-and-acquire F10 after the documentation check — arXiv by title and author only (no `doi:` field exists); the Internet Archive's file chosen by format, never an encrypted one; DOAB unverified from here, fails closed, on the owner's first-run list.
R257 (2026-11-14): find-and-acquire F10 after review — a copy found by title is offered only when the titles' content words are the same set (and F11's file check is as strict); the temporary folder's in-use mark is counted per call; smaller hardenings of identifiers, links, licence text, caching and retries.
R258 (2026-11-14): find-and-acquire F6 after review — a change of library forgets everything of the old one; the box is read-only while an add is sent; an act's answer is ordered by when it was sent; settings written one request at a time; reads at least 400 ms apart under steady events; the wording at the edges.
R259 (2026-11-14): cloud folders W11 — R235 upheld: the button "Bring in the new version…" stays whatever is known of the file's presence (the press is guarded); only the sentence differs; the "no button" part of R251 (c) is withdrawn.
R260 (2026-11-14): cloud folders W10 — the end-to-end spec does not assert the plan's "within 10 s" (a loaded machine would fail it); the time is recorded; the limit goes on the owner's Mac list.
R261 (2026-11-14): find-and-acquire F10 after its re-review — titles compared in order; a differing arXiv DOI refuses; one list of joining words; the echo check sees escapes; a counted hold on the download folder for F11.
R262 (2026-11-14): find-and-acquire F6 after its re-review — the screen orders what it shows by the service's own `updatedAt` per entry; the project shown never changes without the researcher's act; an unanswered add is given up after 60 s with the text kept; focus and wording at the edges.
R263 (2026-11-14): find-and-acquire F6, last points — a read started after the last act's answer is taken whatever its stamps (the stamp decides only against reads already on their way); the unanswered-add sentence is visible.
R264 (2026-11-14): cloud folders W11 after review — whenever the engine's judgements are emptied (lock, pause, folder gone and back) changed and may-have-changed files are judged again in the next walk; the press's own judgement is kept; a may-have-changed file back with its registered reading is settled, not looped.
R265 (2026-11-14): Zotero Z9 as reported — defect D26: a settings save keeps the pause "undone" unless the request says `resume: true` for that link; subagents' commits carry the trailers their own instructions give (the coordinator's dispatches had said otherwise); the Library screen's one link "Zotero".
R266 (2026-11-14): cloud folders W11, last point — an entry whose source was removed is never forced for a presence judgement (no second call per scan); the call-count test covers removed-source entries.
R267 (2026-11-14): find-and-acquire F8 (an author alone) — the author's entry stays "Choose works"; the queue carries counts and the lists come from `options`; a chosen work's record from a fresh single-work request; the people search only when it can change the outcome; ids in requests must be stored on the entry.
R268 (2026-11-14): Zotero Z9 after review — a write's answer wins over reads started before it arrived, with one fresh read after; the form inert while saving; "Review N waiting" is the project's current number; a newer-version settings file is said by the service's state; a link moved to another project takes that project's defaults.
R269 (2026-11-14): Zotero Z9, last points — a save for a library that was left never locks the next one, and an unanswered save is given up after 60 s with the draft kept; the review link names the project; the service's copied rule for a newer settings file stays until Z10 opens the library module.
R270 (2026-11-14): find-and-acquire F8 as reported — an initial matches a name but always asks; people carry up to three subject names instead of sample titles; the files and shapes beyond the brief accepted.
R271 (2026-11-14): find-and-acquire F8 after review — the ask-when-more-than-twenty rule tested; a ticked work's fresh record must be that work or the entry asks; "already added" derived from the queue's live entries; a full page with no count means more exist; notes for F9.
R272 (2026-11-14): find-and-acquire F7 after review — the spec waits for the switch to be confirmed; a Crossref title ending in a colon is joined to its subtitle with a space; for F9: an add waits for a pending change of the switch, and the status region keeps the result of the researcher's own act for a second.
R273 (2026-11-14): find-and-acquire F8, last points — a ticked work's fresh title is compared whole with the kept one (never a character prefix; only a title cut to the stored limit is compared on its kept words); a typed single letter is always an initial and always asks.
R274 (2026-11-14): Zotero Z10 (the scheduler) — a run that cannot start is not recorded and is tried at the next tick; never more often than the interval by the scheduler's own count; `nextRunAt` and the line "Next automatic sync: not before …"; the same door as a manual run.
R275 (2026-11-14): Zotero Z10 as reported — time counted by the clock that moved further (one early run possible, never a burst); a missing key is a recorded failed run once per interval; the changed Z8 test accepted.
R276 (2026-11-14): Zotero Z10 after review — a researcher's Stop holds every automatic run for a full interval; a record dated in the future is pinned at first sight; at least 5 minutes of steady time between two automatic runs of a link; a newer history file stops scheduling.
R277 (2026-11-14): find-and-acquire F11 (the file check, the held file) — a strict match rule (DOI, exact embedded title with author, or 90% of the title in order with the author; never another volume, edition or a review); one held file per entry; removing the entry discards it; the review entry shows the evidence.
