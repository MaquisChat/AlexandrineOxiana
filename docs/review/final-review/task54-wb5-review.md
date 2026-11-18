# Task 54, whole-branch review — WB5: the service and the command line

Reviewer 5 of 7. Checkout `.claude/worktrees/agent-a0328b7cc1ec55b55` (branch `wb-review`, 7b81976). Paths below are relative to it.

## What I read

**End to end:** `apps/library-service/src/server.ts`, `auth.ts`, `errors.ts`, `media.ts`, `main.ts`, `startup-token.ts`, `file-grants.ts`, `streams.ts`, `routes/util.ts`, `routes/find-browser.ts`, `routes/libraries.ts`, `routes/governance.ts`, `routes/projects.ts`, `routes/capture.ts`, `routes/import.ts`, `routes/review.ts`, `routes/citations.ts`, `routes/transcription.ts`, `routes/jobs.ts`; `apps/cli/src/index.ts`, `errors.ts`, `session.ts`, `prompt.ts`, `output.ts`, `commands/common.ts`, `commands/secrets.ts`, `commands/project.ts`, `commands/library.ts`, `commands/export.ts`, `commands/maintenance.ts`, `commands/list.ts`.

**Sampled:** `state.ts` (requireSession/Writable, adopt, closeLibrary, shutdown, describe, move bookkeeping), `routes/your-library.ts` (the starts, the test route, the file-grant handler), `routes/documents.ts` (header), `routes/fonts.ts` (add/get/delete), `routes/fieldwork.ts` (consent document), `routes/sources.ts` (attach, transcripts), `routes/tools.ts` (jobs), `routes/search-settings.ts` (`registerSecretKey`), `routes/zotero.ts`, `commands/import.ts` (report printing), `commands/zotero.ts` (exit codes); on the other side of seams: `packages/ui/src/screens/MoveLibrary.tsx`, `packages/library/src/move.ts` (progress), `import/attach.ts` (`attachOne`), `repo/pending-writes.ts` (`resolvePendingWrite`), `import/bulk/report.ts` (`reportLabel`), `core/governance/schema.ts` (`parseGovernanceWithWarnings`).

**Probes** (both deleted; `git status` shows none of mine):
- `apps/library-service/src/open-race.probe-wb5.test.ts`: two `POST /libraries/open` of the same library at once (both 200, the library stays read-write, so that race held); `POST /projects/:id/attach` with relative paths.
- `apps/cli/src/esc.probe-wb5.test.ts`: `ao import` of a folder holding a file whose name carries terminal escape sequences.

## Findings

No Critical and no Important finding.

### Minor

**M1. `ao import` prints imported file names to the terminal raw, escape sequences included.** `apps/cli/src/commands/import.ts:182-183` (`failed  ${f.item}: …`, `note    ${f.item}: …`), fed by `packages/library/src/import/bulk/report.ts` `itemLabel` (a relative key comes back unchanged). Probe: a file named `a\x1b]0;PWNED\x07\x1b[2Jb.pdf` in an imported folder gives on stdout `failed  a\u001b]0;PWNED\u0007\u001b[2Jb.pdf: The file could not be read…`. The terminal acts on these sequences: it sets the window title, clears the screen, and some terminals act on OSC 52 (write the clipboard). A crafted name can therefore hide the import's failure lines. Folders imported for a study can hold files the researcher received from others. Source folder names are safe (`core/naming.ts` replaces C0/C1), so `ao list` and `ao recheck` are not affected; the import report, the dry-run summary lines and `--json`-less notes are. This breaks the standing rule against running outside text as markup. Direction: one function in `output.ts` that replaces C0/C1, bidi and other format characters in every value that came from outside before `out.line` or `out.progress` writes it, plus a test with an escape-named file. Not in the known list.

