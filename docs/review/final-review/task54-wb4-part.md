## WB4 — Find and acquire, exports and citations: `packages/library/src/find`, `export`, `citation` (about 13,000 lines)
You are reviewer number 4. Your part: `packages/library/src/find/**`, `export/**`, `citation/**`.
Where a mistake costs most: the owner's rule (R301, R303): a found file is NEVER attached without the researcher's own decision on its own review entry — attack every path from a fetched file to a source's files (the runner, "use all the files that look right", the browser hand-over, the library window, a resume after a crash, a restore, a second device); the fetchers (which hosts, redirects, a file that is not what its name says, size bounds; the sign-in session — where cookies and tickets live and who can read them); the sealed queue in an encrypted project; what a search sends to outside services (titles of identifiable sources; Elicit and the other configured targets; the settings that turn each off); exports and backups (what a backup holds, a restore into another library, an export of a pseudonymised project: does ANY exported file carry a real name, an absolute path, a held file, or a secret?); the destruction record in an export.
Specific checks:
1. R77: do citation keys in reports and exports respect pseudonymisation?
2. R88 on the library's side: a citation or bibliography produced by `citation/**` for a source tied to a participant.
3. A backup made, then restored: is the review queue's state (held files and their pending entries) carried rightly — can a restore turn a held file into an attached one, or lose the entry and keep the file?
4. The texts the feature shows ("Nothing was sent", "This was not downloaded", counts): any that can be false?

