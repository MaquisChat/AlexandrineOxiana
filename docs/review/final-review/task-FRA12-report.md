# Task FR-A12 report: a title search never carries what may be a participant's data (R379)

Branch `fr-a12-title-search`, worktree `.claude/worktrees/agent-a7f301291240d4274`. Head: `b361c91`. Status: DONE.

## Commits
- `59bbb25` fix(library): no title search for audio, video or image files (R379 i). Also adds the R379 resolve/attach tests.
- `6d378e1` fix(library): no title search in a project that holds identifiable data (R379 ii)
- `84824bd` fix(library): a bulk import's report says when titles were not looked up (+ bulk engine tests)
- `a04df61` test(library): a watched folder never sends a recording's name for a title search
- `b361c91` test(service): a recording dropped in a default project makes no title search request

## What changed (file:line)
1. **Audio, video and image: never a title search.** `packages/library/src/import/resolve.ts:316-327`. `resolveItem`'s single `search` helper (the only caller of `searchTitle`, used by both step 5 and step 6) returns nothing unless `titleSearch` is true. `titleSearch` is false whenever the sniffed `mime` matches `LOCATED_MEDIA` (`^(image|video|audio)/`, the existing constant in the same file). It is decided by the sniffed type only. An item with no file (mime `""`, e.g. a reference-only record or a sidecar alone) is **not** a media file. A reference record whose *type* is "audio" but which has no file is therefore not covered by (i), only by (ii). That follows "audio, video or image *file*".
2. **Identifiable project: no title search from a file name, an embedded title or a reference manager's title.**
   - The signal is `policy.identifiability.containsIdentifiable`, the ruling's own words ("a project whose rules say it holds identifiable data"). I did not use `pseudonymizeFileNames`, which the reviewer mentioned. `containsIdentifiable` is broader: it covers a project that says it holds identifiable data but does not pseudonymise names.
   - New field `LookupContext.titleSearchAllowed?: boolean` (`packages/library/src/lookup/context.ts:34-41`). It is fail-closed: only an explicit `true` allows title searches.
   - `lookupContextFor` sets it to `policy?.identifiability.containsIdentifiable === false` (`context.ts:80-82`). An unreadable policy (null) means no title search.
   - `resolveItem` reads it at `resolve.ts:323`, so every caller gets it without code of its own: attach, bulk import (folder, ZIP, BibTeX/RIS/CSL, Calibre, Zotero local/web, device), watched folders (through attach) and the service.
   - `sensitive` is untouched. The module comment says the same at `resolve.ts:41-44`.
3. **Identifier look-ups stay.** Step 3 is untouched. A DOI PDF in a default project is still looked up through Crossref and gets its DOI at `identifier+lookup` (test below).
4. **The file name still fills the record on the device.** Step 5's local `step(... "filename")` is untouched. The tests assert title, creator, year and their `filename` evidence.
5. **Find and acquire is not affected.**
   - `packages/library/src/find` calls neither `resolveItem` nor `searchTitle`, and does not read `titleSearchAllowed` (checked with `grep -rn "titleSearchAllowed|resolveItem|searchTitle" packages/library/src/find apps/library-service/src`: no hits outside tests).
   - Find does build its context with `lookupContextFor`, but only `resolveItem` consults the new field. The find suites pass unchanged.
6. **What the researcher is told.**
   - The batch record already has `notes`. They are shown as "## Notes" in report.md/.json and in `ImportReport.notes`, which reaches the UI.
   - `packages/library/src/import/bulk/run.ts:810-811` adds the exact sentence once per batch (`TITLES_WITHHELD_NOTE`, run.ts near `DELETED_NOTE`): "Titles were not looked up online, because this project holds identifiable data. Identifiers (DOI, ISBN) were still looked up."
   - The note is added only when the policy is readable, title searches are withheld by the context, and OpenAlex would otherwise be allowed (`providerAllowed`). The last condition stops the note from claiming a withheld search in a project that allows no look-ups.
   - It goes in the import **report** only. The dry run explicitly looks nothing up online, so no note was added there. Attach (single drop) has no report: nothing is shown there.

## Tests (each seen to fail first for the right reason unless noted)
`packages/library/src/import/attach.test.ts`, new describe "R379 (FR-A12) …" at the end:
- The reviewer's probe: `Gonzalez 2024 Interview about her eviction.m4a` (`audio/mp4`) under the default rules. No OpenAlex search request; title, creator, year and `filename` evidence still come from the name. Failed first with `search=Interview+about+her+eviction+Gonzalez`.
- m4a, mp4 and png in a project with **no** identifiable data: no search. Failed first.
- The same name as a PDF: no search in a default project. In a no-identifiable project exactly one search, `search=Interview+about+her+eviction+Gonzalez`. Failed first.
- A DOI PDF in a default project: the DOI is looked up (Crossref evidence), no search. This test guards unchanged behaviour, so it passed before and after.
- An embedded title (slides PDF, step 6), a sidecar RIS title (step 4 then 6), and a sidecar-only record in a default project: no search. Failed first with both searches.
- An item with no file in a no-identifiable project is searched (it is not media). This guards (i)'s scope, so it passed before and after.
- Through `attachFiles` in a default project (m4a and PDF): no search, and the title comes from the name. Failed first.

