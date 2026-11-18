# Task FR-A11: report (addresses and two blank values, Ruling R379)

Branch `fr-a11-addresses`, head `35a517a`. There are four commits, one per point, and `git status --short` is empty.

## Point 1 (WB1 I4): `classifyUrl` never throws (commit 47f75d1)
- `packages/core/src/capture/platforms.ts`: a new `decodeHandle` helper wraps `decodeURIComponent` in a try. When a YouTube `@handle` cannot be decoded, the address falls through to YouTube's `unknown`. When a TikTok `@handle` cannot be decoded, the function returns TikTok's `unknown`. `classifyUrl` now trims the input and calls the inner `classify` inside a try. On any unexpected error it returns `{platform:"other", kind:"unknown", canonicalUrl: raw}`, which is what it already returned for an input that cannot be read as an address.
- Tests, each seen failing first with `URIError` (or a 500) and passing after the fix:
  - core `platforms.test.ts` has the three probes, a table of 30 malformed strings, and non-string inputs.
  - UI `src/api/capture.test.ts` checks that `previewLink` does not throw on the same kind of input.
  - Service `capture-queues.test.ts`: `/capture/browser/links` answers the same 400 for an undecodable handle as for an unrecognised TikTok path (before the fix it answered 500).
  - Library `profile-capture.test.ts`: `readEnumeration` given a listing with one bad entry address still parses the other entries.
  - Library `link-capture.test.ts`: `stripSnapshot` handles addresses that cannot be decoded.

## Point 2 (WB3 I1, WB1 M7): no credentials or secret parameters in a stored address (commit 35a517a)
- New file `packages/core/src/capture/secret-names.ts` holds `SECRET_WORDS`, `KEY_PREFIXES`, `nameWords` and `secretName`, exported from `@ao/core`. This is the rule from `html-strip.mjs`. I chose it because it works on names; `sessionLike` in `find/where.ts` looks at the shape of a value, so it does not fit parameter names.
  - The new word list is html-strip's list, plus the extra words in `snapshot.ts` (bearer, authentication, accesskey, privatekey, secretkey), plus two words I added: **phpsessid** and **jsessionid**. The old rule did not catch those two, because each is one word.
