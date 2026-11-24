# CI283 guard — the unit-test network guard (FR-748 (1), R544)

Worktree `.claude/worktrees/kg-4`, branch `kg-ci283-guard`, from 769e3e5. Not pushed.

Commits:
- `541d3ab` A network guard for the unit-test runs: no test reaches a public host (FR-748, R544) — the guard, its test, four `vitest.config.ts` entries.
- `3f76d77` Find routes tests: late lookups of a closed service no longer reach OpenAlex (FR-748, R544) — the one test file mended.

No product code changed. No dependency added. No time limit changed.

## How the guard works

`packages/library/tests/net-guard.ts` is a Vitest `setupFiles` entry. Inside a Vitest run (`process.env.VITEST` is set) it:

1. **Sets the global dispatcher.** It makes undici's global dispatcher `new Agent().compose(interceptor)`. The interceptor passes requests to 127.0.0.0/8, `localhost`, `*.localhost` and `::1` on to the Agent. Any other host is refused by a throw, before anything connects. The error reads: "The test run's network guard (FR-748): this test made a real request to <host>; give its project `metadata_lookup: []`, recorded answers (AO_LOOKUP_FIXTURES), or its own MockAgent."
2. **Records each refused host and fails the test.** Its `afterEach` is registered by the set-up file, so it runs after the file's own afterEach hooks (Vitest runs after-hooks in reverse order). It fails the test if any host was refused during it. This matters because the lookup client turns every network error into "could not be reached" (`lookup/http.ts`, `fetchWithRetries`), so a refusal on its own could pass unseen. `afterAll` does the same for anything refused after the last test.
3. **Puts the guard back after a test that changed the dispatcher.** `beforeEach` notes the global dispatcher the test starts with, which is after the file's `beforeAll`, so a file that installs its own dispatcher for all its tests still works. If a test ends with a different dispatcher installed, the test fails and the dispatcher it started with is put back. `afterAll` does the same check at the file level and puts the guard back.
4. **Outside a Vitest run it does nothing.** It does not even import `vitest`, because that import is dynamic and inside the `VITEST` branch.

**Why it reaches the library's undici (checked, not assumed).** undici 8.12.3 (`lib/global.js`) keeps the global dispatcher on `globalThis` under `Symbol.for('undici.globalDispatcher.2')`. Every copy of undici reads the same slot. There is only one undici in the store (`node_modules/.pnpm/undici@8.12.3`). The service's and CLI's tests import it by path, as `packages/library/node_modules/undici`, and the guard file resolves the same copy. `request(url, { dispatcher: undefined })` in `HttpClient` and in `find/fetch-file.ts` reads that slot at call time.

**Node's own `fetch`.** Node 22.23 bundles undici 6.29.1, which reads `Symbol.for('undici.globalDispatcher.1')`. undici 8's `setGlobalDispatcher` also writes that legacy symbol, with a `Dispatcher1Wrapper` around the same dispatcher. I checked by experiment, in plain Node and in the guard's test: a global `fetch` to a made-up host is refused with the guard's error, and a loopback `fetch` works. So `fetch` needs no separate guard. The product's only global `fetch` calls are to the local media worker (`worker-client.ts`, `media-worker.ts`), which is loopback.

**Its test:** `packages/library/tests/net-guard.test.ts`, 7 tests. It uses only `*.invalid` made-up hosts. It checks:
- an undici `request` is refused with the exact error;
- `fetch` is refused;
- loopback works over 127.0.0.1 and `localhost`, by undici and by `fetch`;
- the loopback matcher accepts and rejects the right hosts;
- `afterTest` fails on a refusal it has not reported;
- `afterTest` fails on a dispatcher left installed, and puts the guard back;
- importing the file in a child Node process without `VITEST` installs nothing.

I saw it fail before the guard existed. I also checked it with throwaway files, since deleted: a test that swallows the refused request still fails, in the library, the CLI, and the extension under both jsdom and node environments.

## Per package

