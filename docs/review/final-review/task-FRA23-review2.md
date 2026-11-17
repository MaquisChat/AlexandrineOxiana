# FR-A23 — scoped second look (R449), 4d571dd..b32595e

## Verdict: APPROVED WITH SMALL POINTS

R449 is met point by point. My round-1 Important findings are closed:
- **I1:** one look at a time in the whole process. Thirty paths start one look, and the flag always clears.
- **I2:** nothing under Documents is looked at.

M1, M2, M3, M4 and M6 are closed. M5 and M7 are closed as R449 e and f word them.

Four small points remain (S1 to S4). None is Critical or Important. Two of them, S1 and S2, follow directly from the wording of R449 b and e, and need the coordinator's ruling.

## What I ran
All at `nice -n 10`, one file at a time. Both probes are deleted, and `git status --short` is empty.

- **`@ao/library` probe** (`library-place.probeFRA23.test.ts`):
  - G1: the flag after a look that throws synchronously (in `isFolder` and in `free`), a rejected look, and a path refused before the look.
  - G2: three requests in the same tick.
  - G3: the bound answers first and the look settles later.
  - S1: the suggestion with a rejecting look, a look that throws synchronously, a request joined after the bound, and a fresh look after it settles.
  - S2: the paths the suggestion looks at; a `.DS_Store` + `.localized`-only folder suggested, then `createLibrary` on it.
- **`@ao/ui` probe** (`LibraryChooser.probeFRA23.test.tsx`):
  - F: `roomSentence` at every boundary, plus an exhaustive check of exact values (every 0.1 GB from 1 to 9.9, every 0.1 TB from 1 to 9.9, every whole GB from 10 to 999, every whole MB from 1 to 999).
  - R1: a slow first look, then the box is edited.
  - R2: the next request never answers; then an answer of 500 after a figure.
- **The task's own files, after deleting the probes:**
  - `library-place.test.ts`: 19 passed.
  - `library-place-routes.test.ts`: 8 passed.
  - `LibraryChooser.test.tsx`: 18 passed.
- I made no edits to tracked files. Whether each guard is held by a test was judged by reading (section 6).

## 1. Probes against the new code, and the guard's other side
- **P1 (thirty paths on a hung share):** one look runs; the other 29 answer "cannot tell" at once. Both the implementer's test and my G2 (three calls in one tick: `[7e9, undefined, undefined]`, 1 look) show this.
- **The flag never sticks** (G1). Each of the following gives "nothing", and the next call then answers 5e9:
  - an `isFolder` that throws synchronously (`look` is an async function, so the throw becomes a rejection, which is caught);
  - a `free` that throws synchronously;
  - a rejected look.

  A refused path (`rel`, NUL) returns before the flag is set.
- **The bound answers first** (G3): the 2 s bound answers "nothing", and a request meanwhile also gets "nothing". After the look settles, the next request looks again (5e9).
- **The suggestion** (S1):
  - A rejecting look, or one that throws synchronously, answers "nothing", and the next request looks fresh.
  - A request after the bound joins the already-answered promise ("nothing", one look).
  - After the look settles, a fresh look gives `/h/Alexandrine Oxiana`.
- **P2:** not applicable any more (Documents is not read). **P4:** closed by `lstat` and held by the implementer's real-folder test (a link to nowhere, a link to an empty folder, a file → " 4", and create succeeds).
- **U1 and U3:** see sections 3 and 4.

## 2. (a) The home folder only
- **Documents, Desktop, Downloads:** `grep` finds no such path in `library-place.ts` or the route. With an injected look on darwin, 9 paths were looked at, and none contains Documents, Desktop or Downloads (S2).
- **The home folder's cloud classification:** `classifyLocation(home, env)` only, with no look (implementer's test: `looked` is empty).
- **`.DS_Store` + `.localized` only:** suggested as free, and `createLibrary` on it gives "created". Both count with `entriesBesidesFinderFiles`.
- **A home that is a symbolic link:** only the candidates under it are `lstat`ed, and a link at a candidate is taken. Sound.
- **An unreadable home** (EACCES on each candidate): each candidate is "unreadable", which counts as taken, so there is no suggestion. That agrees with the ruling's "none". By reading: as root I cannot make EACCES; the injected "unreadable counts as taken" test covers the state.

## 3. (d) The figures
- 0 and 999,999 → "less than 1 MB." + the little-room sentence.
- 1e6 → "1 MB." and 999.6e6 → "999 MB."; both + the little-room sentence.
- 1e9 → "1 GB." and 9.96e9 → "9.9 GB."; both + the little-room sentence.
- 9,999,999,999 → "9.9 GB." + the little-room sentence.
- 10e9 → "10 GB."; 999.9e9 → "999 GB."; 1e12 → "1 TB."; 3.6e12 → "3.6 TB."; 1.5e15 → "1500 TB.".
- **Exact values:** in the exhaustive check, 0 exact values were understated by a floating-point step (e.g. 2.3 GB stays "2.3 GB").
- **No contradiction:** the little-room sentence appears exactly when the figure is under 10 GB.
- **Non-finite or negative numbers** never reach `roomSentence`: the screen checks `Number.isFinite(r.freeBytes) && r.freeBytes >= 0` first (`LibraryChooser.tsx` effect), so "NaN" or "Infinity" cannot be written.

