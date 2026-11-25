# D31b: decision 31 (b), R556 (2): bring a file in at once when a lookup service asks to wait

Worktree `.claude/worktrees/kg-3a`, branch `d31-attach-at-once`, from db8623b. Not pushed. **Built.**

Commits:
- c4155b0: the lookup client gets the option to leave out a service that asks to wait.
- 8454b72: attach and watched folders use it; the sentence; the review entry's `leftOut`; the closing tests' new waiting device.
- 700d4da: service route test.
- 6e9c1f4: UI tests.

## 1. What "asked to wait" does now

### The mechanism

**Client** (`packages/library/src/lookup/http.ts`):
- New option `GetOptions.askedToWait: "leave-out"`. The default is `"wait"`, which is today's behaviour.
- New error `LookupLeftOutError { host, notBefore, services }`. It is NOT a `LookupHttpError`, so it is neither "failed" nor "not found".
- New per-host map `notBefore`, kept in memory in the `HttpClient` instance.
- `fetchWithRetries` does this under the option:
  1. Before anything is sent: if `clock() < notBefore[host]`, it throws `LookupLeftOutError` at once. Nothing is sent; the throttle and concurrency slots are not taken.
  2. When the answer is a **429**, or a **503 with a readable Retry-After** (seconds or an HTTP date):
     - it records `notBefore[host] = max(previous, now + min(asked, 1 h))`;
     - `asked` is the Retry-After, or 60 s for a 429 that names no time;
     - the one-hour cap is R411 b's;
     - then it throws `LookupLeftOutError`. There is no sleep and no retry.
  3. A **503 without a wait asked**, a 500, or a network error: today's path (retries with back-off, then `LookupHttpError`).

**Lookup chain** (`lookup/index.ts`):
- `firstAnswer` treats a left-out provider like a failed one: it asks the next provider.
- If no provider gave the item and at least one was left out, it throws one `LookupLeftOutError`. That error names the providers left out and carries the latest `notBefore`.
- `searchTitle` names `openalex`.
- `context.ts` has a new field `LookupContext.askedToWait`. Every provider passes it through with `requestRules(ctx)` (crossref, openalex ×2, openlibrary, loc).

**Resolution** (`import/resolve.ts`):
- `ask` catches `LookupLeftOutError` and records `Resolution.leftOut`: `{ services, identifier | title (+creator), notBefore }`.
- Then it goes on at once, exactly as for a lookup that gave nothing.

**Attach** (`import/attach.ts`):
- The session's lookup context is `{ ...lookupContextFor(...), askedToWait: "leave-out" }`.
- Watched folders use `createAttach` at both sites (`watch.ts:1899`, `:2738`), so they get the same.
- Bulk Import builds its own context in `bulk/run.ts:972` and is untouched. Zotero batches go through Bulk. Find has its own contexts.

### One PDF with a DOI, when every service answers 429 / Retry-After 60
1. Crossref `/works/<doi>` is asked once and gets a 429.
   - It is left out; Crossref is held until T = now + 60 s.
2. OpenAlex `/works/doi:<doi>` is asked once and gets a 429.
   - It is left out; OpenAlex is held until T.
   - The DOI is recorded in `leftOut`: `services ["crossref", "openalex"]`, `identifier "doi:…"`.
3. The title search at OpenAlex is left out **without sending**, because OpenAlex is still held.
   - It is recorded in `leftOut` with its title and creator.
4. The file is stored at once:
   - with the embedded title;
   - the DOI is only a hint (R55);
   - outcome `needs-review`, reason `Waiting for lookup service response.`.
5. In all: 2 requests and no waits. Today this took 540 s.

### Three files attached together
- The files are taken one after another, as before.
- The first file asks OpenAlex once and gets the 429.
- Files 2 and 3 leave OpenAlex out with nothing sent.
- No waits add up.
- Tested: three files, 1 request in all, no waits ≥ 1 s.

### When one service waits and another confirms
- Today: when Crossref fails, `firstAnswer` asks OpenAlex, and OpenAlex's answer is accepted. The source is `created`, with no review.
- Now: the same. Nothing is recorded as left out for that DOI, because a provider gave the item.
- `leftOut` holds only lookups that NO provider answered.
- The sentence is shown only when the record goes to review AND something was left out. This is tested ("Crossref asks to wait, OpenAlex answers": `created`, no reason, no review entry).

### When the record is in review for another reason
- The record is in review for other reasons (a likely duplicate, an identifier that was not confirmed, low confidence) and something unanswered was also left out:
  - the outcome reason is the waiting sentence, **except that a likely duplicate keeps its own sentence**;
  - the entry's reasons list `[likelyDuplicate?, WAITING, …verification reasons]`.
