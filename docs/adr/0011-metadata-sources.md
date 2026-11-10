# 0011. Metadata sources: embedded extractors and governed online lookups

- **Status:** Accepted
- **Date:** 2026-11-10

(The plan named this file `0007-metadata-sources.md`; 0007 is already the index ADR, and 0008–0010 are taken, so this is 0011.)

## Context

Spec 5.1 (drag-and-drop attach, DOI and ISBN lookup) and 5.4 step 3 (identify each item) need two things:

- metadata embedded in the files people bring: PDF, EPUB, MOBI/AZW3, DOCX, HTML, photos and videos;
- metadata from public bibliographic services for the DOIs and ISBNs found.

Both run on untrusted input and both can leak. A file can carry scripts, links to remote resources, or a zip bomb. A lookup sends an identifier or a title off the device, and a cache of lookups on disk could reveal what an encrypted project holds (R30).

## Decision

### Embedded metadata (`packages/library/src/extract/`)

`extractMetadata(path, mime)` dispatches on the MIME type, falling back to the file extension for generic types. It returns title, creators, issued date, language, identifiers, the text of the first 3 pages or sections (at most 20,000 characters) and, for media, capture metadata.

- **Identifiers:** taken from metadata fields (XMP `prism:doi`, OPF `dc:identifier`, EXTH 104, `citation_doi` and `citation_isbn`). The extracted text is also scanned with core's `findIdentifiers`.
- **PDF (pdfjs-dist):**
  - Reads the Info dictionary and XMP. XMP wins, and junk titles such as "Microsoft Word - x.docx" are ignored.
  - Takes text from up to 3 pages.
  - Sets `needsOcr` when page 1 has fewer than 50 non-space characters.
  - Settings: `isEvalSupported: false` (pdfjs 6 has no eval path, so this is kept as defence in depth), `useWorkerFetch: false`, no cMap, standard-font or wasm URLs, no font-face loading, and no XFA.
  - PDF JavaScript is never run: pdfjs runs it only through its separate scripting sandbox, which is never loaded.
- **EPUB and DOCX (yauzl):**
  - Limits: at most 10,000 entries, each entry at most 50 MB uncompressed, and at most 200 MB in total. The declared sizes are checked, and yauzl enforces them while inflating.
  - Absolute paths and `..` entry names are refused.
  - A violation throws `UnsafeFileError` with a code.
  - EPUB metadata comes from the OPF (`dc:*`); DOCX metadata comes from `docProps/core.xml`.
- **Linear-time scanning (R52):** markup is never matched with backtracking patterns over whole documents. `extract/scan.ts` tokenises with `indexOf` and stops at the first unterminated tag, comment or quote, so hostile input such as 200,000 unclosed `<title>` tags stays linear. Metadata is read from at most the first 512 KB: the HTML head, the OPF, `core.xml` and LoC responses. DOCX and HTML text collection stops at 20,000 characters. Extracted text keeps single line breaks and at most one blank line.
- **HTML:**
  - Parsed as text, with no DOM and no scripts. Nothing the page references is fetched.
  - Fields are taken in order of preference: Highwire `citation_*`, then Dublin Core, then OpenGraph, then `<title>`.
- **MOBI and AZW3:** the PalmDB header and record 0 are parsed directly, using EXTH 100 (author), 503 (title), 104 (ISBN), 106 (date) and 524 (language). Every offset and length is checked against the bytes read, and record counts are bounded.
- **Images and video (exiftool-vendored):**
  - Uses one process pool per process, ended by `shutdownExtractors()`.
  - **Capture time:** DateTimeOriginal, then CreateDate, then QuickTime CreationDate or MediaCreateDate, then ModifyDate as a last resort. ModifyDate is needed because files straight from a camera, such as the test DNG, carry only IFD0 DateTime. `capturedAtSource` (`original`, `created` or `modified`) says which one was used; `modified` must be treated as unverified, not as a capture time.
  - **Time zone:** `tzOffset` comes only from OffsetTimeOriginal, or from an explicit zone on the QuickTime creation date. Nothing is inferred from GPS.
  - **Other fields:** device (Make + Model), lens (LensModel), and ContentIdentifier for Live Photo pairing.
  - GPS stays raw here. Coarsening and stripping are governed where files are stored and exported.

### Online lookups (`packages/library/src/lookup/`)

- **Order:**
  - `lookupDoi`: Crossref, then OpenAlex.
  - `lookupIsbn`: Open Library (the edition, then author records), then the Library of Congress. The LoC endpoint is plain HTTP, so it is **never used for sensitive (encrypted-project) lookups** (R52): it is skipped with a debug note, and an encrypted project loses that ISBN fallback.
  - `searchTitle`: OpenAlex search.
