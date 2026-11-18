# Task FR-A11 — second look, scoped to round 2 (R391)

Same reviewer as round 1. Worktree `.claude/worktrees/agent-aec5814627adb9fd4`, branch `fr-a11-addresses`, head 2970c03 (seven commits on 35a517a).

What I read:
- R391 in full;
- the round-2 section of the report;
- the changed modules in full: `secret-names.ts`, `key-shape.ts`, `blank.ts`, `platforms.ts` (`cleanPath`, `cleanQuery`, `stripTracking`, `cleanAddress`, `classifyUrl`), the `html-strip.mjs` copy and its `cleanUrl`, `local-path.ts` and each route that uses it, `merge.ts`, `engine.ts`, `link-capture.ts`, `profile-capture.ts` and `browser-capture.ts`;
- the new tests.

What I ran:
- Three probe files (`*.probeFRA11.test.ts`), each run alone at `nice -n 10` and deleted afterwards.
- Thirteen mutations: each guard was taken out, its test seen failing, and the guard put back. No `git stash` was used.
- One mutation made the route test write a file under `apps/library-service/C:\Windows\win.ini/`. I removed it (see M5).

At the end `git status --short` is empty.

## Verdict: APPROVED WITH SMALL POINTS — with one Important finding

Every clause (a)–(g) of R391 is built, and each is held by a test that fails without it. My round-1 probes for the stored address now pass. The Important point is next door to the round's change. Clause (d) touched the page snapshot's own address cleaner, which now drops the query, the fragment and the user information, but still keeps `;jsessionid=…` path parameters. A site that rewrites its addresses puts that id into every link, so the session id that I1 removed from the stored address is still written in the saved page, in every `href` and in the form's `action`.

## Per clause

**(a) Two classes of name, query and path parameters.**

Probe results:
- Path parameters, all dropped. `/app;jsessionid=JSESSPATH1/viewtopic.php` becomes `/app/viewtopic.php`. `;JSESSIONID=` goes too, and `;foo=bar` beside it is kept.
- Run-together names, all dropped: `accesstoken`, `authtoken`, `sessiontoken`, `authkey`.
- Ordinary names with a key-shaped value, all dropped: `sid=<32 hex>`, a 22-character mixed-case `pwd=…`, `usertoken`/`apitoken`/`tOkEn` with a hex value.
- A JWT-shaped value is dropped under any name (`?data=eyJ….….…`).
- R391's M1 examples are all KEPT, and their twins with key-shaped values are dropped:
  - `?session=12`, `?session=2023-24`, `form_session=7`;
  - `?token=verb`, `?signature=MS-123`;
  - `?code=CS101`, `?key=value`.
- `?token` and `?token=` are kept (an empty value is not "no value").
- `service-support` checks the stored address, the title and every file and folder name under the library.

Mutations, each failing a test:
- `cleanPath` made to return the path unchanged: 79 failures;
- the title taken from the raw path again: 1;
- `keyLikeValue` without judging runs of the value: 1.

What the value rule MISSES. These are allowed by R391, which fixes the rule as `sessionLike`:
- a UUID (`3f2504e0-4f89-11d3-9a0c-0305e82c3301`, in either case);
- a 32-character lower-case base32 or alphanumeric id;
- a 6- or 8-digit one-time code;
- a short base64 value (`Ab+c9/Zz12==`);
- a short Zoom `pwd`.

A percent-encoded value is judged after decoding, so it is not a miss.

What it DROPS that is honest, for ordinary names only (`?id=` keeps them all):
- a number of 19 or more digits;
- a long old-style Google Sheets `?key=0Ak…` or a Google document id;
- a SHA-1 or a 16-digit hexadecimal value under `hash` or `code`;
- a base64 page state;
- a mixed-case title with digits, such as `?key=TheQuickBrownFox2023Report`.

Names judged without a value (the snapshot) now drop:
- `data-key`, `data-code`, `data-hash`, `data-session`, `data-token`, `data-sid`;
- any attribute whose JSON value holds such a key (for example `data-props='{"key":…}'`);
- the whole `<input name="code">`.

Words that merely contain them are not touched: `keywords`, `keyboard`, `hashtag`, `passage`, `codec`, `passport`. In a static, sandboxed copy with no scripts, the only visible loss is form fields with those names. This fails safe, and I accept it. For an address, `?token` with no value is kept, which is right because there is nothing to leak.

