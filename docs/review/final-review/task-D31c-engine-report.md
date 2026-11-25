# Decision 31 (c), "Look up again": the engine (T1 and T2). Report

Branch `d31c-look-up-again`, worktree `.claude/worktrees/kg-4`, from 7d8d861. Status: **BUILT** (T1 and T2). Nothing in `apps/library-service` or `packages/ui` was touched. The workspace typecheck is clean.

Commits, in order:
- `ab58ebd`: the entry's look-up state and its pure helpers (T1).
- `7f7c428`: a lookup that fails outright is kept, never as waiting (T1). The same commit adds the lookup chain's per-call provider filter and the extended proof for the older build.
- `ab586e3`: the act `lookUpAgain` and the automatic pass's `dueLookUps` (T2).
- `2e3a471`: these are exported from `@ao/library` for T3.

## 1. The entry's new fields (R566 7)

`LeftOutLookup` (`packages/library/src/repo/review.ts:110-135`) gains optional fields only:
- `why: "asked-to-wait" | "failed"`. When it is absent, the lookup counts as "asked-to-wait"; every (b) entry has no `why`.
- `tries: number`.
- `lastTriedAt: ISO`.
- `outcome: "found" | "nothing" | "not-allowed" | "gave-up"`.

`notBefore` became optional: a lookup that failed outright has no time to wait for. There is no new entry kind and no new decision act. The entry's `kind` is still `"import"` and its `status` is still `pending`/`resolved`.

Here is an example line after a look-up of a file whose DOI lookup was left out and whose title search failed. It is shown unsealed; in an encrypted project the line is sealed as before:

```json
{"id":"…","projectId":"…","sourceId":"…","kind":"import","status":"pending","createdAt":"2026-11-24T15:00:00.000Z",
 "fields":{…},"reasons":["The lookup service has now answered. Its matches are shown below; nothing changes until you accept one.","The match was found from an identifier in the file, which may belong to a work the file cites. Check it against the document first.", …],
 "confidence":0.55,"method":"embedded","candidates":[<the attach's, unchanged, same positions>, <appended>],
 "hints":["doi:10.5555/…"],
 "leftOut":[
   {"services":["crossref","openalex"],"identifier":"doi:10.5555/…","notBefore":"2026-11-24T15:01:00.000Z","tries":1,"lastTriedAt":"2026-11-24T15:16:00.000Z","outcome":"found"},
   {"services":["openalex"],"title":"…","creator":"…","why":"failed"}]}
```

**`resolve.ts` (R577 iv)** (`import/resolve.ts:395-420`): some lookups fail outright, meaning none of their services answered and they failed (no network, a 500). Such a lookup is now kept with `why: "failed"`. The entry records which services failed and which identifier hint or title search was being looked up, with no `notBefore`.
- **Where:** only in an attach and a watched folder, the callers whose context leaves out a service that asks to wait (`askedToWait: "leave-out"`). Bulk Import, Zotero and Find are unchanged (R556 v). This is my reading; see §8.
- **Mixed case:** some services were left out because they asked to wait, and the others failed. Each kind is then kept as its own item. This settles R563 M2 for (c).
- **How the chain names the failed services:** it puts a non-enumerable `failedServices` on its error (`lookup/index.ts:85-100`).
- **R55 holds:** the identifier stays a hint. It is never written to the record (tested).

**The waiting sentence** depends on `isAskedToWait` only:
- `reviewFor`: `import/common.ts:139`. `leftOut` is now written whenever anything was kept.
- The attach's outcome reason: `import/attach.ts:402`.

A failed lookup alone never makes an entry or an attach read "Waiting for lookup service response."; the entry keeps today's sentence. Both cases are tested.

## 2. The state function (`import/look-up-state.ts`)

`lookUpStateOf(entry)` returns `{ state, tries, notBefore?, fromFile }`, or `undefined` when nothing was left out (`:83`). States are checked in the order of the table. `reasonsWithLookUpState(reasons, view, likelyDuplicate)` (`:127`) puts the state's sentence where the earlier state sentence stood. If none stood there, it goes first after a likely duplicate's sentence. Nothing else moves.

