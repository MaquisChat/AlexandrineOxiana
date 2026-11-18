# Review of Task FR-A12: a title search never carries what may be a participant's data (R379, R381)

Reviewer: a new adversarial reviewer. Worktree `agent-a7f301291240d4274`, branch `fr-a12-title-search`, head b361c91 (base 7b81976).

## Verdict: APPROVED WITH SMALL POINTS

- **Spec:** met.
- **Quality:** approved.
- **Findings:** 0 Critical, 0 Important, 5 Minor.
- **The finding:** WB3 C1 is closed on every automatic path that reads the researcher's files: attach, Bulk Import (every adapter, including the command line), watched folders, Zotero local/web and sync, resume after a crash, and the service's attach route.
- **Point for the coordinator:** M1. A bulk import that is already running keeps the rules it read when it started. Is that acceptable?

## What I ran
All runs used `nice -n 10`, one file at a time. Probes were in `packages/library/src/import/resolve.probeFRA12.test.ts` and are now deleted. `git status --short` is empty.

**P1. The C1 probe, re-run as written.** Input: `resolveItem` of `Gonzalez 2024 Interview about her eviction.m4a` (`audio/mp4`). The context was hand-built (`policy: DEFAULT_GOVERNANCE`, `sensitive: true`, no `titleSearchAllowed`). Output: `P1 []`, so no request was made. Before the fix this sent `search=Interview+about+her+eviction+Gonzalez`.

**P2. A hand-built context with the flag set wrongly.** Input: a context with `titleSearchAllowed: true` and `DEFAULT_GOVERNANCE`, and a PDF with the same name. Output: the search **is** sent. `resolveItem` trusts the flag and does not check the policy itself. See M3.

**P3. Recordings with misleading names, attached to a project that holds no identifiable data.** Inputs: M4A bytes named `….pdf`, the same with no extension, and the same as `….txt`. Output: `[]`, so no request. `file-type` sniffs all three as `audio/x-m4a`, and attach passes on the sniffed MIME type.

**P4. `lookupContextFor` in awkward states:**

| Project state | `titleSearchAllowed` |
|---|---|
| Locked encrypted project whose rules say no identifiable data | `true` (the rules are still readable, which is correct) |
| `governance.yaml` corrupted | `false` |
| `governance.yaml` empty (default rules) | `false` |

**P5. What leaves on a DOI look-up in a default project.** Input: a PDF named after the interview. Exactly one request was made: `https://api.crossref.org/works/10.5555/ao.fixture.2021.001`. Its headers were `user-agent: AlexandrineOxiana/0.0.0 (+https://github.com/…)` and `accept`. There was no title, no file name, no hint and no mailto (this test set none).

**Guard-removal checks.** In each case I took the guard out, ran the tests, then restored the file with `git checkout`.

| Guard removed | Result |
|---|---|
| Media check in `resolve.ts:323` | attach.test "audio, video and image files are never searched for…" fails |
| `titleSearchAllowed === true` in `resolve.ts:323` | 4 tests fail: attach ×3 and bulk ×1. The watch test still passes, because the recording is also held by the media check. |
| `titleSearch = true` (both guards) | the service test `server.test.ts` "R379 …" fails with `https://api.openalex.org/works?search=Interview+about+her+eviction+Gonzalez&per-page=5`. It passes again once restored. |
| `context.ts:81` set to `true` | lookup.test "lookupContextFor…" and attach ×3 fail |
| `context.ts:81` made fail-open (`!containsIdentifiable`) | **nothing fails**. See M3: harmless today, because a null policy also denies every provider. |
| `resolve.ts:323` with absent read as allowed (`!== false`) | **nothing fails** in attach, lookup or resolve. See M3. |
| `run.ts:811` reduced to `!titleSearchAllowed` (the policy and `providerAllowed` conditions dropped) | **nothing fails** in bulk.test. See M2. |

## Spec table (brief and R379 FR-A12)

