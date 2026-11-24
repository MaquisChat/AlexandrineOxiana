# Decision 31 (c), "Look up again" — design and build plan (from the read-only design pass, 24 November 2026)

This is the design pass's answer, kept as it was given (it wrote no file itself). It was made by reading the code of `d31-attach-at-once` at bebe640; nothing was run. The coordinator's ruling on it is R566 in the ledger.

## Facts read (file:line, worktree kg-3a, commit bebe640)

**A. How an attach's answer becomes a record or a review entry**
- **Confirmed without review:** `resolveItem` (`import/resolve.ts:314-679`) reaches the 0.9 threshold. Then `reviewFor` returns undefined (`import/common.ts:132-133`) and the record is written, along with any `leftOut`.
- **In review:** `reviewFor` builds the entry: `candidates` (`common.ts:150`, at most 3, `resolve.ts:669`), `hints`, and `leftOut` (`common.ts:153`). The waiting sentence comes second, after a likely duplicate (`common.ts:138-143`).
- **How the file is written:** append-only. The newest line per id wins (`repo/review.ts:466-500`). An update is a new line with the same id (`appendReviewUpdate`, `review.ts:455`).
- **No act adds candidates today.** The only governed rewrites are decide/resolve (`bulk/review.ts:217`, op `review.decide`), the withdrawal act (`review.ts:289-322`) and removal (`review.ts:331`).
- **How accept-candidate works:** it indexes into the candidates of the entry as read now (`bulk/review.ts:153-155, 177-179`). It writes the candidate's fields, its DOI/ISBN included (`fromCandidate`, `:125-137`), with lookup evidence. A later lookup therefore only has to append items of the same `LookupResult` shape (`lookup/context.ts:6-15`) to `candidates`.
- **Two traps:**
  1. Candidates must only be appended, never reordered or replaced. The page's index would otherwise point at a different match.
  2. `decideReview` writes `{...entry, resolved}` from an entry it read before the change (`:140, :217`). A look-up that read the entry before its own change could write it as pending again and reopen a decided entry. It must read the entry again inside its change, as `reviewedAfterWithdrawal` does (`review.ts:309`).
- **What the screen shows:** the row shows `reasons[0]` (`ReviewQueue.tsx:1103`). The detail lists every reason (`:2188-2192`) and the candidates, each with its accept button (`:2225-2230`). With none it says "No candidate matches were found." (`:2226`) — untrue for an entry that has not been looked up yet. The queue screen is `ReviewQueue.tsx` (there is no `ProjectReviewQueue.tsx`).
- **What the service sends to the page:** `entryOut` (`routes/review.ts:39-64`) does not send `leftOut`.

**B. What can change between the attach and the later look-up**
- Entry decided: its status is no longer pending (`bulk/review.ts:99`). Nothing to do.
- Source removed (skip, merge, delete): the entry is resolved "source-removed" (`review.ts:331-354`), and the list leaves out entries whose source is gone (`bulk/review.ts:67`).
- Bulk undo: does not apply; attach entries have no batch.
- Record edited by hand: import entries stay pending (`review.ts:253-267` touches only capture entries). A later accept-candidate overwrites the researcher's edit, as it does today.
- Rules changed: `lookupContextFor` reads them again, including title search (`context.ts:85-97`), and `providerAllowed` evaluates each service (`:64-82`).
- Project locked: `runMutation` refuses (`mutate.ts:488`). Unlock is where the resume belongs (`routes/projects.ts:159-162`).
- Read-only library: `requireWritable` refuses (`state.ts:665-671`).
- Library moved: `quiesce` drains registered work (`state.ts:1165`).

**C. Where an automatic pass can live, and how it stops**
- At opening: `activate` (`state.ts:943-987`). The backups' pattern is `startWork` + `setInterval` + `unref` (`:1914-1928`), with a configurable interval (`backupCheckMs`, `:191`).
- `idle()` waits for every task (`:638`), and `drainWork` drains the work registry (`:370`).
- At a close, `beginClosing` aborts the closing signal and calls `http.stop()` (`:1629-1633`), before the lock goes (`:1297, :1339`).
- `startsHeld` holds work back during a move (`:311`).

**D. Governance and audit**
- A lookup is only *evaluated*. A denial is a debug note, and nothing is audited (`context.ts:63-82`). Lookups are not audited anywhere today; an attach audits only its capture and store.
- `authorizeOnly` with `auditAllow` can audit an allow (`mutate.ts:445-473`).
- R55: hints are never put on the record (`resolve.ts:38-41`).
- R411 b: the researcher's own "Try again" may go at once. R556 ii and R563 I1 say no service is asked before its time.