**M2. Live events carry raw error text, while the same error read again carries only its kind.** `state.ts:463, 947, 1625-1626` and `routes/capture.ts:274` publish `error: state.describe(err)`, which is `"${err.name}: ${err.message}"` with only the paths removed (`state.ts:556`). An unexpected `TypeError` therefore reaches the screen as `TypeError: Cannot read properties of undefined (reading …)`. Its message may also hold data. `toApiError` (`errors.ts:201-203`) refuses to echo exactly this. The capture registry keeps only `errorName` for the same queue (`packages/library/src/capture/queues.ts:97, 145`), so the event and a later read of the queue differ. This breaks R96 (errors in plain language). Direction: map events through `toApiError(err).message` (or the error's kind), and keep `describe` for the log only. Not in the known list.

**M3. `POST /projects/:id/attach` accepts relative paths, and they are read relative to the service's working directory.** `routes/sources.ts:286-296` checks `paths` only with `strArray`. Every other route that takes a path in its body refuses a non-absolute one or a NUL (`libraries.ts:63-67`, `governance.ts:122`, `fieldwork.ts:105`, `import.ts:48`, `fonts.ts:117`, `citations.ts:71, 89`). Probe: `{ paths: ["package.json", "../../etc/hosts"] }` → `package.json` was opened and type-sniffed from the service's cwd ("This kind of file cannot be attached…"). The other path was "could not be found or read". The library's in-library check (R362 c) still applies, so the harm is small, but the route accepts a path that no researcher chose (R96: a path in a body is checked). Direction: the same `isAbsolute` and NUL check as the sibling routes.

**M4. A move can stall without end when its client stays connected but stops reading.** `streams.ts:33-47`: `ndjsonWriter` waits for `drain` or `close`. `packages/library/src/move.ts:512-514` awaits `onProgress` on every progress step, and `routes/libraries.ts:214` passes the writer in. If the socket stays open but is not read, the move never goes on, while `state.moving` stays true. Every change in the library is then refused with 503 MOVE_IN_PROGRESS (`server.ts:299-302`), and the move cannot be started again (409). R102 N1 says "the move itself always runs to its end", but that holds only for a client that has gone. Only a holder of the UI token can cause this, and the screen aborts the stream when it closes, so this is Minor. Not probed (a socket that is not read is hard to make with `inject`). Direction: give the move's progress a write that is never awaited (drop lines past a buffer cap, as `sseWriter` does), or a time limit on each drain.

**M5. Long POSTs that change nothing count as "mutating" and hold up a move or a shutdown.** `server.ts:297-305` counts every non-GET request after its body is parsed. Two cases follow:
- `POST /find/browser/file/:ticket` hands the raw stream to its handler (`find-browser.ts:229`), so it is counted before its body arrives. It can last up to `FIND_BROWSER_TAKE_MS` (5 minutes) and writes only to the inbox, outside the library.
- `POST /libraries/locate` streams a search for minutes.

During either, `POST /libraries/move` waits 60 s and then refuses with 409 "Some changes are still being made" (`libraries.ts:195-198`). R108 wanted a slow upload not to hold up a move. Direction: do not count these two routes as mutating (route config), or count the upload only from the seam (v).

**M6. The token that confirms deleting the old copy is compared with `!==`.** `routes/libraries.ts:273` (`m.confirmToken !== token`). Every other secret is compared in constant time through `sameSecret` (R96). The token is local and single use, and expires after 15 minutes, so the risk is theoretical. Direction: `sameSecret`.

**M7. `GET /libraries/move/status` cannot say that a move is still running.** It answers `{ pending: null }` both while a move is running and when there is none (`routes/libraries.ts:265-268`). The screen therefore polls, up to 900 × 2 s (`MoveLibrary.tsx:59-80`), whether the move is running, has failed or never started. This is the service side of FR-166/167 (group B). I note it only because one field (`moving: true`) would let the screen tell the cases apart. I do not think the group is wrong.

**M8. A 32 MB browser capture has no limit on how many run at once.** `routes/capture.ts:398-422` limits each body to 32 MB, but neither the route nor the extension's token limits concurrency. The link lists are limited (`LINK_QUEUES_PER_EXTENSION`); this route is not. Each request is parsed as one JSON string, the base64 screenshot is then decoded, and the sidecar runs with a 512 MB heap (R64). A few requests at once from a paired extension (a bug, or several open windows) can exhaust the heap and crash the service. Writes are crash-safe through the txn marker, so this costs availability, not data. Direction: one browser capture at a time per pairing (429 otherwise), as for link lists.

## The specific checks

**1. Is EVERY route behind the token and the Host/Origin checks, or deliberately not?** Yes. All of it is in one `onRequest` hook (`server.ts:204-292`), which runs before routing reaches any handler, the not-found answer included.
- **Host:** checked for every request, media included (`server.ts:215`).
- **Origin:** a request that carries one must come from the shell, from a paired extension, or from any extension origin, the last only for the pairing-confirm route and its preflight (`server.ts:232`).
- **Credentials:** credential-named query keys are refused (`server.ts:259`); the bearer token is compared in constant time (`auth.ts:28`).
- **Extension token:** limited to `EXTENSION_ROUTES` (`server.ts:121`) from its own Origin; only `GET /projects` may come without an Origin (`server.ts:128, 279`, R111). The auto-made `HEAD /projects` is not in the list, so it is refused to the extension.

Reached without a token, by design:
- (a) `GET`/`HEAD /media/:ticket`. The ticket is the credential. The route is chosen by its own configuration, not by a path test (`media.ts:221-226`, R140 3), and gets its own Origin, fetch-metadata and Referer rules. Right per R135/R140.
- (b) `POST /extension/pair/confirm`. The 6-digit code is the credential: 5 tries per code, a rate limit per origin, an extension Origin required (`server.ts:260-263`). Right per R96/R98. The per-origin limit can be dodged by a local program that varies the Origin, but the per-code limit still holds.
- (c) `OPTIONS` preflights from an allowed origin. They answer 204 with that exact origin and no data (`server.ts:243-256`). Right.

UI-token routes that the screens alone should call also check `caller` and, where it matters, the shell's Origin: `/extension/pair/status` (`capture.ts:327-333`), fonts, tools, the find/your-library starts (`uiOnly`), and the media ticket and picture routes. The extension's own routes check `caller === "extension"` (`find-browser.ts:210-212`, `capture.ts:363`).

**2. Three routes whose handler trusts a field it should not.** I found none that is exploitable. The routes I attacked:
- `/imports/:batchId/*`: the project is found by searching unlocked projects' batch lists (`import.ts:60-72`), so it is never taken from the request.
- `/review/:itemId/*`: `projectId` comes from the body but must be in the library (`review.ts:91-96`), and the library's `pendingEntry` ties the item to that project.
- `/projects/:id/transcriptions/:jobId/cancel`: checks `held.projectId === projectId` and reads only that project's journal (`transcription.ts:85-108`).
- `/libraries/pending-writes/:txn/resolve`: `txn` is checked against `TXN` and the markers on disk (`pending-writes.ts:176-178`).
- `/settings/fonts/:id`: `isUserFontId`, then looked up in the index; the path is built from the entry, not from the parameter (`fonts.ts:192-230`).
- `/media/:ticket`: bound to the library, project, source and asset; the project's lock is checked on every request and before the first byte (`media.ts:343-396`).
- The browser's file ticket: checked before the body is read (constant time) and ended at the seam with `where = "browser"` (`find-browser.ts:235, 279`).
- The move's confirm token: bound to the pending move (M6 aside).

The one field I found trusted without a check is a relative path in `attach` (M3).

**3. R58 on the service's side: are governance-load warnings sent to the screens?** No, on no route. `parseGovernanceWithWarnings` (`core/governance/schema.ts:298`) has no caller outside core. `GET`/`PUT /projects/:id/governance` (`routes/governance.ts:71-109`), `GET /projects`, retention and the `library.state` event all use `parseGovernance` and drop the warnings. The ledger's R58 is still `[OPEN]`, and FR-125 (group D) records it. I agree with D: the warnings are an exception naming an unknown control (it waives nothing, which fails closed) and the old spelling `manual_upload` (read as the new key, or ignored when the new key is also set). Neither loosens the rules.

**4. Ledger line 272 (Task 36 carry-overs): fixed or open?** Each part separately:
- **(a) A move whose request reached the service but sent no line back.** Fixed on the screen. `MoveLibrary.tsx:108-135` sets `reached` once the headers arrive and then polls `move/status`; it never says "nothing was copied". What remains, a lost *error* line leading to a 30-minute poll, is FR-166/167 (B), and M7 above is its service side.
- **(b) The streaming byte cap in `tx.copyFile`.** Open. `packages/library/src/repo/mutate.ts:265-278` has no byte limit, and the protocol documents' size cap is still checked after the copy. This is FR-148/FR-173/FR-174 (D). I agree with D.

## Checked and sound

- **Start-up token.** It is read from standard input only. A token variable in any letter case, any argument, a runtime flag naming a token, a terminal on stdin, or the token's value found anywhere in the environment or argv refuses the start. The first line is bounded (1 KiB). Start-up errors have the token replaced (`startup-token.ts`, `main.ts:114-116`). After the token, only exact grant lines are acted on, the reader's buffer is bounded at 8 KiB, and nothing it reads is echoed.
- **Log.** The serializers keep only the method, the path and the status. The query is dropped; media and browser-file paths and any 32-hex segment are written `[redacted]`; credential-named keys are redacted wherever they appear. Bodies are never logged.
- **Errors.** One mapping (`errors.ts`): `TypeError` and unknown errors give a generic 500, and `errorBody` removes paths from the message and the reason. Framework routing errors never echo the address.
- **File-carrying answers.** Pictures, media, fonts and PDF ranges carry `nosniff`, `no-store` and `default-src 'none'; sandbox`. The error handler strips content headers that were copied before a failure (`server.ts:311-316`).
- **The browser's file route.** One content-type parser in an encapsulated plugin. The body streams to an exclusive 0600 file in a 0700 inbox that is checked for its owner and mode. The route enforces a size cap, the `%PDF-` mark, a stall timeout, an overall 5-minute limit and the declared length. It answers with `Connection: close` when the body was not read to its end, and removes the inbox file in every outcome.
- **Taking a file from the inbox.** `file-grants.ts` checks containment as text before any file-system call, then uses O_NOFOLLOW and O_NONBLOCK and compares the open handle's dev/inode with the earlier `lstat`, so a link or a swapped file is refused.
- **Shutdown.** New requests get 503. In-flight requests are waited for (at most 60 s). Imports are paused, not cancelled. The find runner, the Zotero sync, watches and queues stop before the lock is released. Media tickets and folder grants end at once. Pending port and notice writes are awaited.
- **Two opens of the same library at once** (probe): both answer 200 and the library stays read-write.
- **Passphrase guessing.** Unlock and the new-recovery-code route share a per-project limiter that counts each attempt before it is checked; parallel requests cannot get past it.
- **The command line.** It changes the library only through the library's own calls: none of `apps/cli/src` writes files itself (grep). Keys are never accepted on the command line, Commander's messages never repeat what was typed, and `AO_PASSPHRASE` and `AO_ZOTERO_API_KEY` are removed from the environment at start. Exit codes are 0/1/2/3/4 as documented, plus 130/143 on a signal, and error messages have their paths removed.

## Could not verify

- **The move stall (M4)** under a real client that holds the socket open without reading it. A probe would need a raw HTTP client against a listening service with a library of many files.
- **What the screens show of an event's `error` text (M2).** I did not open the UI's handlers.
- **Whether the import dry-run's `summaryLines` print outside names the same way as M1.** I read the code path but did not probe it.
- **The memory reached by concurrent 32 MB browser captures (M8).** I did not measure it; that needs a listening service and a heap measurement.