- **Governance (R14, R50):**
  - Every call takes a `LookupContext`: the project id, its effective policy, the actor, the time zone and clock, and `sensitive`.
  - `sensitive` fails closed: anything but an explicit `false` counts as sensitive, so a context built by hand without it never writes to the disk cache and never uses LoC. `lookupContextFor` sets it from the project's encryption.
  - `lookupContextFor(repo, projectId, http)` builds this context from the repository.
  - Before each provider is asked, the lookup calls `evaluate({action:'process', process:{op:'metadata_lookup', provider}})`.
  - A denied provider is skipped with a debug note and the next one is tried; a deny is never an error.
  - An unreadable policy denies every provider.
  - A lookup throws `LookupHttpError` only when every permitted provider failed to answer.
- **HTTP (`HttpClient`, undici):**
  - **User-Agent:** `AlexandrineOxiana/<version> (+https://github.com/maquiscatta-sys/AlexandrineOxiana)`. The user's contact email is added as `; mailto:<email>` only when it is set in settings, and only if it is a plain address.
  - **Rate limits per host:** Crossref 5/s, OpenAlex 5/s, Open Library 1/s, LoC 1/s, and 1/s for any other host.
  - **Retries:** 3 retries on 429, 5xx or network errors. The backoff is 0.5 s, 1 s, then 2 s, or the server's Retry-After, capped at 60 s.
  - **Deadline:** each attempt, redirects and body included, is aborted after 60 s (`AbortSignal.timeout`).
  - **Redirects:** followed only within the same origin, at most 3 times.
  - **Responses:** bodies are capped at 5 MB.
- **Cache:**
  - Stored in `<Library>/.cache/lookups/<sha256(cacheKey)>.json`. The directory is 0700 and the files are 0600, written atomically.
  - Answers (200) are kept for 30 days; not-found answers (404/410) for 1 day. An entry whose stored time is in the future counts as expired.
  - On JSON paths, a 200 response is cached only if it parses as JSON.
  - Files are written with the library's atomic writer (mode 0600). A symlink in place of the cache directory is refused: nothing is read or written through it, and it is never chmodded.
  - An entry holds only the time it was stored, the status and the body. It never holds the URL, the request headers or the contact email.
  - Lookups for an encrypted project (`sensitive: true`) are cached in memory only. `HttpClient.purgeSensitive()` drops them; it must be called when an encrypted project is locked (wiring belongs to Task 22/30).

### Endpoints

| Provider | Endpoint | Verified |
| --- | --- | --- |
| Crossref | `https://api.crossref.org/works/{doi}` | Reached from the build sandbox on 2026-11-10 (HTTP 200). |
| OpenAlex | `https://api.openalex.org/works/doi:{doi}`, `https://api.openalex.org/works?search=…&per-page=5` | Reached on 2026-11-10 (HTTP 200). |
| Open Library | `https://openlibrary.org/isbn/{isbn13}.json` (302 to `/books/OL…M.json`), `https://openlibrary.org/authors/OL…A.json` | Reached on 2026-11-10; redirect behaviour confirmed. |
| Library of Congress | SRU `http://lx2.loc.gov:210/LCDB?version=1.1&operation=searchRetrieve&query=bath.isbn%3D{isbn13}&maximumRecords=1&recordSchema=mods` | **Unverified.** |

**LoC details.** The SRU URL is the base documented on LoC's "LC SRU Servers" page (`https://www.loc.gov/standards/sru/resources/lcServers.html`, read on 2026-11-10). The build sandbox could not connect to port 210. `https://lx2.loc.gov/lcdb` and `https://lccn.loc.gov/{lccn}/mods` answered with LoC's "No Connections Available" page.

- **Limits of this endpoint:**
  - It is plain HTTP on a non-standard port, so only the ISBN is sent.
  - Some networks block the port. A lookup that cannot reach it is reported as unavailable, and the result falls back to whatever Open Library said.
- **Fallback if it is retired:** the loc.gov JSON API (`https://www.loc.gov/books/?q={isbn}&fo=json`). It answered over HTTPS from the sandbox, but its keyword search did not match ISBNs reliably in a spot check, so it is not used yet.
- **Revisit:** verify the SRU endpoint from a normal network before release.

## Consequences

- Lookups are deterministic and testable offline. Tests use undici's `MockAgent` with recorded, hand-written JSON and XML fixtures (`packages/library/tests/fixtures/lookup/`), and never use the network.
- An encrypted project loses the disk cache, so repeated lookups cost requests. The rate limits keep this polite.
- Fixtures:
  - Real camera files (a DNG and a CR3 from raw.pixls.us, CC0) are downloaded by `scripts/fetch-fixtures.mjs`, pinned by sha256. Their tests skip when the files are absent.
  - Everything else is generated by `tests/fixtures/generate.mjs`.
  - There is no HEIC fixture; see `tests/fixtures/ATTRIBUTION.md`.
- WorldCat (spec 5.1, "where available") is not implemented. Its API needs an institutional key.