**(b) The query as written, in one pass.** The kept pairs come back byte for byte (`?print&ids=1,2,3&path=/a/b&q=a%20b&t=~x`). Counting by doubling: 10,000 to 20,000 parameters took 1.1× to 2.2× as long over three runs; 10,000 to 20,000 path segments took 0.6×; a name of 5,000 to 10,000 words took 2.2×. All three are linear. The old rule needed about 9.7 s for 10,000. The test that holds this measures wall-clock time (M6).

**(c) One `blank()`.** I put each of 20 values through each place: space, tab and newline, U+00A0, U+200B, U+3000, U+FEFF, U+200E, U+202E, two combining marks, U+034F, U+2800, U+3164, U+115F, U+00AD, U+2060, U+FE0F, a tag character, U+00A0 followed by a combining mark, "e" followed by a combining mark, and ".".
- Legal basis, protocol number, the set-aside reason and the withdrawal-review reason: every blank value is refused. "e" with a combining mark and "." pass.
- Library: `link-capture` and `profile-capture` now use `nonBlank`. Mutation results:
  - each reverted alone: 1 failure each;
  - `merge` with the approver check removed: 1 failure;
  - the engine's set-aside back to `trim()`: 1 failure;
  - `\p{M}` taken out of `blank`: 3 failures.
- Exceptions: one whose reason or approver is invisible (U+200B, combining marks, fillers) is read and waives nothing. An approver of ordinary white space (space, U+00A0, U+3000, U+FEFF) still makes the file UNREADABLE through the schema's own `trim()` check (M3).

**(d) The snapshot drops user information.**
- `//ana:pw@`, a leading space, `HTTPS://`, `srcset` and CSS `url()` are all cleaned.
- `https://x.org/a@b` and `mailto:` are left alone, as they should be.
- Removing the guard fails 2 tests.
- Gaps: the path parameters (I1), and two forms browsers normalise (M2).

**(e) Two copies on one table.** Changing the copy's splitting back to `[\s_.:-]` fails 3 rows. The implementer showed the core side fails 1 row.

**(f) The catch-alls.**
- `classifyUrl`'s catch returns `cleanAddress`; reverting it fails 2 tests in `platforms-catch.test.ts`.
- `browser-capture`'s `|| cleanAddress(url.href)`; reverting it fails 1 test in `browser-capture-fallback.test.ts`.
- `cleanAddress("ftp://ana:pw@x/a;jsessionid=1?t=2")` gives `ftp://x/a`.
- Two branches that are not catch-alls still give the input as given (M4).

**(g) One path helper.**
- `isLocalAbsolutePath` uses the host's own `isAbsolute`, requires a non-empty string, and refuses a NUL.
- It is used at `sources.ts:295`, `governance.ts:122`, `fieldwork.ts:105`, `import.ts:48/59/112/216`, `citations.ts:71/89`, `fonts.ts:119` and `libraries.ts:65/131`. That covers every route that takes a path in its body, the `approveOutside` lists of both the dry run and the import included.
- No route takes a path in its query. The watched-folders routes refuse path keys outright. `zotero.ts` only reads paths taken from Zotero's own preference file, through `localDataDir`.
- The test tries `C:\Windows\win.ini`, `c:/x.pdf`, `\\server\share\package.json`, `package.json` and a NUL on each route. Swapping back to the old regular expression fails 8 tests.

**Duplicates and identity.** Fewer parameters are dropped now, so `?session=12` and `?session=13` stay distinct. Collisions remain only for ordinary names whose value is key-shaped: two old Google Sheets `…/ccc?key=0Ak…` links, or `?hash=<sha1>` pages, become one dead address. Browser capture still makes a separate source each time, so nothing is merged; the address just no longer leads to the page. This is accepted by R391; it is listed as M1.

## Findings

### Important

**I1 — The page snapshot keeps `;jsessionid=…` path parameters in every link.** `packages/library/src/capture/html-strip.mjs:104` (`cleanUrl`) cuts at `?` and `#` and removes user information, but never looks at path parameters.
Probe (`stripHtml`, deleted): a page with
- `<link rel="canonical" href="https://…/app;jsessionid=JSESSHTML1/case">`,
- `<meta property="og:url" content="…/a;jsessionid=JSESSMETA">`,
- `<a href="/app;jsessionid=JSESSLINK1/next">`,
- `<form action="/login;jsessionid=JSESSFORM1">`

