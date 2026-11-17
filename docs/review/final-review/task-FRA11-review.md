# Task FR-A11 — review (addresses and two blank values; R379, R389)

Reviewer: fresh adversarial reviewer. Worktree `.claude/worktrees/agent-aec5814627adb9fd4`, branch `fr-a11-addresses`, head 35a517a (base 7b81976). Read in full: the common briefs, the findings with their probes (WB1 I4/M3/M4/M7, WB3 I1, WB5 M3), the task brief, the report, the review package (936 lines), R379 (the FR-A11 bullet), R389, R41 C1/I4, R99 I8, R96. Six probe files (`*.probeFRA11.test.ts`) were written, run alone at `nice -n 10`, and deleted. Guards were taken out one at a time and restored. At the end `git status --short` is empty.

## Verdict: APPROVED WITH SMALL POINTS — with one Important finding

All four points are built as the brief asked, and each is held by a test that fails without it. The original probes are closed. The one Important gap is in point 2. The shared word rule handles query parameters, but three very common carriers of a session id or access key in real addresses still get through. A session id written into the PATH (`;jsessionid=`) is kept: it is stored in `identifiers.url`, in the title, in the source's FOLDER NAME, in the change log and in the index. Short or run-together parameter names are also kept (`sid`, `pwd`, `authkey`, `accesstoken`, and others). R379's wording ("query parameters whose names are secret-like") is met to the letter. The brief named `jsessionid`, though, and its usual form in the wild is the path parameter.

## Spec

| Item | Status |
|---|---|
| P1: `classifyUrl` never throws; an undecodable handle gives the platform's `unknown` | ✅ The three probes give tiktok/youtube `unknown`. 5,000 random and structured inputs (lone surrogates, NULs, IDN, IPv6, `javascript:`, `data:`, malformed escapes after every platform prefix) plus 1 MB strings: no throw. |
| P1 tests: 30 strings, the screen's preview, the service's route, the downloader's list | ✅ All present. The core tests fail with `URIError` when `decodeHandle` and the outer try are removed. |
| P2: user name and password always dropped; secret-named parameters dropped; path and other parameters kept; tracking and fragment as before | ✅ for the query and the user information (`%40`-encoded user, user name alone, password alone). ❌ for path parameters (I1). |
| P2: ONE word rule, moved to core; html-strip imports it or a test keeps the two equal | ✅ Two copies (the worker has to stay self-contained, which is justified), and a test compares the two LISTS. The `words`/`secretName` FUNCTION is copied as well and is not compared (M5). |
| P2: the downloader's fetch | ✅ It fetches the cleaned address (R389 a). Probe: worker `submitted` = `https://www.youtube.com/watch?v=aoTest00001` and `https://www.youtube.com/feed/x`. A grep of the whole library folder (job journal, change log, sources, index, WAL) finds no `hunter2`, `SECRETTOKEN` or `SESS`. |
| P2: `key` and `code` | ✅ Kept, per R389 b (defensible; see below). |
| P2: service-support case with the token in `url`; the command line prints the cleaned address | ✅ |
| P3: blank legal basis and blank protocol number refused | ✅ Spaces, tabs, U+00A0, U+200B, U+3000, U+FEFF, bidi marks, U+2060 and U+00AD are all refused. Not refused: combining marks alone, U+2800, U+3164, U+115F (M3). |
| P4: attach refuses relative and NUL paths with the siblings' sentence; nothing read | ✅ |

## Findings

### Important

