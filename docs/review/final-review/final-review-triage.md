# Final review - triage of the 616 deferred points (615 + FR-616 added later)

Input: `.superpowers/sdd/PLAN/final-review-list.md` (FR-001 ... FR-616). Code checked: the worktree `.claude/worktrees/reader-main` (branch `claude/pdf-reader-highlights`, head f7da5a6), and for F18d's open points the round-2 worktree `agent-a64783022f22d4d6b` (4806df5). Paths below starting `reader-main:` are in the first. Nothing in the repository was changed.

## Counts

| Group | Meaning | Items |
|---|---|---|
| A | fix before finished | 8 |
| E | the owner's | 83 |
| C | a test to add | 16 |
| B | worth fixing if cheap | 94 |
| S | superseded | 29 |
| D | leave, documented | 386 |
| | **total** | **616** |

By area:

| Area | A | B | C | D | E | S | total |
|---|---|---|---|---|---|---|---|
| Core/library | 4 | 13 | 5 | 147 | 6 | 8 | 183 |
| Service | 0 | 14 | 3 | 51 | 2 | 2 | 72 |
| UI — screens | 3 | 44 | 1 | 50 | 7 | 8 | 113 |
| Reader (PDF) | 0 | 1 | 0 | 5 | 2 | 0 | 8 |
| Zotero | 0 | 6 | 0 | 18 | 2 | 0 | 26 |
| Cloud/watched folders | 0 | 3 | 0 | 3 | 1 | 1 | 8 |
| Find and acquire — lookup and copies | 0 | 4 | 1 | 16 | 2 | 1 | 24 |
| Find and acquire — library window and shell | 1 | 4 | 2 | 15 | 0 | 4 | 26 |
| Find and acquire — browser extension | 0 | 2 | 0 | 8 | 1 | 1 | 12 |
| Desktop shell | 0 | 2 | 0 | 31 | 7 | 2 | 42 |
| Browser extension — capture | 0 | 0 | 0 | 3 | 4 | 0 | 7 |
| Tests and tooling | 0 | 0 | 4 | 37 | 4 | 0 | 45 |
| Docs | 0 | 1 | 0 | 2 | 3 | 0 | 6 |
| Owner / real Mac / real services | 0 | 0 | 0 | 0 | 42 | 2 | 44 |

## Method and its limits

1. Every bullet of the list was read and placed from its own words; every candidate for A, and every point touching keys, audit, governed changes, the txn marker, backups, deletion, moves, provenance, the pairing token or secrets in logs, was read in its LEDGER line and checked in the current code (file:line given).
2. B, C, D and E were placed mostly from the wording; a quick code look was made where cheap, and '(not checked)' marks the ones where a check would matter.
3. Repeated points (the same defect in several tasks, or one ledger point split over several bullets by the list's semicolon rule, e.g. FR-031/032, FR-077/078, FR-166/167, FR-185-193) are placed once as a group of ids; umbrella items ('the other Minors of the review not listed as fixed', plan-table rows) are placed in D: their content is either itemised elsewhere or sits in review files this triage did not open.
4. The list now holds 616 items: FR-616 was appended after compiling ('Added after the list was compiled', ruled A by R361); it is counted under the sign-in window's area.
5. Limits: no tests were run; F18d's round 2 is not merged, so items 563/583/594/606 count as S only once it is; the review files under `.superpowers/sdd/PLAN/` and `docs/owner-checklist.md` were not read; Mac-only behaviour was not observable here.

## Group A - fix before the project is called finished (8 items in 7 points)

Ordered by seriousness as judged here.

### A1. FR-394 (Core/library)

- **Point:** An encrypted project's audit log is readable without the key; only the withdrawal reason (R177 b) is hashed. The 'set aside' reason (R157) and every other reason a researcher types (governance edits, exceptions, refusals, deletions) are written in plain text.
- **Still in the code:** reader-main: the only reason hashing is packages/library/src/repo/review.ts:302 (`reasonGiven: true, reasonSha256`); grep finds no other `reasonSha256`. repo/repo.ts:169 setAsideMark(reason), :495 setGovernance(reason), :823 appendRefusalEvent(reason) pass the text to the log as typed; the log is plaintext JSONL (audit-store.ts).
- **What a researcher would experience:** A researcher who writes 'removed at Maria H.'s request' as the reason for a deletion, a set-aside or a rule change in an ENCRYPTED project leaves the participant's name readable by anyone who copies the library folder - exactly the leak R177 b closed for one reason only.
- **Size:** M: apply R177 b's pattern (hash + sealed text) to every free-text reason in encrypted projects, or rule which reasons may stay plain; tests per route.

### A2. FR-592 (Core/library)

- **Point:** Defect D27: the attach route (drag-and-drop onto a source) and the folder import accept a path INSIDE the open library's own folder, so a file waiting for the researcher's check can be attached past its review entry.
- **Still in the code:** reader-main: apps/library-service/src/routes/sources.ts:286-295 passes `paths` straight to `attachFiles`; packages/library/src/import/attach.ts:397 has no library-root check (grep for root/realpath finds none); packages/library/src/import/bulk/outside.ts checks only 'outside the imported folder', never 'inside the library'. Only watched folders refuse it (import/watch.ts:95, 189). PLAN.md:506 still lists D27 open.
- **What a researcher would experience:** In a plain project a found file still waiting for 'Use this file' / 'Not this file' (or any file inside the library tree) can be dropped onto a source: it is stored as a manual upload, so its provenance says 'manual upload' instead of 'found copy', the review entry stays, and 'Use this file' later adds the same bytes a second time. The researcher's own check (the product's promise for found files) is bypassed and the record of where the file came from is false.
- **Size:** S-M: refuse by real path in attach and folder import, as watch.ts does; two tests.

### A3. FR-530, FR-593 (UI — screens)