- `platforms.ts` `stripTracking` is the one function that builds the stored address. It now always clears the user name and password, and drops every query parameter that is a tracking parameter or that `secretName` flags. The fragment still goes. The path and every other parameter stay, in their order. Platform links in their canonical form do not change.
- `html-strip.mjs` has to stay self-contained: it runs as plain JavaScript in a `worker_threads` Worker, and in source mode it cannot load `@ao/core`'s `.ts` files. Its two lists are now exported (and declared in `.d.mts`). They match core's, and a test in `html-strip.test.ts` compares them. The cleaner's own list grew by bearer, authentication, phpsessid, jsessionid, accesskey, privatekey and secretkey. That only removes more, so it fails safe.
- What the rule does with a bare `key` and a bare `code`: it **keeps** both. `key` counts as secret only directly after api, access, private or secret. A bare `key` and `code` far more often name a record, a document (for example a sheet's `key`) or a country, and dropping them would break the address. The cost is that a Google-style `?key=<API key>` would be kept.
- Tests, each seen failing first:
  - core `platforms.test.ts`: the probe; `?id=7&page=2&lang=en` survives; 18 secret parameter names are dropped (Signature, X-Amz-Signature, X-Amz-Credential, X-Amz-Security-Token, sig, token, auth, apikey, api_key, sessionid, PHPSESSID, jsessionid, access_token, id_token, refresh_token, password, client_secret, AWSAccessKeyId); `key` and `code` are kept; user information is dropped on each platform's unrecognised paths; platform addresses are unchanged.
  - core `secret-names.test.ts` is new.
  - library `service-support.test.ts`: a new case after the existing one (about :369) sends the probe through `captureBrowserPage` and checks that `identifiers.url`, `provenance.originalUrl`, the record and the audit events contain none of `ana`, `hunter2`, `SECRETTOKEN`, `SESS` or `frag`. It also covers a token in `url` itself.
  - library `html-strip.test.ts`: the list-equality test.
  - CLI: new file `src/output.test.ts` checks that `safeUrl` and `itemView` print the cleaned address.
- **Needs a ruling (what the downloader fetches):** the downloader fetches `c.canonicalUrl` (`packages/library/src/capture/link-capture.ts:349`, `download()`; profile listings use the same value at `profile-capture.ts:179`). It already did this before this fix, so it was never the exact address the researcher gave.
  - For recognised platform links the address is rebuilt from the post id, and this fix does not change it.
  - Only an unrecognised path on YouTube, Instagram or TikTok that carries a user name or secret-named parameters is now fetched without them.
  - I did not switch the fetch to the raw address, because the job's input is written to `<Project>/jobs/journal.jsonl`, which is plain text in an unencrypted project. Fetching the raw address would put the token into a stored file.
  - Browser capture fetches nothing: the page comes from the extension. With `alsoDownload`, it hands `url.href` to link capture, which then works as described above.
  - Please rule on whether the raw address should be fetched anyway.

## Point 3 (WB1 M3, M4): a blank value does not satisfy a rule that requires one (commit ac049b4)
- `packages/core/src/governance/engine.ts` has a new `blank()` helper: a value is blank if it is absent or holds only `[\s\p{Cf}]`. A plain `trim()` does not remove a zero-width space, which the brief requires, so the check uses this pattern.
- `blank()` is applied to `protocol.number` under `requireBeforeCapture` and to `store.legalBasis` under `requireLegalBasis`.
- Tests in `engine.test.ts`, seen failing first: a space, `"\t\n"`, a no-break space, a zero-width space and a mixture of them are refused with the existing sentences. A real value with spaces around it passes.

## Point 4 (WB5 M3): the attach route takes only absolute paths (commit dc50ccd)
- `apps/library-service/src/routes/sources.ts` now runs the same `isAbsolute` and NUL check as `governance.ts:122` and returns the same sentence, `"paths" must be absolute paths.`. Each sibling route defines its own local `isAbsolute`; there is no shared helper, so I added the same local definition here.
- Test in `fieldwork-governance.test.ts`, seen failing first (`package.json` was answered 200): `["package.json"]`, `["../../etc/hosts"]`, a path holding a NUL, and an absolute path mixed with a relative one all get 400 with that sentence, no `items`, and an unchanged source list. The tests run from the service's folder, so before the fix `package.json` was actually opened and sniffed; the 400 now comes before the library is called. An absolute path still gives 200.

## Runs (`nice -n 10`, all on head 35a517a with a clean tree)
- The touched test files passed one by one during the work (core capture 204/204, engine 135/135, and the others).
- `pnpm -r typecheck`: exit 0, no errors.
- core whole suite (`vitest run`; the package has no `test` script): 15 files, 755 passed.
- library: 106 files passed, 1 skipped; 3704 tests passed, 22 skipped.
- library-service: 40 files; 1027 passed, 1 skipped.
- cli: 6 files; 62 passed, 15 skipped (they need the media worker's Python environment, which this worktree does not have).
- ui `src/screens/Capture.test.tsx src/api`: 8 files, 164 passed.
- About how these runs were made: the full suites and the typecheck ran as one chained background command at `nice -n 10`. It finished with exit 0 (all logs end in `exit 0`) before the coordinator's message that called them lost; the core suite was re-run in the foreground. I did not run them again, because no commit and no file changed after them. Logs are in the scratchpad: `fra11-{tc,lib,svc,cli,ui}.log`.

## What only a real Mac or a real service can show
Whether a real signed-in site's page still opens from the cleaned address. The tests only show that the path and the non-secret parameters stay.

## Deferred
- minor (deferred): `packages/library/src/capture/snapshot.ts` still has its own `SECRET_WORDS` and `KEY_PREFIXES` for the keys of the downloader's JSON. It is a subset of the shared list, and moving it onto core's rule is outside this brief.
- minor (deferred): for an input that is not http or https (for example `ftp://u:p@x`) or cannot be read, `classifyUrl` still returns the input as given, as it did before. Every place that stores an address only accepts http(s) addresses.

## Round 2 (R391)

Implementer of round 2 (fresh). Branch `fr-a11-addresses`, base 35a517a. Commits: ed5514e (a, and b's one-pass rewrite), 0debbfa (c), bdddeb0 (d), 505662f (e), 69778e7 (f), 6e54dcc (g), 2970c03 (b: speed of the rule). Every new test was seen failing first for the right reason, except the blank() unit test and the M5 table (see those points).

### (a) I1 + M1: two classes of secret name, in the query and in path parameters (ed5514e)
- `packages/core/src/capture/secret-names.ts` (rewritten): `nameWords` splits at every character that is not a letter or digit (`\p{L}\p{N}`) and at camel case, lower-cased. `nameClass` looks at each word and at each run of up to 4 consecutive words joined, plus the whole name joined, so `access_token`, `accessToken`, `accesstoken` and `tOkEn` (→ `token`) all count.
  - **Always** (`SECRET_WORDS`, `TOKEN_PREFIXES`+token, `KEY_PREFIXES`+key with `auth` added, `SIGNED_LINK_NAMES` = xamzsignature/xamzcredential/xamzsecuritytoken/keypairid, and a run ending in secret/password/passwd/sessionid/passcode/credential(s) or in one of the compounds): password, passwd, secret, jsessionid, phpsessid, sessionid, csrf, xsrf, authorization, authentication, authenticity, bearer, nonce, otp, jwt, credential(s), passcode, apikey, accesskey, privatekey, secretkey, authkey, clientsecret, cookie(s). From the old list, token, tokens, auth, session, signature and sig moved to the ordinary class.
  - **Ordinary** (`ORDINARY_WORDS` and a run ending in `token`/`tokens`): token, tokens, auth, session, sid, signature, sig, pwd, pass, key, code, hash, ticket. I added **sess, sessid, cfid, verifier** so that every name the review's I1 lists is dropped when its value is a key (`usertoken`, `sharetoken`, `apitoken`, `cftoken`, `csrfmiddlewaretoken` go through the `…token` ending). These go only when the value looks like a key.
  - `secretName(name, value?)`: a value with the shape of a signed token is a secret whatever its name. An ordinary name with **no value given** counts as a secret (unknown counts as secret). The snapshot cleaner judges attribute, field and JSON-key names that way, so it drops at least as much as before. It now also drops `data-key`, `data-code`, `data-hash`, `<input name="code">` and the like; that is harmless in a static, sandboxed copy, but it is new.
- `packages/core/src/capture/key-shape.ts` (new): `HEX_KEY`, `MIXED_KEY`, `ASPNET_KEY` and `sessionLike`, moved verbatim from `packages/library/src/find/where.ts`. `where.ts` now imports `sessionLike` from `@ao/core`, and its tests stay green. `keyLikeValue(v)` = `sessionLike(v)`, or `sessionLike` of any run of `[A-Za-z0-9_-]` once `v` is split at the other characters. This mirrors how `where.ts` applies the rule to each `/` segment of a path. It is needed for an OAuth `4/0AX4…` and for a CloudFront `Signature` containing `~`. `signedTokenValue`: `^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`.
- **What "looks like a key" accepts.** 16 or more hexadecimal digits alone; or 20 or more of `[A-Za-z0-9_-]` holding a lower-case letter, a capital and a digit; or ASP.NET's `(X(…)…)` form; tested on the whole decoded value or on any run of it. Values are percent-decoded first, and `+` is read as a space in a query.
  - Accepted (10): `0123456789abcdef`, `5f2b8c9e0a1d4e7f9b3c6a8d2e1f0b7c`, `DEADBEEFDEADBEEF`, `1234567890123456`, `aB3dE5fG7hJ9kL1mN3pQ`, `AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY`, `4/0AX4XfWhAbCdEfGhIjKlMnOpQrStUvWxYz0123456789`, `(S(lit3py55t21z5v55vlm25s55))`, `(A(Bx12)S(abc))`, `Nql641NHEU…~SYeUSoBJ…`.
  - Refused (10): `12`, `2023-24`, `verb`, `MS-123`, `CS101`, `value`, `ZOOMPWD1`, `zzzz…`(28), `Conference-Session-Number-Twelve`, `123456789012345` (15 digits), and also `abcdefABCDEF-ghijkl_mnop` (it has no digit).
  - Note: a number of 16 or more digits counts as a key (it is all hexadecimal), so `?code=1234567890123456` is dropped. That is the existing rule.
- `packages/core/src/capture/platforms.ts` `stripTracking`: rebuilt as `protocol//host + cleanPath + cleanQuery`, with no user information and no fragment.
  - `cleanPath` removes the secret `;name=value` parts of each segment and keeps the rest of the path as written.
  - `cleanQuery` is one pass over the raw `&` parts and keeps the rest byte for byte (point b).
- `packages/library/src/capture/browser-capture.ts` (~:187): the title comes from the cleaned address's host and path, so a `;jsessionid=…` no longer reaches the title or the folder name.
- `html-strip.mjs`: its copy follows. The list-equality test in `html-strip.test.ts` now covers all five lists.
- Tests: core `platforms.test.ts` (new describes R391 a and R391 b); core `secret-names.test.ts`; library `service-support.test.ts` (new: a path `jsessionid`, `;Sid=<hex>` and `sid=<hex>` through browser capture; checks the stored address, the title and every file and folder name under the library, the record and the audit).
- **Round-1 and earlier tests whose expectation R391 changes** (each now uses a key-shaped value in place of a short one, or adds value-judged cases):
  - core `platforms.test.ts`: "ordinary parameters stay…" (`token=T0K`); "the parameter %s goes" (`S3CR3T`); "a user name alone goes too…" (`token=T`, `sig=S`).
  - core `secret-names.test.ts`: "%s is not" (key, code and extractor_key moved to a new value-judged test); "the lists are what they say" (KEY_PREFIXES now includes `auth`).
  - library `service-support.test.ts`: "browser capture strips scripts…" (`token=SECRETTOKEN`); "browser capture stores the page's address…" (`SECRETTOKEN2/3`).
  - The round-1 "a bare `key` and a bare `code` stay" passes unchanged, since `key=abc&code=FR` is not key-shaped.

### (b) M2: the query is otherwise left as written (ed5514e; 2970c03)
- One pass over the raw query. The review's probe holds byte for byte: `?print&ids=1,2,3&path=/a/b&q=a%20b&t=~x`.
- 10,000 parameters, bound 1000 ms: in two runs alone at load ~47 it measured 330–560 ms. It **failed once (1,320 ms) inside the full core run** at load ~36. The rule before this round took about 9.7 s.
- 2970c03 makes the rule cheaper (one pattern for the endings; camel-case splitting only when there is a capital), with the same answers, which the table test confirms.
- (b) has no separate fix commit: the one-pass rewrite was the means of judging path parameters and values in (a).
- Tracking parameters go the same way.

### (c) M3: one `blank()` (0debbfa)
- `packages/core/src/blank.ts` (new, exported with `nonBlank`): `^[\s\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}\u2800\u3164\u115F\u1160\uFFA0]*$`, or not a string.
- Engine: legal basis, protocol number, and now the set-aside and withdrawal-review reasons (previously `trim() === ""`).
- `merge.ts` `effectivePolicy`: an exception waives nothing when its reason **or** approver is blank, the same as an empty reason today. No warning is added, since none exists today for an empty reason. The schema's own `by` check (`trim() !== ""`) is unchanged, so a blank-looking `by` does not make the file unreadable.
- Library: `link-capture.ts:455` and `profile-capture.ts:281` use `nonBlank`, so `"\u200b"` gives LEGAL_BASIS_REQUIRED, and the comments rule (`:293`) sees no legal basis.
- Set-aside and withdrawal-review: the library already passes the reason to the engine, which now refuses it with the same sentence. The service's and the screen's checks are left as they are.
- Tests, each seen failing first: engine (fillers and combining marks for the legal basis and protocol number; the two reasons), merge (blank reason or approver waives nothing; the file is still read), library `link-capture.test.ts` (new), `profile-capture.test.ts` (the comments case extended), `attention.test.ts` and `review-resolution.test.ts` (invisible reasons added to the existing loops).
- `blank.test.ts` was written just after the module; its callers' tests failed first.

### (d) M4 (bdddeb0)
- `html-strip.mjs` `cleanUrl` removes `user[:pass]@` from the authority after the query and fragment are cut. The review's probe (a canonical link) and six forms are tested; the tests failed first.

### (e) M5 (505662f)
- `html-strip.test.ts`: a table of 63 [name, value, expected] rows goes through both `secretName` functions.
- The copy must stay self-contained: it runs as plain JavaScript in a `worker_threads` Worker, where `@ao/core`'s TypeScript source cannot be loaded.
- The first table passed even when either copy's splitting was changed, so I added rows (`access~token`, `api[key]`, `session/id`, `api2Key`, `page2Token`). Now changing html-strip's split back to `[\s_.:-]` fails 3 rows, and dropping the digit from core's camel-case split fails 1 row. Both changes were reverted.

### (f) M6 (69778e7)
- `platforms.ts` `cleanAddress` (exported): the cleaned form when it can be made; otherwise the address without `user:pass@` (removed first, since a password may hold `;`), cut at the first `?`, `#` or `;`.
- `classifyUrl`'s outer catch returns it. `browser-capture.ts:197/208` now use `c.canonicalUrl || cleanAddress(url.href)`.
- Tests, both failing first:
  - core `platforms-catch.test.ts` stubs `./secret-names.js` so that the classifier throws (once: the cleaned form; always: the cut-short form);
  - library `browser-capture-fallback.test.ts` stubs `./platforms.js` to give an empty canonical address.

### (g) M7 (6e54dcc)
- `apps/library-service/src/routes/local-path.ts` `isLocalAbsolutePath`: the host's `path.isAbsolute`, a non-empty string, no NUL.
- Used by every route that takes a path, each keeping its own sentence:
  - `POST /projects/:id/attach` (sources.ts);
  - `POST /projects/:id/protocol/documents` (governance.ts);
  - `POST /projects/:id/consents/:fid/document` (fieldwork.ts);
  - `POST /projects/:id/import/dry-run`: `adapter.path`/`dataDir`, and `approveOutside.folders/files`, which are new checks with the sentence `"approveOutside" must hold absolute paths.`;
  - `POST /projects/:id/import`: `adapter.path`/`dataDir`, and `options.approveOutside.folders/files/rememberFolders`, also new;
  - `POST /projects/:id/device-import` `dir`;
  - `POST /bibliography` `dest` and `POST /export/refman` `outputPath` (citations.ts);
  - `POST /settings/fonts` `path`, which had no NUL check before;
  - `POST /libraries`, `/libraries/open`, `/libraries/reconnect`, `/libraries/move/plan`, `/libraries/move` (`absPath`), and `/libraries/locate` `roots`.
- No route takes a path in its query. Watched folders refuse path keys outright.
- Tests (`fieldwork-governance.test.ts`, new describe): `C:\Windows\win.ini`, `c:/x.pdf`, `\\server\share\package.json`, `package.json` and `/tmp/x\0.pdf` get 400 on each route listed. All failed first.
  - Seen while they failed: `/bibliography` with `dest: "C:\Windows\win.ini"` **wrote a file** under `apps/library-service/C:\Windows\win.ini/`. I removed it.
- Only Linux was run. On a Mac `path.isAbsolute` is the same POSIX rule; on Windows it would be win32's.

### Note on `git stash`
- Before the coordinator's note, I used `git stash push <paths>` and then `git stash pop` twice (core address files; `engine.ts`) to see tests fail against the old code. Each pop came straight after its push, and both restored exactly my files (the tests that followed passed with my changes). The stash list is now empty.

### Runs (`nice -n 10`, load 35–50 throughout)
Logs are `fra11-r2-*.log` in the scratchpad. All on head 2970c03, except where noted.
- `pnpm -r typecheck`: exit 0 (run at 6e54dcc; 2970c03 only changed function bodies, and core and library typecheck passed after it).
- **Core**, all of `vitest run`: 897 passed, 5 failed. The failures were the 10,000-parameter test (1,320 ms, at 6e54dcc) and 4 citation-rendering timeouts (5 s). Re-run alone (`platforms.test.ts` + `src/citation`, at 2970c03): 296 passed, 0 failed.
- **Service** (`test`): 1,031 passed, 1 skipped, 4 failed. Three were 60 s timeouts (media 8-hour stream, recovery-code rate limit, server R111). The fourth was find-browser R348 d: "Ready in 18 seconds" against "Ready in 20 seconds", wall-clock drift. Re-run alone: 193 passed; R348 d failed again the same way. It is a timing issue; none of these routes was touched.
- **Command line**: 62 passed, 15 skipped (no Python environment).
- **UI** `Capture.test.tsx src/api`: 163 passed, 1 failed (SSE "many small chunks … linear time"). It failed again alone. I did not touch the UI.
- **Library** (`test`): 3,759 passed, 22 skipped, 14 failed. All are time or timeout limits in files I did not touch: refman (linear parsing), zotero-local floods, the zotero-sync network-drop test (a timeout), annotations-cap, transcript-segments, and three html-strip timing tests (5 MB adversarial, pre-scan linear, at most 8 waiting). Re-run alone: 13 still failed, the same timing set; load was 40–50 all along.
  - The html-strip "5 MB adversarial" test passes when run by itself: 5.4 s and 8.8 s with this round's `html-strip.mjs`, 5.9 s with the base 35a517a copy swapped in, against a 15 s limit. So the costlier name rule does not visibly slow it.
  - All of these need a quiet machine to confirm.
- `git status --short` is empty at the end.

### What only a real Mac or a real service can show
- `path.isAbsolute` on a real Mac. It is the same POSIX function, but it has not been run there.
- Whether real signed-in pages still open from the cleaned addresses.

### Minor (deferred)
- minor (deferred): `snapshot.ts` still has its own smaller word lists for the downloader's JSON keys (as in round 1).
- minor (deferred): the service's and the screen's own reason checks for set-aside and withdrawal-review still use `trim()`. The library refuses a blank reason with the same sentence.
- minor (deferred): a 16-or-more-digit number counts as a key under `sessionLike` (all digits are hexadecimal), so `?code=<16 digits>` is dropped.
- minor (deferred): the snapshot cleaner judges names without a value, so it now also drops `data-key`, `data-code` and similar attributes (that fails safe).

## Round 3 (R415)

Worktree `.claude/worktrees/agent-aec5814627adb9fd4`, branch `fr-a11-addresses`, 2970c03 → b552308 (7 commits: one per point; (f) is two, M5 and M6). No `git stash` was used. `git status --short` is empty at the end.

### (a) I1: the snapshot drops path parameters (b6e32db)
- `packages/library/src/capture/html-strip.mjs` `cleanUrl`: after the query/fragment cut and the user-information removal, every path segment loses everything from its first `;`.
  - The authority is left alone.
  - An address of a scheme with no `//` (`mailto:` …) is returned unchanged.
  - The module header comment is updated.
- Test, in `html-strip.test.ts` "R415 a": the review's probe page (canonical link, `og:url`, `<a href>`, form `action`, plus a `srcset`). None of them keeps `jsessionid` in the saved page. Plus `cleanUrl` unit rows.
- Failed first: both tests.

### (b) M1: the value's shape (d1551f8)
- Core: `packages/core/src/capture/key-shape.ts` `keyLikeValue` also returns true for:
  - a UUID anywhere in the value (`UUID_KEY`, either case);
  - a run of 24 or more `[a-z0-9]` holding both a letter and a digit (`lowerIdRun`).
- `sessionLike` (Find's rule) is unchanged.
- The `html-strip.mjs` copy changed identically.
- Tests:
  - `secret-names.test.ts` "R415 b": `sid=<uuid>` and a 32-character base32 value under `session` are dropped. `code=123456`, `session=12`, `key=value`, `token=verb` and `id=<uuid>` are kept.
  - `platforms.test.ts` "R415 b": the same cases through `classifyUrl`.
  - The two-copy table in `html-strip.test.ts` gains 9 rows.
- Failed first: yes, 9 core tests and 4 table rows.

### (c) M2: a browser's reading (62219e8)
- `cleanUrl` first removes TAB, CR and LF from the whole address.
- In an http(s) or scheme-less address, backslashes in the leading `//authority` become slashes.
- The authority (for user information and the path-parameter split) now ends at `/` or `\`. So `https:\\host\p@q` keeps its host.
- Tests in "R415 c":
  - the review's two strings (`h\tttps://ana:hunter2@host/p` → `https://host/p`; `https:\\ana:hunter2@host\p` → `https://host\p`);
  - CR/LF inside;
  - a scheme-less `\\`;
  - a saved page with both forms.
- Failed first: yes.
- Note: the brief writes `h\ttps`. As a JS string that is "htps"; the review's string `h\tttps` is used.

### (d) M3: the last two `trim()` checks; a blank approver (4710160)
- `browser-capture.ts:184`: `nonBlank(input.legalBasis)?.slice(0,2000) ?? nonBlank(policy default)`.
- `import/common.ts:78` (`storeInputs`): `nonBlank(...)`.
- `packages/core/src/governance/schema.ts` ExceptionSchema: `by` is now a plain required `z.string()`, as `reason` is.
  - A blank approver (spaces, U+00A0, U+3000, U+FEFF, U+200B, a filler) is read, and `effectivePolicy` (which already checks `blank(e.by)`) waives nothing.
  - So a blank `by` and a blank `reason` give one outcome, and the file is still readable.
- Tests:
  - new `packages/library/src/capture/browser-capture-legal.test.ts`: a U+200B basis in the request, and a U+200B project default. Neither is stored; a real basis is stored trimmed.
  - new `packages/library/src/import/common.test.ts`: `storeInputs` with U+200B, U+3164 or U+0301 gives no basis.
  - `merge.test.ts`: the blank-by test.
- Failed first: yes, all three blank cases.
- **Changed existing test:** `merge.test.ts` "exception shape › by must be non-blank" asserted that `by: "  "` makes the file unreadable. R415 d changes this. It is now "by is required; a blank one is read and waives nothing", and a missing `by` still throws.

### (e) M4: other schemes (4e1ee36)
- `platforms.ts` `classify`: for a parsed non-http(s) address, the new `withoutUser` clears the user name and password through the URL setters and returns `u.href`. It falls back to `cleanAddress` if they would not clear. Without user information, it returns the input as given.
- An unparseable input is still returned as given.
- Tests:
  - `platforms.test.ts` "R415 e": ftp, sftp and ssh lose their user information; plain words, `mailto:`, and ftp without credentials come back as given.
  - `apps/cli/src/output.test.ts` "R415 e": `itemView`/`safeUrl` and the JSON document of an ftp outcome hold no `ana`/`hunter2`.
- Failed first: yes, 4 core tests and the CLI test.
- Only user information is removed, as the brief says. An ftp query parameter such as `?token=T` stays.

### (f) M5 (755c42b), M6 (b552308)
- **M5:** the describe "every route that takes a path…" in `apps/library-service/src/fieldwork-governance.test.ts` now `chdir`s to the test's temporary folder (vitest 3 forks pool), and creates each foreign name there as a file. Mutation check: with the `/bibliography` `dest` guard disabled, the test fails (500 ≠ 400), and `git status` showed nothing written into the repository. The guard was restored.
- **M6:** new `packages/core/src/capture/platforms-onepass.test.ts` counts calls to `secretName` and the characters handed to it, by mocking `./secret-names.js`, for 10,000 and 20,000 parameters.
  - Calls are exactly 5,001 and 10,001, and the characters double exactly.
  - Mutation check: a cleaner that re-judges earlier parts fails it (254,401 ≠ 5,001).
- **Changed existing test:** `platforms.test.ts` "10,000 parameters are cleaned in one pass, well under a second" lost its wall-clock assertion, as R415 f orders. It keeps the result check.

### Runs (all at nice -n 10)
- **Core, whole suite:** 2 failed, 925 passed. Both failures are in `citation/citation.test.ts` (5 s timeouts, a file not touched). Alone: 44/44 passed.
- **`@ao/library` `src/capture src/import/common.test.ts src/service-support.test.ts`:** 289 passed, 2 skipped (8 files passed, 1 skipped).
  - An earlier single-file run of `html-strip.test.ts` failed the time-limit test "the pre-scan is linear" (R107; `prescan` does not call `cleanUrl`), both with the file and alone. The load was about 34. It passed in the full run above.
- **Service, whole suite:** 1 failed, 1034 passed, 1 skipped. The failure is `find-browser-routes.test.ts` "R348 d … the pause after a hand-over", a file not touched. Alone: 44/44 passed.
- **`pnpm --filter @ao/cli test`:** 63 passed, 15 skipped (they need the worker's Python environment).
- **`pnpm -r typecheck`:** exit 0, every package Done.

### Unsure / not proved
- The CLI "--json" check runs through `itemView` and the JSON document it feeds. The real `ao --json capture` tests need the media worker, which is absent here, so they skip.
- The snapshot's backslash handling leaves path backslashes as written. Only the scheme-and-host part is normalised, per the brief.
- minor (deferred): `\` in a snapshot path segment is not split for path parameters except as an end of segment (`/;[^/\\]*/`). This is harmless.
