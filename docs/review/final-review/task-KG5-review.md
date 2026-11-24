# KG-5 — adversarial review (FR-730, FR-740; Ruling R503 j, k)

Worktree `/home/user/AlexandrineOxiana/.claude/worktrees/kg-5`, branch `kg-5-bundle-sandbox`, 579bdcd..e0bc1cd (acfe2cb FR-730, e0bc1cd FR-740). I read the whole diff once, the implementer's brief and report, R485, R497, R498, R501, R503 (j, k), FR-730 and FR-740.

**Verdict.** A (FR-730): **approve with small points.** B (FR-740): **approve with small points.** Nothing is Critical or Important.

## What I ran
- Probe (`compare.probeKG5.py`, scratchpad, deleted): build 10's manifest against `constraints-macos-arm64.txt`, with names normalised as PEP 503 does. Result: 56 and 56, no duplicate, every line a plain `name==version`, nothing missing on either side, every version the same as a string. Every name is even spelled as the manifest spells it (`PyYAML`, `pydantic_core`, `pdfminer.six`, `huggingface_hub` …).
- Probe (`pins.probeKG5.py`, deleted): `manifest.check_pinned` given tricky input (table under A1).
- Probe (`reqs.probeKG5.py`, deleted): the `Requires-Dist` of each pinned package, from the main checkout's Linux venv, checked against the pinned versions with darwin/arm64 markers (results under A2).
- Probe (`heap.probeKG5.mjs`, deleted): a plain `worker_threads` Worker with `resourceLimits` 16, 256 and 1024 MB, under no process flag, then `--max-old-space-size=64`, then `=512`, with `NODE_OPTIONS` empty (results under B1).
- Mutations, each restored with `git checkout --`:
  - `manifest.py` `return complete or pinned` changed to `return complete`;
  - `_same_version` changed to compare strings;
  - `resourceLimits` commented out in `sandbox.ts`.
- Tests, one file at a time at `nice -n 15`:
  - `node --test scripts/build-sidecars.test.mjs`: 9/9.
  - `build-macos.test.mjs`: 34/34.
  - pytest `tests/test_packaging_manifest.py` (main venv, read-only, `-p no:cacheprovider`): 28 passed.
  - `custom-styles.test.ts`, twice, with the machine's `NODE_OPTIONS=--use-openssl-ca --max-old-space-size=8192` and a load average of about 8: 33/33 both times (56 s and 51 s). The 16 MB case took 3.2 s and 3.5 s against its 20 s limit. The 512 MB case took 10.5 s and 9.7 s against its 150 s limit.
- For the sandbox tests I copied the CSL bundle (`styles.zip`, `bundle.json`, `locales/`) from the main checkout and removed it afterwards.
- At the end:
  - `git status --short` is empty;
  - no `*probeKG5*` file is left;
  - no child process or `ao-sandbox-child-*` temporary folder is left.
- No permission check refused anything.

## Findings

### Critical
None.

### Important
None.

### Minor
1. **The exit code of `main` under `--pins-complete` has no test.** At `services/media-worker/packaging/manifest.py:513-514`, `pinned = report_pins(...) if args.pins_complete else 0; return complete or pinned` is the one line that turns a failed pin check into a failed build.
   - I replaced it with `return complete`, and all 28 tests still passed.
   - `report_pins` itself is tested, and the code is correct by reading. But if this wiring broke, the build would print `constraints check FAILED` and still pass, which is exactly the "build that passes while not doing what it claims" a Mac-only path cannot afford.
   - Direction: one test that runs `main()` with `--pins-complete` against a small fake bundle (the existing `make_bundle` helper) and a constraints file that misses one package, and asserts a non-zero exit. Fix this one first.
2. **A file that names more than the bundle holds passes silently.** At `manifest.py:270-280`, `check_pinned` ignores lines for packages the bundle lacks. This is right for the outcome: pip ignores a constraint for a package it never installs, and the build tools are not in the file anyway. But the README's step 1 ("remove the line of one no longer in the bundle") then depends on nobody forgetting.
   - With 56 lines named and 50 bundled, the build says nothing about the 6 stale lines.
   - Direction: print the stale names on an informational line, without failing the build.