- If nothing was left out: today's "Some details could not be confirmed, …". This is tested.

## 2. Where "not before" lives, and a restart

- It lives in the session's `HttpClient`, in memory (`notBefore` Map). There is one client per open library (`apps/library-service/src/state.ts:726`).
- If the library is closed, another library is opened, or the app quits, the client goes and the holds are lost. A fresh session asks the service again at once.
- Nothing was built to make the holds last. The review entry does record each left-out lookup's `notBefore` (ISO), so a later "look up again" (c) can honour it across a restart.

**Callers without the option** (Bulk, Zotero, Find):
- Only answers to option callers create holds. A non-option caller's own 429 handling is unchanged.
- A non-option caller that meets a hold waits for it before asking (`awaitHold`). This wait:
  - is bounded like its own Retry-After wait (`maxRetryAfterMs`, 60 s by default);
  - is cut by stop or close.
- So for holds up to 60 s (every 429 without a time, and every Retry-After ≤ 60) a non-option caller never asks before T. This is tested.
- For a hold longer than 60 s, it asks after 60 s. That is what it does today after its own 429, since its own waits are capped at 60 s.
- Today (checked): the client kept no hold between callers. One caller's Retry-After did not stop another caller asking at once.
- Bulk and Find only meet a hold when an attach or a watched folder in the same session left one.

## 3. The review entry's new content, and the older build

**Representation:**
- The entry keeps the existing `kind: "import"`.
- `reasons` are plain strings (there are no reason codes in this store); the owner's sentence is put first among them.
- There is one new optional field, `leftOut: Array<{ services, identifier?, title?, creator?, notBefore }>`.
- No new kind, cause, method, decision or enum value.

Example line (from the test, plain project):
```
{"id":"…","projectId":"…","sourceId":"…","kind":"import","status":"pending","createdAt":"…","fields":{…},"reasons":["Waiting for lookup service response.", …],"confidence":0.55,"method":"embedded","leftOut":[{"services":["openalex"],"title":"Notes from the tide-line interviews","creator":"Souza","notBefore":"2026-11-24T15:01:00.000Z"}]}
```
A DOI case gives `{"services":["crossref","openalex"],"identifier":"doi:10.5555/…","notBefore":"…"}`, and the same DOI is in `hints`.

**What I read in the older build** (`git show 2d12ab1:…`):

| file:line | what it does |
|---|---|
| `packages/library/src/repo/review.ts:463-479` (`parseReviewFile`) | `JSON.parse` of the line; the only check is `typeof e.id === "string" && e.projectId === projectId`. No schema. An unknown field is carried in memory. Nothing is refused for a reason text. |
| `review.ts:65-101` (`ReviewEntry`) | `kind: "verification" \| "import"`. Reasons are `string[]`. |
| `import/bulk/review.ts:214`; `bulk/undo.ts:106,109,332`; `repo/review.ts:330` | Rewrites of an import entry are appended lines of `{ ...entry, status/… }`, so an unknown field is **kept** when that build rewrites the entry. |
| `index/rebuild.ts` and `reviewRow` | The index row takes named fields only, so the unknown field is **left out of the index**. The file keeps it. |
| `apps/library-service/src/routes/review.ts:39-64` (`entryOut`) | Picks named fields: the field is not sent to that build's screen, which shows the reasons as text. The sentence is therefore visible in build 10 too. |

**Proof test:** "R556 (2) iv …" in `packages/library/src/import/attach-asked-to-wait.test.ts`.
- It writes an entry through a real attach.
- It parses that entry with a verbatim copy of the older `parseReviewFile` rules: 0 lines skipped, `kind` is "import", no batch and no cause (group "attach"), method "embedded", reasons are strings.
- It appends the older build's spread rewrite and shows `leftOut` survives.

## 4. The sentence, and where it is shown

- `Waiting for lookup service response.`
  - It is declared once: `LOOKUP_WAITING_TEXT` in `packages/shared/src/api/sources.ts`.
  - The library uses it as `ITEM_REASONS.waiting` (`import/common.ts`).
- Where it is shown:
  - the attach outcome's `reason`, so the "Attached files" line reads `{file} — Stored; it needs review: Waiting for lookup service response.`;
  - a watched folder's `imported` event `reason`;
  - the review queue entry, first among "Why it needs review".
- The page needed no change. It shows the service's reason and the entry's reasons through `UserText`.
- Not untrue anywhere I found: it is shown only when the record is in review and a lookup was left out that no other service answered. The words become literally true once (c) exists (R556).

## 5. What a later "look up again" (c) needs

**There now:**
- per entry: which services, which identifier hint or title and creator, and the time not to ask before;
- the entry's `sourceId`;
- the hints;
- R55 is kept: identifiers stay off the record.