**F. Lookups that failed outright** record nothing (`resolve.ts:402-404`), so nothing can retry them.

**G. The older build (2d12ab1)**
- Its `parseReviewFile` checks only id and project (`review.ts:463-479`).
- Its accept-candidate reads candidates from the newest line, as now.
- `entryOut` picks named fields; reasons go to the page as text.
- So it reads candidates added later, shows a changed reason, and carries extra fields inside `leftOut` items.

## 1. The design (plain words)

An entry that came in while a service asked to wait shows "Waiting for lookup service response.". Under its matches it says that the services have not been asked yet; it does not say "No candidate matches were found".

**When it is looked up again**
- Automatically, while the library is open read-write, the project is unlocked, and the time the service named (`notBefore`, kept on the entry) has passed: at opening, at unlock, and on a quiet timer (every 10 minutes). The pass is registered work: it stops at a move or a close, `idle()` waits for it, and nothing is written once the closing signal is aborted.
- By hand, with "Look up again" on the entry. Before the named time the button is off and says when it can be used (recommended over R411 b's "at once"; owner decision 3).

**What is asked**
- Only the lookups recorded in `leftOut`, and only the services that were left out. A service that already answered "nothing" is not asked again.
- The project's rules are asked again at that moment, for each service and for title search. A service no longer allowed is not asked.
- Entries are taken one after another, never in parallel. The client limits Crossref to one request at a time itself; other hosts it does not limit (`http.ts:13`).
- A new "asked to wait" sets the in-memory hold, so the next entries leave that service out without sending.
- Tries are bounded: up to 5 automatic tries for each left-out lookup, waiting 15 minutes, then 1, 4, 12 and 24 hours (or the service's own later time). After that the entry says it has stopped trying, and "Look up again" stays available.

**What happens to the answer**
- Nothing on the record changes. Answers are appended to the entry's candidates.
- The reasons list's own waiting sentence is replaced by a true sentence for the new state. "Waiting for lookup service response." stays shown only while some lookup is still waiting.
- The researcher decides with the existing acts (accept-candidate, accept, merge, skip).

**How it is written**
- Each try is one governed change modelled on `reviewedAfterWithdrawal`. It reads the entry again inside the change; a decided entry or a removed source means nothing is written.
- The policy requests are `process/metadata_lookup` for each service asked, plus the source's `store`.
- It is audited as op `review.lookup-again` with ids and counts only.
- The state is kept inside the existing `leftOut` items, as new optional fields `tries`, `lastTriedAt` and `outcome`. There is no new kind and no new decision.

**Where the design pass disagrees with the coordinator's leaning**
1. "accept-candidate unchanged" holds only if candidates are append-only and the look-up re-reads the entry inside its change. Otherwise a resolved entry can be reopened, or the wrong match accepted (`bulk/review.ts:140, 153, 217`).
2. "One request at a time per service" is not given by the client except for Crossref (`http.ts:13`). The pass must serialise itself, and interactive attaches still run beside it.
3. Audit: sending a hint or a title is audited nowhere today. If the only audit line is written after the answer, a close between the send and the write leaves a request unaudited. Recommended: audit the send before it goes (`authorizeOnly` with `auditAllow`), then write the outcome as its own change.

## 2. The owner's decisions

1. **Automatic and by hand, or by hand only.** Recommended: both. The automatic pass is bounded and only adds candidates.
2. **May a later answer ever fill a record without the researcher's act** (even a perfect DOI and title match)? Recommended: never. It stays a candidate.
3. **"Look up again" before the service's named time.** Options: honour the wait (recommended, R556 ii), or send one request at once as the researcher's act (R411 b).
4. **Lookups that failed outright:** (a) not covered; (b) recorded from now on and offered by hand only (recommended); (c) also retried automatically.

## 3. Build plan

**T1. Engine: record failures; extend `leftOut`; append-only candidates**
- Files: `repo/review.ts`, `import/resolve.ts`, `import/common.ts`.
- Adds: optional `tries`, `lastTriedAt`, `outcome` ("found" | "nothing" | "not-allowed" | "gave-up") and `why` ("asked-to-wait" | "failed") on `LeftOutLookup`; `why:"failed"` written from `resolve.ts:402` only if decision 4 is (b) or (c); a pure `appendCandidates` that de-duplicates with `addCandidate`'s key.
- Tests that must fail first: appending keeps existing indices; the old-reader proof (`attach-asked-to-wait.test.ts`) still passes with the new fields.
- Must not change: what the waiting sentence or `reviewFor` decides.
- Risk: a failure written into `leftOut` makes the old "waiting" sentence logic count it. Keep the sentence tied to `why:"asked-to-wait"`.

**T2. Engine: `lookUpAgain` (new file `import/look-again.ts`) and `dueLookUps`**
- Adds: `lookUpAgain(repo, http, projectId, entryId, {by, closing, now})`; `dueLookUps(repo, projectId, now)`; a provider filter on `lookupDoi` / `lookupIsbn` (`lookup/index.ts:75-91`) so only the listed services are asked; context from `lookupContextFor` plus `askedToWait:"leave-out"`, run under `whileOpen`.
- Tests that must fail first: (1) a decided entry is not reopened; (2) a removed source writes nothing; (3) a denied service is not asked and gives `not-allowed`; (4) a locked project writes nothing; (5) no send before `notBefore`; (6) a second 429 sets the hold and later entries send nothing; (7) close mid-lookup writes nothing (R247 c); (8) the record's `source.json` is byte-identical after a "found"; (9) the audit has ids and counts only.
- Must not change: `decideReview`, attach, Bulk Import, Find.
- Risk: the provider filter leaking into other callers.

**T3. Service: the pass and the route**
- Files: `state.ts`, `routes/review.ts`, `routes/projects.ts` (unlock), `shared/src/api/review.ts`.
- Adds: `runLookUpAgain()` through `startWork("lookup-again")`, with a timer started in `activate` and stopped in `closeLibrary` and `quiesce`; a test interval option, `lookUpAgainCheckMs`; `POST /review/:itemId/look-up-again {projectId}`, a separate route (do not add it to `REVIEW_DECISION_ACTIONS`: the `Same<>` checks at `routes/review.ts:79-84` must stay); an `entryOut` field `lookUp?: {state, notBefore?, tries}` with no titles in it.
- Tests: the pass runs at open; `idle()` waits for it; nothing is sent after `beginClosing`; read-only returns 409; locked returns 423; it resumes at unlock.
- Risk: a burst at opening. Cap each pass (for example 20 entries) and run strictly one after another.

**T4. UI**
- File: `ReviewQueue.tsx` (attach entry detail), with its tests.
- Adds: the "Look up again" button (off with its time shown before `notBefore`), the state sentences, and a replacement for "No candidate matches were found." while waiting. Reasons stay shown through UserText.
- Tests: the button posts; the waiting text shows; after "found" the new candidates are listed and accept-candidate's index is right.

**T5. The owner's page, and a compatibility proof by test against 2d12ab1's reader.**

## 4. The words (proposed)
- **Waiting:** "Waiting for lookup service response." (the owner's words). Under the matches: "Not looked up yet: the lookup service asked to wait."
- **Being looked up (on the screen only):** "Looking this up again…"
- **Found:** "The lookup service has now answered. Its matches are shown below; nothing changes until you accept one." For an identifier taken from the file, add: "The match was found from an identifier in the file, which may belong to a work the file cites. Check it against the document first."
- **Nothing found:** "The lookup service has now answered, but it found no match for this item."
- **Rules no longer allow it:** "This project's rules no longer allow this lookup, so it was not looked up again."
- **Given up:** "The lookup service asked to wait each time it was tried ({n} tries), so the app has stopped trying by itself. You can still use Look up again."
- **Button before its time:** "Look up again (after {time})"
- **Failed outright:** "A lookup service could not be reached."

## 5. Risks and open points
- **Silent change to data:** none if the look-up writes only the review line, re-reads it inside its change, and appends without reordering.
- **Hand edits:** accept-candidate overwrites them, as today. The found sentence should say that accepting replaces the details shown.
- **Politeness:** at opening, many entries for the same host come due together — the pass is capped and sequential, and the hold stops the rest; interactive attaches still run beside it; after a restart the in-memory hold is lost, and the `notBefore` kept on the entry covers it; tries are bounded.
- **Audit:** if the send is not audited before it goes, a close between send and write leaves it unaudited (recommended: audit before).
- **R55:** what is sent is what the attach already sent (an identifier hint, or a title only when title search is allowed). Candidates hold identifiers, as today; only the researcher's accept writes them.
- **Older build:** it reads and keeps everything above. It does not look anything up, so in build 10 "Waiting…" stays as it is. If build 10 resolves an entry, it carries the new fields. Nothing was run; all of this is by reading.
- **Not determined:** whether moving a source between projects exists and what it does to entries; whether core's evaluate attaches conditions to `metadata_lookup` that a mutation must honour.

### Critical files for implementation
- `packages/library/src/repo/review.ts`
- `packages/library/src/import/bulk/review.ts`
- `packages/library/src/lookup/index.ts`
- `apps/library-service/src/state.ts`
- `packages/ui/src/screens/import/ReviewQueue.tsx`