| Package | Guarded? | Why |
|---|---|---|
| `packages/library` | yes (`vitest.config.ts` setupFiles) | holds the lookup client, Zotero web client and file download (undici) |
| `apps/library-service` | yes (after `src/test-setup.ts`) | builds a real `HttpClient` for each opened library (`state.ts`) |
| `apps/cli` | yes, in the test process | in-process tests (`zotero.test.ts`) use the library; spawned children are not covered (see below) |
| `apps/browser-extension` | yes | `real-service.test.ts` runs the real service in-process, and so the lookup client (its project already has `metadata_lookup: []`) |
| `packages/core` | not needed | no network code at all: no undici, no `fetch`, no `node:http` |
| `packages/shared` | not needed | pure types and sentences |
| `packages/ui` | not needed | product code only `fetch`es the local service. Every MSW `server.listen` uses `onUnhandledRequest: "error"`, except `SnapshotFrame.browser.test.ts`, which starts its own 127.0.0.1 server |
| `apps/desktop` (Vitest `e2e/*.test.ts`) | not needed | talks only to 127.0.0.1 stand-ins. `library-standin.test.ts` uses `node:https` to 127.0.0.1 with a made-up SNI name, not undici. Does not load the library |

`scale` configs (`vitest.scale.config.ts`, `vitest.zotero-scale.config.ts`) are **not** guarded. They were outside this task and I did not run them. Adding the same `setupFiles` line there is a one-line follow-up.

## Tests that install their own global dispatcher (item 2)

Each one captures `previous = getGlobalDispatcher()`, which is now the guard, and puts it back:

- **library:**
  - `zotero-web.test.ts`:2146 and `zotero-conflict.test.ts`:484 restore in `finally`.
  - `bulk.test.ts`:1688 restores in `afterEach` (`restoreDispatcher`).
  - These restore in `afterEach`: `runner.linked-missing.test.ts`:126, `fetch-file.recorded.test.ts`:57, `runner.test.ts`:3290, `fetch-file.test.ts`:116.
  - `tests/zotero/fake-zotero.ts` `guardNetwork()` returns a restore function; `fake-zotero.test.ts`:701 asserts the dispatcher is restored.
- **service:** `search-settings-routes`, `server` (`finally`), `zotero-sync-scheduler`, `find-browser-routes`, `your-library-routes`, `zotero-web-resume`, `zotero-sync-routes` and `find-routes` all restore in `afterEach`. The re-sets inside tests (`zotero-sync-routes`:270/571, `cli zotero.test.ts`:206/210) are undone by that `afterEach`.
- **cli:** `commands/zotero.test.ts` restores in `afterEach`.

The guard's new check would have failed any test that did not put its dispatcher back. None did: there were 0 "left its own global dispatcher" failures across all four suites. Nothing needed mending here.

## Tests the guard caught

| File | Test (varies by run) | Host | Mended how |
|---|---|---|---|
| `apps/library-service/src/find-routes.test.ts` | Whole-suite run: "choose: an unknown candidate is 400…", "every reason code has its sentence", "51 ids are refused…". Alone, run 1: "every reason code…", "51 ids…", "F8b: the author offer carries counts only…" | `api.openalex.org` (`/works/doi:10.5555/ao.f5.zorblatt`, `/works?search=Filler line…`) | its own MockAgent (see below) |

**What happened (shown by temporary logging, since removed).** The file's project allows `metadata_lookup: [crossref, openalex]` and serves made-up answers through its own `MockAgent` with `disableNetConnect`. But after each test it put the process's own dispatcher back. A closed service's lookup client still sent a request it had queued, 2 to 150 ms after `svc.close()` had resolved, and retried it about 500 ms later, by its backoff. Before the guard, those late requests went to the **real** `api.openalex.org`. That is the same hidden dependence as R541.

**The mend.** The file installs a `MockAgent` that answers nothing and connects nowhere (`quiet`) in `beforeAll`, and puts it back after each test instead of the process's dispatcher. The process's dispatcher comes back only in `afterAll`. After this change: 3 runs alone, 46/46 each, 0 refusals.

Total caught: 1 file, 3 tests per run (which 3 differs by timing), one host. Far under the stop threshold.

## Finding (not built: product, belongs with FR-748 (2))