**I1 — Session ids and access keys that the word rule does not catch are still stored in a captured page's address, its title and its folder name.** `packages/core/src/capture/platforms.ts:70-78` (`stripTracking`), `packages/core/src/capture/secret-names.ts:12` (the word list), `packages/library/src/capture/browser-capture.ts:186` (the title is `hostname + pathname`).
Probe (`stored.probeFRA11`, deleted): `captureBrowserPage` in an unencrypted project, then a grep of the library folder:
- `https://forum.example.org/app;jsessionid=JSESSPATH1/viewtopic.php?t=2&sid=PHPBBSID1` leaves `JSESSPATH1` in `identifiers.url`, in the title, in the source's folder name (`Sources/2026-11-17 Unknown - forum.example.org-app;jsessionid=JSESSPATH1-viewtopic.php [mbj1]/`), in `changes/2026-11.jsonl` and in `library.sqlite-wal`. `PHPBBSID1` stays in `identifiers.url` and the change log.
- `https://us02web.zoom.us/j/8512345678?pwd=ZOOMPWD1` leaves `pwd=ZOOMPWD1` (a meeting passcode) in `source.json` and the change log.
- `https://onedrive.live.com/redir?resid=ABC&authkey=!ONEDRIVEKEY1` leaves the share key.

Names the rule KEEPS (core probe): `sid`, `sess`, `sessid`, `pwd`, `pass`, `passcode`, `authkey`, `accesstoken`, `authtoken`, `sessiontoken`, `apitoken`, `usertoken`, `sharetoken`, `CFID`/`CFTOKEN`, `ticket` (CAS), `oauth_verifier`, `csrfmiddlewaretoken`, `subscription-key`, `Key-Pair-Id`. It also keeps mixed-case repeats: `?Token=A&TOKEN=B&tOkEn=C` leaves `tOkEn=C`, because `nameWords("tOkEn")` gives `t ok en`. Cases this realistic matter here: phpBB forums put `sid=<32 hex>` in addresses (forum ethnography is a core use), Java portals and library catalogues put `;jsessionid=` in the path, and Zoom links carry `pwd=`. Browser capture exists for signed-in pages (`access: "signed-in-session"`). This breaks R379 point 2 in spirit, and the brief's list ("`jsessionid` … go").
Direction:
- Remove `;name=value` path parameters whose name is secret-like (at least `jsessionid`, `sid`, `phpsessid`), from the stored address and from the title.
- For short, ambiguous names (`sid`, `s`, `sess`, `pwd`, `pass`, `ticket`), drop the value only when it LOOKS like a secret: the value-shape rule `sessionLike` in `find/where.ts:102` already exists for this.
- Treat run-together compounds that end in `token`, `secret`, `password` or `sessionid` as secret (excluding `tokenizer` and the like).
- Compare names case-insensitively, deleting by the exact key seen.
- Add a test for each.

### Minor

**M1 — A parameter name that is a word in its own right is dropped, so two different pages get the same stored address, and nothing tells the researcher.**
- What happens: `session`, `signature`, `token(s)` and `auth` are dropped wherever they appear as a word. A conference programme's `?session=12`, ConfTool's `form_session=…`, a legislature's `?session=2023-24`, a corpus tool's `?token=…` and an archive's `?signature=<shelf mark>` all lose the parameter.
- What follows: browser capture has no duplicate check by address (every capture creates a new source). `?session=12` and `?session=13` become two sources with the identical stored address `…/programme.php`. Neither leads back to its page, and the given address is kept nowhere, so it cannot be recovered. Link capture refuses an `other` address anyway. The queues' running-address key (`queues.ts:63`) would treat two such platform-unknown links as one, but those are rare.
- Direction: the same value-shape rule as I1 for these word-names (drop `session=12` only when the value looks like a key), or record that a parameter was removed (`provenance.note`).

**M2 — Removing one parameter rewrites the rest of the query.** `platforms.ts:75`: `URLSearchParams.delete` re-serialises the whole query. Probe: `?print&ids=1,2,3&path=/a/b&q=a%20b&t=~x&token=T` becomes `?print=&ids=1%2C2%2C3&path=%2Fa%2Fb&q=a+b&t=%7Ex`. The same address without `token=` is left untouched. Some servers treat `?print` differently from `?print=`, or a literal `+` differently from `%20`. The deletion is also quadratic: 10,000 distinct secret-named parameters take about 9.7 s. The service caps addresses at 2048 characters, so this only bites on downloader output, which `snapshot.ts` `cleanUrl` passes through `classifyUrl`. This existed before for `utm_*` (about 9.3 s); the fix widens it. Direction: filter the raw `&`-separated pairs of `u.search` and keep the kept pairs byte for byte. That fixes the rewrite, the cost and the case problem in I1 at once.