3. **`check_pinned` reads lines more loosely than the build script does, and it is stricter than pip.** None of this matters on the build path, because `parseConstraints` in `build-sidecars.mjs:107-116` rejects anything that is not `name==version` before pip or `manifest.py` runs. But called on its own (pins probe):

   | Constraint line | Bundle has | `check_pinned` says | Is that right for pip? |
   |---|---|---|---|
   | `Pydantic_Core==2.50.5`, `pydantic.core==2.50.5` | `pydantic-core 2.50.5` | equal | Yes (PEP 503) |
   | `pikepdf==10.13.0post1` | `10.13.0.post1` | equal | Yes |
   | `certifi==2026.10.23.0` | `2026.10.23` | equal | Yes (zero padding) |
   | `x==1` | `1.0` | equal | Yes |
   | `x==1.0` | `1.0.post1` | problem | Yes: a post release is a different version |
   | `x==1.0` | `1.0+cpu` | problem | Stricter than pip, which accepts a local version under a public `==`. Fail-safe, so I accept it. |
   | `x==1.0+cpu` | `1.0` | problem | Yes |
   | `x===1.0`, `x==1.*`, a line with a marker or `--hash` | `1.0` | problem, with an odd "pins it at =1.0" style message | Fail-safe |
   | `x[extra]==1.0`, `x>=1.0` | `1.0` | "does not name it" | Fail-safe |
   | a bare `x` | `1.0` | "pins it at " followed by an empty version | Message reads oddly |
   | `x==1.0` then `x==2.0` | `1.0` | the last line wins silently | pip would fail on the conflict |

   - Every one of these fails safe: none is called equal where pip would install another version.
   - Direction (optional): reject duplicate names in both parsers.
4. **The list of what still floats is incomplete.** The report says altgraph, macholib, setuptools, and pip "fixed by the Python version". The Python version is not fixed:
   - the workflow's `actions/setup-python` asks for `"3.13"`, so it takes the newest 3.13 patch (build 10 had 3.13.17);
   - the interpreter and its standard library ship in the bundle, and the pip that `venv` brings changes with that patch;
   - the venv stamp (`build-sidecars.mjs:252`) uses only `3.13`, which is older than this change.

   There are no hashes either, so a re-uploaded wheel of the same version (a new build tag) would not be noticed. With those two additions the list is complete: a 3.12+ venv has no `wheel`, and nothing else is installed by that pip call. To be listed, not built now.
5. **The report misdescribes the cache in one sentence, which matters only for cost.** It says "the cached `venv-default` is restored but unused". In fact both the cache key and its `restore-keys` prefix (`desktop-macos.yml:199,201`) now include the arm64 file's hash, so the next build restores nothing. It rebuilds the venv cold and downloads the Node archive again.
   - This is correct behaviour; it just costs some minutes.
   - The Node archive shares that cache, so every future change of the pin file also throws the archive's cache away. That is waste, not a fault.
6. **The new notes leave the total memory of the service unbounded by their wording.** `--max-old-space-size` is a cap per isolate: the service's main thread gets 512 MB, and each sandbox worker gets 512 MB too (probe: old generation about 504 MB in every worker). Up to two workers run at once, so with two runaway styles the process can approach 1.5 GB.
   - The new sentences "in the app the cap is 512 MB" (ADR 0012:65, `sandbox.ts:19-22`) are true per worker, but calling 512 MB "the service's memory ceiling" invites reading it as a total for the process.
   - Direction: add "per worker; at most two at once" in the ADR line.
   - Related, not touched by this task: `packages/library/src/capture/browser-capture.ts:281` gives its HTML-strip worker `resourceLimits` that the same setting overrides. The coordinator may want that on FR-740's entry.
7. **The 512 MB test does not observe the worker's cap, only the child's main heap.** `custom-styles.test.ts:380-384` asserts that the child's own `heap_size_limit` is between 512 and 1023 MB, and then that the reason is `resources`. With `resourceLimits` removed it still passes (I checked; the implementer said so too). That is consistent with its claim ("ended only its worker; the process renders again"), but the comment's "the worker's real cap is 512 MB" rests on probes, not on this test. Acceptable as it stands.
8. **Wording.** The head comment of `build-sidecars.mjs` (:20-21) says "A package named in the Intel file is pinned by it even where pyproject.toml pins it directly". The code does that for any constraints file that is not complete, including a hand-made `--constraints <file>`. A copy of the arm64 file at another path is likewise treated as not complete: it overrides the direct pins and is not checked, because `isCompletePinSet` compares resolved paths. Trivial.