| state | when | sentence that stands in the reasons (R577, word for word) |
|---|---|---|
| waiting | some asked-to-wait lookup has no outcome (`notBefore` = latest of them) | "Waiting for lookup service response." |
| found | no lookup waits; some has outcome "found" | "The lookup service has now answered. Its matches are shown below; nothing changes until you accept one." + (if the found lookup's identifier is one of the entry's `hints`) "The match was found from an identifier in the file, which may belong to a work the file cites. Check it against the document first." |
| gave-up | outcome "gave-up" (`tries` = most) | "The lookup service asked to wait each time it was tried ({n} tries), so the app has stopped trying by itself. You can still use Look up again." |
| nothing | outcome "nothing" | "The lookup service has now answered, but it found no match for this item." |
| not-allowed | outcome "not-allowed" | "This project's rules no longer allow this lookup, so it was not looked up again." |
| failed | only lookups that failed outright, none answered | none: the entry keeps its own reason (today's sentence) |

All of R577's words are declared once, in `packages/shared/src/api/sources.ts:168-189` beside `LOOKUP_WAITING_TEXT`:
- `LOOK_UP_AGAIN_TEXT`, which also holds `notLookedUpYet`, `looking`, `act`, `after` and `notLookedUpFailed` for the page.
- `lookUpGaveUpText(n)` and `lookUpAgainAfter(time)`.

## 3. `lookUpAgain`, step by step (`import/look-again.ts`)

`lookUpAgain(repo, http, projectId, entryId, { by, closing?, now?, debug? })` is at `:208`. The whole act runs under `whileOpen(lib, closing, …)`.

1. **Reading the entry and early refusals (`:227-245`). It writes nothing and sends nothing.** It refuses in these cases:
   - `closing` is aborted or the handle is closed: "closing".
   - The library is read-only: "read-only".
   - The project is locked: "locked". `projectReviewEntries` throws, and the error is turned into this answer.
   - No such import entry: "not-found".
   - The entry is no longer pending: "decided".
   - Its source is gone: "source-removed".
   - **Automatic** and nothing due: "not-due".
   - **By hand** and nothing can be asked yet: `{ why: "not-yet", notBefore }`, the earliest time (R577 iii). A failed lookup has no time, so the researcher can ask it at once.
   - Every lookup already answered: "nothing-to-look-up".
2. **The rules again, now (`:247-275`).** These calls are made fresh:
   - `lookupContextFor` and `providerAllowed` for each service.
   - For title search, also `titleSearchAllowed`.
   - LoC is never used for an encrypted project.

   A lookup none of whose services is allowed now is not asked; its outcome becomes "not-allowed". A service the client still holds (`http.heldUntil(host)`, a read-only getter added at `lookup/http.ts:432`) is left out without sending, and no try is counted. If every allowed service is held: automatic gives "not-due"; by hand gives "not-yet" with the hold's time. Nothing is written.
3. **The send is audited before it goes (`:277-290`, R566 6).** `authorizeProcessing` (that is, `authorizeOnly`) runs with one `process/metadata_lookup` request per service about to be asked and `auditAllow`:
   - `authorizeOnly` now takes several requests of one action. Each is evaluated, a denial of any is audited and thrown, and the allow is ONE audit event (`repo/mutate.ts:445-480`).
   - It is refused like any change when the library is closing (`LibraryClosedError`, then "closing") or the project is locked.
   - If it is refused, nothing is sent.

   Example audit line:
   ```json
   {"seq":12,"action":"process","entity":{"type":"source","id":"<sourceId>"},"decision":{"result":"allow"},
    "details":{"op":"review.lookup-again.send","reviewEntry":"<entryId>","by":"researcher","services":["openalex"],"lookups":1}, …}
   ```
4. **Asking (`:292-299`).** Lookups are asked one after another, each with `askedToWait: "leave-out"` and the call's own filter `{ only: <its services> }` on `lookupDoi`, `lookupIsbn` or `searchTitle`:
   - The filter is an argument of that one call (`lookup/index.ts:30-37, 59, 142`). No other caller passes it.
   - A service that asks to wait again sets the client's hold, as today. The lookup gets a new `notBefore`, `tries + 1` and no outcome; it gets "gave-up" once `tries` reaches 5.
   - Answers set the outcome:
     - A found answer gives "found".
     - No answer gives "nothing".
     - If every asked service fails outright, the lookup becomes `why: "failed"` (by hand only).
   - `LookupCancelledError` (the closing) stops the act at once and nothing is written. The answer is "cancelled": the send was audited, and its line stands alone.
5. **The write (`:301-335`).** One `importChange` (governed, txn marker, audited) with the source's `store` request:
   - It **reads the entry again inside the change**. If the entry is no longer pending or its source is gone, the change is rolled back (nothing written) and the answer is "dropped".
   - Otherwise it appends ONE new line of the entry: candidates appended, the lookups' `tries`, `lastTriedAt` and `outcome`, and the reasons with the new state's sentence.
   - `source.json` is not touched.

   Example audit line:
   ```json
   {"action":"store","entity":{"type":"source","id":"<sourceId>"},"decision":{"result":"allow"},
    "details":{"op":"review.lookup-again","reviewEntry":"<entryId>","by":"automatic","lookups":2,"candidatesAdded":1,"state":"found","txn":"…","changes":0}}
   ```

**Returns `LookUpAgainResult` (`:72-90`):**
- `{ done: true, entryId, sourceId, asked, services, notAllowed, found, state }`, where `found` counts the matches appended and `state` is a `LookUpView`.
- `{ done: false, why: "not-found"|"decided"|"source-removed"|"locked"|"read-only"|"closing"|"not-due"|"nothing-to-look-up"|"dropped"|"cancelled" }`.
- `{ done: false, why: "not-yet", notBefore }`.

A policy refusal of the send is audited and thrown (`PolicyDeniedError`). Everything else about the library's state is answered, not thrown.

## 4. The bounds and waits (`LOOK_UP_AGAIN_BOUNDS`, `look-up-state.ts:26`, one place)

- At most **5 automatic tries** per left-out lookup.
- The wait before automatic try k+1 is `waitsMs[k]`, counted from the last try. The attach counts as the try before the first, counted from the entry's `createdAt`. The waits are 15 min, 1 h, 4 h, 12 h and 24 h.
- The service's own time (`notBefore`) is always honoured as well.
- The fifth try that is answered "wait" again ends the lookup with "gave-up". The researcher can still ask it.
- Researchers' tries count in `tries` too.
- Clocks: `now` is injected (`opts.now`; `dueLookUps(repo, projectId, now)`), and the client's hold uses the client's own clock.

`dueLookUps` (`look-again.ts:124`) returns `{ entryId, sourceId }[]`, oldest first. An entry is listed when it is pending, its source is present, and it has a lookup due by those rules. A failed lookup is never due (R577 iv). A locked project gives `[]`.

## 5. The cap on candidates, and why

The page lists every candidate and accepts by position: `ReviewQueue.tsx:2229-2230` maps all of them with no slice, and the accept action takes the list index `i`. The service sends all of them (`routes/review.ts:59`). The library takes `candidates[index]` of the newest line. No route or schema bounds the index.

So:
- `appendCandidates` (`look-up-state.ts:47`) only appends. It never reorders, replaces or drops an existing candidate.
- It de-duplicates with the resolution's own key, now shared as `candidateKeyOf` (provider | DOI | lowercased title). `addCandidate` in `resolve.ts` uses it too.
- It adds **at most 3 new matches per look-up** (the resolution's own cap per item).
- An entry may therefore list more than 3 matches. A cap on the total would have had to drop a match, so I chose not to cap it. Each lookup is answered at most once ("found" and "nothing" are final), so the list stays bounded: about 3 + 3 × (number of left-out lookups).
- Tested through `decideReview`: the old positions accept the same matches, and the new position accepts the new one.

## 6. The older build (2d12ab1)

- **Review file:** `attach-asked-to-wait.test.ts`, test "R556 (2) iv". It already copies 2d12ab1's `parseReviewFile` check, and now also reads a later line with every new field:
  - `why`, `tries`, `lastTriedAt` and `outcome`.
  - A failed lookup without `notBefore`.
  - Candidates appended after the existing ones, and the "found" sentence.

  It checks that kind, status, method and reasons are as that build knows them, and that every earlier candidate keeps its position (2d12ab1's accept-candidate indexes the newest line). It also checks that a decision line of that build (which spreads the entry) keeps every new field.
- **Audit log:** in 2d12ab1, `verifyChain` (`packages/core/src/audit.ts`) checks seq, prevHash and hash only. Op names are free-form (`details.op`), and no registry of op names exists in the service or the page. The new ops `review.lookup-again.send` (action `process`, the action the media worker's audited allows already use) and `review.lookup-again` (action `store`) are therefore read like any other. This is by reading, not run against that build.

## 7. What T3 will need (exact signatures)

```ts
import { dueLookUps, lookUpAgain, lookUpStateOf, LOOK_UP_AGAIN_BOUNDS, LOOK_SEND_OP, LOOK_UP_AGAIN_OP,
  type DueLookUp, type LookUpAgainResult, type LookUpAgainRefusal, type LookUpView, type LookUpState } from "@ao/library";
import { LOOK_UP_AGAIN_TEXT, lookUpAgainAfter, lookUpGaveUpText, LOOKUP_WAITING_TEXT } from "@ao/shared";

dueLookUps(repo: Repo, projectId: string, now?: Date): Promise<DueLookUp[]>          // { entryId, sourceId }
lookUpAgain(repo: Repo, http: HttpClient, projectId: string, entryId: string,
            opts: { by: "automatic" | "researcher"; closing?: AbortSignal; now?: Date; debug?: (n: string) => void }): Promise<LookUpAgainResult>
lookUpStateOf(entry: { leftOut?: LeftOutLookup[]; hints?: string[] }): LookUpView | undefined   // { state, tries, notBefore?, fromFile }
```

**The pass** (at opening, at unlock, and on a timer):
- Run it as registered work (`startWork`).
- For each project, `for (const d of await dueLookUps(repo, p, now)) await lookUpAgain(…, { by: "automatic", closing })`, strictly one after another and capped per pass (the design suggests 20).
- Stop on `why: "closing" | "cancelled"`. "not-due" is normal; it means the client's hold answered for the service.
- The pass must also serialise itself against the route. Two look-ups of the same entry at once would both send, and the later write wins for `tries`; candidates are de-duplicated.

**The route** `POST /review/:itemId/look-up-again {projectId}`:
- `done: true` → 200 with the counts and the state.
- "not-yet" → the time (the page's button reads "Look up again (after {time})").
- "locked" → 423.
- "read-only" → 409.
- "decided", "source-removed" and "dropped" → the existing "already reviewed" refusal.
- "closing" and "cancelled" → the closing sentence.
- "nothing-to-look-up" → a refusal.

**`entryOut`:** `lookUp?: { state, notBefore?, tries }` from `lookUpStateOf(e)`. It carries no titles and no identifiers; `fromFile` only chooses the sentence.

**The page:** under the matches, it says `notLookedUpYet` while waiting and `notLookedUpFailed` for "failed", instead of "No candidate matches were found." (R566 8). That is T4.

## 8. Tests (each file run alone, `nice -n 10`, MockAgent with `disableNetConnect`, no real waits)

**New:** `import/look-up-state.test.ts` (16) and `import/look-again.test.ts` (17). They cover:
- (1) decided between send and write, using a held promise after the answer; also decided before.
- (2) source removed between send and write.
- (3) a service no longer allowed: 0 requests, "not-allowed", no send audited.
- (4) a locked project: nothing sent, the library folder byte-identical.
- (5) not before `notBefore`: automatic gives not-due; by hand gives "not yet" with the time. This also holds with a fresh client whose in-memory hold is gone.
- (6) a second "wait" sets the hold, and the next entry sends nothing; growing waits; the 5th try gives "gave-up"; the researcher can still ask after that.
- (7) closing in mid-lookup: the library folder is byte-identical after `close()` and after everything settled; the send's audit line stands alone with no outcome line.
- (8) after "found", `source.json` is byte-identical and accept-candidate by old and new positions works through `decideReview`.
- (9) the audit file's bytes hold neither the title nor the DOI; the exact keys of both lines are checked.
- Also:
  - a failed lookup is not taken by the automatic pass but is by the researcher's act;
  - one that fails again stays failed and never reads "Waiting…";
  - an encrypted entry stays sealed (raw bytes checked, opened with the key);
  - the provider filter is the call's own;
  - "nothing" is final.

**Extended:** `import/attach-asked-to-wait.test.ts` (11): a failed lookup is kept and the entry does not read "Waiting…"; the mixed wait-and-fail case; the older-build proof.

**How the tests were seen to fail:**
- The new files failed first only because the modules did not yet exist. The attach tests failed for the right reason (`leftOut` was missing).
- I then planted seven faults in `look-again.ts` and `look-up-state.ts`, one at a time; each was caught by its test:
  - no re-read inside the change;
  - no hold check;
  - failed lookups taken automatically;
  - by hand ignoring `notBefore`, caught only after I added the fresh-client case;
  - rules not asked again;
  - the send audited after the request;
  - candidates prepended.

**Runs (last summary line of each):**
- look-up-state 16/16 · look-again 17/17 · attach-asked-to-wait 11/11 · attach-closing 5/5 · attach 69/69 · resolve-titles 24/24 · common 2/2
- lookup/http-closing 7/7 · http-keys 18/18 · http-leave-out 31/31 · lookup 39/39 · recorded 21/21
- review-held.linked 6/6 · review-held 67/67 · review-later-conflict 18/18 · review-resolution 27/27
- watch-choices 9/9 · watch-closing 1/1 · watch-local 51/51 · watch-settings 9/9 · watch 143/143 · watch.scale (its own config) 1/1
- bulk: annotations-plan 9/9 · bulk-asked-to-wait 1/1 · bulk-closing 2/2 · bulk 103/103 · disk-full 14/14 · failure-cause 5/5 · patterns 2/2 · space 15/15 · zotero-conflict 41/41 · zotero-gone 26/26
- find: elicit 18/18 · free-copy 80/80 · fetch-file.recorded 15/15 · runner 301/301 on the second run. The first run failed "R411 b (M2): a Retry-After as an HTTP date, on a 503"; it passed alone and on the rerun. It is intermittent: an HTTP date drops milliseconds. My only change in the client is the read-only `heldUntil`.
- refman 142/142 · in-library 32/32 · device 28/28 · zotero-local 85/85 · zotero-web 92/92 · zotero-sync 77/77
- lock-guards 7/7 · backup-governed 22/22 · transcription-jobs 15/15 (the other `authorizeOnly` callers) · seams-inert 9/9 · library 35/35
- shared: shared 14/14 · boundary 19/19
- `pnpm -r typecheck`: all nine packages Done.
- Not run: `bulk.scale.test.ts` (Bulk Import's code path is unchanged: it never leaves anything out).

## 9. Uncertain, or choices made

1. **Failed lookups are kept only where services that ask to wait are left out** (attach and watched folders). R577 (iv) says "kept from now on"; R556 (v) says Bulk Import and Zotero are not changed. If the owner wants Bulk Import's entries to carry them too, it is a one-line change (`keepFailed` in `resolve.ts`).
2. **The write's policy request is `store` only.** The `process/metadata_lookup` requests are evaluated and audited in the send's authorisation. The design listed both for the write; putting them in the write as well would audit each service twice.
3. **"not-yet" by hand:** when some lookups can be asked now and others cannot, the act asks the ones that can. It answers "not yet" only when none can.
4. **An asked-to-wait lookup that now fails outright becomes `why: "failed"`** (by hand only from then on). In a mixed answer (one service asks to wait, another fails), the lookup stays waiting with both services, so the failed one may be asked again automatically with it. This is rare, and it was not a lookup that failed at the attach.
5. **`not-allowed` is re-checked by the researcher's act.** If the rules allow the service again, it is asked. The automatic pass never retries it.
6. **Concurrency of two look-ups of the same entry:** both send, and the later write wins for `tries` (the re-read keeps it safe for decisions). T3 should run the pass and the route one at a time per library.
7. The older-build compatibility is proved by a faithful copy of 2d12ab1's reader rules in a test, not by running that build (as in (b)).
