# Task 54, second part — the seven dispatches (each prompt = the line "Read the common brief first: `/home/user/AlexandrineOxiana/.superpowers/sdd/PLAN/task54-wb-common.md` — all of it, then this." + the part below)

Each reviewer: a FRESH Opus agent (`general-purpose`, model `opus`, in the background, NO isolation — they read the integration checkout). Reports: `task54-wb<N>-review.md`.

## WB1 — `packages/core` and `packages/shared` (about 8,600 lines of code)
You are reviewer number 1. Your part: `packages/core/src` and `packages/shared/src`.
Where a mistake costs most: the policy engine (every decision path: does anything fail OPEN — an unknown action, an unknown control, a missing or half-parsed rules file, a profile requirement, an exception that has expired or lacks a reason?); the audit chain (hashing, sequence, verification: can an entry be dropped, reordered or re-written and still verify? what does a truncated last line do?); pseudonymisation (participant codes for names: every function that turns a participant or a source into text for a citation, an export or a report); citations (CSL, citation keys, BibTeX keys); the duplicate finder; date and name parsing where they decide identity.
Specific checks (answer each yes/no with evidence):
1. R88: are participant codes wired through citations — is there ANY path where a citation, a bibliography entry or a citation key built by core carries a participant's real name when the project pseudonymises?
2. R58: does core hand back governance-load warnings in a form the callers cannot drop silently (follow one warning from the parser to the type the service returns)?
3. The texts in `packages/shared` that the screens show verbatim: any that states something the code does not do (pick the twenty most consequential — encryption, consent, destruction, export, "nothing was changed").
4. Types crossing the boundary: any field the service sends that `shared` types as required but the library can omit (or the reverse).