**M3 — The blank rule is not applied where the library itself checks a legal basis, nor to the governance's other required texts.**
- `blank()` (`engine.ts:167`) is used only inside the engine. The library checks presence with `String.trim` (`link-capture.ts:455/464`, `profile-capture.ts:280/286/293`), and so does the screen (`Capture.tsx:558`). A legal basis of `"\u200b"` therefore:
  - satisfies the library's own rule that comments ("third-party personal data … always need a legal basis", `profile-capture.ts:293`) need a legal basis, in a project whose `requireLegalBasis` is false (by reading);
  - is refused as `POLICY_DENIED` instead of `LEGAL_BASIS_REQUIRED` in link capture, so the screen does not offer to ask for one.
- Probe (`blank.probeFRA11`): the `set-aside` and `review-withdrawal` reasons accept `"\u200b"` and a combining mark alone. The schema accepts an exception whose `by` is `"\u200b"` and whose `reason` is `""` (`schema.ts:88-89`).
- Combining marks alone, U+2800, U+3164 and U+115F also count as a value for the legal basis and the protocol number.
- Direction: export one `blank()` from core and use it in each of these places (consider `\p{M}` and the fillers too).

**M4 — The snapshot's own address cleaner keeps a user name and password.** `html-strip.mjs:54` `cleanUrl` removes the query and the fragment, but not `user:pass@`. Probe: `<link rel="canonical" href="https://ana:hunter2@portal.example.org/case/7?…">` is stored as `href="https://ana:hunter2@portal.example.org/case/7"` in the page snapshot. A page rarely embeds the reader's credentials, so this is Minor. It is, however, the one place in the stored record where `hunter2` survived the brief's probe. Direction: remove user information there too. `snapshot.ts:73` already does, through `u.host`.

**M5 — The two copies of the word rule are compared by their lists only.** `html-strip.mjs:40-51` has its own `words()` and `secretName()`, textually equal to core's `nameWords`/`secretName` today. The test (`html-strip.test.ts`, "one word rule") compares only `SECRET_WORDS` and `KEY_PREFIXES`; removing `bearer` from the copy fails it, which I checked. A change to the splitting regex in one copy would pass. `snapshot.ts` keeps a third, smaller list (the report defers this). Direction: compare `secretName` on a fixed table of names in both copies.

**M6 — The catch-alls fall back to the address as given.** `classifyUrl`'s outer catch (`platforms.ts:173`) returns `canonicalUrl: raw`, and `browser-capture.ts:195/205` stores `c.canonicalUrl || url.href`. Neither is reachable today for an http(s) address: nothing in `classify` throws, and `stripTracking` never returns "". But if either path is ever taken, the raw address with its secrets is stored. No test reaches the outer catch: removing it alone changes no test result. Direction: in the catch-all, return the cleaned form, or `""` for an http(s) input, and drop the `|| url.href` fallbacks.

**M7 — The attach route (like its siblings) treats `C:\…`, `c:/…` and `\\server\…` as absolute on macOS and Linux.**
- Probe (`attach.probeFRA11`):
  - The service still refuses each of these with 400 and the siblings' sentence: `package.json`, `~/x.pdf`, `./package.json`, a NUL, `file:///etc/hosts`, `""`, `[1]`, a string, `null`, `{}`, 501 paths, 100,000 paths and a 5,000-character path. The source list is unchanged after them.
  - It answers 200 to `C:\Windows\win.ini`, `c:/x.pdf` and `\\server\share\package.json`. On a POSIX host these are relative names, read from the service's working folder ("could not be found or read").