**Not there:**
- a governed, audited update of an existing record from a lookup;
- a queue or trigger that survives restarts;
- the screen words;
- the in-memory holds lasting past the session (only the `notBefore` recorded per entry lasts);
- a field telling (c) which project rules applied at the time (it must re-evaluate them);
- in encrypted projects, the field sits inside the sealed line, as everything else does.

## 6. Tests changed (not loosened)

The FR-749 closing tests used a 429 / Retry-After 60 to make an attach wait. Since an attach no longer waits on a 429, the wait is now a request in the air: an undici mock reply with `.delay(600_000)`, which an abort clears. The assertions are unchanged: cancelled outcome, nothing written, count 1.
- `packages/library/src/import/attach-closing.test.ts`
- `packages/library/src/import/watch-closing.test.ts`
- `apps/library-service/src/close-during-attach.test.ts` (the attach part only; the Bulk part still uses a 429, unchanged)

## 7. Test files run (single files)

All passed.

**New:**
| file | tests |
|---|---|
| lookup/http-leave-out | 14 |
| import/attach-asked-to-wait | 9 |
| import/bulk/bulk-asked-to-wait | 1 |
| service attach-asked-to-wait | 1 |

The client and engine tests were seen failing first: no export or option, then 60 s waits and no sentence. Bulk, the service route and the UI tests passed at once. Bulk's is by design: it pins behaviour that did not change. The service route test was written after the engine change. The UI needed no change.

**Library:**
| file | tests |
|---|---|
| lookup.test | 39 |
| http-closing | 7 |
| http-keys | 18 |
| recorded | 21 |
| attach.test | 69 |
| common | 2 |
| resolve-titles | 24 |
| attach-closing | 5 |
| watch-closing | 1 |
| watch.test | 143 |
| watch-local | 51 |
| watch-choices | 9 |
| watch-settings | 9 |
| bulk.test | 103 |
| bulk-closing | 2 |
| annotations-plan | 9 |
| disk-full | 14 |
| failure-cause | 5 |
| patterns | 2 |
| space | 15 |
| zotero-conflict | 41 |
| zotero-gone | 26 |
| find/elicit | 18 |
| fetch-file.recorded | 15 |
| fetch-file | 42 |
| free-copy | 80 |
| people | 40 |
| runner.linked-missing | 62 |
| runner | 301 |
| search | 120 |
| settings | 21 |
| device | 28 |
| in-library | 32 |
| refman | 142 |
| sidecar | 17 |
| zotero-dry-run-journals | 4 |
| zotero-local | 85 |
| zotero-sync | 77 |
| zotero-web | 92 |
| index | 58 |
| rebuild-interrupted | 13 |
| review-held | 67 |
| review-held.linked | 6 |
| repo | 61 |
| seams-inert | 9 |
| extract | 43 (+2 skipped) |

**Service:**
| file | tests |
|---|---|
| close-during-attach | 11 |
| find-browser-routes | 44 |
| find-routes | 47 |
| import-disk-full-answer | 3 |
| import-disk-full | 2 |
| import-log | 1 |
| import-setup | 25 |
| review-queue | 23 |
| source-availability | 5 |
| sources-list-pdf | 5 |
| watched-folders-routes | 59 |
| fieldwork-governance | 23 |
| open-library | 25 |
| project-recheck | 5 |
| records | 9 |
| server | 160 (+1 skipped) |

**UI:**
| file | tests |
|---|---|
| Library | 48 |
| Library.dismiss | 4 |
| Library.notices | 4 |
| Library.reader | 9 |
| Library.recheck | 12 |
| Library.zotero | 14 |
| ProjectReviewQueue | 26 |
| ReviewQueue | 125 |
| ReviewQueue.look | 18 |

**Shared:** shared.test 14.

**Typecheck:** clean for @ao/library, @ao/shared, @ao/library-service and @ao/ui.

**Not run:**
- `*.scale.test.ts`: excluded by the config.
- `lint:css` / `lint:colours`: no screen code changed, only UI tests.
- e2e specs: their services answer lookups from recorded fixtures and never get a 429 (CI-283 report B2).

## 8. Uncertain

- A hold longer than 60 s binds a caller without the option (Bulk, Find) only for 60 s (§2). This is a judgement call for "do not change Bulk or Find" versus R411.
- A likely duplicate that also had a lookup left out keeps its duplicate sentence as the outcome reason. The waiting sentence is second among the entry's reasons.
- A non-option caller (Bulk, or Find with its lookup time limit) that meets an attach's hold now waits up to 60 s where before it would have asked at once. This is a small change, and only happens when an attach or a watched folder ran into a 429 in the same session.