Closing the service, or the library, does not stop the lookup client's queued and retrying requests. They are still sent after `close()` has returned, for up to the backoff total (0.5 + 1 + 2 s), from a library that is already closed. The project's rules allowed lookups, so this is not "a request no rule allows". But the service sends it after its close has finished. It fits FR-748 (2)'s open question of whether a stop cuts the lookup's wait short. The test file already allows for it ("R247 c: a late lookup answer never recreates a library folder"). Three other service files (`find-browser-routes`, `your-library-routes`, `search-settings-routes`) put the process's dispatcher back after each test in the same way. They were not caught in this run, but could be on a slower machine. If so the guard will now fail them loudly and name the host, and the same mend applies.

## The command line's separate process (item 4)

- `apps/cli/src/commands/import.test.ts` and `apps/cli/src/import-key.test.ts` spawn nothing. They are pure functions, with no network.
- `apps/cli/src/cli.test.ts` spawns `node --import tsx src/index.ts`, and the in-process guard does not cover that child. From reading the file: every import project there ("Imp", "RefsA/B/C", "Broken", "AuditT/E", "AnchT/E", "DryA") uses `GOV_NO_LOOKUPS` (`metadata_lookup: []`). "NoUpload" uses default rules, but every import into it is refused by policy before any lookup. The "library and project" group's project "Study" uses default rules, but it only captures through the fake tools.
- **One logged run.** I ran the whole file with a temporary preload (`NODE_OPTIONS=--import=<scratch probe>`, not committed). The probe sets, in every child, a global dispatcher that logs and refuses any non-loopback request. A one-test check confirmed the probe loaded in each spawned CLI (3 spawns, 3 "loaded" lines). Result: **40/40 passed, 0 non-loopback requests** from any CLI child. Nothing needed mending.
- **Why not `HTTPS_PROXY=127.0.0.1:9`.** undici's `Agent`, the default global dispatcher, ignores proxy variables, so that method would have shown nothing.
- **Not covered and not determined:**
  - requests by a child through `node:http`/`https` directly (none found in product code);
  - the media worker's own network use (the Python worker, tools such as yt-dlp; the CLI tests put fake tools on `PATH`);
  - any future CLI test whose project allows lookups. Nothing stops that child from reaching the network.

  A durable cover would be a child-process form of the guard preloaded through the spawn's `NODE_OPTIONS`. It is not built: it was not asked for, and nothing is exposed today.

## The suites (whole package, one at a time, `nice -n 10`, guard in place)

- `@ao/library`: Test Files 1 failed | 149 passed | 1 skipped; Tests 1 failed | 5777 passed | 5 skipped (1097 s). The one failure is `find/runner.test.ts` "R324 a: not offered for an entry whose record has a file…": `TypeError … reading 'chance'` at :4972. That is R544 (a), the known order-dependent test, and it is not a network failure. It passed alone (4 passed | 297 skipped). **0 tests caught by the guard.**
- `@ao/library-service`: before the mend, Test Files 1 failed | 46 passed; Tests 3 failed | 1177 passed | 2 skipped. All 3 failures were the guard, in `find-routes.test.ts`. After the mend that file passed 46/46 three times alone. I did not re-run the whole service suite after the mend.
- `@ao/cli`: Test Files 7 passed (7); Tests 87 passed (87). 0 caught.
- `@ao/browser-extension`: Test Files 11 passed (11); Tests 242 passed (242). 0 caught.
- `net-guard.test.ts`: 7/7.
- Typecheck: `@ao/library`, `@ao/library-service`, `@ao/cli` and `@ao/browser-extension` all exit 0.
- `git status --short` is empty. None of my processes are left running. The vitest processes still on the machine belong to other worktrees.

## Uncertain

- How many tests pass in the library suite only because their project has `metadata_lookup: []` cannot be counted from a run. The guard only shows tests that actually send.
- The three other service files above are possibly exposed when slow.
- The root `pnpm test` (the Vitest workspace, as CI runs it) uses each package's own `vitest.config.ts`, so the guard applies there too. I did not run it whole.
