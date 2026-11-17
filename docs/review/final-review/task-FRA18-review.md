# Review — Task FR-A18 (rules the engine cannot read are said on the screens; R379, R58)

Reviewer: fresh adversarial reviewer. Worktree `agent-a6ee131b0cb253cae`, branch `fr-a18-unreadable-rules`, head da348d8 (base 7537f63). At the end `git status --short` there is empty: the probe file was deleted and every mutation was reverted.

## Verdict: NOT APPROVED (one Important finding, small to fix)

- **Spec:** ✅ for every case where the file exists. ❌ for a missing rules file: there the new answer says `readable: true` while the engine refuses everything.
- **Quality:** good. Every new guard but one is held by a test that fails without it (the exception is the path scrub; see M3).

## What I ran
1. **WB6 I1's own probe against the fixed code.** File: `encryption: {atRest: optional}` + `residencey: {allowed: [local]}`. GET answers 200, `readable:false`, issues `["residencey: unknown key (check spelling) in governance.yaml"]`. No path, no newline. A real change in the same project (POST collections) gets 403 POLICY_DENIED. **Closed** for this input.
2. **23 file shapes, each through GET and then through a real change** (probe `server.probeFRA18.test.ts`, deleted afterwards). The GET answer's `readable` is compared with what the engine actually does. Results:

| file | GET | `readable` | issues (first) | engine (a real change) | agree? |
|---|---|---|---|---|---|
| not YAML (`encryption: [broken`) | 200 | false | "invalid YAML: Flow sequence … at line 1, column 20" | 403 | ✅ |
| empty file | 200 | true | — | 403 "Governance requires encryption at rest, but this project is not encrypted" | see M1 |
| YAML list / scalar / binary bytes | 200 | false | "top level must be a mapping" | 403 | ✅ |
| BOM + valid rules | 200 | true | — | 200 | ✅ |
| duplicate keys | 200 | false | "invalid YAML: Map keys must be unique at line 9, column 1" | 403 | ✅ |
| unknown top-level key / unknown nested key | 200 | false | "residencey: unknown key …" / "encryption.foo: unknown key …" | 403 | ✅ |
| wrong type (`audit.enabled: 'yes'`) | 200 | false | "audit.enabled: Expected boolean, received string" | 403 | ✅ |
| bad enum value holding a home-folder path | 200 | false | "encryption.atRest: Invalid enum value. Expected 'required' \| 'optional' \| 'off', received '\<path\>'" (scrubbed) | 403 | ✅ |
| impossible date | 200 | false | "retention.rawDataDestroyAfter: not a real date" | 403 | ✅ |
| profile that does not exist (`ferpa`) | 200 | false | "profiles.0: Invalid enum value. Expected 'irb' \| … received 'ferpa'" | 403 | ✅ |
| exception dated in the past | 200 | true | — | 200 | ✅ |
| exception without a reason | 200 | false | "exceptions.0.reason: Required" | 403 | ✅ |
| key `<img src=x onerror=…>` + U+202E + BEL | 200 | false | the key verbatim, with the bidi mark and the control character | 403 | ✅ (see M4) |
| 100,000-character implicit key | 200 | false | "invalid YAML: The : indicator must be at most 1024 chars …" | 403 | ✅ |
| 100,000-character explicit key (`? …`) or enum value | 200 | false | one issue of **100,049 / 100,092 characters** | 403 | ✅ (M2) |
| 5,000 unknown keys | 200 (≈14 s under load) | false | **5,000 issues, 3.3 MB answer** | 403 | ✅ (M2) |
| 5 MB file (valid, long comment) | 200 | true | — | 200 | ✅ |
| **file missing** | 200 | **true** | — | **403 "Policy could not be evaluated: governance.yaml is missing"** | ❌ **I1** |
| **dangling symbolic link** | 200 | **true** | — | **403 "… governance.yaml is missing"** | ❌ **I1** |
| symbolic link to a valid file outside the library | 200 | true | — | 200 | ✅ |
| a folder in the file's place | **500 INTERNAL** | — | — | 403 "EISDIR …" | M5 |

   - Not readable through permissions: not testable here (the probe runs as root). It would read like the folder case: `readMaybe` rethrows anything that is not ENOENT, so GET answers 500.
   - Locked encrypted project: GET 200 with the readability fields, as before.
3. **Saves (PUT):**
   - An unreadable text gives 400 VALIDATION "governance.yaml is invalid:\nresidencey: …". It cannot be saved, and the screen shows that message as its error.
   - With the file missing, a save of valid rules gives **403 POLICY_DENIED "governance.yaml is missing"**, with or without a reason (I1).