## Checked and found sound

### A — FR-730
- **A1 — the file matches the manifest.**
  - It holds exactly build 10's 56 packages at their versions (compare probe).
  - All 9 direct pins of `pyproject.toml` (`dependencies`) agree with the file.
  - The `packaging` extra (`pyinstaller==6.22.3`, `pyinstaller-hooks-contrib==2026.10`) is not in the file, which is right: they are not in the bundle. The `test` extra is not installed by the build.
  - `check_pinned` normalises both sides with the same `dists.canonical`, which is PEP 503's rule.
- **A2 — will pip accept it on the Mac? What I could establish:**
  - Every line is a plain `name==version`, with no extras, URLs, editable entries or markers. `parseConstraints` enforces that before pip runs.
  - The pip call is `install --only-binary=:all: -c <file> <direct pins and packaging-extra pins as written>` (`build-sidecars.mjs:256`). For a complete set, `installRequirements` keeps the direct pins, so a direct pin that disagrees with its constraint would stop pip. None disagrees.
  - Build 10 itself installed exactly this set, from the same `pyproject.toml` (unchanged since 579bdcd), on the same kind of machine, with pip's own resolver. The set is therefore a real resolution, `packaging==26.4` alongside PyInstaller included.
  - None of the 56 is there because of another platform's marker: the manifest was written on the Mac.
  - The Linux venv holds 44 of the 56 at exactly the pinned version. For those 44, none of their darwin/arm64 requirements is broken by another pinned version, and none of their requirements without an extra names a package outside the file.
  - The two "violations" the probe printed both come from the venv's OLDER versions, not the pinned ones: `httpx2 2.16.0` requires `httpcore2==2.16.0`, and `pydantic 2.14.3` requires `pydantic-core==2.50.4`. The pinned versions move together, as build 10 shows.
- **A2 — what I could not establish:**
  - the metadata of the 12 versions the Linux venv lacks;
  - that every wheel is still downloadable today (a yanked wheel still installs under `==`; a deleted one would stop pip, and the error names it);
  - the requirements of PyInstaller 6.22.3 and hooks-contrib 2026.10 against `packaging==26.4` (they are not in the venv; build 10 shows they resolved together).
- **A3 — the check fails the build when it should:**
  - (a) A package not named: `report_pins` returns 1, and `main` returns it (by reading, see Minor 1). `check_complete` already makes every `*.dist-info` in the bundle a manifest package, so an unnamed one cannot slip past.
  - (b) A version that differs: same path; mutation-tested through `_same_version`.
  - (c) A missing file: `loadConstraints` throws first ("constraints file not found"). In `manifest.py`, `read_bytes`/`read_text` raise and exit non-zero.
  - (d) `--pins-complete` without `--constraints`: argparse exits with code 2 and the message (tested).
  - The failure comes after the manifest is written and before the bundle is used. `build-sidecars` throws, `build-macos` fails, and the report artefact (`if: !cancelled()`) still uploads the manifest. Good for diagnosis.
- **A3 — the check runs on the Mac path and no other.**
  - Path traced: `build-macos.mjs:84` `workerArgs ["--constraints", ARM64_CONSTRAINTS]`, then `build-sidecars.mjs` `loadConstraints` (`complete: true`), then `manifestArgs` adds `--constraints <file> --pins-complete`.
  - Intel: `isCompletePinSet(INTEL)` is false, so it is unchanged (and Intel is switched off).
  - Linux (`ci.yml:322`) and Windows: `defaultConstraints` is `undefined`, so they are unchanged.
  - `apps/desktop/package.json` `build:sidecars` and `smoke:sidecars`: an Apple-silicon developer now gets the complete set, which is intended.
  - The smoke `--check` path does not run the pin check (it re-checks completeness only). That is right.