- **Point:** Defect D28: in the review queue's panel for its other kinds of entry (field changed on both sides, an import's doubts, a capture) the NEXT entry appears in the place of the one just decided, so a double press or a steady rhythm on 'Accept' can decide the next entry unseen.
- **Still in the code:** PLAN.md:507 lists D28 open; reader-main: packages/ui/src/screens/import/ReviewQueue.tsx guards only the found-files section (the 'Not taken… Look at the file' texts at :181-183, R319 'nothing moves under the pointer' at :36); the other kinds go through VerificationPanel (:1043-1049) which has only the per-request `busy` flag.
- **What a researcher would experience:** A researcher working through a queue of conflicts accepts an entry and, with a quick second press, accepts the next one without having seen it - a field value silently replaced or an import doubt settled without a look. Governed and audited, but decided by nobody.
- **Size:** M: give the panel the same post-decision guard as the found-files cards (keep the decided card in place, or a short quiet period), probe in real browsers.

### A4. FR-616 (Find and acquire — library window and shell)

- **Point:** At a sign-out, if the sign-in window does not close within the five seconds the shell waits, the library's sign-in hosts are forgotten while the old window, with its session, stays open; a later link start could then fetch from the library's host (R361; already RULED group A).
- **Still in the code:** F18d round 2 (approved, not yet merged into reader-main): worktree agent-a64783022f22d4d6b apps/desktop/src-tauri/src/library_window.rs:1834-1840 `sign_out` renews the store (and drops the host set) without regard to whether the old window really closed; LEDGER R361 (after line 1698).
- **What a researcher would experience:** A researcher signs out of their library (for instance on a shared or lent computer); a window that hangs stays signed in while the app believes it signed out, and the next link opened can fetch through the still-live institutional session. The sign-out says it is done when it is not - a false sentence at a privacy step.
- **Size:** S: keep the hosts when the window still exists after the wait and say the sign-out did not complete; one test (as R361 specifies).

### A5. FR-053 (Core/library)

- **Point:** Plaintext free-text names in an encrypted project's project.json: collection names, tag names and consent scope text.
- **Still in the code:** reader-main: packages/library/src/repo/projects.ts:536-575 (writeProjectData) moves only participant details, session place/notes and withdrawal reasons into fieldwork.json.enc; collections, tags and consents' scope stay in the plaintext project.json. SPEC.md:213 says the readable part of an encrypted project is 'non-identifying'.
- **What a researcher would experience:** A collection named 'Interviews - Ahmed family' or a consent scope naming a community stays readable in a library copied to a USB stick or a cloud drive, although the researcher chose encryption to protect it. Nothing tells them which names stay readable.
- **Size:** L: a design question (seal these names like fieldwork details, or warn when naming); index and locked-view consequences.

### A6. FR-258 (UI — screens)