4. **Mutations, each reverted:**
   - Without the Capture screen's `!loadError` guard, the "request failed" test fails.
   - Without `setReadability` after a save, both Governance tests fail.
   - Without the import API's `readable === false` branch, the wizard's test fails.
   - Replacing the service's `clean` (scrub + collapse to one line) with the identity: **all 4 service tests still pass** (M3).
5. **Read in full:** the package, the brief, the report, R379 (the FR-A18 bullet, and R395 in the build line), R58 and R96. Read in the code: `mutate.ts decide/governanceOf`, `governance-edit.ts readGovernance/setGovernance`, `schema.ts parseGovernanceWithWarnings`, `scrubPaths`, `UserText`, `ErrorNote`, and the UI's policy readers.

## Findings

### Important

**I1 — A missing rules file (or a dangling link in its place) is answered `readable: true` while the engine refuses every change in the project, and the Governance screen cannot repair it.**
`apps/library-service/src/routes/governance.ts:75-87` (`governanceReadability`), with `:105`; this depends on `packages/library/src/repo/governance-edit.ts:60-63` and `packages/library/src/repo/mutate.ts:359-362`.
- How the two disagree:
  - `readGovernance` turns a missing file into the empty text, and `governanceReadability("")` gives the defaults: readable, no issues.
  - The engine's own read (`governanceOf`) throws "governance.yaml is missing", so `decide` refuses every capture, import, change and export.
- Probe: delete `governance.yaml` (or point a link at nothing) →
  - GET `{readable:true, issues:[], warnings:[]}`;
  - POST collections → 403 "Policy could not be evaluated: governance.yaml is missing".
- What the researcher sees:
  - The Governance screen shows the default cards and no alert.
  - Capture and Import parse `""` as readable defaults and say nothing.
- Worse, the screen cannot repair it. The save is evaluated under the missing file: `setGovernance` sees `pre.yaml === ""` as readable, so it sets no `unreadablePolicyFallback`. The PUT then answers 403 POLICY_DENIED, with or without a reason, and the screen shows only "This project's rules do not allow that."
- This is exactly the wall of refusals beside a screen that says the rules are fine (WB6 I1), reached by another way in. It breaks R379 FR-A18 and the dispatch's agreement requirement.
- Direction:
  - The answer must tell "no file" apart from "empty file". For example, `getGovernance` (or a sibling) says whether the file exists, and the readability answer is `readable:false` with an issue like "the rules file is missing".
  - The rules file's own save must be possible when the file is missing. That is the same repair path as for an unreadable file (judge the write under the new rules, with a reason); otherwise the alert points the researcher at a screen that cannot help.
  - The second part is a pre-existing gap in the library. The coordinator decides whether it belongs to this task, but without it the alert has no remedy.

### Minor

