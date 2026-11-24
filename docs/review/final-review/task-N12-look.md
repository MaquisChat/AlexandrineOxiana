# N12's two mends (46338c8, e3527e6) — the reading-only look (24 November 2026; nothing was run)

Kept from the reviewer's final message. Verdict: the integrity-check mend (e3527e6) APPROVED; the move mend (46338c8) APPROVED WITH SMALL POINTS.

## Important
1. **A move that fails after its "close-source" step leaves the service's session with a closed index** (from the move mend, on top of an older fault).
   - Steps that can still throw after close-source: each step's `writeJournal(dest, j)` (`move.ts:820`), `markPendingComplete` and the unlink in "finalize" (`move.ts:868-870`), and the test crash hook (`move.ts:821`).
   - When `executeMove` throws, the route sees `state.session === s` still true, calls `state.activate(s)` and resumes batches on that session (`routes/libraries.ts:340-347`).
   - `s.lib` is already closed, and since the mend so is `s.index`. Before the mend only writes failed (`LibraryClosedError`). Now index reads fail too: `IndexHandle.db` hands back a closed better-sqlite3 connection (`index/db.ts:51-58`), so a search raises a raw error.
   - The deeper fault was already there: the failure path assumes "the old library carries on as before" (`libraries.ts:341`), which is false once close-source has run. The route should check `isClosed(s.lib)` and treat the library as moved (open it at the destination) rather than reactivate the session.

## Minor
2. Between close-source (`move.ts:858`) and the route's `closeLibrary()` (`libraries.ts:370`), during a SUCCESSFUL move, routes that only need `requireSession` (`state.ts:657-662`) still hand out `s.index`, now closed: a search in that window errors where it used to read.
3. The mend's comment ("checkpointed before the copy and not written since", `move.ts:856`) holds only on the fresh path: the checkpoint is at `move.ts:619`; a RESUMED switch (`finishesSwitch` then `completeMove`, `move.ts:607-608`) runs none, so what the reopened service wrote into the index since the restart (`startIndexRebuild` at adopt, `state.ts:752`) is folded into `library.sqlite` when the index closes; old and new then differ and `deleteOldCopy` keeps that file (fail-closed, `move.ts:1146-1148`). On the fresh path no index writer was found in the window (`quiesce` stops the rebuild, background work, Find and watches, `state.ts:1159-1209`; `assertNotMoving` refuses changes; in-flight changes are drained first, `libraries.ts:289`); not every GET route was audited for index writes.
4. The `MoveOptions.index` doc (`move.ts:167`) still says only "checkpointed": it should say the move closes the index together with the source. Inside the repository the only caller is the service, which always passes one (`libraries.ts:337`); the CLI never calls `executeMove` or `completeMove`.
5. Older, outside these commits: `state.ts:716` and `:746`, and the CLI's `session.ts:110`, close the index before `lib.close()` waits for registered work (the opposite order to M7) — on paths where opening the repository failed or the session was never activated.

## Every `close()` of a `Library`
| Site | Index open? | Closed by / order | Verdict |
|---|---|---|---|
| `state.ts:682`, `:688` | no (adopt has not opened one yet) | – | safe; never adopted |
| `state.ts:717` | maybe | `index?.close()` at :716, before the lock's release | safe (Minor 5) |
| `state.ts:747` (unwanted) | yes | :746, before the lock's release | safe (Minor 5) |
| `state.ts:880`, `:884` | no | – | safe; never adopted |
| `state.ts:1339` closeLibrary | yes | beforeRelease | the reference case |
| `reconnect.ts:868` | no; `rebuildIfNeeded` closes its own handle (:883) | – | safe |
| `move.ts:858` | yes (service) | beforeRelease (the mend) | safe on success; Important 1 on failure |
| `move.ts:991` | no; its own fresh library, no index | – | safe |
| cli `session.ts:96` | no (read-only) | – | safe |
| cli `session.ts:111` | maybe | :110, before release | safe (Minor 5) |
| cli `session.ts:138` | yes | beforeRelease; one shared closing promise | safe |
| cli `commands/library.ts:27`, `:47` | no | – | safe |

None of these plain closes can run before a later `close({ beforeRelease })` of the same object; the only such pair was the move's close followed by `closeLibrary`, now covered.

## The integrity-check mend
- A turn refused at its start (`repo/state.ts:305`), closed or moved: goes to `endIfClosed`, which throws `ReadOnlyLibraryError("moved")` for a move and `ReadOnlyLibraryError(readOnlyReason)` for a plain close (the reason undefined for a library opened read-write).
- Refused through the closing signal while the library is not yet closed (`state.ts:242`): `isClosed` is false, the original `LibraryClosedError` is rethrown — right.
- `endIfClosed` cannot mask the cause (its `lstat` failure becomes `false`).
- A split move writes no `MOVED.json` at the root (`move.ts:843`), so the check reports "closed", not "moved" — as it already did between batches.
- The route turns either error into `checkStoppedByClose` only when `state.session !== s` (`libraries.ts:436`); during a move's switch the session is still `s`, so the "moved" error reaches the client.