| Item | Status |
|---|---|
| (i) No title search for audio, video or image, by sniffed type, in steps 5 and 6 | ✅ `resolve.ts:323,327`. `search` is the only caller of `searchTitle` in the program. |
| Item with no file is not media | ✅ (mime `""`). This is tested. |
| (ii) No title search unless the rules say no identifiable data, set in `lookupContextFor`; `sensitive` not reused | ✅ `context.ts:34-41,80-82` |
| (iii) Identifier look-ups unchanged | ✅ Step 3 is untouched. The test passes before and after. P5 shows only the DOI leaves. |
| (iv) The file name still fills the record locally | ✅ `expectNameOnDevice`: title, creator, year, and `filename` evidence |
| (5) Find and acquire does not go through the gate | ✅ It does not call `resolveItem` or `searchTitle`, and it does not read the flag. |
| (6) The note in the bulk report | ✅ Exact sentence, once per batch. It is not in the dry run or attach; R381 (d) moves that to FR-658. It is not always true: see M2. |
| Tests through attach, bulk, watched folder and service | ✅ Each fails without the guard (above). |

## Every way out, checked

**Every caller of a look-up provider.**
- `searchTitle`: its only caller is `resolve.ts:329`, inside the gated `search`.
- `lookupDoi` and `lookupIsbn`: their only caller is `resolve.ts:384` (step 3).
- `openAlexSearch`: called only from `searchTitle`.
- There are no other `getJson` or `getText` calls in `lookup/`.

**Every `resolveItem` caller.**
- `attach.ts:307` covers drag-and-drop, the service's `/projects/:id/attach` and watched folders.
- `bulk/run.ts:1353` covers folder, ZIP, BibTeX/RIS/CSL, Calibre, Zotero local/web/sync, device, the command line (`apps/cli/src/commands/import.ts:232`, `zotero.ts:217`) and resume after a crash. The context is rebuilt on every `run()`.
- Both callers build the context through `lookupContextFor`. No non-test code builds a `LookupContext` by hand for an import. The only other hand-built context is `find/settings.ts:379` `testContext`, which sends the fixed test words.

**Other outgoing traffic.**
- `zotero-web.ts` sends the API key and library id to Zotero, not titles.
- The media worker fetches only addresses the researcher gave.
- `worker-client.ts` and `media-worker.ts` talk to localhost only.

**Service routes.** `sources/:sid/recheck` and `/projects/:id/recheck` call `repo.recheckSource`. The Repo has no HTTP client, so these are local. The review routes make no look-ups. No route offers "refresh metadata" or "look this up" for an imported source.

**Find and acquire, which is out of scope.**
- Its background work: retries of a queued entry, and `copyOn` asking arXiv, DOAB and the Internet Archive by title and family name.
- `copyOn` works only on the record Find itself made from the typed reference and the service's answer (`entry.sourceId`, created or adopted by the runner). It never works on a source that came from a file.
- "Where to get it" and the catalogue address are links the researcher opens; the app does not open them. The browser extension's `find-tab.ts` fetches only the PDF at the tab's own address.
- So nothing sent automatically by Find comes from the researcher's files.

**Media check by sniffed type.**
- Attach and bulk sniff with `file-type` (`attach.ts:398-404`, `run.ts:1289-1300`) and pass on the sniffed MIME type.
- `file-type` returns `application/ogg` (`ogx`) or `application/vnd.ms-asf` for some recordings. Both are refused as unsupported, so they never reach `resolveItem`.
- Every ftyp brand it returns maps to `audio/`, `video/` or `image/`. It never returns `application/mp4`.
- An item with several files is judged by its first kept file, and only that file's name is parsed (`run.ts:1349-1356`).
- ZIP entries go through the same `prepareFiles`.

## Findings

### Minor

**M1. A running bulk import keeps the rules it read at its start.**
- Where: `bulk/run.ts:809`. `this.lookup` is built once and used for every item (`:1361`).
- What happens: if the researcher changes the rules to `containsIdentifiable: true` during a long import (a Zotero library of thousands of items), title searches continue until the batch ends. The store decisions for each item are evaluated again at each write (R42); the look-up context is not.
- This is not new: the list of allowed look-up services already worked this way. But R379 makes this flag a privacy gate. Attach is not affected, because it builds a new context for each call.
- Direction: re-read the policy (one small file) for each item, or for each group of items, or drop the run's context when the rules are saved. Coordinator's call.