- **A3 — tests that fail without their guard:**
  - name normalisation, unnamed package and `report_pins`' exit code: judged by reading;
  - the version comparison: by mutation (the string comparison fails the first new test);
  - `--pins-complete` without `--constraints`: by reading (it asserts the message);
  - the JS helpers (`defaultConstraints`, `isCompletePinSet`, `installRequirements`, `manifestArgs`): by reading;
  - `build()` actually using them: by reading only (it needs pip and PyInstaller);
  - the wiring in `main`: NOT held by a test (Minor 1).
- **A4 — the new name and venv.** The name `macos-arm64` comes from the file name.
  - `--skip-build` on arm64 now finds `venv-macos-arm64`, and the workflow's smoke step no longer passes `--constraints none` (test added).
  - The cache restore and save paths are the glob `apps/desktop/.build/venv-*`, so the new venv is saved.
  - The save step's conditions are unchanged.
  - Nothing reads `pinSet` or the venv path:
    - `build-common.mjs` copies the manifest whole for the notices;
    - `About.tsx` shows the manifest;
    - neither the launch check nor `--self-check` reads either one.
  - The `git grep` hits are all documentation or tests that were updated.
- **A5 — the workflow.**
  - It parses (`yaml.safe_load`: jobs plan, build, extension).
  - The steps still run in a workable order: the cache is restored, `pnpm install`, `build-macos`, the caches are saved, then the smoke step reuses the same venv.
  - The key and the `restore-keys` both hash the new file, so a changed constraints file changes the key.
- **A6 — what still floats.** altgraph, macholib and setuptools are right: PyInstaller and hooks-contrib bring them, and a 3.12+ venv has no setuptools or wheel. To add: the Python patch release and its pip, and the absence of hashes (Minor 4).
- **A7 — the documentation.**
  - The "Changing a pin" steps work as written against the scripts:
    - the stamp includes the file's hash, so a changed file makes a new venv;
    - the `pin set:` and `constraints check:` lines exist with the words quoted;
    - the manifest records `constraints.file` and its `sha256`;
    - the artefact name `worker-bundle-report-macos-apple-silicon` matches `mac-targets.mjs` (`label: "apple-silicon"`).
  - One nuance: step 2's `--resolve-for macos-arm64` resolves under the constraints, but it will not point out a NEW package that a changed pin brings with it (pip simply resolves it to the newest version). Step 3's build check is what names it. Worth half a sentence.

### B — FR-740
- **B1 — the claim holds; my probe agrees with the implementer.** Under `--max-old-space-size=N` the worker's old generation is N whatever `resourceLimits` asks for, smaller or larger:

  | Process setting | Worker cap asked: 16 MB | 256 MB | 1024 MB |
  |---|---|---|---|
  | `=64` | `heap_size_limit` 70 MB, about 56 MB allocated | 112 MB, about 56 MB | 112 MB, about 56 MB |
  | `=512` | 518 MB, about 504 MB | 560 MB, about 504 MB | 560 MB, about 504 MB |
  | none | 22 MB | 304 MB | 1072 MB |

  - Only the young generation still follows `resourceLimits`.
  - So "replaces" is right and the brief's "the larger of the two" was wrong.
  - The head comments of `sandbox.ts`, `custom-styles.ts`, `sandbox-worker.mjs` and ADR 0012 are true, apart from the per-isolate nuance (Minor 6).
  - The desktop line, quoted, from `apps/desktop/src-tauri/src/service.rs:116`: `vec!["--max-old-space-size=512".into(), service_dir.join("service.mjs").into_os_string()]`. Its test is at :628, and the launch check prints "the service runs with the 512 MB ceiling" (`launch-check.mjs:1052, 1165`).