## 4. (e) The line while typing
- **The CSS:** `.ao-library-room { min-height: calc(var(--line-spacing) * 1em) }` (`library.css:60-62`).
  - `--line-spacing` is defined once in `theme/base.css:8`, outside the per-theme colour tokens, so it is the same in both themes.
  - The value is in `em`, so it scales with 200% text.
  - It is a minimum, not a fixed height, so a wrapped little-room sentence grows the line and is not clipped.
- **Same words:** the line does not change when the words are the same (the implementer's MutationObserver test). So a screen reader hears a figure only when it differs.

### S1 — the old disk's figure stays against a new path, and indefinitely if the request never answers (Minor; needs a ruling)
`LibraryChooser.tsx` room effect: no client-side bound; the API client has no timeout.

- **What happens:** R2 typed `/Users/r/lib` (500 GB shown), then selected all and typed `/Volumes/Tiny/lib` with a request that never answers. Three seconds later the box held `/Volumes/Tiny/lib` and the line still said **"Free space on that disk: 500 GB."**
- **How long:**
  - Normally the old words stay for the whole time the researcher types, then 600 ms, then at most about 2 s (the service's bound).
  - A 500 or a refused connection empties the line (R2 after 500: `""`).
  - The figure stays for ever only when the service accepts the request and never answers. The service's own 2 s bound makes that rare (a hung or very slow service).
- **Compared with what it replaced:** in the normal case this is what R449 e asks for, and it is arguably better than the jump. But nothing tells the researcher that the figure belongs to the previous path. A researcher who picks a folder on another disk with **Choose folder…** and presses Create within about 2.6 s sees the previous disk's figure.
- **Smallest fix:**
  - Bound the screen's wait: empty the line if no answer has come about 3 s after the request (e.g. `AbortSignal.timeout`).
  - Optionally, empty at once when the picker fills the box, as opposed to typing.
  - Whether the stale window is acceptable is the coordinator's call.

### S2 — the screen's own earlier request can leave the final path with no figure (Minor; needs a ruling)
`library-place.ts:503` with the screen's room effect.

- **What happens:** R1 simulated the service guard. A first look took 1.5 s (a disk spinning up). The researcher added " 2" during it. The new request was answered "cannot tell" at once. The first answer was dropped as stale, and nothing asks again, so the final line was `""` for a path whose room could be told a moment later.
- **Within the ruling:** this is R449 b's "any other request meanwhile: cannot tell". It is never a wrong figure, only a missing one. It will be met with slow external HDDs.
- **Smallest fix (screen only):** do not send a new room request while the screen's previous one is in flight. When it returns, ask once for the box's current path if it changed.

## 5. Still holds from round 1
- **The routes test passes unchanged in its guards:** 401 without the token; 403 for a foreign Origin or Host; 403 for the paired extension (the `EXTENSION_ROUTES` allow-list is untouched); 400 refusals with no path in them; the query is not read; nothing is created.
- **Stale answers are still dropped** by the counter (`roomAsk.current !== ask`). The existing stale-answer test passes, and R2 shows that a late 500 for the current path empties the line.
- **The suggested path** is still shown through `UserText`, and the button's name and description are unchanged.

### S3 — a stale route comment (Minor)
`apps/library-service/src/routes/libraries.ts:115` still says "only whether Documents and the few candidate folders exist and are empty is read". Smallest fix: drop "Documents and".

### S4 — the suggestion's bound does not cover the mount probe, which is not joined either (Minor)
`libraries.ts:117`: `defaultLocationEnv()` runs before `suggestedLibraryFolder`. It runs `mount` on macOS, or reads `/proc/mounts` and `/sys` on Linux, on every GET, with no bound and no join. I could not make it hang here, and these do not normally touch a network share. Smallest fix: move `defaultLocationEnv()` inside the joined, bounded look, or cache it for the process.

## 6. Each new guard and its test (judged by reading)

| Guard | Test that fails without it |
|---|---|
| `roomLookRunning` set / checked | yes: "thirty paths … start ONE look" (`walk.count` 1) |
| its reset in `finally` | yes: "once it settles, the next call looks again" (`count` 2, 5e9) |
| the suggestion join | yes: `expect(second).toBe(first)` and `calls` 1 |
| the suggestion bound | yes: pending at 1999 ms, undefined at 2000 ms |
| home cloud check | yes: OneDrive variable → undefined, `looked` empty |
| no Documents look | yes: `looked` equals `[base]` |
| `lstat` | yes: the real-folder links test (" 4", create succeeds) |
| `roomFigure` rounding down | yes: the rows test |
| 600 ms | yes: U3 test (≤ 2 requests; 300 ms gives 12) |
| keep words until the answer | yes: "a second path keeps the first figure" |
| empty at once for a non-full path | yes: `{Home}r` → `""` |
| no-number answer empties | yes |
| **error answer empties** (`.catch` → `setRoomWords("")`) | **no**: the only error test starts from an empty line, so removing it leaves the suite green (my R2 shows the behaviour works). Minor test gap: add an error after a figure. |
| reserved height (CSS) | none, which is expected: CSS is checked by reading only |

## Could not verify
- A real hung `stat` or `statfs` on a dead share (injected only).
- macOS's `mount` under a dead share (S4).
- How the reserved line looks in a real browser at 200% (CSS read only).
- The e2e assertion was not run.
