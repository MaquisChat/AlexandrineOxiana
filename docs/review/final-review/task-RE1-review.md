# Review — rough-edges batch RE-1 (core and library)

Worktree `.claude/worktrees/re-1-core`, branch `re-1-core`, 567d98d..05451c3 (six commits). The three items sent back under R469 (FR-368, FR-420, FR-423) were not reviewed.

**Verdict: NOT APPROVED.** There are three Important findings. FR-425's guard is far wider than the roll-back it is meant for. FR-410/618's ruled sentence is untrue in every restore case that reaches it (it needs a ruling). FR-124's mixing of two works still happens through a sidecar file. FR-030, FR-106, FR-411 and FR-123 hold, with small points. FR-047 and FR-142 are confirmed closed.

## What I ran (all at `nice -n 10`; every probe deleted; `git status --short` empty at the end)
- I read the briefs, the report, the list entries, R365, R394/R410/R422/R425/R446 and R469, and the whole diff.
- Probes (`*.probeRE1.test.ts`, each a copy of the neighbouring test file with one probe block added, run with `-t PROBE-RE1`):
  - `export/restore-governed.probeRE1`: (A) one file destroyed on a verified record beside one left out on a bystander's damaged log, then restored three generations deep; (B) the backup's own project's live log damaged after the destruction; (C) an encrypted project.
  - `import/attach.probeRE1`: a sidecar `.ris` beside a PDF that cites a DOI.
  - `repo/sources-read-race.probeRE1`: real outside edits while a roll-back is pending.
- Guard mutations, each one put back with `git checkout -- <file>`:
  - removing the restore's carry-forward fails FR-410 test 1;
  - removing the export's id check fails FR-410 test 1;
  - making `inTurn` call `work()` directly fails the FR-411 test (raw `ENOENT … rename`);
  - removing the `!st.recoveryPending` guard fails the FR-425 test;
  - removing the step-6 title guard fails the FR-123 test;
  - forcing `mixed = false` fails the FR-124 test.
- Touched test files: `attach`, `library` and `profile-capture`: 140 passed. Core `engine.test.ts`: 139 passed. `registry-notice`, `sources-read-race` and the FR-410 tests passed when run with the guards in place.

## Findings

### Important