- This matches `governance.ts`, `fieldwork.ts`, `libraries.ts`, `import.ts` and `citations.ts`, so it is not a regression.
- Other routes take a path without a NUL check: `import.ts:48` (import path), `import.ts:206` (device import), `citations.ts:71/89` and `libraries.ts:131`. A folder dry-run with a NUL answered 200 with nothing found, not a 500.
- Direction: one shared helper using the host's `path.isAbsolute` plus the NUL check, in every route that takes a path.

**M8 — Addresses captured before this fix keep their secrets.** `source.json`, the index, and the append-only change log of earlier browser captures still hold `user:password@` and tokens. Nothing in the task scrubs them. **For the coordinator:** is a one-off rewrite of `identifiers.url` and `provenance.originalUrl` wanted? The change log cannot be rewritten.

## The implementer's doubts
- **What the downloader fetches** (R389 a, ruled): verified. The job's input and the journal hold only the cleaned address. The raw address survives only in memory: in the returned outcome (`download.url` in the browser-capture answer, the queue's items, `capture.progress` events). Nothing writes those to disk.
- **`snapshot.ts`'s third list** (deferred): real but minor. It is a subset of the shared list, so it strips less than it could (folded into M5).
- **Non-http inputs returned as given:** sound. Every caller that stores an address requires http(s). The command line echoes back only what the researcher typed.

## R389 b — a bare `key` and a bare `code`
Keeping both is defensible.
- Against keeping `key`: Google API keys (`?key=AIza…`) belong to API endpoints, not to pages a researcher captures.
- For keeping `key`: `key` is a document's identifier in older Google Sheets links, catalogues and many CMSs, and dropping it breaks the address.
- Against keeping `code`: an OAuth `code` is single use and expires in minutes.
- For keeping `code`: `code` is a course, product, country or classification code on many pages.

The stronger risks are those in I1.

## Checked and sound
- The three original probes. `classifyUrl("https://user:secret@example.com/a?token=abc")` now gives `https://example.com/a`.
- 5,000 fuzzed inputs (slowest 12 ms) and a 1 MB handle (25 ms): no throw.
- The preview (`previewLink`), the links-only route (now 400, as for an unrecognised path) and the downloader-output parsers all go through `classifyUrl`, which no longer throws. `decodeURIComponent` remains nowhere else on these paths.
- Through every entry point, `identifiers.url`, `provenance.originalUrl`, audit details, the change log, the index, the job journal and the downloader's input hold none of `ana:`, `hunter2`, `SECRETTOKEN` or `SESS` for the brief's probe address. The entry points were: browser capture, browser capture with the downloader (merged), link capture of a platform's unrecognised path, and the command line (by its test and by reading `output.ts`).
- Platform canonical forms are unchanged (YouTube `v=`/`list=`, playlists, TikTok, Instagram, short links).
- `%5F`-encoded names, a name with no value and a leading `;` are all handled.
- The html-strip list grew only by words that remove more (fails safe). The touched snapshot tests pass, apart from the two timing tests below.
- Guards and the tests that hold them (each guard removed, the test seen failing, the guard restored):
  - the `decodeHandle` and outer try: 30+ failures in core;
  - clearing `username`/`password`: 3 failures;
  - `secretName` in `stripTracking`: 21 failures;
  - `blank()` replaced by `trim`: both new engine tests fail;
  - `blank()` replaced by `!v`, separately for each of the two checks: each test fails;
  - the attach check: the new service test fails (`package.json` answered 200);
  - the html-strip list: the equality test fails.

## Could not verify
- Two timing tests in `html-strip.test.ts` (R107: "the pre-scan is linear …" at 1,452 ms against a 700 ms limit, and "at most 8 snapshots wait …") failed in two runs, at a load average of 34. The task's change to `html-strip.mjs` touches only the word lists, not the pre-scan or the worker pool. The implementer reports the library suite passed. They should be re-run on a quiet machine.
- The UI and the command line were not run beyond reading and the implementer's tests (UI capture tests, `output.test.ts`).
- Encrypted and locked projects were not probed for point 2. The address is cleaned before any store, so they are not expected to differ.
