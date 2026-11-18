# Task CI-268 — the CI's package-install step must not depend on one Ubuntu mirror

This brief stands alone. Work ONLY in the worktree `/home/user/AlexandrineOxiana/.claude/worktrees/ci-flake` (branch `ci-find-runner-flake`, head 73efb33). Every shell command starts with `cd /home/user/AlexandrineOxiana/.claude/worktrees/ci-flake &&`. NEVER use `git stash`. Do not push. No installs. No product code is touched: only `.github/workflows/ci.yml`, one new shell script, one new test file, and `package.json`'s `test:scripts` line.

## The fault
GitHub's Linux runners now take Ubuntu packages from `http://us-east-2.ec2.archive.ubuntu.com/ubuntu` (through the mirror list `/etc/apt/apt-mirrors.txt`). Three runs of the last four failed in the step that installs packages: `apt-get update` worked, then the download of 134 MB stalled and the step's four-minute limit cut it off (a healthy run fetches it in 15 seconds). The step already has a fallback, but only for names that do not resolve, and its `sed` does not match that host.

`.github/workflows/ci.yml` has the same shape three times (read all three): job `test`, step "System tools for the media worker (proxies, OCR)" (about line 40; packages `tesseract-ocr ghostscript ffmpeg`; limit 4 minutes); job `desktop`, step "System packages (web view libraries, …)" (about line 198; a long package list over several lines; limit 8); job `worker-bundle`, step "Tools the smoke test hands to the worker …" (about line 323; `--no-install-recommends tesseract-ocr ffmpeg`; limit 4).

## What to build (tests first)
1. **`scripts/ci-apt-install.sh`** (bash, `set -euo pipefail`, executable bit set in git: `git update-index --chmod=+x`), called as `bash scripts/ci-apt-install.sh [apt options such as --no-install-recommends] <packages…>`. Behaviour, in this order:
   - `APT_OPTS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=20)` on every apt-get call.
   - The files to rewrite: by default `/etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list`; when the environment variable `CI_APT_SOURCE_FILES` is set (for the test), that space-separated list instead.
   - A function `use_other_mirror "<why>"`: prints `::warning::<why>; using mirrors.edge.kernel.org for this run.` and, for each of those files that exists, runs `sudo sed -i -E 's#https?://([a-z0-9-]+\.)*(archive|security)\.ubuntu\.com/ubuntu/?#https://mirrors.edge.kernel.org/ubuntu/#g'` on it. Write the loop with `if [ -f "$f" ]; then …; fi` — NOT `[ -f "$f" ] && …`, whose failure as a function's last command would end the script under `set -e`.
   - If `getent hosts azure.archive.ubuntu.com` fails: `use_other_mirror "Ubuntu's package mirrors do not resolve on this runner"`.
   - `sudo apt-get update "${APT_OPTS[@]}"`.
   - The DOWNLOAD, bounded, apart from the install (stopping apt while it only downloads is safe; stopping it while it unpacks is not): `sudo timeout "${CI_APT_FIRST_TRY_SECONDS:-120}" apt-get install -y --download-only "${APT_OPTS[@]}" "$@"`. If that fails or runs out of time: `use_other_mirror "The runner's package mirror failed or was too slow"`, `sudo apt-get update …` again, and the same download again bounded by `${CI_APT_SECOND_TRY_SECONDS:-300}` — if THAT fails the script fails (non-zero), having installed nothing.
   - Then the install from what was downloaded: `sudo apt-get install -y "${APT_OPTS[@]}" "$@"`.
   - A header comment in plain words: what it is for, what was seen (17–18 November 2026: the mirror answered `apt-get update` and then stalled on the packages; three runs lost), and that packages are still verified against Ubuntu's signing keys, so another mirror cannot substitute anything.
2. **`scripts/ci-apt-install.test.mjs`** (`node:test` + `node:assert/strict`, like the other `scripts/*.test.mjs` — read one first, e.g. `scripts/e2e-args.test.mjs`, for the style). It runs the script with `PATH` set to a temporary folder of STUB programs (small bash scripts named `sudo`, `apt-get`, `timeout`, `getent`, `sed` is the real one — so put the real `/usr/bin` and `/bin` AFTER the stub folder) that append their arguments to a log file and exit as the test tells them (through environment variables or marker files), and with `CI_APT_SOURCE_FILES` pointing at temporary copies of a mirror list and a sources file. The `sudo` stub just runs its arguments; the `timeout` stub drops its first argument and runs the rest (or, when told, exits 124 without running it). Cases:
   - a healthy mirror: the calls are exactly update, download-only (through timeout 120), install; the source files are unchanged; no `::warning::`;
   - the first download exits non-zero: warning printed; the files now name `https://mirrors.edge.kernel.org/ubuntu/` where they named `http://us-east-2.ec2.archive.ubuntu.com/ubuntu/`, `http://azure.archive.ubuntu.com/ubuntu/`, `http://archive.ubuntu.com/ubuntu` and `http://security.ubuntu.com/ubuntu/`, and a line for `https://packages.microsoft.com/ubuntu/24.04/prod` is untouched; then update, download-only (timeout 300), install, in that order;
   - the first download runs out of time (the timeout stub exits 124): the same;
   - both downloads fail: exit status non-zero and NO plain install call was made;
   - the names do not resolve (the getent stub fails): the files are rewritten BEFORE the first update, with the "do not resolve" warning;
   - options pass through: called with `--no-install-recommends a b`, both the download and the install carry `--no-install-recommends a b`;
   - a file of the list that does not exist does not stop the script.
   Each test must be seen to FAIL against a wrong script first (for instance run the tests before the script exists, and say so). Skip the suite with a clear message if `bash` is not on the PATH (it is, here and on the runners).
3. **`package.json`**: add `scripts/ci-apt-install.test.mjs` to the `test:scripts` list.
4. **`.github/workflows/ci.yml`**: in each of the three steps replace the `if ! getent … fi`, the `apt-get update` and the `apt-get install` lines by ONE call of the script with that step's packages and options (keep the desktop step's comment about recommended packages and GStreamer, above the call; keep each step's name). Set the three steps' limits to `timeout-minutes: 10` (two tries must fit), and replace the comment "When the runner cannot reach the package mirror, apt retries each file for 20 s; fail fast instead." by one that says what the script does. The steps run after `actions/checkout`, so the script is there — check that each of the three steps does come after its job's checkout.

## Verify
`bash -n scripts/ci-apt-install.sh`; `node --test scripts/ci-apt-install.test.mjs`; `pnpm test:scripts` (all of it — it takes about a second or two); `node -e "const y=require('yaml');y.parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8'));console.log('yaml ok')"` (if the `yaml` package cannot be required from the repository root, check the file with `python3 -c "import yaml,sys;yaml.safe_load(open('.github/workflows/ci.yml'));print('yaml ok')"`); `git status --short` empty after the commit.

One commit, message in plain words (what and why), ending with exactly these two trailer lines:
```
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JfZFTcXP1442Jh7BrkG3hS
```

## Report
Final message, at most 120 words: the head commit, the test results (how many tests, that they failed first), anything you could not do or are unsure of. No file dumps.