keeps all four ids. This is exactly the case R391 a names. Sites that rewrite their addresses put the id into every link of the page, so the snapshot of the page captured in I1's probe holds the id that the stored address no longer holds. The snapshot is plain text in an unencrypted project.
Smallest fix: in `cleanUrl`, after the cut, remove each `;name=value` path parameter whose name the copied `secretName(name, value)` flags (the same logic as core's `cleanPath`). Add a test with the four forms, and a row in the shared table.

### Minor

**M1 — The value rule misses common token shapes and drops some honest ids (needs the coordinator's ruling).** `key-shape.ts` (`keyLikeValue`). It misses a UUID (the usual form of a password-reset, invitation or magic-link `?token=`), a lower-case alphanumeric id of 24 to 32 characters, and a numeric one-time code `?code=482913`. It drops `?key=<old Sheets id>`, `?code=<19 digits>` and `?hash=<sha1>`. All of this follows from R391's choice of `sessionLike`. If the coordinator wants UUID tokens caught, the smallest change is a UUID shape for ORDINARY names only, in `keyLikeValue`, leaving `sessionLike` for Find unchanged.

**M2 — The snapshot's cleaner keeps user information in two forms a browser normalises.** `html-strip.mjs:104`: `href="h\tttps://ana:TABPW@x.org/"` and `href="https:\\ana:BSPW@x.org/"` keep the password. A browser reads both as `https://ana:…@`. Smallest fix: before matching, remove tab, CR and LF (already done in `compact`) and read `\` as `/`.

**M3 — Two legal-basis readers still trim instead of using `blank()`, and the schema treats a blank approver two ways.**
- `browser-capture.ts:184` and `import/common.ts:78` read a legal basis with `trim()`. In a project that does not require one, `"\u200b"` is stored as `provenance.legal.basis` and shown as a basis. Where one is required, the engine refuses it. Smallest fix: use `nonBlank` at both places.
- `schema.ts:89`: an exception approver of spaces, U+00A0, U+3000 or U+FEFF makes the rules file UNREADABLE, while U+200B or a filler is read and waives nothing. Both fail closed, but the researcher meets two different results for the same mistake. Smallest fix: let the schema accept it, so that `effectivePolicy` ignores it as R391 c says, or refuse every `blank()` value there.

**M4 — `classify` still returns the input as given for a non-http or unreadable input.** `platforms.ts:241/243`. The command line's `safeUrl` prints that value, so `ftp://ana:pw@x/?token=T` is echoed with its password into `--json` output. No stored address is affected. Smallest fix: return `cleanAddress(raw)` in both branches (it is safe for every scheme).

**M5 — When the path guard is missing, its test writes into the repository.** `fieldwork-governance.test.ts:370` sends `/bibliography` with `dest: "C:\Windows\win.ini"`. Without the guard, the service creates `apps/library-service/C:\Windows\win.ini/…bibliography….txt` in its working folder. This happened during my mutation run, as it did for the implementer, and I removed it. Smallest fix: run that request with a destination under the test's temporary folder that is relative only by its drive form, or chdir to `tmp` for the describe.

**M6 — The one-pass test measures time.** `platforms.test.ts` "10,000 parameters … well under a second" failed once in the implementer's full run (1,320 ms at load 36). Smallest fix: assert linear work instead, for example by comparing 10,000 and 20,000 parameters, or count calls through a spy on `secretName`. Alternatively, raise the bound well above the old 9.7 s, so that it still catches the quadratic rule.

## Checked and sound
- Costs grow linearly: in parameters, in path segments, and in the words of a name. `nameClass` makes at most 4 runs per word plus one whole join.
- `%3B`-encoded path parameters are kept, which is negligible because browsers do not encode `;` in paths.
- The fallback regular expression in `cleanAddress` removes user information before cutting, and the function never throws (each branch reached by the stub tests).
- The routes that take a path were checked one by one. The library's set-aside and withdrawal-review refusals reuse the engine's sentence.
- `where.ts` now imports `sessionLike` from core, and the moved patterns are verbatim.

## Could not verify
- macOS (`path.isAbsolute`; the same POSIX function) and Windows. On Windows, `win32.isAbsolute` accepts `\\server\share\x` and a rooted `\x` with no drive, so the helper would need a network-path refusal if Windows ever becomes a target.
- Time limits under the current load (35–50). I judged cost by doubling, as asked.
