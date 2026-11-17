# Task FR-C2 — report (tests only; no product code changed)

Branch: `worktree-agent-a8f81b7c97773ed6a` (reset to `claude/pdf-reader-highlights` at 74f275c first).
Commits: 63e1231 (FR-195), 4c961b4 (FR-227/228), cbfeeea (FR-562), 1d6d08d (FR-214). Not pushed.

Every mutation below was a scratch edit of product code, run, and reverted with `git checkout`; `git status` was clean of product changes after each.

## 1. FR-195 — new-project dialog (`packages/ui/src/screens/NewProject.test.tsx`, describe "…(FR-195)")

| Test | Code guarded | Mutation | Failure under it |
|---|---|---|---|
| the identifiable-data refusal is said in plain words, switches encryption on and asks for a passphrase | `NewProject.tsx:114` `needsEncryption` (`/enable encryption/i` must match the service's identifiable-variant message from `packages/library/src/repo/projects.ts:106`) | regex changed to `/encryption at rest/i` (matches only the other variant) | alert text was the service's raw "This project contains identifiable da…" instead of the plain sentence |
| after the encryption refusal, choosing a passphrase completes the create as an encrypted project | `NewProject.tsx:318-319` (`setServiceNeedsEncryption(true)`, `setEncryptChoice(true)`) | both lines deleted | "Unable to find a label with the text of: Passphrase" (encryption not switched on; the create could not be completed encrypted) |
| a clipboard that fails at the recovery step says so, keeps the code on screen and does not pass the step | `components/RecoveryCodeStep.tsx` `copy()` catch: `setCopied("Copying did not work here…")` | the catch made silent | "Unable to find role=status" |
| Tab and Shift+Tab stay inside the recovery step | `NewProject.tsx:376-382` (wrap at the ends of the trap) | both wrap branches deleted | focus left the dialog (activeElement was `<body>`'s inert content) |
| Escape while the create is in flight neither closes the dialog nor loses the recovery code that comes back | `NewProject.tsx:342` `if (busy \|\| made \|\| found) return;` | `busy \|\|` removed | dialog "New project" gone after Escape (the recovery code would never be shown) |

Note on the Tab-trap test: jsdom 27's selector engine returns `querySelectorAll` matches of a selector *group* group by group (all inputs, then buttons, then `[tabindex='-1']`), not in document order as the DOM standard and browsers do. The trap reads its ends from that list, so in jsdom its "first" and "last" differ from a browser's (from the heading, Tab went to the checkbox and then left the dialog). The test therefore puts the dialog's own `querySelectorAll` results in document order (a per-element override, commented in the test) so it exercises the trap as a browser runs it. Not a product defect; the existing keyboard test only passes because its first control is an input and its last a button.

## 2. FR-227, FR-228 — `media-src` (`packages/ui/src/contentSecurityPolicy.test.ts`, describe "media-src: recordings come only from the service on this computer (FR-227, FR-228)")

The policy is built in `packages/ui/index.html:23` (meta tag) and `apps/desktop/src-tauri/tauri.conf.json:14` (the shell's `app.security.csp`). The file already asserted every directive exactly; what was missing was that another origin is not allowed. Added: a small CSP-3 source matcher (`allows`, which throws on any source form it does not know such as `*` or `https:`), and for BOTH the page's and the shell's policy: the directive is exactly `http://127.0.0.1:* http://localhost:* blob:`; a media ticket on loopback and a `blob:` are allowed; recordings and pictures (`media-src`, `img-src`) from other origins (public hosts, LAN addresses, `127.0.0.1.example.org`, `localhost.example.org`, `127.0.0.1.nip.io`, `[::1]`) are refused; `data:` media and the shell's own `tauri://localhost` files are refused for media.

Mutations: (a) `https://media.example.org` added to `media-src` in `index.html` → "media-src must refuse https://media.example.org/interview.mp3" (plus the exact-value and page/shell-equality tests); (b) `http://192.168.1.20:*` added in `tauri.conf.json` → "media-src must refuse http://192.168.1.20:4100/media/tk_abc" for the shell.

Observation: `media-src` admits any port on 127.0.0.1/localhost, not only the service's port (as R135 4 set it); under a browser dev origin of `http://localhost:5173` the app's own files are therefore loopback too. Asserted as built.

## 3. FR-562 — the sign-in window's retry (`packages/ui/src/screens/FindAcquire.test.tsx`, "round 2 (R342)")

Code: `FindAcquire.tsx:1613` `if (!live()) return false;` (after the shell's first refusal, before closing the leftover) and `FindAcquire.tsx:1616` `if (!(await closed) || !live()) return false;` (after the leftover's close, before asking again). `live()` = mounted and the generation unchanged (`gen` moves on at a lock, `markLocked`, or a library change).

| Test | Mutation | Failure |
|---|---|---|
| FR-562: a lock between the shell's refusal and the close: the leftover is not closed by the retry and the shell is not asked again | line 1613 removed | closeLibraryWindow called 2 times, expected 1 (the retry closed a window after the lock) |
| FR-562: a lock while the retry waits for the leftover to close: the shell is not asked again, no window is opened | `\|\| !live()` removed at line 1616 | openLibraryWindow called 2 times, expected 1 (a window opened after the lock) |

The lock is made as the service makes it: the queue's reads answer 423 PROJECT_LOCKED and an event makes the page read it (the "is locked" heading appears) while the shell's answer / close report is held back.

## 4. FR-214 — an import's undo restoring merged sources (`e2e/import.spec.ts`, "an import that merges into existing sources, undone: … (FR-214)")

How the product merges: `packages/library/src/import/bulk/run.ts:1294-1300` — a certain duplicate (same DOI) that is not the same file, with the default option "Merge into the existing source". Scenario: import 1 = `first.bib` (two articles: DOI, title, author, year, journal); the service's stored sources are kept. Import 2 = `second.bib` (the same two DOIs with volume, issue, pages, publisher and a keyword; plus one new article). Report: Created 1, Merged into existing sources 2; service counts `{created:1, merged:2}`; the fields filled in (`volume 61, issue 4, page 812–830, publisher Sage`, one tag; `volume 118, page 1–22`). Undo: dialog "Remove 1 imported source and restore 2 merged sources?", status "Removed 1 imported source and restored 2 merged sources.", batches `[2 undone, 1 finished]`, the project holds exactly the two first sources, each source's stored `source` (minus `modifiedAt`/`modifiedBy`) and `assets` deep-equal what they were before import 2, and the tag "food systems" is gone. Chromium and WebKit pass.

Mutations (in `packages/library/src/import/bulk/merge.ts:204`, `revertMerge`'s loop over `rec.filled`): (a) loop over nothing → status "restored 2 merged sources" not found (only the tagged source counted as changed); (b) every field but `/volume` restored → the field comparison failed: Received `+ "volume": "61"`.

## Findings

**F1 (FR-562, product, minor): the retry does not check that the row is still waiting.** `live()` covers a lock and a change of library, not the row leaving its state. If the service returns the entry (for example at the ticket's end) while the retry waits for the leftover to close, and the page reads it meanwhile, the retry still asks the shell again: the window opens for a row that no longer waits, and is then closed by the ticket effect (`FindAcquire.tsx:1559-1571`) after the next read. Evidence (probe test, kept OUT of the commit, saved at `/tmp/claude-0/-home-user-AlexandrineOxiana/ac3b5cb4-f467-5f83-9948-4e7d2e34f036/scratchpad/FR-562-probe-left-the-wait.test-snippet.tsx`): after `becomes(no-open-copy)` + a read, then the leftover's close: `opens 2, closes 2, cancels 0, state "No open copy"`; expected openLibraryWindow ×1, got ×2. For the coordinator's ruling (R342 b / R344 N4 name only the lock).

FR-214: no defect — the undo restores merged sources exactly (fields, assets, tags).

## Runs (each at `nice -n 10`, foreground)
- `vitest run src/screens/NewProject.test.tsx src/contentSecurityPolicy.test.ts src/screens/FindAcquire.test.tsx` → `Test Files 3 passed (3) · Tests 241 passed (241)`
- `pnpm --filter @ao/ui test` → `Test Files 112 passed (112) · Tests 2084 passed (2084)`
- `pnpm -r typecheck` → all packages `Done` (last line: `apps/browser-extension typecheck: Done`), no errors
- `pnpm e2e -- --app-only e2e/import.spec.ts --trace off` → `8 passed (2.1m)` (4 scenarios × Chromium, WebKit)

Nothing left running.

minor (deferred): the `GET /zotero/sync` unhandled-request warnings printed by MSW in NewProject tests are pre-existing (the Library screen), not from these tests.