**M2. The bulk report's note can say something untrue, and its conditions are untested.**
- Where: `run.ts:811` and `run.ts:2188-2189`.
- The note says "Identifiers (DOI, ISBN) were still looked up". In a project whose `processing.metadata_lookup` is `[openalex]` (Crossref, Open Library and the Library of Congress removed), the note appears. DOIs still go through OpenAlex, but no ISBN is looked up, because `lookupIsbn` asks only Open Library and the Library of Congress.
- It is also added when a batch started before this fix is resumed after it, although part of that batch was searched by title.
- Removing the `policy` and `providerAllowed` conditions breaks no test.
- Direction: add the identifier sentence only when the identifier services are allowed (or word it per service), and add a test for a project that allows no look-ups, where there must be no note.

**M3. The fail-closed defaults are not held by tests, and `resolveItem` trusts the flag on its own.**
- Where: `resolve.ts:323` and `context.ts:81`.
- If absent were read as allowed (`!== false`), or if an unreadable policy were read as allowed (`!containsIdentifiable`), no test would fail.
- Neither change leaks anything today:
  - no non-test caller builds a context by hand;
  - a null policy denies every provider.
- P2 shows that a context made with `titleSearchAllowed: true` and identifiable rules does search.
- Direction:
  - add one resolve test with a hand-built context that has no flag, and one `lookupContextFor` test with unreadable rules;
  - optionally, have `search` also require `lookup.policy?.identifiability.containsIdentifiable === false`, so the gate is checked twice.

**M4. What an honest researcher loses goes beyond the cost the ruling named.**
- In every project with the default rules (which say they hold identifiable data), papers without an identifier are no longer matched online by title. This is the cost the ruling names, left to the owner as decision 22 (R381 c).
- (i) also applies in projects that say they hold no identifiable data. A scanned article or book chapter imported as an image (`scan0001.tif`, a photo of title pages) is no longer looked up by its name or embedded title. This follows the ruling's text ("image files"), but the owner may not have pictured scans.
- A reference-only record whose type is audio or interview (a Zotero "interview" item with no file), in a project with no identifiable data, is still searched by its title. The report said so; it is consistent with "file".
- None of this is a defect. It is listed for the owner.

**M5. A test-only fragility.**
- `apps/library-service/src/server.test.ts:35` imports `../../../packages/library/node_modules/undici/index.js` to set the global dispatcher.
- The test works, and fails without the guard. But it depends on pnpm's folder layout and on the client using the global dispatcher. If either changes, the test passes silently with `sent` empty.
- Direction: a `HttpClient` dispatcher seam in the service's test options, or a check in the test that a known request is intercepted.

## Checked and sound
- The gate is placed in `lookupContextFor`, so every caller is covered without code of its own.
- `sensitive` is untouched.
- The flag is false when it is absent, when the policy is null, when `containsIdentifiable` is true, and under the default rules.
- Step 5 still writes title, creator and year with `filename` evidence. Step 6 and step 4's sidecar title are withheld, as R381 (b) rules.
- An identifier look-up sends only the DOI or ISBN in the path, with the User-Agent and no title (P5).
  - An identifier could hold a name only through a DOI suffix written into the file. That would be an identifier the file states, not a parsed name; I judge the risk negligible.
  - The Library of Congress is never asked for sensitive projects.
- The note is added once per batch: `note()` removes duplicates, including on resume.
- No existing test was loosened. The step 5 and step 6 tests already ran with `containsIdentifiable: false`.

## Could not verify
- Real OpenAlex and Crossref traffic. Everything was checked through the network double.
- The UI's display of the batch note. The path already exists and no UI code changed.
- Whether file-type sniffs every real-world recording format as `audio/` or `video/`. I checked by reading `file-type` 22.2.0's detectors for the accepted extensions, not with real files.
- Title queries already in the disk cache of projects that were never encrypted: `openalex:search:<query>`. They stay on the device, and the report lists them as deferred.
