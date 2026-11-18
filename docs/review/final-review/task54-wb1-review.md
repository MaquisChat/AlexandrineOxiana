# Task 54 whole-branch review — WB1 (`packages/core/src`, `packages/shared/src`)

Reviewer 1 of 7. Checkout `.claude/worktrees/agent-a0328b7cc1ec55b55` (branch `wb-review`, 7b81976). Read-only; three probe tests were written under `packages/core/src` (`citation/scrub.probe-wb1.test.ts`, `naming.probe-wb1.test.ts`, `capture/platforms.probe-wb1.test.ts`), run alone at `nice -n 10`, and deleted. `git status --short` shows none of them.

## What I read

**End to end:** `governance/engine.ts`, `governance/schema.ts`, `governance/merge.ts`, `governance/profiles/index.ts` and `yaml-text.ts`, `audit.ts`, `citation/csl-map.ts`, `citation/render.ts`, `naming.ts`, `import/dedupe.ts`, `import/identifiers.ts`, `verify/evidence.ts`, `capture/platforms.ts`, `changelog.ts`. In shared: `index.ts`, `credentials.ts`, `api/errors.ts`, `api/sources.ts`, `api/attention.ts`, `api/settings-reset.ts`, `api/device-notices.ts`, and `api/review.ts` (lines 1–170).

**Partly read:** `verify/checks.ts` (lines 1–265: creator and date agreement), `api/find.ts`, `api/zotero-sync.ts` and `api/search-settings.ts` (their texts only, found with grep).

**Seams I followed into other parts:** `library/export/bibliography.ts` (how the participant rules are wired), `library/repo/sources.ts:466-492` and `library/export/project-export.ts:266-281` (the callers of `pseudonymize`), every caller of `parseGovernance` and `parseGovernanceWithWarnings`, the service's `routes/review.ts` (`entryOut`, the withdrawal route), `routes/library-audit.ts`, `routes/capture.ts:122-138`, and `ui/screens/Capture.tsx:101,610`.

**Not read:** `verify/recheck.ts`, the rest of `checks.ts`, `import/filename-patterns.ts`, `annotations/*`, the `model/*` schemas beyond `source.ts:49`, `citation/styles.ts`, and most of `shared/api/find.ts` and `capture.ts`.

## Findings

### C1 — Critical: a participant's name in a script written without spaces (Chinese, Japanese, Thai and similar) is never pseudonymised inside a title, either in citations or in folder names
- **Where:** `core/src/citation/csl-map.ts:206-228` (`scrubText` compares whole `[\p{L}\p{N}\p{M}]+` runs) and `core/src/naming.ts:186-211` (`pseudonymize` requires no letter on either side, `(?<![\p{L}…])…(?![\p{L}…])`).
- **What is wrong:** Chinese and Japanese text has no word breaks, so a name joined to the next characters is never a separate "word" and is never replaced.
- **Probe output:**
  - `toCslItem` of an interview with participant code P-001 (map `王小明 → P-001`, creator `王小明`, `participantIds` set) returns `{"author":[{"literal":"P-001"}],"title":"王小明访谈录"}`. The creator is coded, but the participant's real name is still in the title.
  - The same happens for `山田太郎さんへのインタビュー`.
  - `pseudonymize("王小明访谈录", map)` returns it unchanged. `"Interview 王小明"` becomes `"Interview P-001"` only because there is a space.
- **Consequence:**
  - The real name is printed in a copied citation and in an exported bibliography (`library/export/bibliography.ts:174,239`).
  - The same function makes source folder names in pseudonymising projects (`library/repo/sources.ts:492`). Under R32 these folder names stay readable even in encrypted projects, so the name sits in plain text on disk.
  - The fail-closed requirement (`requireParticipantCodes`) does not help: the creator *is* coded, and only the title leaks.
- **Breaks:** R88 I1 ("scrub uses every pseudonym-map entry"), R23/R32 (folder names pseudonymised), and the standing rule that a participant's identity must not leave where the rules allow.
- **Not previously reported:** not in `final-review-list.md`. `verify/evidence.ts:39` already has `NO_SPACE_SCRIPT` for exactly this case, and title matching in verification uses it.
- **Direction:** for names that contain no-space-script characters, match by substring (on character boundaries, after folding), as `hasTokens` in evidence.ts does. Add tests in both functions with a name glued to the next characters.