**M1 — Readable rules that the project cannot satisfy also refuse everything, with no alert.**
- An empty file (or a hand edit to `encryption.atRest: required`) in an unencrypted project is read as the defaults. Every store is then refused: "Governance requires encryption at rest, but this project is not encrypted" (`mutate.ts enforceConditions`).
- `readable:true`, and no screen says why. The save path refuses such rules (`setGovernance` checks the project's own state), so only a hand edit or an emptied file gets here.
- This is outside the letter of FR-A18 (the engine can read the file), but it is the same experience for the researcher. Needs the coordinator's ruling (whether "readable" should also cover "the project can meet these rules", or a separate note).

**M2 — The issues are not bounded in number or length.** `routes/governance.ts:79-84`; `GovernanceSettings.tsx:508`.
- 5,000 unknown keys give 5,000 issues and a 3.3 MB answer, all rendered as list items.
- An explicit `? …` key or an enum value of 100,000 characters gives one issue of about 100,000 characters (the zod message quotes the received value).
- It is the researcher's own file, so this is not a leak, but the brief asked for bounds.
- Direction: cap the lines (for example the first 20, then "and N more") and the length of each (cut with "…").
- Also: GET now parses the YAML twice (the old `violations` block at `:99-104`, then `governanceReadability`). Reuse one parse.

**M3 — The path scrub and the collapse to one line are not held by any test.**
- With `clean` replaced by the identity, all four FR-A18 service tests pass.
- None of them puts a path, or a newline, inside an issue. The test's `not.toContain(tmp)` holds only because the issue never contained a path.
- Direction: a file whose bad enum value is an absolute path (inside and outside the library root), and assert `<library>` / `<path>`.

**M4 — Control characters and bidi marks pass through to the screen.**
- `clean` collapses only whitespace: a BEL (U+0007) and U+202E from a key reach the issue text.
- `UserText` renders it as text (no markup, so safe), and its `dir="auto"` isolates the line. But U+202E still reverses the "unknown key (check spelling) …" part of that one line visually.
- Direction: strip C0/C1 controls and bidi overrides from the quoted key, or wrap the quoted part in its own `UserText`.

**M5 — A folder (or an unreadable file) in the rules file's place gives a 500.**
- GET `/projects/:id/governance` answers 500 INTERNAL "Something went wrong" (EISDIR from `readMaybe`), so the Governance, Capture and Import screens show a generic failure while the engine refuses with "EISDIR …".
- This is pre-existing, not caused by the fix, but the dispatch says "never a 500".
- Direction: map the read failure to `readable:false` with "the rules file cannot be read (it is a folder / not readable)".

**M6 — Without the service's field, the import API calls rules readable that its own reader cannot read.**
- `api/import.ts:340` returns `{...importPolicyFromYaml(g.yaml), readable: true}` even when its own parse failed, because `importPolicyFromYaml` swallows the failure.
- The Capture API derives `readable` from its own parse instead, so the two screens disagree on an older answer without the field.
- The UI and the service ship together, so this is Minor.

**M7 — Other places still fall back silently** (listed as the dispatch asked):
- **ReviewQueue** (`ReviewQueue.tsx:505`) and **Zotero sync** (`ZoteroSync.tsx:512`) read the import policy and fall back to strict without the sentence. The report left these out.
- **The browser extension:** `GET /projects` gives `captureMethods: []` for unreadable rules (`routes/projects.ts:15-21`), so the project silently vanishes from the extension's list (`Popup.tsx:148`).
- **Fieldwork, exports, the reader, Find and acquire, watched folders, settings and the Library drop zone** do not read the rules. Their refusals come back from the service as POLICY_DENIED with the reason "Policy could not be evaluated: governance.yaml is invalid: …", which `errorText` shows. That is terse but not silent.
- `api/library.ts:363` declares `governance()` with the old type, and nothing calls it.

**M8 — Two points the report already deferred, confirmed:**
- After an unreadable file, the first save still asks for a reason, and the dialog shows the machine-built sentence (WB6 M6).
- The Governance test's PUT double answers 200 without that step, so the test does not exercise the real flow.

## Checked and sound
- **Every unreadable shape except a missing file or a folder:** GET answers 200, `readable` matches the engine, and each issue names the key and the problem. There is no stack, no class name and no library path. A home-folder path quoted in a value is scrubbed to `<path>`. A YAML parser message is cut to its first line, with the `governance.yaml:` prefix removed.
- **Warnings (R58's non-fatal notes):** the old-form legal-basis key and exceptions that waive nothing reach GET and PUT. A readable file never carries issues; an unreadable one never carries warnings.
- **Governance screen:**
  - The alert appears only when `readable` is false: `role="alert"`, the `ao-warning` class, the exact text, the issues each through `UserText` (React text, never markup). Focus is not moved (asserted).
  - The cards still render, and the YAML stays editable.
  - "Save changes" is enabled once the text parses leniently, and is refused (400, message shown) while the engine still cannot read it.
  - After a readable save the alert goes; tested, and the test fails when the line that resets it is removed.
  - The warnings' note is a plain `div.ao-hint`, not an alert.
  - Locked or read-only: the alert shows beside the read-only reason, and the controls stay off.
  - Stale answers: the screen is keyed by project (`routes/governance.tsx:26`).
- **Capture:**
  - The sentence shows for the service's `readable:false` and for rules the screen's own reader cannot parse, and not when the request failed (a mutation proves that guard).
  - Strict controls unchanged.
- **Import wizard:**
  - The sentence shows on the first step through `ErrorNote`, and is reset on a project change.
  - "Link in place" stays disabled; the guard is proven by mutation.
- **Contract:** GET and PUT are the only producers of the rules' answer. No restore, new-project or profile route returns it. Consumers tolerate an older answer: the Governance screen's `readabilityOf` defaults to readable with empty lists, and capture and import read `Partial<>`. The command line does not read this route.

## Could not verify
- A file made unreadable by permissions (the probe ran as root). By reading the code, it would answer 500 like the folder case.
- Screen-reader announcement of the alert (needs VoiceOver or NVDA). By reading the code, the alert is inserted once, with its content, when loading ends, and is not re-inserted on re-render.
- WebKit or end to end: none exists for this, as R395 (b) accepts.