- **B2 — the child-process tests:**
  - **Real code:** the child imports the real `src/citation/sandbox.ts` by its file URL, which brings the real worker `.mjs` and citeproc.
  - **The 16 MB case fails without the cap:** with `resourceLimits` commented out it fails with `reason: "timeout"` instead of `"resources"`. That run took 16.2 s against the 20 s limit, so under heavier load the mutation might fail by time limit instead; it fails either way.
  - **No leftovers:**
    - `onTestFinished` sends SIGKILL to a child that is still running and removes the temporary folder;
    - the sandbox workers are threads, so killing the child ends them;
    - a child that dies early is reported with its stderr;
    - a child that hangs is ended by the test's own limit, then killed. That a vitest time-out runs `onTestFinished` I judged by reading vitest's documented behaviour; I did not provoke it.
    - Nothing was left after my runs.
  - **Times:** comfortable (see "What I ran").
  - **tsx:** `--import tsx` resolves from `packages/library` upward to the root's `node_modules/tsx`, a root devDependency (`package.json:25`), present after `pnpm install --frozen-lockfile` in a fresh checkout and on GitHub. The same pattern is already used by `apps/cli`, `apps/library-service` and `apps/desktop/e2e` tests. It is not a dependency of `@ao/library` itself (a small point, with precedent).
  - **Only the heap flag removed:** `withoutHeapSetting` removes only `--max[-_]old[-_]space[-_]size` in its `=` and space forms, and keeps every other option (unit-tested). The child's `execArgv` is exactly what the test passes.
- **B3 — no product change.** The diff of `packages/library/src/citation/*.ts|*.mjs` outside the tests changes comment lines only; no other line changed.

## For the Mac build to watch
These are in the step "Build the app and its disk image (build-macos.mjs)", worker part. Lines 2 and 3 appear only when the venv is new, which the next build's venv will be; on later builds that reuse it from cache, line 1 says `(reused)`.

1. `pin set: macos-arm64 (services/media-worker/packaging/constraints-macos-arm64.txt); build venv: apps/desktop/.build/venv-macos-arm64 (new)`. If it says `pin set: default`, the pins were NOT used.
2. `> apps/desktop/.build/venv-macos-arm64/bin/python -m pip --disable-pip-version-check install --only-binary=:all: -c services/media-worker/packaging/constraints-macos-arm64.txt faster-whisper==1.2.1 av==18.1.0 requests==2.34.2 certifi==2026.10.23 pillow==13.0.0 pillow-heif==1.8.1 rawpy==0.28.0 ocrmypdf==17.14.1 numpy==2.5.5 pyinstaller==6.22.3 pyinstaller-hooks-contrib==2026.10`
3. pip's `Successfully installed …`: for example `ctranslate2-4.9.1`, `PyYAML-6.0.4`, `pydantic_core-2.50.5`. Record the versions of altgraph, macholib and setuptools from this line for the follow-up item.
4. `> apps/desktop/.build/venv-macos-arm64/bin/python -I services/media-worker/packaging/manifest.py --bundle apps/desktop/sidecars/ao-worker-aarch64-apple-darwin --target aarch64-apple-darwin --pin-set macos-arm64 --constraints services/media-worker/packaging/constraints-macos-arm64.txt --pins-complete --out …/sidecar-manifest.json`. The presence of `--pins-complete` is what shows the check was asked for.
5. `manifest: 56 bundled packages, …` then `manifest check: every package (56) and native library (…) …`.
6. **`constraints check: every package in the bundle (56) is pinned by constraints-macos-arm64.txt at the version installed`**. This is the check running and passing.

**Must be ABSENT:**
- `constraints check FAILED`;
- `--constraints none` anywhere;
- in the "Packaged worker smoke test" step, `build venv … is missing`.

**Artefact `worker-bundle-report-macos-apple-silicon`:** its `sidecar-manifest.json` should have:
- `"pinSet": "macos-arm64"`;
- `"constraints": {"file": "constraints-macos-arm64.txt", "sha256": "d3e96fdabbff5ad8c1eaeb21a7310c9e1609a5d44d22392d909d916f3b16bbd7"}`;
- the same 56 name/version pairs as build 10;
- `"python"`: if it is not `3.13.17`, the runtime moved (Minor 4).

## Could judge only by reading
- That pip on the Mac accepts the call and finds every wheel; build 10 is strong evidence.
- `build()`'s use of the new helpers.
- That `main` returns non-zero on a pin failure (code correct, no test).
- That `onTestFinished` runs on a vitest time-out.
- The requirements metadata of the 12 pinned versions missing from the Linux venv, and of PyInstaller 6.22.3 and hooks-contrib 2026.10.