### I1 — Important: the core `pseudonymize` (used for folder names and export file names) does not fold accents or full-width forms; the citation scrubber does
- **Where:** `core/src/naming.ts:186-211`. It only applies NFC and case-insensitivity. Compare `csl-map.ts:155-164`, which transliterates, applies NFKD and strips combining marks.
- **Probe output** (map built as `sources.ts:482-491` builds it, with `Lucía`, `Fernández` and `Lucía Fernández`):
  - `"Entrevista a Lucia Fernandez"` is returned unchanged.
  - `"ＬＵＣÍＡ talks"` is returned unchanged.
  - `"lucia_cocina video"` (map has `lucia.cocina`) is returned unchanged.
- **Consequence:**
  - A title typed without the accents the participant's stored name has (common in social-media text) leaves the real name in the source's folder name (readable in encrypted projects, R32).
  - Project-export file names (`project-export.ts:276`) are affected the same way.
  - The same name is coded in the bibliography but left in the folder name.
- **Breaks:** R23/R32 and R88 I1 ("name matching normalised everywhere").
- **Direction:** use one name-folding rule (csl-map's `fold`/`normName`) in both places, and test the pairs above.

### I2 — Important: participant names that are in the map but are not a creator of the source are scrubbed only in their exact word order; URLs are not checked for spaced forms
- **Where:** `csl-map.ts:313-318`. Map entries become a single form (`words` of the key) with no reversed form and no bare parts. The URL check `urlNamesParticipant` (`csl-map.ts:231-246`) tries only the separators `"" - . _`.
- **Probe output** (map `Maria Lopez → P-003`; the source is by an unrelated author, as with a news story about a participant):
  - The title `"Lopez, Maria: her life; and LÓPEZ MARIA"` is returned unchanged.
  - These URLs are all kept in `item.URL`:
    - `https://news.example/Maria%20Lopez/story` (decoded to a space, which is not a separator)
    - `…?q=maria+lopez`
    - `…/lopez-maria`
- **Why it matters:** the map is deliberately extended with every participant's name details (`bibliography.ts:100-102`, `fullName` and similar fields), so this is the ordinary path for a participant who is the subject of a source rather than its creator.
- **Breaks:** R88 I1 ("scrub uses every pseudonym-map entry"; "URL check against slug forms").
- **Direction:**
  - Give map entries of two or more words their reversed order (and a "Family, Given" form) in titles.
  - In URLs, treat whitespace and `+` as separators, and also look for the reversed order.

### I3 — Important: the governance control `consent.requireStatus` ("Every source records its consent status") has no effect anywhere
- **Where:**
  - The schema and default are in `core/governance/schema.ts:124,174,221`. `engine.ts` only checks that the value is a boolean (`:116`).
  - Nothing else reads it: grep over packages and apps finds only the UI model and `GovernanceSettings.tsx:329`, which offers it as a checkbox.
- **Consequence:** a source whose `provenance.legal.status` is `"unknown"` (`model/source.ts:50`) is stored in a project that requires a consent status. A researcher who ticks the box (on by default) believes it is enforced.
- **Breaks:** the rule that governance fails closed, and the rule that a governance control does what the screen says.
- **Not previously reported:** not in the FR list.
- **Direction:** either make the engine refuse `store` (and `capture`) of identifiable data with an unknown status when this is set (the request needs the status), or take the control off the screen and out of the defaults, with a note in the guide. This is the owner's choice.

### I4 — Important: `classifyUrl` throws `URIError` on a malformed percent escape in a YouTube or TikTok handle, which takes down the Capture screen
- **Where:** `core/capture/platforms.ts:94` and `:128` (`decodeURIComponent(seg[0])` with no try).
- **Probe output:** `classifyUrl("https://www.tiktok.com/@%ZZ")`, `"https://www.youtube.com/@%E0%A4%A"` and `".../@%ZZ/video/123"` all throw `URIError: URI malformed`.
- **Callers that do not catch it:**
  - `ui/src/api/capture.ts:192` (`previewLink`) is called during render at `ui/screens/Capture.tsx:610`, and the UI has no app-level error boundary (only `FindEntryRow.tsx` has one). Pasting such a link, or typing `https://www.tiktok.com/@%` on the way to a percent-encoded handle, throws in render.
  - `library-service/routes/capture.ts:135` (`postLinksOnly`) answers 500 INTERNAL instead of 400.
  - `library/capture/profile-snapshot.ts:114,130` and `snapshot.ts:68` parse yt-dlp output, which is outside text. One bad entry URL fails the whole parse.
- **Breaks:** R146 ("a hint there; the service decides"; nothing is refused on the strength of the preview) and R96 (plain-language errors, not INTERNAL).
- **Direction:** decode inside a try and keep the raw segment (or return `unknown`) on failure. Test it in core.

### Minor
- **M1 — `audit.enabled` has no effect.** The screen offers "Keep an append-only, hash-chained audit log" (`GovernanceSettings.tsx:380`), but nothing reads `audit.enabled`, and audit is always on. This fails safe, but unticking it suggests the log stops. Make the control read-only or remove it.
- **M2 — one dropped governance warning is not covered by FR-125's grading.** `parseGovernanceWithWarnings` has no caller outside core, so every load warning is dropped (FR-125, graded D on the grounds that the warnings "only say an exception waives nothing"). That grounds does not cover the legacy-key warning at `schema.ts:331`: `consent.defaultLegalBasis.manual_upload: ignored`. A legal basis the researcher wrote is silently not used. The rule is fail-safe, but the researcher is never told. Not a re-grade to Important: the effect is a refusal, not a leak.
- **M3 — a whitespace-only legal basis satisfies `requireLegalBasis`.** The engine checks `!s.legalBasis` (`engine.ts:218`), and the service's `str()` only refuses an empty string (`routes/util.ts:41`). `legalBasis: " "` therefore passes GDPR's requirement. Trim in the engine.
- **M4 — `protocol.number` of only spaces satisfies `requireBeforeCapture`** (`engine.ts:170`), for the same reason.
- **M5 — a short name in the pseudonym map codes unrelated creators.** `codeFor` (`csl-map.ts:190-196`) matches a creator's bare family or given name against the map. A participant detail such as `nickname: Rose` (picked up by `NAME_KEY` in `bibliography.ts:89`) therefore turns every creator with given name "Rose" into that participant's code in bibliographies. This fails safe, but the citations come out wrong.
- **M6 — `sanitizeSegment` keeps a leading dot.** `" .hidden"` becomes `".hidden"` (probe), so a source title starting with "." gives a hidden folder on macOS (`naming.ts:50-62`).
- **M7 — `stripTracking` keeps userinfo.** `classifyUrl("https://user:secret@example.com/a?token=abc")` returns the canonical URL with `user:secret@` and `token=abc` (probe). The CLI prints `canonicalUrl` (`apps/cli/src/output.ts:36`). The snapshot paths do not keep userinfo (`snapshot.ts:73` uses `u.host`), so the exposure is limited to the CLI.
- **M8 — `CONFIRMABLE_IDENTIFIER_KEYS` is a duplicated list.** `shared/api/sources.ts:53` is a copy of `library/source-actions.ts:84`. The two are equal today, but nothing ties them together (unlike the `Same<>` checks in `routes/review.ts:79-83`).

## The specific checks

1. **R88: can a citation, bibliography entry or citation key built by core carry a participant's real name when the project pseudonymises? — YES.**
   - Through the title for names in scripts written without spaces (C1).
   - Through the title and the URL for map entries that are not creators, in reversed order or with space or plus separators (I2).
   - Citation keys hold: no key is copied when any creator is coded or `participantIds` is set (`csl-map.ts:377`). With `requireParticipantCodes` and only an interviewer, the key is copied (probe: `"citation-key":"lopez2020"`), but the interviewer is the researcher.
   - Creators fail closed as designed (`csl-map.ts:322,332`). The wiring in `bibliography.ts:95-150` passes the map, the name details and `requireParticipantCodes` from the engine's own decision.
2. **R58: are governance-load warnings handed back in a form callers cannot drop? — NO.** The function that returns them, `parseGovernanceWithWarnings`, has no caller outside core. All 17 callers use `parseGovernance`, which discards `.warnings` (`schema.ts:288-290`), so the warnings never reach a service type. This is already listed as FR-125 (D). See M2 for the one warning its grading does not cover.
3. **Shared texts the screens show verbatim that state something the code does not do? — None found in the texts I checked; but see I3 and M1 for two governance labels that are false.**
   - Checked against code:
     - `REASON_SEALED_LOCKED`, `REASON_SEALED_MISSING`, `REASON_SEALED_UNREADABLE` and `REASON_SEALED_MISMATCH` (`library/repo/audit-reasons.ts:159-162`)
     - `IN_LIBRARY_TEXT` file, folder and import-file
     - `HELD_FILE_REVIEW_TEXT`
     - the device-notice kinds
     - the settings-reset contract
     - `findRefusal` (`api/find.ts`): `queueUnreadable`, `indexNotReady`, `readOnly`, `closed`, `entryState`
     - `search-settings` "Keys are never kept in plain files"
     - zotero-sync `deletions-unconfirmed`
   - I read the code behind only some of these: the `REASON_*` texts and `IN_LIBRARY_TEXT`. The others I judged from their wording and the library's names, and the twenty were not all verified line by line (see "Could not verify").
   - The two false statements I found are UI labels for core governance controls, not texts in `shared`: "Every source records its consent status" (I3) and "Keep an append-only, hash-chained audit log" (M1).
4. **A field the service sends that `shared` types as required but the library can omit (or the reverse)? — None found in the sample.**
   - `ProjectReviewEntry.sourceId` is filled with `e.sourceId!` (`routes/review.ts:47`). The library filters out entries without a `sourceId` before listing (`import/bulk/review.ts:67,81`), so this holds.
   - The withdrawal route's `sourceId!`, `resolvedAt!` and `reason!` (`routes/review.ts:140`) come from `reviewedAfterWithdrawal`, which resolves the entry and is guarded by `pendingEntry` (`review.ts:94-99`).
   - `LibraryAuditCheck`, `AttentionMarksResponse` and `AuditEventView` agree with what the routes return, and are scrubbed of paths.
   - I did not sweep every route.

## Checked and sound
- **The policy engine fails closed.** Each of these is refused through the catch in `evaluate` (`engine.ts:428-434`) or by `assertShape`:
  - an unknown action (`:423`) or an unknown processing op (`:196`)
  - a bad `now` or `tz`
  - a missing payload (`need`)
  - a malformed effective policy
- **Governance parsing:**
  - The rules file is parsed strictly (zod `.strict()`, unknown keys refused). Invalid YAML throws `GovernanceParseError`, and every library caller reads that as refusal or strictest.
  - An exception without a written reason is ignored (`merge.ts:145`). An exception lowers a control only to its exact approved value. Booleans need an exact match.
- **Profile minimums:** they are folded in strictest-wins order, and the HIPAA cloud folder rule needs an approved list. DMP `require` items are only reported, by design (the profile text says so).
- **`loosenedControls`** detects each of these:
  - boolean, ordered, list and date loosenings
  - a profile removed
  - a new or changed exception
  - a platform added or the restriction dropped
  - an earlier `approvedFrom`
  - a changed default legal basis
- **Audit chain:**
  - Hashing covers every field except `hash`, in canonical JSON (RFC 8785).
  - Values that are not canonical (non-finite numbers, holes, class instances) are refused when sealing.
  - In `verifyChain`, a dropped middle entry gives prev-mismatch, reordering gives seq-gap or prev-mismatch, and a rewritten field gives hash-mismatch. A `null` line or one that cannot be hashed is a break, not a throw.
  - A rewritten tail or a truncation is documented as needing the external anchor, which is the library's part. The torn last line is handled in the library (R28), so I did not probe it here.
- **Rendering:** citeproc is reset on every call (`render.ts:101-107`), and locators are cleaned before html or rtf output.
- **`findDuplicate`:** identifiers are made canonical, and a fuzzy match is vetoed by a conflicting DOI or ISBN.
- **`toIsbn13`:** check digits are validated, and an ISMN is excluded.

## Could not verify
- **The twenty shared texts:** I checked only the sealed-reason texts and `IN_LIBRARY_TEXT` against the code behind them. Settling the rest needs a reader of the library's find runner and Zotero sync (WB3 and WB4's parts), since those texts describe what that code does.
- **The I4 crash on screen:** I inferred it from the code path (a throw during render, and only one error boundary). A UI probe typing `https://www.tiktok.com/@%` into the Capture links box would confirm it.
- **The verification rules:** `verify/checks.ts` from line 266 and `recheck.ts` (grounding, platform identity, the AI-quote rules of R37–R40) were not reviewed. They were reviewed several times before (Tasks 16 and 22).
- **The rest of the types crossing the boundary:** only a sample was checked. A complete check would compare every `routes/*.ts` return value with its `@ao/shared` type for optional fields the library may leave out.