**I1 — FR-425: the warning is turned off for the whole project, for as long as `recoveryPending` holds, whatever caused it. A real change made outside the app hides behind it, and nothing true is said in the warning's place.** `packages/library/src/repo/sources.ts:156`.
- Probe: the failed undo of `setAnnotations(sid)` (the FR-425 test's own set-up), then two outside edits:
  - another source of the same project: its `annotations.json` gets "tampered";
  - the same source's leftover file is edited by hand.
- Both reads returned the edited text as the source's annotations (`["a","tampered"]`, `["edited by someone"]`). The integrity warnings were `[]`.
- After the reopen, the roll-back silently overwrote the same-source edit. Only "rolled-back-incomplete-write" was recorded. The other source's edit was reported only because it was read again.
- `recoveryPending` is set for more than a failed in-process roll-back:
  - a marker still pending at open, `repo.ts:678-679`;
  - an incomplete audit line, the same lines;
  - `audit-append-failed-at-open`, `repo.ts:740`.
- In a read-only library, or when the cause comes back on the reopen, it lasts across reopens. So the comment's promise, "a real change outside the app is still found by a read after that open", does not hold there.
- What is said instead: nothing. `projectWarnings` shows no notice for `recoveryPending` (`repo.ts:1203` only passes it on to the attention warnings). While the roll-back waits, the researcher reads the half-undone change, which already failed for them, as the source's notes, with no sign. Before this change the (misattributed) warning was the only sign. This edges on "a half-written change presented as real".
- Direction:
  - Keep the warning off only for the source folders that the pending marker names.
  - For those, say the true thing (a change to this source's notes did not finish and could not be undone; reopen the library to put it back), or return the pair from before the change.
  - Every other source keeps the D21 warning.
  - Add a test for another source changed outside the app while the roll-back waits.

**I2 — FR-410/FR-618: the ruled sentence "The project's log says this file was destroyed under its retention rule; that entry could not be verified." is not true in the restore cases that reach it.** `packages/library/src/export/project-export.ts:507-511`.
- A restore never goes ahead on the backup's OWN project's unverified log. Probe B was refused: "The audit log of the project "Origin" does not hold together … nothing was restored here."
- So a file in `destroyedUnverifiedAssetIds` was always left out because of ANOTHER project's records, or a planted folder's (`restore.ts:621-628`; R179 / R182 d).
- The copy's log holds no destruction entry for it. It holds only the restore's own (verified) entry, which says the file was left out on unverified records. Probes A and C, and the implementer's own test 1 (the Bystander case), all print the sentence.
- So "the project's log says" and "its retention rule" both claim more than the evidence gives. The sentence names the wrong log and the wrong rule.
- The verified sibling ("1 file was destroyed under the project's retention rule") is likewise another project's rule in the cross-project case. That wording is older than this task (see M5).
- The sentence's wording comes from the list entry FR-618 itself, so this needs the coordinator's ruling, not a fix by the implementer.
- Suggested wording for a restored copy: "1 file is not included. It was left out when this project was restored from a backup, because records the app could not verify name it as destroyed." (plural likewise).
- Suggested wording when the project's own log does not verify (the `null` branch): "1 file is not included. It is marked as destroyed, but the project's audit log does not hold together, so the app cannot confirm it."

**I3 — FR-124: two works are still mixed in one record, through a sidecar.** `packages/library/src/import/resolve.ts:497-505` and step 4 (`:528-537`).
- The set-up: a text-only DOI with no title of the file's own, so `ungrounded` applies, and the cited work's values are offered with override. Then a sidecar `.ris` gives the item's own title, author and year (score 0.85 > 0.6, so it overrides only the fields it has).
- Probe output: title "Minutes of the reading group", creators "Doe, Jane", year 2024 (the sidecar). Beside them, from the cited work's lookup: container "Journal of Upland Studies", volume "12", publisher "Example University Press".
- The reasons are a title conflict and "An identifier found in the file could not be confirmed…". Neither says that the journal, volume and publisher came from the cited work. `LOOKED_UP_FROM_TEXT` is not shown, because the title no longer equals `textLookupTitle`.
- This is the brief's "must hold" ("nothing in the review step presents a CITED work's details as this document's own without saying where they came from"), broken by another way in. The behaviour is older than this task, but it is FR-124's own rough edge.
- Direction: when a later step brings the item's own title, take back the fields that only the text lookup gave (keep them as the candidate). Otherwise, keep saying `LOOKED_UP_FROM_TEXT` while any value that lookup gave is still in the draft. Add a test with a sidecar.

### Minor

- **M1 — FR-410: older restored copies.** A copy restored before this change has `leftOutUnverified: n` in its `project.restored` entry but no id list. Its export, and a restore of its backup, still state those destructions as fact (`project-export.ts:385-391` reads only `destroyedUnverifiedAssetIds`). I judged this by reading. Direction: when a `project.restored` entry has `leftOutUnverified` and no list, treat every file that entry left out as unverified (for example, every destroyed asset whose `destroyedAt` equals that restore's time), or say the count.
- **M2 — FR-410: a leaked `.partial` folder.** `verifiedAuditEvents` (`project-export.ts:385`) runs after the `.partial` folder is made and added to `activePartials` (`:357-360`), but before the `try` at `:398`. If reading the log throws (an I/O error), an empty `<name>.partial` is left in the destination, and `activePartials` keeps it for the rest of the process. Direction: read the log before creating the folder, or move the read inside the `try`.
- **M3 — FR-411: the turn is per process only, and the report's reason for that is wrong.** The command line also writes the list: `apps/cli/src/commands/library.ts:21,39` and `session.ts:93` call `createLibrary`/`openLibrary`, which call `registerLibrary` (`library.ts:507`). The service and the command line can therefore still race: one registration can be lost, and over a damaged list one rename can fail. That failure is swallowed in `note()` and logged in the chooser's route. Reads (`listLibraries`, `state.ts:802`) are outside the turn: one that falls between `backupIfDamaged`'s rename and the save sees no file and gets an empty list. I judged this by reading. Direction: correct the report; if wanted, a lock file or a re-read and merge before save.
- **M4 — FR-030: the guessed and folder sentences.** When the kind of destination was guessed, `move.ts:483` wraps the new sentence as "Destination type could not be determined (it may be cloud_folder): The library would be moved to a cloud-synced folder; …". That keeps an internal kind name and states as fact what was only guessed. The sibling sentence `engine.ts:280` ("Cloud folder <id> is not on this project's approved list", no full stop, "(unspecified)") is in the same refusal family and is still not plain. Direction: one plain sentence for the guess ("The library's new place may be a cloud-synced folder; …") and a plain sentence for the folder case.
- **M5 — The verified export sentence names the wrong project's rule.** "destroyed under the project's retention rule" for a copy's file left out on another project's verified record (probe A's first line, when the destroying project was a bystander). This is older than the task and is shown beside I2's sentence. Settle both in the same ruling.
- **M6 — FR-106: three wordings for one count.**
  - CLI: "N possible edit(s) not checked: run the same command later…";
  - capture queue: "N possible edits not checked (capture the profile again later to check them)";
  - report file: "Captions that look edited but could not be checked: N. Run the capture again later…".
  - "edit(s)" is not a whole word form. Each is true; this is a matter of consistency.
- **M7 — FR-123: an identifier from the file's metadata, not its text.** `LOOKED_UP_FROM_TEXT` says "found in the file's text", but untrusted identifiers also come from the file's metadata fields (`extract/index.ts:68-77`; a PDF's XMP/Info DOI, `pdf.ts:86`). For such a DOI the sentence names the wrong place. "found in the file" would be true in both cases.

## Per item

| FR | Implementer's claim | Verdict | Note |
|---|---|---|---|
| FR-030 | Refusal no longer names the project's id | holds | Plain and true for a known kind; M4 for a guessed kind and for the folder case. Five tests changed or added; checked by reading that they assert the new sentence. |
| FR-047 | Closed (273145d) | holds | `library.ts:72-83,190`; the test at `library.test.ts:122` passes; a folder of `.DS_Store` only counts as empty, and a directory or link of that name still counts. |
| FR-106 | Counted, reported everywhere | holds | Counted only when the post's own fetch returns nothing; the next run checks again (nothing was stored). M6. |
| FR-123 | Marked, with no title search on the cited title | holds | The guard is held by its test. R394/R410/R422/R425/R446 are untouched: the change lives only in the `ungrounded` branch, which needs no local title, and in step 6. A document's OWN DOI in its text now stays at 0.6 instead of 0.8. Both go to review (threshold 0.9), and the sentence's "may" is true. M7. |
| FR-124 | Not mixed with a reference DOI | partly | The reference-DOI case is held by its test; the sidecar path still mixes (I3). |
| FR-142 | Closed (c2ef36f) | holds | `engine.ts:7` "files with a location"; no "photos" wording left. |
| FR-410 / FR-618 | Built to R365 a | partly | Mechanics sound (see below); the sentence is untrue (I2, needs a ruling); older copies (M1); `.partial` leak (M2). |
| FR-411 | One change at a time | partly | Holds in one process; the command line is a second writer (M3). |
| FR-425 | Leftovers not called outside changes | does not hold | Much wider than the case, and says nothing in its place (I1). |

## Checked and sound
- **FR-410 mechanics.**
  - The ids are written in the copy's `project.restored` entry. That entry is appended to the staging folder's audit log before the rename, through the same crash-safe path as the rest of the entry (`restore.ts:806-830`).
  - The ids are mapped to the copy's (`ids.get`), so they match the copy's assets. The carry-forward reads the backup's log only after `verifyChain` has passed (`restore.ts:527-534`).
  - Probe A, three generations: each entry names the current copy's id, and the third copy's export still says "could not be verified".
  - When the copy's log no longer verifies, nothing is stated as fact (the `null` branch; the implementer's test 2).
  - A file destroyed on a verified record beside one left out on unverified records gives two notes with the right counts (`omittedFiles` 2).
  - A library with no such field exports exactly as before (the read happens only when there is a destroyed original).
  - Encrypted project (probe C): the plain-text audit line holds only UUIDs and counts, no names or paths. Asset ids were already in plain-text destruction entries.
  - Size: one id is about 39 bytes in one audit line (about 390 KB for 10,000 files). There is no line limit in `AuditStore`, nothing on screen shows these details, and the export reads the whole log anyway.
  - Destruction certificates are untouched: a copy gets none.
- **The other locks.**
  - The export's `verifiedAuditEvents` enters `core.serial`, and `exportInner` is not inside a turn, so there is no deadlock.
  - FR-411's `inTurn` is not re-entered (no registry function calls another inside its turn), and a rejection does not block the next change.

## Could only judge by reading
- M1: older copies.
- M3: two processes.
- The FR-425 open-time causes: a read-only library, a marker still pending at open, `audit-append-failed-at-open`. Only the in-process case was probed.
- M7: an XMP DOI.
- A backup whose log has been cut at the end (chain still verifying), which would drop an earlier restore's mark: whether the backup's seal or hash catches that.

## Second look (R473)

Scope: 05451c3..74ef3ad (RE-1c, seven commits): R473's points I2 with M1 and M5, then M2, I3, M7, M3, M4 and M6. Not looked at: I1 (FR-425) and the queue work of FR-368/420/423 (they are on `re-1b-core`).

**Verdict for this round: NOT APPROVED.** One Important finding remains (S-I1). Everything else holds as ruled, apart from four Minor points.

### What I ran
All at `nice -n 10`. Every probe was deleted; `git status --short` is empty; head is 74ef3ad.

- **Probes on the export** (`export/restore-governed.probeRE1`, a copy of the test file):
  - P1: a destruction entry of the earlier form (no file list), made before the backup.
  - P2: the project's own destruction and a bystander's verified one, at the same moment.
  - P3: one export of a copy that has all three kinds — its own later destruction, a file left out on a verified record, and one left out on unverified records.
  - P4: the copy's log cut at its end, so the restore entry is gone, then the library reopened.
- **Probes on the import** (`import/attach.probeRE1`), five orders:
  - a sidecar with the item's own title;
  - a sidecar with an identifier only;
  - a sidecar whose title equals the cited work's;
  - two sidecars;
  - no sidecar.
- **Probes A, B and C are now part of the implementer's tests:** "probe A … three restores deep", "probe C … encrypted", "probe B's ground". With them: a restore of a restore, a file destroyed before the backup, the legacy entry (M1) and the failed log read (M2). I read each of these tests.
- **Test files of this round**, re-run after the restart:
  - library `restore-governed`, `attach`, `registry-notice`: 133 passed;
  - library `move`, `profile-capture`: 107 passed;
  - core `engine`: 140 passed;
  - shared: 14 passed;
  - cli `output`: 3 passed;
  - ui `CaptureQueue`: 22 passed.

### Findings

**S-I1 (Important) — FR-410/618: the copy's log cut at its end, and the export states as fact what only unverified records said.**
- Where: `packages/library/src/export/project-export.ts`, `destroyedBasis` (~:155-178) and the read through `verifiedAuditEvents`.
- Probe P4:
  - A copy's file was left out on a bystander's damaged log (unverified).
  - The copy's log was cut at its last line, which is the `project.restored` entry, and the library reopened.
  - The app knows the log was cut: integrity warning `truncated`; an `audit.anchor-mismatch` event in the log; `repo.verifyAudit(copy)` returns `{ok:false, anchored:true, alteredAt:[…]}`.
  - Yet the chain verifies again from the reopen's head, so `verifiedAuditEvents` answers `ok`. With no restore entry left, `destroyedBasis` takes the copy for a project never restored.
  - The notes say: **"1 file was destroyed under the project's retention rule and is not included."**
- The first round's code did the same. But this is exactly what FR-410 exists to stop, and the app holds the evidence.
- Direction: for these notes, take the log as intact only where `verifyAudit` says so (no recorded anchor mismatch, no cut). Otherwise use the `logNotIntact` sentence. Add a test with the end of the log cut.

**S-M1 (Minor) — FR-724 is not the only inaccuracy, because the destruction is matched by its time.**
- P1, the earlier form of the destruction entry (no `destroyedAssets`, a form real older libraries hold):
  - That entry adds nothing to `recordedAt` (`Array.isArray` guard).
  - A file destroyed in the original BEFORE its backup therefore reads in the copy as "It was left out when this project was restored from a backup, because a verified record in this library shows it was destroyed."
  - That is false: `leftOut` was 0. The origin itself still says the own-rule sentence correctly.
- P2, a match by moment:
  - A file left out because a BYSTANDER's verified record destroyed the same bytes at the same millisecond as one of the project's own destructions is counted as "own".
  - The result was "2 files were destroyed under the project's retention rule…", where one was another project's.
  - In real use this needs the same millisecond. It has the same root as FR-724.
- Direction: record the destruction's time even for the earlier form; and list FR-724 together with these two (matching by moment can name the wrong rule), or match by the destruction's own record of hashes.

**S-M2 (Minor) — M1 is applied wider than the ruling.**
- A legacy entry anywhere in the log (`countOnly`) turns every file of the copy left out on a verified record into "records the app could not verify" — including files left out by LATER restores on verified records.
- That is safe, but the sentence is then untrue for those files. R473 M1 says "every file **that restore** left out".
- Judged by reading.
- Direction: limit it to the files whose `destroyedAt`/restore matches that legacy entry, or accept it and say so in the ledger.

**S-M3 (Minor) — M3: a set-aside list can overwrite another.**
- `registry.ts` `update`: when the list read again is also damaged (another process wrote a damaged list in the window), `backupIfDamaged` renames it onto the SAME `libraries.json.corrupt-<stamp>` name. The stamp is to the second, so the first copy set aside is overwritten. Its usable entries are merged first; the rest of it is lost.
- Only with two processes in the same second. Judged by reading.
- Direction: a unique suffix for the second set-aside copy.
- Note: the list is read again only after a damaged list was set aside, not before every save. The ordinary race between processes is left to FR-721, as ruled.

**S-M4 (Minor) — Two stray comments, cosmetic.**
- `packages/shared/src/api/capture.ts:24`: the comment "How long a finished queue stays readable (1 hour)." now sits above `editsNotCheckedText`, not above `CAPTURE_QUEUE_KEEP_MS`.
- `packages/ui/src/components/CaptureQueue.tsx:53`: the FR-106 comment is left above the `lead` line.

### Per point

| Point | Verdict | Note |
|---|---|---|
| I2 + M5 (four sentences) | holds, except S-I1 and S-M1 | All eight sentences (four kinds, singular and plural) match R473 I2 word for word; the plural audit-log sentence keeps "confirm it", as the implementer says. P3: own, restored-verified and restored-unverified each say their sentence once in one export; `omittedFiles` 3 is the sum. Three generations deep: each file keeps its sentence. Encrypted project: the same. A file destroyed before the backup: own-rule sentence. The copy's log damaged inside the chain: the audit-log sentence for every destroyed file. Its end cut: S-I1. |
| M1 (legacy entry) | holds, wider than ruled (S-M2) | The test rewrites a real entry and reopens; both the export and a restore of its backup say "could not verify". |
| M2 (failed log read) | holds | The log is read before `mkdir` and `activePartials.add`; the test makes `AuditStore.read` fail with EIO and the destination stays empty. The list of active partial folders is never touched on this path. |
| I3 (FR-124) | holds | Own title from a sidecar: journal, volume and publisher are gone; the cited title stays as evidence (the conflict is shown); the candidate and the hint stay; `LOOKED_UP_FROM_TEXT` is not said. Two sidecars: the first, without a title, is passed over; the cited work's creators and date are dropped (the review then says "Creators is missing", which is true). A sidecar with an identifier only is not taken, so no own DOI sits beside cited details. A sidecar whose title equals the cited work's: the lookup's details stay, with the sidecar's author and `LOOKED_UP_FROM_TEXT`. I accept that, since the researcher's own record names that work. "The sidecar first" cannot happen: step 3 always runs before step 4. |
| M7 (FR-123) | holds | "found in the file"; no old sentence left. |
| M3 (FR-411) | holds (S-M3) | Reads wait in the turn, and no registry function calls another inside its turn (no deadlock). The comment names the command line as a second writer (FR-721). Both new tests fail without the change, by the report and by reading. |
| M4 (FR-030) | holds | `uncertain` is checked with `bool` (fails closed). The only caller of the move request is `move.ts:481`, and no screen or test matched the old "Destination type could not be determined" prefix. A guessed kind now says "may be <plain words>", and the cloud-folder refusal is a plain sentence with no id. The backup's and restore's cloud-folder sentences still name the folder id (the implementer's deferred point, outside M4). |
| M6 (FR-106) | holds (S-M4) | One sentence from `@ao/shared`, used by the command line, the capture queue and the report file. No old wording is left (grep). The queue summary always has parts before it, so it never reads "Finished: .". |

### Broken in what was approved before
Nothing found. FR-030's plain sentence, FR-106's count, FR-123's guard and FR-411's turn all still hold, and their tests pass.

### Could only judge by reading
- S-M2 and S-M3.
- Two real processes racing on the libraries list (FR-721).
- Whether a cut at the end of a BACKUP's log is caught before a restore.