## WB2 — the library engine: `packages/library/src/repo`, `fs`, `crypto`, `index`, and the files directly in `packages/library/src` (about 22,000 lines)
You are reviewer number 2. Your part: `packages/library/src/repo/**`, `fs/**`, `crypto/**`, `index/**`, and the `.ts` files directly in `packages/library/src` (library.ts, lock.ts, move.ts, registry.ts, retention.ts, secrets.ts, consent-docs.ts, protocol-docs.ts, destruction-record.ts, restore-record.ts, old-copies.ts, reconnect.ts, job-journal.ts, transcription-jobs.ts, worker-client.ts, …).
Where a mistake costs most: `repo/mutate.ts` (`runMutation`: decide → marker → write → audit → commit; recovery after a crash at every point; a deny is audited; two changes at once; a locked or read-only project); the write-ahead marker and its recovery (`txn.ts`); the audit store and its anchor; encryption (key derivation, sealing, what stays readable in an encrypted project — names, the audit log, `governance.yaml`, the index, temporary files, the SQLite index and its journal files); the lock file; moving a library (ledger line 111's points: a crash between the record and the switching journal; the source written between "switching" and marking the old copy); retention and destruction (is anything destroyed without its record, or recorded as destroyed while it remains?); the index (rebuildable — is anything ONLY in the index?).
Specific checks:
1. Ledger line 111 (Task 13's deferred points on moving a library): for each, is it fixed, still open and harmless, or worse than recorded?
2. Find three library changes that do NOT go through `runMutation` (or its governed equivalents) — or show there are none: grep every `writeFile`, `rename`, `unlink`, `rm`, `appendFile`, `copyFile` in your part and account for each class.
3. An encrypted, LOCKED project: list everything the code can still read or write in its folder, and say whether each is intended.
4. Absolute paths: is any stored in a file of the library (records, journals, the index, audit details)?

## WB3 — imports and capture: `packages/library/src/import`, `capture`, `lookup`, `extract` (about 23,000 lines)
You are reviewer number 3. Your part: `packages/library/src/import/**` (the attach, the bulk import and its adapters: folder, device, ZIP, Calibre, BibTeX, RIS, CSL-JSON, Zotero RDF, Zotero local, Zotero web; watched folders), `capture/**`, `lookup/**`, `extract/**`.
Where a mistake costs most: a batch that is paused, crashed and resumed (is anything imported twice, lost, or reported as done when it is not?); the batch record and the report (what they keep of the researcher's disk: paths, file names, Zotero keys); ZIP handling (entry names with `..`, absolute names, links, a zip bomb, a name differing only by case); parsers on hostile input (time and memory bounds); the duplicate decision; watched folders (the one-call gate, R208 d; a file still being written; a file that is in the cloud and not on this computer); capture of a web page (the snapshot: scripts, outside requests, what is stored of cookies or the signed-in page); network lookups (what leaves the computer: is a title or a name of an identifiable source sent to an outside service when the project's rules forbid it?).
Specific checks:
1. R64, R69, R75: do batch records, linked paths and Zotero keys respect pseudonymisation and the "no absolute path stored" rule — in the record, the journal, the report shown and the report exported? Follow one import of each kind.
2. Ledger line 134 (Task 16's deferred points on grounding a creator or a date in evidence): for each, still open? any that lets a wrong author or year be recorded as verified?
3. Ledger line 212 (Task 27): the re-run after a rule changed; the proxy queue's key and disposal; the encrypted Zotero-web allowed path under a location rule — each fixed or open?
4. Every place that fetches from the network in your part: the host allow-list, redirects, size and time bounds, and what is logged.

## WB4 — Find and acquire, exports and citations: `packages/library/src/find`, `export`, `citation` (about 13,000 lines)
You are reviewer number 4. Your part: `packages/library/src/find/**`, `export/**`, `citation/**`.
Where a mistake costs most: the owner's rule (R301, R303): a found file is NEVER attached without the researcher's own decision on its own review entry — attack every path from a fetched file to a source's files (the runner, "use all the files that look right", the browser hand-over, the library window, a resume after a crash, a restore, a second device); the fetchers (which hosts, redirects, a file that is not what its name says, size bounds; the sign-in session — where cookies and tickets live and who can read them); the sealed queue in an encrypted project; what a search sends to outside services (titles of identifiable sources; Elicit and the other configured targets; the settings that turn each off); exports and backups (what a backup holds, a restore into another library, an export of a pseudonymised project: does ANY exported file carry a real name, an absolute path, a held file, or a secret?); the destruction record in an export.
Specific checks:
1. R77: do citation keys in reports and exports respect pseudonymisation?
2. R88 on the library's side: a citation or bibliography produced by `citation/**` for a source tied to a participant.
3. A backup made, then restored: is the review queue's state (held files and their pending entries) carried rightly — can a restore turn a held file into an attached one, or lose the entry and keep the file?
4. The texts the feature shows ("Nothing was sent", "This was not downloaded", counts): any that can be false?

## WB5 — the service and the command line: `apps/library-service`, `apps/cli` (about 14,000 lines)
You are reviewer number 5. Your part: `apps/library-service/src/**` and `apps/cli/src/**`.
Where a mistake costs most: who may call (the bearer token, the Host and Origin checks, the routes the browser extension may call and nothing more, the routes only the screens may call; tickets for media and files — lifetime, scope, in an address only where a ruling allows); the content-security policy and every header on every kind of answer (JSON, a file, a snapshot, an error); what an error says (no path, no secret, no stack); request bodies (size bounds, a schema on every route, a path in a body — is each such path checked?); streaming uploads and downloads (a client that stops half-way; a slow client); start-up and shut-down (resume of batches, jobs and finds; the lock; a second service on the same library); the log (what it writes of names, paths, tokens). The command line: what it prints of secrets and paths; its exit codes; that it changes the library only through the same governed calls.
Specific checks:
1. For EVERY route: is it behind the token and the Host/Origin checks, or deliberately not (list the deliberate ones and say whether each is right)?
2. Three routes whose handler trusts a field it should not (an id used in a path, a project id that is not the opened one, a ticket for another project) — or show there are none.
3. R58 on the service's side: are governance-load warnings sent to the screens on every route that loads the rules?
4. Ledger line 272 (Task 36: moving a library when the request reached the service but no line came back; the streaming byte cap in the copy): fixed or open?

## WB6 — the screens: `packages/ui` (about 38,000 lines)
You are reviewer number 6. Your part: `packages/ui/src/**` (and `e2e/` only to see what is covered).
Where a mistake costs most: outside text as markup (grep every `dangerouslySetInnerHTML`, `innerHTML`, `srcDoc`, `href={` and `src={` built from data — each must be `UserText`, `SnapshotFrame` or a checked address); a screen that says something happened when the service refused or never answered ("Saved", "Destroyed", "Nothing was changed", "Sent"); destructive actions (destroy, withdraw consent, detach, sign out, delete a project: is each confirmed, can a repeated key or a double click fire it twice, does focus land somewhere sensible after); the review queue's decisions (a decision applied to an entry the researcher has not seen; a stale list); forms that hold a secret (passphrase, token: kept in state longer than needed? shown? logged?); locked and read-only states (every control off, with the reason); accessibility (names, keyboard, focus, live regions) on the ten screens a researcher uses most.
Specific checks:
1. R58: do governance-load warnings reach the screen — on which screens, and is there a screen that loads the rules and drops them?
2. Colours: any colour not from a theme token (the lint covers `.ts(x)` and CSS — look for what it cannot see: inline SVG, canvas, `style=` strings).
3. Contract: pick the fifteen requests whose answers matter most and compare the screen's reading of each field and each error code with the handler in `apps/library-service`.
4. Ledger line 272's screen points (Move library: no false "nothing changed"; Fieldwork's re-attach button).
Known and being fixed (do not report): dialogs whose first focus is the confirming button, confirmed by a held or doubled Enter on their opener (FR-630, Task FR-A9: `ChoiceDialog`, the capture acknowledgement, the watched folders' two). If you find ANOTHER control that a held or repeated key can fire twice, that is new.

## WB7 — the desktop shell, the browser extension and the media worker: `apps/desktop`, `apps/browser-extension`, `services/media-worker` (about 14,600 lines)
You are reviewer number 7. Your part: `apps/desktop/src-tauri/**` (Rust; read only — no cargo runs), `apps/browser-extension/src/**`, `services/media-worker/**` (Python).
Where a mistake costs most: the shell (how the service is started and its token handed to the window; the Tauri capabilities and the commands exposed to the web view — can a page that is NOT the app's own call any? the library sign-in window: which hosts it may load, where its session is stored, what "sign out" removes; the updater or any download-and-run; what is written to the device file and its permissions; the Mac-only parts nothing here has run: say plainly which they are); the extension (its permissions against what it uses; messages from web pages — can a page make it send a capture or a file, or read the token? what it sends to the service and to nobody else; the pairing); the worker (how jobs are given and their results trusted; paths it is handed; subprocess calls — any shell, any argument built from a file name; temporary files of an encrypted project; models or tools downloaded: from where, verified how).
Specific checks:
1. Every Tauri command and every extension message handler: who can call it, and what is the worst they can do with it?
2. Any secret (token, passphrase, ticket, cookie) that reaches a log, a process argument list, an environment variable inherited by a child, or a file with wide permissions.
3. The worker: one job of each kind followed from the service's request to the result written into the library — is the result's file checked before it is believed?
4. Dependencies: any not pinned exactly (package.json, Cargo.toml/Cargo.lock, the Python requirements), any fetched at run time.