Other test files:
- `packages/library/src/lookup/lookup.test.ts` "lookupContextFor": `titleSearchAllowed` is true for a no-identifiable project and false for a default project and for one with `containsIdentifiable: true`. Failed first (`undefined`).
- `packages/library/src/import/bulk/bulk.test.ts`, new describe at the end:
  - Folder import (m4a and PDF) in a default encrypted project: no search request, both titles from the name, and the report note present. The search part failed first (checked by restoring the pre-fix resolve.ts). The note part failed before run.ts was changed.
  - No-identifiable project: the PDF is searched as before and there is no note. It passed before too: the recording's identical query is served from the lookup cache, so this test cannot prove (i). attach.test.ts does.
- `packages/library/src/import/watch.test.ts`: a recording arriving in a default project's watched folder sends no search and keeps the name's title. Failed first with the pre-fix resolve.ts.
- `apps/library-service/src/server.test.ts`: POST `/projects/:id/attach` of the recording in a default encrypted project sends no request (the library's undici MockAgent set as the global dispatcher, recording every request to OpenAlex/Crossref, as find-routes.test.ts does). Failed first with the pre-fix resolve.ts (`https://api.openalex.org/works?search=Interview+about+her+eviction+Gonzalez…`).

Test details:
- The "default rules" projects in these tests are `governanceYaml` with only `consent.defaultLegalBasis.manual-upload` set, encrypted. Without that line, attach is refused by the default rules ("Record a legal basis…"). `containsIdentifiable` stays at the default, true.
- No existing test was changed or loosened. Every existing step 5 and step 6 test already ran in projects with `containsIdentifiable: false`.

## Runs (nice -n 10)
- `pnpm --filter @ao/library test`: Test Files 106 passed | 1 skipped (107); Tests 3710 passed | 22 skipped (3732). This includes attach, lookup, bulk and watch.
- `pnpm --filter @ao/library-service test`: Test Files 40 passed (40); Tests 1026 passed | 1 skipped (1027). This includes server.test.ts.
- `pnpm -r typecheck`: every package Done, no errors.
- No shared text or screen was changed, so no UI suite, lints or end-to-end run.

## For the owner and coordinator
- As the ruling foresaw: in a default project, a paper with no identifier is no longer matched online by its title. The remedy R379 names ("These are published works: look their titles up online", a per-import switch) is not built here.
- A sidecar's title is withheld too. I read it as "a reference manager's title". A reference record's own title (score 0.9) never reached a search anyway.

## Cannot be shown here
- Real OpenAlex and Crossref traffic. Everything was asserted against the network double.

minor (deferred): the dry run (wizard step 2) does not show the "Titles were not looked up online…" note.
minor (deferred): the lookup disk cache of a non-encrypted, non-identifiable project still keeps title queries (`openalex:search:<query>`), as before. This is unchanged and outside R379.

## Round 2 (R385)
Head: `16d352f`.

### M2: the bulk report's note is always true (`a11ecfd`)
- **Text.** `run.ts:2189` now reads exactly: "Titles were not looked up online, because this project holds identifiable data. Look-ups by identifier (DOI, ISBN) are not affected."
- **Conditions.** Unchanged (`run.ts:811`): the policy is readable, the context withholds title searches, and OpenAlex (the title-search service) is allowed.
- **Tests (`bulk.test.ts`, describe "R379").** The test that asserted the old sentence was updated through its `NOTE` constant. Three tests now cover the note:
  - Present in a default project. It failed with the old text until `run.ts` was changed.
  - Absent where the project holds no identifiable data. The check is now on any note that starts with "Titles were not looked up", so it no longer depends on the exact text.
  - Absent where the default rules allow no look-up service (`metadata_lookup: []`). This test is new.
- **Mutation checks.**
  - Dropping `providerAllowed(...)` fails the "no look-up service" test.
  - Dropping `!titleSearchAllowed` fails the "no identifiable data" test.
  - Dropping the `policy &&` part fails nothing. It is redundant: a null policy already fails `providerAllowed`. I left it in.

### M3: the fail-closed defaults (`16d352f`)
- **Hand-built context (`attach.test.ts`, "R385 c").** A context from a no-identifiable project with `titleSearchAllowed` removed makes no search, and the name still fills the record. Reading an absent flag as allowed (`!== false`) at `resolve.ts:323` makes this test fail.
- **`lookupContextFor` (`lookup.test.ts`).** What it gives in each case:
  - Corrupted `governance.yaml`: `policy: null`, `titleSearchAllowed: false`.
  - `governance.yaml` removed: `policy: null`, `titleSearchAllowed: false`.
  - Reading an unreadable policy as allowed (`!containsIdentifiable`) makes this test fail.
- **Not fail-closed, so fixed.** A locked encrypted project whose rules say it holds no identifiable data gave `titleSearchAllowed: true`.
  - `context.ts` now gives `false` when the project is encrypted and not unlocked (`repo.isUnlocked`). Nothing can be stored in a locked project, so a search would serve no purpose.
  - Tested: a locked no-identifiable project gives `sensitive: true` and `titleSearchAllowed: false`. A locked default project gives `false`.
  - This test failed first with `true`.
- **Not done.** The optional second check of the policy inside `resolveItem` (review P2: a hand-built context set to `true` is trusted). It was not asked for. No production caller builds a context by hand.

### Runs (nice -n 10)
- `vitest run src/import src/lookup` (@ao/library): Test Files 26 passed (26); Tests 1056 passed | 15 skipped (1071). This includes the touched files attach, lookup and bulk.
- `pnpm -r typecheck`: no errors.