- **Point:** A pause pressed while the media player renews its ticket is ignored, so the recording starts playing by itself when the renewal lands (the log's own rule: 'a recording must never start without the researcher's action').
- **Still in the code:** reader-main: packages/ui/src/components/MediaTicketPlayer.tsx:200-203 `onPause` ignores pauses while `pending` is set; :204-212 `onMetadata` then calls `el.play()` when `pending.play` is true. Task 62 reworked the viewer but this path is unchanged.
- **What a researcher would experience:** A researcher pauses an interview recording (an identifiable participant's voice) just as the ticket expires - for instance because someone entered the room - and a moment later the recording plays aloud again on its own.
- **Size:** S: let a researcher's pause during renewal clear `pending.play`; one test.

### A7. FR-127 (Core/library)

- **Point:** BibTeX: a line that starts with '@' INSIDE a real field value (an abstract or note quoting '@handle') ends the entry there - the field is cut and every later field of the entry is dropped, silently.
- **Still in the code:** reader-main: packages/library/src/import/refman.ts:503-505 and :612-615 (a value stops at any line-start '@', `ended = true`); the same recovery rule in import/sidecar.ts:168-183 (blockEnd). No warning is produced for the cut.
- **What a researcher would experience:** A social-media researcher imports a .bib whose abstracts quote accounts on their own line ('@someuser replied…'); the records come in with truncated abstracts and without the fields that followed (keywords, DOI, URL, notes) and the import report says nothing - data silently changed at import.
- **Size:** M: apply the line-start-'@' recovery only when the braces do not balance by end of file / next entry, or report the cut as a doubt; tests with a real-looking abstract.

## Group E - the owner's (83 items)

| Ids | Area | The point | What the owner must decide or try |
|---|---|---|---|
| FR-591, FR-138 | Reader (PDF); UI — screens | Annotations the researcher makes are stored with the computer's account name as author (also in a project export's byline) - Defect D23; the display-name setting was never built. | Choose: annotations carry no author, or a name you type once in Settings. Until then your computer's login name (often your real name) goes into exports. |
| FR-238 | Tests and tooling | An encrypted project's NAME stays in plain text in project.json and as its folder name. | Decide whether that is acceptable (a locked project has to be shown by some name) or whether projects should get neutral folder names. Tell researchers in the guide either way. |
| FR-197, FR-198, FR-199 | UI — screens | No minimum length or strength for an encrypted project's passphrase (neither dialog nor service). | Decide a minimum (e.g. 12 characters) or a strength meter, or knowingly none. |
| FR-369, FR-403 | Core/library | The audit log's design: an event correctly chained and appended while the app is closed is believed at the next open (a reviewer forged a destruction event that way); after an identity renewal a lost anchor of the old log is no longer reported. | Decide whether to pay for a stronger log (a keyed chain, or an anchor kept outside the library), or accept and document that someone with access to the folder and the know-how can forge entries. |
| FR-171 | Core/library | A resolve of an interrupted change whose audit anchor is missing or mismatched keeps the project blocked until the library is reopened (literal R131 d). | Confirm that 'reopen the library' is an acceptable step for a researcher, or ask for an unblocking action. |
| FR-356, FR-372 | Browser extension — capture | The browser extension sends its pairing token to whatever program answers on its saved local port; it cannot tell the app from another local program. | Decide whether the extension should first check a proof from the app (more work) or accept the limit (only programs running as you could do this). |
| FR-388 | UI — screens | The capture note uses this computer's date, not the project's time zone (R160 says the project's zone governs). | Say which date a capture note should show when you work away from the project's zone. |
| FR-575, FR-595 | UI — screens | The interface has no give-up for a read that never answers: a screen's first read can stay at 'Reading...' for ever (seen once in WebKit, D30). | On your Mac, note whether any screen ever stays at 'Reading...'; then decide whether every screen should give up after a time and try once more by itself. |
| FR-436 | Reader (PDF) | Above about 220% zoom on a Retina screen the reader's text is softer than the screen could show. | Look at a PDF zoomed in on your Mac and say whether the sharpness is good enough. |
| FR-506 | Zotero | The Library screen names a Zotero library by its number ('Zotero library user:42'). | Decide whether the app should remember Zotero library names with the links. |
| FR-520 | Zotero | The sync history does not say which syncs were automatic. | Say whether a row should read 'automatic'. |
| FR-511, FR-522 | Find and acquire — lookup and copies | A button 'Use all the files that look right' (one press for many) and the order of waiting files are not built. | Decide whether you want one press for many files (a deliberate weakening of 'one decision per file'). |
| FR-532 | Owner / real Mac / real services | Whether 'Add the PDF showing in the sign-in window', pressed while looking at the PDF, should count as the confirmation. | Decide: add at once, or keep the separate check (today). |
| FR-536 | Owner / real Mac / real services | If deciding many found files one after another feels slow, the quiet pause after a decision could be lifted for the keyboard. | Try deciding a run of files in the real app; say if it feels slow. |
| FR-551 | Owner / real Mac / real services | The sign-in window refuses the address ranges 198.18.0.0/15 and 64:ff9b:1::/48; on a network using a 'fake-IP' proxy or a local NAT64 every library file is refused. | Tell us if your network uses such a tool; if so the two ranges can be let through. |
| FR-458 | Owner / real Mac / real services | Find and acquire works better with a free OpenAlex key and needs to know how your library signs you in. | Get an OpenAlex key (free) and try your library's sign-in once. |
| FR-568 | Find and acquire — browser extension | No 'wait in my browser' for a library link (only for a record). | Say whether you want it. |
| FR-607 | Core/library | Left for later phases: signed audit checkpoints, the destruction certificate inside the verification report, validating timestamps on synced changes, streaming Zotero RDF, Zotero leftovers. | Confirm these stay for a later phase (nothing to do now). |
| FR-609 | Core/library | WorldCat lookup not built - needs an institutional key. | Decide whether your institution's key is available and wanted. |
| FR-610 | Core/library | Romanised fallbacks for file names (non-Latin titles) not built. | Decide whether file names in other scripts are fine as they are. |
| FR-446, FR-447, FR-299 | Docs; Desktop shell | Licences: the exact LGPL terms of one bundled library (LibRaw); the About text names no source address; main's older worker manifest still names gallery-dl (GPL-2.0-only); Node.js is on no licence list. | Before release: supply the public source address, and have the licence list checked (LibRaw's terms, Node.js's licence included, nothing GPL-2.0-only shipped). |
| FR-326 | Desktop shell | The unused Intel (x86) build pins: remove them or keep them and say so. | Say whether an Intel-Mac build is wanted. |
| FR-288, FR-324 | Service; Desktop shell | OCR (tesseract) has no pinned build until CI builds it for both architectures, so OCR shows as unavailable in the tools screen. | Decide whether OCR of scanned PDFs is needed in the first release (it needs that build work). |
| FR-289, FR-320 | Service; Desktop shell | No real media-worker bundle was built in the sessions; the CI job on main is its first test. | After the merge to main, confirm the worker-bundle CI job succeeds once. |
| FR-543 | Desktop shell | An https stand-in for the sign-in window's tests would need the shell to trust a test certificate - no switch exists. | Nothing for you unless the coordinator asks; a test-infrastructure choice. |
| FR-236 | Tests and tooling | 'Copy citation' copies the in-text form, not a reference-list entry. | Say which form you expect from 'Copy citation'. |
| FR-343 | Docs | The extension's download may need two unzips. | When you download the extension, note whether you had to unzip twice. |
| FR-272, FR-334 | Owner / real Mac / real services | Opening an ad-hoc-signed build on your Mac; opening the downloaded app from Finder with the quarantine mark ('Open Anyway'); reopening while closing; the release app's page. | Download the app as a researcher would, open it from Finder, and note every warning. |
| FR-344, FR-345, FR-346, FR-347 | Owner / real Mac / real services | Docs gaps: macOS folder-access prompts; where the web view keeps its data; whether the first-use banner's answer survives a relaunch; whether a library move creates a missing parent folder. | During your hands-on run, note these four behaviours so the guide can say them. |
| FR-302 | Desktop shell | On macOS the single-instance socket lives in the shared temporary folder. | Nothing to try; confirm on the Mac that a second launch just brings the app forward. |
| FR-310, FR-323, FR-237 | Tests and tooling; Desktop shell | Tests checked by reading only on a Mac: Linux-only test skips; macOS process-listing samples; the Back-button check in the real web view. | Run the Mac test job once (or let the coordinator) and confirm. |
| FR-353, FR-354 | Browser extension — capture | Loading the unzipped extension in real Chrome, Edge and Firefox on a Mac; whether a temporary Firefox add-on keeps its pairing across a restart. | Install the extension in each browser you use and pair it; restart Firefox and see if it asks to pair again. |
| FR-437, FR-455, FR-471 | Owner / real Mac / real services | Reader on a real Mac: memory during a fast flick through a 300-500 MB scan, momentum scrolling, delay between 'Lock project' and the reader closing; trackpad drags past six pages, selections in ligatures, right-to-left text, VoiceOver; the tint staying when focus moves to the colour toolbar by Tab. | Open a big scanned PDF, scroll fast with Activity Monitor open, lock the project; select and highlight text with the trackpad and with VoiceOver on. |
| FR-438, FR-439, FR-441, FR-448, FR-479, FR-481, FR-487 | Cloud/watched folders; Owner / real Mac / real services | Watched cloud folders on a real Mac: /usr/bin/stat; a hanging or paused cloud-drive app; an online-only file never opened; real iCloud/Dropbox/OneDrive/Google Drive placeholders; the folder chooser and its privacy prompt; 'a PDF dropped into a watched folder comes in within 10 seconds'. | Watch a folder in each cloud drive you use, pause the cloud app mid-scan, drop in a PDF and time it. |
| FR-444, FR-450 | Owner / real Mac / real services | Zotero with a real account and library: what a 304 answer notices (collection change, deletion), the groups total; the memory (resident size) of a large real library. | Sync your real Zotero library once and note the time and memory. |
| FR-470, FR-480, FR-501, FR-516, FR-608 | Owner / real Mac / real services | Live lookup services: OpenAlex's real 429 format and Crossref's limits; one real DOAB, Unpaywall and Internet Archive answer; Elicit's answer shape and OpenAlex's Bearer key; the Library of Congress address from a real network. | Use 'Test' in Search sources for each service, then look up a handful of real references. |
| FR-478, FR-502, FR-505 | Owner / real Mac / real services | Find and acquire on real references: how many right files are held and why (author above title, words between header and title, a title differing by one word). | Run Find and acquire on 20-30 of your own references and note the held files that were in fact right. |
| FR-482, FR-483, FR-492 | Owner / real Mac / real services | VoiceOver: what is said when the status line replaces 'Added 2 references.'; the researcher's own result said first; how a work in the list is read. | Add references with VoiceOver on and listen. |
| FR-533, FR-538, FR-541, FR-559, FR-589, FR-590 | Owner / real Mac / real services | The library sign-in window on a Mac: its own cookies kept apart and emptied; a publisher accepting the request with the session's cookies; the fixed Safari-form User-Agent; SameSite/partitioning; 'Stay signed in'; sign-in shapes the rules do not catch (PingFederate, WS-Federation, EZproxy, SAML ACS, discovery services); Amendment A20's list. | Sign in through your library in the app's window, fetch three PDFs from different publishers, quit and reopen with and without 'Stay signed in'. |
| FR-535 | Owner / real Mac / real services | A scroll followed by a press within about 450 ms is not taken (stricter than 250 ms). | While deciding found files, note whether presses are refused too often after scrolling. |
| FR-569, FR-585 | Owner / real Mac / real services | Firefox (its PDF viewer does not let the extension's script in) is not proved; Chrome's five-minute limit for one service-worker event against a very slow reading. | Try 'get through my library in my own browser' in Firefox and with a slow PDF in Chrome. |
| FR-597 | Owner / real Mac / real services | No blob picture decodes in WebKit under the test harness; must be checked in the real macOS web view. | Open a source with a photo or proxy picture on the Mac and check it shows. |

## Group C - a test to add (16 items)

- FR-101 (Core/library): Per-path tests for the capture rules 'needs review', 'incomplete' and missing legal basis (R83 governance on capture). - size S
- FR-141 (Core/library): A test that an encrypted project's Zotero-web import keeps location only on the allowed path (R83). - size S
- FR-195 (UI — screens): New-project dialog tests: the identifiable-variant refusal text, completing a create after the encryption refusal, clipboard failure at the recovery-code step, Tab trap and Escape while busy. - size S
- FR-214 (Tests and tooling): End-to-end: an import's undo restoring merged sources ('restored 0' today). - size M
- FR-227, FR-228 (Service): A UI test asserting the content-security policy's `media-src` (what keeps recordings from other origins). - size S
- FR-235 (Tests and tooling): Two assertions on the key file's wrappings accept any object (encryption keys). - size S
- FR-331 (Service): The per-route 'interface only' checks (routes the extension must not reach) are unreachable behind the global one and untested. - size S
- FR-365 (Core/library): The branch where the Backups folder is unreadable at the moment of the check has no test. - size S
- FR-421 (Tests and tooling): Tests skipped when run as root (permission/EACCES guards) never run in verification - add a non-root step. - size S
- FR-426 (Core/library): Confirm with a test that `asset.derive` is the audit record of a transcript's processing decision (no separate entry). - size S
- FR-427 (Core/library): A crash-point test for the new detail of Task 71/72 (M2) - crash safety marker. - size S
- FR-531 (Find and acquire — lookup and copies): Probe that a free-copy lookup still in flight when the service closes writes nothing and holds nothing open (R247 c). - size S
- FR-547 (Find and acquire — library window and shell): No test fails without the cache's drops at a lock and at the close (sensitive answers kept after a lock). - size S
- FR-562 (Find and acquire — library window and shell): No test holds the two 'is the row still the same' checks inside the sign-in window's retry (a lock during the retry). - size S
- FR-564 (Tests and tooling): When a release binary is built, assert it holds neither the probe's test switch nor its marker. - size S

## Group B - worth fixing if cheap (94 items)

- FR-030 (Core/library): A move's refusal names the project by its id, not its name (not checked). - size S
- FR-047 (Core/library): Creating a library in a folder that holds only Finder's .DS_Store is refused as 'Folder is not empty' (library.ts:177 counts every entry) - ordinary on a Mac. - size S
- FR-106 (Core/library): Profile metadata fetches outside the platform lane are skipped silently; report a count. - size S
- FR-123, FR-124 (Core/library): After an unconfirmed lookup, the review step pre-fills a cited work's metadata (a reference DOI found in the text) - the researcher sees it in review but may be misled. - size M
- FR-132 (Core/library): Zotero import leaves out standalone notes, attachment notes, linked URLs, embedded images, and does not apply membership/tag/annotation removals on update; counted in the report (zotero-local.ts:84-85) but easy to miss. - size M
- FR-142 (Core/library): LOCATION_NEEDS_ENCRYPTION says 'photos' where it means 'files with a location'. - size S
- FR-151, FR-152, FR-153 (UI — screens): Library screen: a later ?project= change ignored after an address-driven selection; 'Load more' in the gap uses an old offset; a failed reload after a refused resolve leaves the old list. - size S
- FR-155 (UI — screens): 'Try saving again' offered for a load error (Appearance). - size S
- FR-156 (UI — screens): Governance: a profile toggle uses the debounced parsed config, so a just-typed change to `profiles` can be overwritten in the editor (visible before Save). - size S
- FR-157 (UI — screens): Folder-name pseudonymisation flags fail open for an older batch with no 'created' ids (an advisory flag not shown). - size S
- FR-158 (UI — screens): A right-to-left project name flips the whole banner sentence. - size S
- FR-160 (UI — screens): No control to detach a consent form attached to a consent record by mistake. - size M
- FR-162 (UI — screens): The collection tree's twisty cannot be clicked with a mouse. - size S
- FR-163 (UI — screens): Governance screens do not mark locked projects or offer to unlock. - size S
- FR-165 (UI — screens): Workspace tags: 409 wording, no confirmation for a rename, no reload after a failure. - size S
- FR-166, FR-167 (UI — screens): A lost move error means a long poll on the Move library screen. - size S
- FR-168 (UI — screens): The re-attach offer on Fieldwork neither takes focus nor names the file. - size S
- FR-170 (UI — screens): `ImportReport.created` not shown; older batches have no created ids. - size S
- FR-180 (UI — screens): An unsettled 'unknown outcome' notice calls a project just confirmed 'recovery code not shown' when the same name is created again (a false warning, safe direction). - size S
- FR-182 (UI — screens): The 'cannot tell' new-project notice never re-checks by itself. - size S
- FR-187, FR-188 (UI — screens): DMP projects are created with three presence violations by design; a first-run hint would help. - size S
- FR-194 (UI — screens): A library close during the new-project 'found' panel, 'cannot tell' state or form unmounts the dialog; the 'cannot tell' notice is lost (the recovery-code step itself is held). - size M
- FR-203 (UI — screens): DialogShell's focus trap restores focus before `inert` is removed, so focus can fall to the page on close. - size S
- FR-204, FR-205 (UI — screens): When two new projects with the entered name appear, the dialog and notice take the last; should list them. - size S
- FR-217, FR-218, FR-219 (Service): A tamper found mid-stream gives a cut recording; the player shows only its generic 'stopped at the same place… may be damaged' after retries (MediaTicketPlayer.tsx:174-176), never 'changed outside the app'. - size M
- FR-234, FR-601 (UI — screens): R145: re-check every dialog and popover for focus on open, Tab/Shift+Tab and close (assistive technology). - size M
- FR-244 (UI — screens): Pairing screen wording differs from the extension's. - size S
- FR-254 (Desktop shell): Model 'could not be read/loaded' messages give no next step. - size S
- FR-259, FR-260 (UI — screens): Player: a resume seek that never lands is ignored for good; three idle expiries near one spot give 'may be damaged' (Try again recovers). - size S
- FR-261 (UI — screens): A request that never reached the service is treated as 'may still be going'. - size S
- FR-266 (UI — screens): The 503 sentence says 'nothing was queued' twice. - size S
- FR-291 (UI — screens): The Optional tools screen says each download 'contacts only the tool's publisher' (ToolsSetup.tsx:511) - loose for models hosted by a third party; the first-use banner does list the real hosts (FirstUseTools.tsx:318). - size S
- FR-297 (Desktop shell): No visible feedback while closing waits for the helpers (up to 95 s). - size S
- FR-315, FR-316 (UI — screens): After confirming a download focus lands on the page body; the banner's buttons sit inside its polite status region. - size S
- FR-329 (Service): During a library move the device-only routes are refused with the move's wording. - size S
- FR-335 (Service): A pairing code's `confirming` has no time limit; the page's countdown then calls it expired. - size S
- FR-337, FR-338 (Service): Pairing: an unreadable list is reported as 'not in the list'; revoking any browser clears that warning even when the paired one is still missing. - size S
- FR-342 (Docs): Owner checklist 10.6: the popup's message can run on after 'Captured: saved to your library.' - size S
- FR-348 (UI — screens): A project recheck left by leaving the library is no longer shown on return, though it runs on. - size S
- FR-350 (Service): A stream error part-way through `bytes()` is reported as 'the service could not be reached'. - size S
- FR-361 (UI — screens): The library chooser's headings use the D7 right-to-left pattern. - size S
- FR-362, FR-363 (UI — screens): Import: a report opened by its address has no wizard state; focus jumps to the report's heading at the end of a run even if the researcher moved it. - size S
- FR-368 (Core/library): While the last library is still opening, the chooser checks every 2 seconds without limit. - size S
- FR-370, FR-371 (Service): Addresses a lock cut from a capture queue are listed only on the open screen; nothing reminds after unlock (typed lists can be lost from view). - size M
- FR-385, FR-386, FR-392 (Service): Transcription runs: a move does not carry a running transcription on; Stop on a run waiting for an unlock; a run spanning a lock and unlock waits for the next unlock or launch. - size M
- FR-389, FR-390, FR-391 (UI — screens): Capture settings: the locked/read-only reason not updated live; comma-separated fields keep a draft after their reason is cancelled; the Move-library dialog hint shows outside the desktop app. - size S
- FR-393 (Service): After a lock at the store step, the first try's file remains as an extra version beside the rerun's. - size S
- FR-410 (Core/library): Exporting a restored copy says a file left out on UNVERIFIED evidence 'was destroyed under the project's retention rule' (export/project-export.ts:446) - states as fact what only a damaged log says. - size M
- FR-411 (Core/library): Over a damaged libraries list, opening or creating a library at the moment the chooser reads it fails once with a raw rename error. - size S
- FR-412, FR-413 (UI — screens): The libraries notice overstates partial damage; the watched-folders warning can go stale in a session. - size S
- FR-420, FR-425 (Core/library): Cross-checks read outside the write queue (reconnect checkIntegrity, retention onDisk), and after a failed in-process roll-back the app's own leftovers are later reported as 'changed outside the app' - a false alarm, nothing lost. - size M
- FR-423 (Core/library): Every read of a source with a real mismatch waits for the write queue - in practice through a whole restore. - size M
- FR-454 (Reader (PDF)): A space is put between lines of Chinese or Japanese text in a quote. - size S
- FR-463, FR-467, FR-477 (Zotero): Zotero report wording: 'Updated' and 'Back in Zotero' overlap (rows exceed 'Items'); undoing a deletion mark that restores a bin mark says 'took the Zotero mark off'; a sync whose end could not be written reads 'the app was closed'. - size S
- FR-472 (Cloud/watched folders): 'Watching' shown for up to 30 s while a watch's first call on a folder that never answers is in flight. - size S
- FR-475, FR-476 (Cloud/watched folders): A source opened within ~5 s of import shows no origin line until reopened; a same-content conflict copy is counted but has no line on the screen. - size S
- FR-490 (Find and acquire — lookup and copies): The held file itself cannot be opened before deciding 'Use this file' / 'Not this file' (only its facts are shown). - size M
- FR-504, FR-527 (Find and acquire — lookup and copies): A linked original whose file is missing counts as 'has a file', so Find and acquire never fetches a copy for that source. - size S
- FR-507, FR-508 (Zotero): `ao zotero check-key` does not clear a link's pause as the app does; the damaged-settings sentence is the command line's own. - size S
- FR-512 (Zotero): A Zotero batch stopped by the rules mid-run is recorded 'error' with no reason. - size S
- FR-529 (Find and acquire — lookup and copies): After a decision is given up at 60 s, a late record by the service shows only when the queue is next read. - size S
- FR-537 (UI — screens): Governance's 'Saved.' is cleared at once by the screen's own re-read. - size S
- FR-557, FR-558 (Find and acquire — library window and shell): A press on a control whose request is out says nothing; a queue read that never answers keeps the screen's acts busy. - size S
- FR-561 (Find and acquire — library window and shell): An open the shell answers after more than 60 s can close a newer sign-in window. - size S
- FR-576 (UI — screens): Find and acquire shows the 'service cannot be reached' sentence twice. - size S
- FR-577 (Find and acquire — library window and shell): F17's path after the hand-over loads the whole file in memory (515 MB resident for a 150 MB file); stream the hash. - size M
- FR-584, FR-588 (Find and acquire — browser extension): Extension wording: 'does not let the extension read this tab' also for a closed tab or slow injection; 'did not give the PDF a second time' also for a PDF whose mark is not at byte 0. - size S

## Group S - superseded (29 items)

- FR-031, FR-032 (Core/library): scrypt caps built: reader-main packages/library/src/crypto/keys.ts:27 (MAX_N = 2**18), :73, :83 (maxmem).
- FR-034 (Core/library): `mode` option built: reader-main packages/library/src/fs/atomic.ts:77-99; used 0600 in repo/projects.ts:574.
- FR-058, FR-164 (Core/library; UI — screens): Resolve for invalid/unverifiable markers built: reader-main packages/ui/src/components/StatusBanner.tsx:194 (RESOLVABLE_WARNINGS incl. invalid-txn-marker), PendingWritesDialog.tsx:32-59, repo/pending-writes.ts:59; 'rolled-back-incomplete-write' is informational (nothing to resolve).
- FR-087 (Service): Helper subprocesses get the allow-listed env: reader-main services/media-worker/ao_worker/download.py:269, tools.py:181, jobs.py:45-47.
- FR-599 (Desktop shell): Worker token only on standard input; refused if in env: reader-main services/media-worker/ao_worker/__main__.py:93-102.
- FR-133 (Core/library): Task 58 made annotation text searchable (LEDGER:548, 553; PLAN:557).
- FR-144 (UI — screens): Workspace tag rename/delete built: reader-main packages/ui/src/components/TagList.tsx:3, 18-22.
- FR-245, FR-600 (UI — screens; Service): Task 46c built the pairing-status route (PLAN:539; LEDGER:625, 633; apps/library-service/src/pairing-status.test.ts).
- FR-265, FR-269 (UI — screens): Task 63 built capture queues re-read across reconnects (LEDGER:695-742; apps/library-service/src/capture-queues.test.ts).
- FR-308 (Core/library): Task 46a merged; a rebuild can be started from the interface: reader-main packages/ui/src/components/RebuildIndex.tsx, apps/library-service/src/state.ts:56.
- FR-317 (UI — screens): The point itself says those five Minors no longer apply (rule deleted) - LEDGER:591.
- FR-396 (UI — screens): LEDGER:821: N5's read of the queue inside each removal of an undo is what catches an entry queued while the undo runs (N3 closed by it).
- FR-408 (Cloud/watched folders): Cloud-folders Task W8 built the 'Watched folders' screen (LEDGER:1207; PLAN:614).
- FR-416, FR-419 (Core/library): D20 closed by Task 73, merge 0e890cd (LEDGER:920; PLAN:517).
- FR-499 (Find and acquire — lookup and copies): Carried as D30 / R352 (LEDGER:1630); its remaining question is items 575/595 under E.
- FR-548 (Find and acquire — library window and shell): D29's parts outside the shell fixed and merged, f2f0717 (LEDGER:1607, 1648; PLAN:508).
- FR-563, FR-594, FR-583, FR-606 (Find and acquire — library window and shell; Desktop shell): Fixed on F18d's round-2 branch, NOT yet merged into reader-main: worktree agent-a64783022f22d4d6b (4806df5) apps/desktop/src-tauri/src/library_window.rs:72-73 (TITLE_LIBRARY / TITLE_LINK), :100 (BROWSER_URL_MAX = 4096), :229, :371 (sign-in host set, R360 a), service.rs:11 (comment now names file grants); LEDGER:1696-1697 (review and verification in progress). Re-check after F18d merges.
- FR-553 (Find and acquire — browser extension): F20 built 'Get through my library in my own browser' (LEDGER:1597; merged LEDGER:1692).
- FR-565, FR-580 (Owner / real Mac / real services): The end-to-end run in real Chromium showed the bundled Chromium shows an https PDF and the script reads it (LEDGER:1646).
- FR-596 (UI — screens): D1-D7 closed per the plan table (PLAN:536-538, 544).

## Group D - leave, documented (386 items)

### Core/library (147)

- FR-007, FR-008, FR-009, FR-010, FR-011, FR-012, FR-013, FR-014, FR-015, FR-016, FR-017, FR-018, FR-022, FR-027, FR-059, FR-060, FR-061, FR-062, FR-063, FR-064, FR-065: model/id validation, schema and file-name details with no path a real file takes.
- FR-021, FR-023, FR-025, FR-028, FR-029: Date.parse leniency / timestamp validation (the same point in several tasks; sync ingest is a later phase).
- FR-019, FR-020, FR-040, FR-041: test wording and timer details.
- FR-033, FR-035, FR-036, FR-037, FR-038, FR-039, FR-066: crypto and atomic-write hardening against callers that do not exist, or Windows (66: the only caller closes the index before clearing keys, apps/library-service/src/state.ts:1137-1144).
- FR-042, FR-043, FR-044, FR-045, FR-046: library registry and lock edge cases (raw errors, same-second backups, hostname, clock skew).
- FR-024, FR-026, FR-048, FR-049, FR-050, FR-051, FR-052, FR-054, FR-055, FR-056, FR-057, FR-100, FR-172, FR-178, FR-179: audit/governance edge cases with no real path: 49/178/179 the trimmed line is a torn, never-committed line (repo/pending-writes.ts:124-170, R28); 56 anchor file read-modify-write only across app+CLI, weakens rollback detection only; 55 sources belong to one project.
- FR-246, FR-247, FR-248, FR-249, FR-250: recovery-code staging after planted directories or double crashes (Task 61).
- FR-277, FR-611: rolled-back anchor with a matching cut log: accepted, documented limit.
- FR-067, FR-068, FR-069, FR-070, FR-071, FR-072, FR-073, FR-074, FR-075, FR-076, FR-077, FR-078, FR-079, FR-080, FR-081, FR-082, FR-083, FR-176, FR-177: moves, relink and reconnect edge cases (outside programs during a switch - edits stranded not lost; FAT; Windows; old copies kept with a plain message, move.ts:117; linkable() checked by the caller, reconnect.ts:918).
- FR-093, FR-094, FR-095, FR-096, FR-097, FR-098, FR-099, FR-108, FR-109, FR-110, FR-111, FR-112, FR-113, FR-117, FR-118, FR-119: metadata grounding, identifier and date heuristics (brief-specified; mostly false negatives).
- FR-102, FR-103, FR-104, FR-105, FR-107: capture and profile internals.
- FR-114, FR-116, FR-120, FR-130, FR-148, FR-173, FR-174, FR-175, FR-305, FR-306, FR-307, FR-417: memory/size caps and search performance limits nobody will reach in ordinary use.
- FR-115, FR-126: extraction details (charset, odd image types).
- FR-121, FR-122, FR-125, FR-128, FR-129, FR-131, FR-134, FR-135, FR-136, FR-137, FR-139, FR-140, FR-280, FR-281, FR-282, FR-364, FR-375, FR-376: accepted residuals already recorded (125: the unsurfaced warnings only say an exception waives nothing - unknown keys are refused, core/governance/schema.ts:267, 334-336).
- FR-355, FR-409, FR-415, FR-422, FR-424, FR-428: development-only index state, an untested CLI Ctrl+C wait, a latent holdsTurn quirk, a 20 ms test sleep, an exported internal type.
- FR-283, FR-309, FR-405, FR-406, FR-605: umbrella notes ('the other Minors…') whose points are itemised elsewhere or unexpanded.

### Service (51)

- FR-084, FR-085, FR-086, FR-088, FR-089, FR-090, FR-091, FR-092: media-worker HTTP and CI details.
- FR-143, FR-145, FR-146, FR-147: capture sanitiser counts and timeouts.
- FR-215, FR-216, FR-220, FR-221, FR-225, FR-226: log-field naming and route-matching details (215: `code` still logged as [redacted], media.ts:418 - harmless).
- FR-222, FR-223, FR-224, FR-229, FR-230, FR-231, FR-232: media tickets accepted by R140; an in-flight stream after destruction; absolutePath on non-sources routes goes only to the researcher's own window (not checked); plaintext chunk cache in memory.
- FR-284, FR-285, FR-286, FR-287, FR-290: worker cancel and retry details.
- FR-328, FR-330, FR-332, FR-333, FR-336, FR-339, FR-351: fonts and pairing internals.
- FR-366, FR-367, FR-373, FR-374, FR-381, FR-382, FR-383, FR-384, FR-387: queue and profile-run internals.
- FR-402, FR-404, FR-407: kept-aside copies clean-up and type narrowing.
- FR-603, FR-604: plan-table umbrella rows, itemised under items 335-339 and 328-333/350-351.

### UI — screens (50)

- FR-154, FR-159, FR-161, FR-169, FR-201, FR-202, FR-357, FR-358: lint coverage, shared helpers and duplicated CSS/components.
- FR-181, FR-183, FR-184, FR-185, FR-186, FR-189, FR-190, FR-191, FR-192, FR-193, FR-196, FR-200, FR-206, FR-207: new-project dialog internals the UI already guards (whitespace names, message-text matching, history guard, latent navigate).
- FR-239, FR-240, FR-241, FR-242, FR-243: pairing-screen poll and test details.
- FR-262, FR-263, FR-264, FR-267, FR-268: row memoising and unexpanded Minor numbers.
- FR-278, FR-279, FR-292, FR-293, FR-294, FR-295: tools routes without the shell (developer only), storage of 'Not now'.
- FR-359, FR-360: extra requests on 'Start import'; a command-line flag.
- FR-395, FR-397, FR-398, FR-399, FR-400, FR-401, FR-418: review-queue internals (no library outside development has pre-R176 entries; N5 kept on purpose).
- FR-602, FR-612, FR-613: plan-table umbrella row (itemised as items 151-170); accepted contrast and CSP choices.

### Reader (PDF) (5)

- FR-429, FR-433, FR-434, FR-435, FR-460: matcher, paging and huge-picture limits; tests behind no seam.

### Zotero (18)

- FR-431, FR-432, FR-451, FR-452, FR-456, FR-457, FR-462, FR-464, FR-488, FR-489, FR-513, FR-514, FR-517, FR-518, FR-519, FR-525, FR-526, FR-528: sync internals, accepted limits, version rules for later and stale comments (457 not checked).

### Cloud/watched folders (3)

- FR-443, FR-445, FR-473: register compaction, comparison-before-open, page-cursor.

### Find and acquire — lookup and copies (16)

- FR-459, FR-461, FR-466, FR-468, FR-469, FR-496, FR-497, FR-498, FR-500, FR-503, FR-509, FR-510, FR-515: lookup heuristics and format notes; every file is held for the researcher's decision anyway.
- FR-493, FR-494, FR-495: 493 a pathological PDF stalling; 494 a fetched file is plain in .tmp/find-<id> (0600) only while checked, then removed or swept (find/fetch-file.ts:18-27); 495 query/user/fragment already cut from kept addresses (find/runner.ts:166-178), a path token on an open-access host is rare.

### Find and acquire — library window and shell (15)

- FR-534, FR-539, FR-540, FR-545, FR-546, FR-552, FR-554, FR-555, FR-556, FR-560, FR-571, FR-579, FR-582, FR-586, FR-587: window/shell race and wording details, harmless by the log's own reading.

### Find and acquire — browser extension (8)

- FR-566, FR-567, FR-570, FR-572, FR-573, FR-574, FR-578, FR-581: one wait at a time, pauses, two paired extensions, ticket forms.

### Desktop shell (31)

- FR-251, FR-252, FR-253, FR-255, FR-256, FR-257, FR-318, FR-319, FR-321, FR-322, FR-325: worker bundle manifest and licence-generator checks.
- FR-270, FR-271, FR-273, FR-274, FR-275, FR-276, FR-296, FR-298, FR-300, FR-301, FR-303, FR-304, FR-327: launcher/build hardening, historical text, path scrub in the shell's own log.
- FR-377, FR-378, FR-379, FR-380, FR-542, FR-549, FR-550: two copies on one settings folder (single instance), port write timing, hanging look-ups, start-up script steering.

### Browser extension — capture (3)

- FR-349, FR-352, FR-414: unpacked identity, actionlint, popup text length (shown as text).

### Tests and tooling (37)

- FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-149, FR-150, FR-208, FR-209, FR-210, FR-211, FR-212, FR-484, FR-485, FR-486, FR-521, FR-523, FR-544: test-report and harness tidiness.
- FR-233, FR-430, FR-440, FR-442, FR-449, FR-453, FR-465, FR-474, FR-491, FR-524, FR-598: load-sensitive or timing tests (make deterministic when touched).
- FR-213, FR-311, FR-312, FR-313, FR-314, FR-614, FR-615: harness choices, file sizes, linting.

### Docs (2)

- FR-340, FR-341: checklist line placement.

## Uncertain

Already placed above (the group named first); the alternative and why:

- FR-410 - B / A: The export note states a destruction as fact on unverified evidence; it is a record handed to others, but the situation (restore from a backup whose log does not verify) is rare and the evidence does say 'destroyed'.
- FR-248 - D / A: Recovery-code staging: after two crashes and a resurrected older file the never-shown code stays active without warning - a lock-out path, but needs a double crash plus an outside program restoring an old file.
- FR-494 - D / A: A fetched PDF lies unencrypted in .tmp while checked, also in an encrypted project. It is a published work, 0600, short-lived and swept; but in an encrypted project its title is otherwise sealed.
- FR-127 - A / B: Real files can carry a line-start '@' in an abstract, but the cut is a deliberate recovery rule (R57/R58); placed A because the loss is silent.
- FR-053 - A / E: The plaintext names follow the original design (only fieldwork details sealed); the owner may accept the limit if the guide says so.
- FR-394 - A / E: R177 explicitly left the question for this review; the fix pattern exists, but which reasons to seal is a ruling.
- FR-229, FR-230 - D / C: Not checked whether the review/import routes still send linked files' absolute paths to the UI (R132); the harm is small (own window).
- FR-132 - B / E: Standalone Zotero notes are the researcher's own writing; whether importing them is in scope is a product choice.

## Mechanical check

Every id FR-001 ... FR-616 placed exactly once across A, B, C, D, E, S: yes (616 distinct ids; duplicates: 0; missing: 0). The 'Uncertain' section repeats ids already placed and is not counted. Verified by `gen_triage.py` (built-in assertions) and by an independent re-count of this file (`check_triage.py`).
