# Desktop app (`@ao/desktop`)

The desktop app is a Tauri 2 shell (`src-tauri/`) that shows the built interface in the system web
view, starts the library service (which starts the media worker), hands the interface its
connection, provides native file and folder pickers and dropped-file paths, and stops everything
when it closes (Task 37c, ruling R155). It holds no library logic. How it starts and stops the
service, and the environment it gives it, are in `docs/adr/0013-desktop-shell.md`.

## The shell

- `src-tauri/src/lib.rs`: start-up, the window, closing, signals, the second launch.
- `src-tauri/src/service.rs`: starting the service (token on standard input, ready line, time
  limit), stopping it (closing its standard input, waiting for its process group, forcing).
- `src-tauri/src/helper_env.rs`: the service's allow-listed environment, each name with its reason.
- `src-tauri/src/connection.rs`: the page's connection script and the addresses the window may show.
- `src-tauri/src/paths.rs`: where the helpers are (packaged resources; development overrides in
  debug builds only).
- `src-tauri/src/token.rs`: the access token.
- `src-tauri/src/probe.{rs,js}`: the launch check's in-page probe (debug builds with NODE_ENV=test only).
- `src-tauri/capabilities/main-window.json`: what the page may ask of the shell: listen for events
  (drag and drop) and open a file or folder picker. Nothing else.
- `src-tauri/tauri.conf.json`: the content-security policy, identical to `packages/ui/index.html`'s,
  delivered unchanged (`dangerousDisableAssetCspModification`: Tauri's additions would add hashes to
  the policy and, in `style-src`, switch off `'unsafe-inline'`).

The interface talks to the shell only through `packages/ui/src/desktopShell.ts`.

**The app identifier** `org.alexandrineoxiana.desktop` is defined in one place, `identifier` in
`src-tauri/tauri.conf.json` (JSON takes no comments, so the note is here). It decides the app's data
folder (on a Mac `~/Library/Application Support/org.alexandrineoxiana.desktop`), under which the
shell has the service keep everything (R159): `settings/` (AO_CONFIG_DIR: app settings, pairings,
the outbox), `tools/` and `models/`; and it names the single-instance lock. It is kept for now and
must be confirmed by the owner before the first release: changing it later moves every user's
settings. Without the shell (CLI, tests, the end-to-end harness) the service's own default folder
is unchanged.

Closing holds the single-instance lock until the service and the worker are gone; a second launch
during that time is noted by the first instance, which starts the app again once they are gone.

## Building on Linux

The web view's development libraries (Ubuntu 24.04):

```sh
apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev build-essential pkg-config libssl-dev
```

and Rust 1.97 with cargo. Then:

- `pnpm --filter @ao/desktop run build:linux` builds the library service folder, copies the notices
  the About screen shows (`generated/notices/`, git-ignored), builds the interface, and builds the
  shell (debug; `-- --release` for the release profile). Output:
  `src-tauri/target/debug/alexandrine-oxiana`.
- `pnpm --filter @ao/desktop run launch-check` starts the built shell under `xvfb-run` and checks
  the start, the page reaching the service and the worker, the granted commands, the helpers'
  environment, the second launch, and that no process is left after closing the window, SIGTERM or
  SIGKILL of the shell, and after a service that refuses to start. It needs `xvfb-run` and
  `dbus-daemon`; `ffmpeg` for its audio and video checks. The worker: `AO_DESKTOP_WORKER_BIN`, else
  the packaged worker in `sidecars/`, else the development one (`pnpm setup:py`).
- `pnpm --filter @ao/desktop test`: the launch check's own tests, the Mac build's tests that need no
  Mac (`scripts/build-macos.test.mjs`, `scripts/node-release.test.mjs`), the desktop end-to-end
  harness's unit tests (`e2e/*.test.ts`, Vitest) and the shell's Rust tests.

The steps the Linux and the Mac builds share are in `scripts/build-common.mjs`.

## The desktop end-to-end test (Linux)

`pnpm e2e -- --desktop-only` (from the repository root; not part of a plain `pnpm e2e`, because it
needs the built app) drives the debug build `build:linux` makes through its real window, by
WebDriver: `tauri-driver` in front of the system's `WebKitWebDriver`. One scenario
(`e2e/desktop.e2e.ts`): the library chooser; the first-use Optional tools dialog ("Not now"); a
library at a typed folder and a project; a PDF attached with "Choose files…" through the native GTK file dialog; the
source listed; the stored copy, the untouched original and the audit entries on disk; the window
closed as its close button does; no process of the app left; nothing under the real home folder
created or modified. Its results are in `pnpm report` under
"The desktop app end to end".

- Each run gets a private Xvfb display and D-Bus session bus, and its home, settings, data and
  libraries under one temporary folder (`e2e/desktop.ts`, `e2e/lifetime.ts`). Every process it
  starts (Xvfb, the bus and the session services it starts, such as dconf and the portals, the
  drivers, the app and its helpers, xdotool) gets HOME and the XDG folders there, and each is
  started in its own process group. The `run` fixture (`e2e/fixtures.ts`) stops all of them,
  unmounts the document portal and removes the folder however the test ends, a time-out included,
  and saves the app's output and the clean-up's own notes (`e2e/test-results/*/shell-output.txt`)
  when the test did not pass or the clean-up left something; a last sweep at process exit covers a
  run that was never torn down. The app runs without its test mode: no
  NODE_ENV, no probe. It starts its own service with its own token, which the test never sees; what
  the service wrote is read from disk.
- The native file dialog is the real one. WebDriver cannot reach it, so the test finds it on the
  display by its title and types the file's path into it with `xdotool` (Ctrl+L, the path, Return).
  Only the person's key presses are made by the test.
- Closing: the test sends the window the window manager's close message (`WM_DELETE_WINDOW`, `e2e/x11.ts`).
  WebDriver's own "close window" is not used, because WebKitWebDriver kills the app's process the
  moment its last window closes.
- Not covered: the native folder picker ("Choose folder…"): the library is created at a folder typed
  into the chooser, because the GTK folder chooser completes a typed path with a trailing "/" and
  Return then opens the folder instead of choosing it; a file dropped from another program (an OS drag
  and drop cannot be made under Xvfb); and the macOS app (there is no WebDriver for the Mac web view).
- **If a run was killed.** A test runner killed outright (SIGKILL, or a crashed terminal session)
  runs no clean-up at all, so its run stays behind: Xvfb, the bus and its portals, the drivers, the
  app with its service and worker, a FUSE mount of the document portal, and the run's folder in the
  temporary folder. Nothing in the test process can prevent that. The next run finds such leftovers
  (a run folder whose owning test process is gone) and stops with a list of them, before starting
  anything. When no desktop test is running, remove them with:

  ```sh
  # 1. stop every process of an earlier run (each carries its run folder in its environment)
  for p in $(grep -l "ao-desktop-e2e-" /proc/[0-9]*/environ 2>/dev/null | cut -d/ -f3); do kill -KILL "$p"; done
  # 2. unmount the document portals' file systems, then remove the run folders
  for m in $(awk '$2 ~ /ao-desktop-e2e-/ {print $2}' /proc/self/mounts); do fusermount3 -u -z "$m"; done; rm -rf "${TMPDIR:-/tmp}"/ao-desktop-e2e-*
  ```
- The real home folder is checked before and after the run, but only where this run's programs
  would write (GTK's and dconf's settings, the portals' stores, WebKitGTK's and the app's folders;
  `HOME_WATCHED` in `e2e/desktop.ts`), so other programs of a person's session can run alongside.
  That the run's processes use no other place in the real home is checked per process: each has HOME
  and every XDG folder inside the run's folder.
- The WebDriver client is `e2e/webdriver.ts`, a few W3C commands over `fetch`; the published clients
  bring in packages under licences other than MIT, Apache-2.0 and BSD. Playwright (`@playwright/test`
  1.63.0, Apache-2.0) is only the test runner; no browser of its own is started.

### The library scenarios (Task F19): the sign-in window in the real shell

`e2e/library-window.e2e.ts` runs the real app in the shell's own test mode (a debug build with
NODE_ENV=test, which lets the shell's request reach the loopback address; the shell does not pass it to
the service) against a stand-in library and publisher (`e2e/library-standin.ts`): one https server on
127.0.0.1 answering at made-up names under `ao-library-standin.test` (an EZproxy-like sign-in with a
session cookie for the proxy's domain and a second cookie for the whole made-up domain, a SAML-like
path that fails the run if asked twice or by the shell, publisher pages with and without
`citation_pdf_url`, a PDF sent as a download, a PDF address that answers the shell with a redirect to a
third host; and, for Task F18d, a library catalogue that is also a repository, its landing page and its PDF on
one host, with a cookie of its own for that host, a PDF on the proxy's own sign-in host, and a catalogue page that
links to it). Nine scenarios: the marked page fetched by the shell and waiting in the review queue until
"Use this file"; a page without the mark and "Add the PDF showing in the sign-in window"; a download;
the shell's own request redirected to a third host (its hop to the publisher carries the proxy's
cookie, its hop to the third host does not — while the whole domain's cookie does — its `Referer` holds
no query, and the file waits); the window closed while the entry waits; a quit and a new start (no
cookie at the first request); "Open it here and fetch the PDF" on the catalogue's link (set on "Your
library" to the stand-in's catalogue), its PDF on the host the window was opened at fetched and waiting for
the check, then used as a fetched copy (the shell's request carries exactly the catalogue's own cookie,
never the proxy's); its twin, "Get through my library" reaching a PDF on the library's own sign-in host,
which the shell never asks ("That is a sign-in page, …"); and a library's start handed over, then a link's
start in the same window whose page leads back to that PDF on the library's sign-in host, which the shell
still never asks (R360 a).

**The sign-in window** (`src-tauri/src/library_window.rs`) is opened by the page with the kind of start
(`open_library_window(ticket, url, from)`, R347 a): "library" (or none) — the host it is opened at is the
library's sign-in host and is never fetched from — or "link" — which adds no sign-in host of its own; the
sign-in paths and queries (`/login`, `/saml`, a SAML or CAS ticket, …) are never fetched for either; any
other `from` is refused. The kind is the ticket's (every `open` sets it). **Every host a library's start
opened the window at stays a sign-in host for every later ticket of either kind for as long as the window's
store lives** (R360 a): the window's session outlives a ticket, so a link's page could lead it back there.
The hosts are forgotten exactly where the store is emptied — the sign-out, the quit that empties it, the
start-up clean-up after a forced quit; a sign-out whose window is still there after its five-second wait
does not complete, keeps the hosts and the store, and answers false (R361) — and, where the store is the window's own (an ephemeral one: Linux,
Windows), when the window closes; on macOS they outlive the window as its store does, and with "Stay signed
in" they are kept across a quit in the device file (`library-window.json`, `signInHosts`), written before
the window goes to a new library host. It has no address bar, so its title says where it is (R347 b,
R360 b): the host of the top page shown (its ASCII form, the port when not 443, a host over 64 characters
by its end), set by the shell at every top-level navigation — a re-used window keeps the host of the page
it shows until the new address commits, only the words for the kind changing at once — then
"sign in to your library, then open the PDF and the app will fetch it for you to check" or "open the PDF
on this page and the app will fetch it for you to check". A page cannot set it. The scenarios find the
window by that exact title. The sign-in window is typed into with xdotool (WebDriver does not reach
it: it is a web view of its own ephemeral context). The stand-in tells the shell's request from the
window's by two marks that must agree — `Accept: application/pdf` alone, and no `Sec-Fetch-Mode` (which
WebKitGTK sends with every request and the shell never does); a request where they disagree fails every
scenario.

**On Linux the quit scenario cannot fail:** the sign-in window is private there (an ephemeral store,
which dies with the app's process), so "no cookie after a new start" holds whatever the shell does. It
is kept for the Mac, where the window's store is kept by identifier and must be removed at quit (on the
list for the owner's Mac check).

**They change this machine for the length of the run, and only when asked:**

```sh
AO_E2E_SYSTEM_SETUP=1 pnpm --filter @ao/desktop run e2e     # as root
```

With the switch, the e2e command (`e2e/netns.mjs`) first runs itself again inside a **network namespace
with only the loopback interface** (`unshare --net`), brings the loopback up (there is no `ip` or
`ifconfig` on this kind of machine: a few lines of the machine's Python issue `SIOCSIFFLAGS` on `lo`)
and gives it a second loopback address, 127.0.0.2/32 (the alias `lo:1`: no other interface, no route
out) — without it no name resolves for the web view, because GLib asks glibc per address family with
`AI_ADDRCONFIG`, which answers IPv4 names only when an IPv4 address other than 127.0.0.1 exists — and
checks that an outside address (192.0.2.1) fails at once, the loopback answers and `localhost` resolves
that way. Everything the
scenarios start — the stand-in, the drivers, the virtual display, the shell, its service and worker —
therefore **cannot reach any outside server**; the made-up names still resolve through the machine's
hosts file. If the namespace cannot be made, the run fails.

Then, before the scenarios (`e2e/system-setup.ts`, in this order):

1. **One run at a time:** the lock `/var/lib/ao-e2e-library-standin/lock` (exclusive creation, holding
   the run's id and process id). A second run meanwhile fails, naming the run that holds it. A lock
   whose process is gone is taken over, and only together with step 2.
2. **An earlier run's leftovers** (a run killed outright) are put back from that run's record
   (`/var/lib/ao-e2e-library-standin/record.json` and `hosts.orig`): the hosts file exactly, the
   authority's file and links removed and the store rebuilt with an empty hooks folder, the times, its
   work folder. The record is checked first, field by field, against exactly what the set-up writes
   (and the record, `hosts.orig` and the state folder must be plain files and a folder of the run's
   user, mode 0700, not links): a record that does not match is refused with nothing changed. If the
   put-back cannot be done exactly (the hosts file was changed by something else meanwhile, say), the
   run fails and says what it found; leftovers with no record are refused, not guessed at.
3. **The record** of what this run will change and how to put it back is written, before anything is
   changed.
4. A throw-away certificate authority is made with `openssl` in a private folder
   (`$TMPDIR/ao-e2e-system-setup-<run>`), valid one day, that **can vouch only for names under
   `ao-library-standin.test`** (a critical name constraint, `permitted;DNS:.ao-library-standin.test`:
   a certificate for any other name signed by it does not verify), and a certificate for the stand-in's
   names. **The authority's key is deleted as soon as that one certificate is signed**, before the
   machine trusts the authority (the server's key is kept in memory only).
5. The authority is added to the system's store (`/usr/local/share/ca-certificates/
   ao-e2e-library-standin-<run>.crt`, then `update-ca-certificates` with an empty hooks folder, so no
   other store such as Java's is touched), after checking on a copy that the store is what
   `update-ca-certificates` itself makes of it (or it could not be put back exactly).
6. A marked block mapping the names to 127.0.0.1 is appended to `/etc/hosts` (in place).

Both the web view (GnuTLS) and the shell's request (OpenSSL) then trust the stand-in as they trust any
site; nothing in the product is relaxed. After the scenarios — also when one fails, and on SIGINT,
SIGTERM, SIGHUP and the process's exit — everything is put back from the record and compared with it:
the hosts file's bytes, mode, owner and modification time; every entry of `/etc/ssl/certs` and of the
local authorities' folder (name, kind, link target or content, mode); and the modification times of
those two folders and of the bundle `ca-certificates.crt`. Any difference fails the run. **What cannot
be put back:** the change times (ctime) of the hosts file, of the two folders and of the bundle, the
bundle's inode (`update-ca-certificates` writes a new file), and the modification times of `/var/lib`
and of the temporary folder (where the run's own folders are made and removed).

It needs, as the machine's own tools (not dependencies of the project): `openssl`,
`update-ca-certificates`, `touch` (coreutils, which puts times back to the nanosecond), `unshare`
(util-linux) and `python3`. With the switch set, any obstacle — not Linux, not root, a tool missing, no
namespace, another run holding the lock, leftovers that cannot be put back — **fails the run**, with
the reason in its last lines ("FAILED: the library scenarios were asked for (AO_E2E_SYSTEM_SETUP=1) but
the machine's set-up cannot be made: …"). Without the switch the library scenarios are skipped and the
run's last lines say so, with their number: "<number> library scenarios NOT RUN (skipped), not passed —
not run: AO_E2E_SYSTEM_SETUP=1 is not set …"; the exit is as before.

**If such a run was killed outright** (SIGKILL), the next run with the switch puts the machine back
from the record by itself. To do it by hand instead (as root, when no desktop test is running):

```sh
S=/var/lib/ao-e2e-library-standin
# 0. what the record says: the run's id, and the times to put back (access and modification, to the nanosecond)
python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print("run", r["runId"]); print(r["hosts"]["times"]["a"], r["hosts"]["times"]["m"], "/etc/hosts"); [print(t["a"], t["m"], p) for p, t in r["times"]]' $S/record.json
# 1. the processes the killed run left — Xvfb, dbus-daemon and the session services it started (dconf,
#    the portals), tauri-driver, WebKitWebDriver, the shell (with its sign-in window and WebKit's own
#    processes), the library service and the media worker: stop them and remove the run folders exactly
#    as "If a run was killed" above says. (The e2e command itself, `node e2e/netns.mjs` inside the
#    namespace, and Playwright's runner end by themselves once their worker is gone; the namespace goes
#    with the last of these processes.)
# 2. the hosts file: first check what differs. The only difference must be that run's own block, the
#    lines from `# ao-e2e-library-standin <run> begin ...` to `# ao-e2e-library-standin <run> end`;
#    if anything else differs, STOP and merge by hand (the original would overwrite someone's change)
diff $S/hosts.orig /etc/hosts
#    then its original bytes written back in place, then its two times
cat $S/hosts.orig > /etc/hosts
touch -a -d @<a> /etc/hosts; touch -m -d @<m> /etc/hosts
# 3. the authority's file and its two links (the .pem link and the hash link to it), then the store
#    rebuilt with an EMPTY hooks folder, as the set-up does (the default hooks rewrite Java's store)
rm -f /usr/local/share/ca-certificates/ao-e2e-library-standin-<run>.crt
find /etc/ssl/certs -maxdepth 1 -type l -lname '*ao-e2e-library-standin-<run>*' -delete
mkdir -m 700 /tmp/no-hooks && update-ca-certificates --hooksdir /tmp/no-hooks; rmdir /tmp/no-hooks
# 4. the two folders' and the bundle's times, each from the record (lines printed by step 0)
touch -a -d @<a> <path>; touch -m -d @<m> <path>
# 5. the run's work folder (it holds no key: the authority's key was deleted when it signed), and the record
rm -rf "${TMPDIR:-/tmp}/ao-e2e-system-setup-<run>" $S
```

It needs, besides the built app (Ubuntu 24.04 package names):

```sh
apt-get install -y webkit2gtk-driver xvfb dbus xdotool
cargo install tauri-driver --version =2.1.0 --locked   # or set TAURI_DRIVER to its path
```

and the media worker as the launch check finds it (`pnpm setup:py` is enough). CI runs the build,
`cargo test`, the launch check and this scenario in the `desktop` job of `.github/workflows/ci.yml`:
on `main`, on manual runs, and on working-branch pushes that change `apps/desktop/**`,
`apps/library-service/scripts/**`, `services/media-worker/packaging/**` or the workflow.

To run the debug shell by hand:

```sh
AO_DESKTOP_NODE=$(command -v node) \
AO_DESKTOP_SERVICE_DIR=$PWD/apps/library-service/dist/library-service \
AO_DESKTOP_WORKER_BIN=<a packaged worker, or a script that runs the development one> \
apps/desktop/src-tauri/target/debug/alexandrine-oxiana
```

## The helpers' build

- `scripts/build-sidecars.mjs` builds the packaged media worker for the machine it runs on (Task
  37d): `apps/desktop/sidecars/ao-worker-<target triple>/` with the executable `ao-worker`, its
  `_internal/` folder and `sidecar-manifest.json`. `--smoke` also runs its smoke test. See
  "Packaging" in `services/media-worker/README.md`.
- `pnpm --filter @ao/desktop build:sidecars` and `smoke:sidecars` are shortcuts for it.

`.build/` (build venvs, PyInstaller's work files) and `sidecars/` (the output) are git-ignored.
The target triple follows Tauri's sidecar names (`aarch64-apple-darwin`, `x86_64-apple-darwin`,
`x86_64-unknown-linux-gnu`). The Mac build is below; signing with a Developer ID is Task 37g.

## Building for macOS

One download: **Apple Silicon** (M1 and later), built on a GitHub `macos-15` machine (R133). It needs
macOS 15.0 or later. It is signed ad hoc, not with a Developer ID (R151), so a Mac asks once before
opening it (below).

**Apple Silicon only (R169, the owner's decision of 2026-11-12).** The Intel download is not built.
The Intel runner (`macos-15-intel`), its pins and the worker's Intel pin set stay in the repository,
unused; one switch, `INTEL_BUILDS` in `scripts/mac-targets.mjs`, turns them back on. While it is off,
everything below that mentions Intel is refused in plain words and builds nothing.

**First run on a Mac: 2026-11-12** (run 1 of "Desktop (macOS)", Apple Silicon, macOS 15.8, about 15
minutes without caches). The app and its disk image were built and signed ad hoc; the packaged
worker's smoke test passed; the launch check A–D passed on the debug app, with the page reaching the
service and the worker from the origin `tauri://localhost` (requests, events, pictures, audio and
video). Check R on the release app failed on the check's own mistake: it waited for a worker, which
the app starts only when a library is opened. What a Mac run cannot show, and the owner's own tests
must: opening the downloaded app from Finder ("Open Anyway", below), and using it.

### What the workflow does

`.github/workflows/desktop-macos.yml` ("Desktop (macOS)") runs only when started from a build
request, a tag or by hand (all below), never on an ordinary branch push: Mac minutes are billed at
ten times Linux minutes. A **build request** is a commit that changes
`apps/desktop/mac-build-request.json` on a working branch: raise `"request"` by one and set
`"architectures"` to `"apple-silicon"` (R168; this is how a build is started from a session that can
push only its own branch). A
short first job on Linux decides which downloads to build and refuses a tag that is not a version
of the app (`scripts/mac-targets.mjs`). For each architecture it:

1. installs the pinned tools: Node.js (the release in `macos/pins.json`), pnpm, Python 3.13,
   Rust 1.97 and tauri-cli (`pins.json`), with caches keyed on the lock files;
2. runs `scripts/build-macos.mjs --debug-app`: the pinned Node.js release (downloaded from
   nodejs.org and checked against the SHA-256 in `pins.json` before use), the library service folder
   (built by that Node, with darwin native modules), the packaged worker (the Intel one on its own
   pin set, `services/media-worker/packaging/constraints-macos-x86_64.txt`), the notices and licence
   texts, the interface, then Tauri's bundler for the `.app`; it copies Node, the service folder and
   the worker into `Contents/Resources` (`src-tauri/tauri.macos.conf.json`; where
   `src-tauri/src/paths.rs` looks), signs the app as `macos/signing.json` says (today ad hoc), fails
   if any program or library in it needs a macOS newer than 15.0, and makes the disk image
   `dist-macos/Alexandrine-Oxiana-<version>-<apple-silicon|intel>.dmg` with its `.sha256`
   (`hdiutil` is tried up to three times: it fails now and then with "Resource busy");
3. uploads the disk image and its SHA-256 as the run's artefacts at once, so a check that fails
   afterwards never costs the download; the caches are saved even when a step failed;
4. checks it on the runner: the packaged worker's smoke test (with Homebrew's ffmpeg and tesseract,
   which the app itself does not ship), the launch check A–D on the debug build of the app (the same
   bundle layout; only a debug build reports what the check reads), and check R on the release app
   run from the mounted disk image: its service starts from the app's own resources, listens on
   127.0.0.1 and refuses a request without its token, and nothing is left after the app is stopped
   (no worker is expected in R: the service starts it when a library is opened, which only A–D do);
   and writes the sizes and checksums in the run's summary.

On a Mac with the same tools, `pnpm --filter @ao/desktop run build:macos` does step 2 by hand;
`node scripts/build-macos.mjs --dry-run [--arch arm64|x64]` prints the steps on any system.

**Launch check scenarios on a Mac** (`scripts/launch-check.mjs --app <debug .app>`): A (normal close,
the page reaching the service and the worker, the granted commands, the helpers' environment, the
second launch), B (SIGTERM), C (SIGKILL: the service sees its standard input close) and D (a service
that refuses to start) are expected to work as on Linux: they use only the shell's own test output,
standard input and signals. The check runs the program inside the bundle directly (not through
`open`), so that it can read the program's output. **E (opened again while closing) is skipped on a
Mac**, with its reason printed: there Tauri restarts a bundled app through LaunchServices
(`open -n`; tauri 2.12.5 `src/process.rs`), so the restarted app's output never reaches the check.
**Q (quit by Apple event; a Mac only, FR-731)** asks the running app to quit with
`osascript -e 'tell application id "org.alexandrineoxiana.desktop" to quit'` (AppKit answers that event
with the same `terminate:` as Cmd-Q and the Dock's Quit) and checks, as A does, that the quit went the
orderly way (the shell's `AO_SHELL_QUIT orderly`, a clean stop, exit 0, nothing left; the shell says in
test mode whether its quit hook was installed, `AO_SHELL_QUIT_HOOK installed` or `not installed`, and Q
names a hook that was not), then once more
with the slowed stop, as F does, that the closing window was shown. When the event cannot be sent for
a reason outside the app — macOS does not see the app as running under its bundle id, does not permit
osascript to send it Apple events, or osascript gets no answer within 30 s (a permission request may be
waiting on the runner's screen) — Q stops the app with SIGTERM instead and checks that stop exactly as B
does (the shell ends, the helpers stop cleanly, nothing is left): when it passes, Q prints
`launch-check: skip Q (…): <reason>`, saying also whether the shell printed anything after the event; when
it does not, Q fails, because an app that hangs at the quit looks exactly like an event with no answer. An
event delivered that the app does nothing about fails. A shell that ends at the quit without its
`AO_SHELL_QUIT` line, or by a signal, is examined first as a crash is at the start (the crash report, a
debugger's backtrace, the bundle). On a Mac the check then prints one line that says
whether Q ran: `launch-check: Q ran: …`, `launch-check: Q SKIPPED (<reason>): …` (or `SKIPPED in part`), or
`launch-check: Q FAILED (…)`. On Linux Q is skipped, and says so. Pressing Cmd-Q on a real Mac remains
the owner's check.
At the start and the end the check looks for any process of any copy of the app (its program, or
Node.js or the worker from an app's resources) and stops it; one found at the end is a failure. On a
Mac the processes are read with `ps` instead of `/proc`, there is no virtual display or D-Bus (the
runner has a logged-in desktop session), and the helpers' environment is read with `ps -E`. A check
that cannot see what it checks fails ("could not check"): an environment that cannot be read, or
that lacks the names the service (`PATH`, `AO_SERVICE_PORT`, `AO_CONFIG_DIR`) or the worker
(`AO_WORKER_PORT`) always has, and a leftover-process search that cannot find a stand-in process
carrying its marker.

### Starting a build

**From a tag (works from any branch).** A tag whose name says the version and the architectures
starts a build:

| Tag | Builds |
| --- | --- |
| `v0.0.0-arm.1` | Apple Silicon (a test build) |
| `v0.0.0` | Apple Silicon (a release) |
| `v0.0.0-mac.1` | refused while Intel is off (with Intel on: both downloads) |
| `v0.0.0-intel.1` | refused while Intel is off (with Intel on: Intel only) |

The version (`0.0.0` here) must be the app's version, `version` in `src-tauri/tauri.conf.json`;
otherwise the run stops in its first minute, on Linux, before any Mac time is spent. Only these four
forms build, exactly as written (lower case, a number at the end and nothing after it): any other
tag that starts with `v` and a version, such as a mistyped `-arm1`, `-ARM.1` or `-rc.1`, also stops
there, with a message naming the accepted forms, and builds nothing. The last number
counts attempts: each new build needs a new tag (`-arm.2`, `-arm.3`, …). Because it spends Mac
minutes, a tag is pushed only at the owner's word (R167). From a checkout of the branch to build:

```sh
git tag v0.0.0-arm.1
git push origin v0.0.0-arm.1
```

**With the "Run workflow" button (on the GitHub website).** GitHub shows this button only for a
workflow whose file is on the repository's default branch (`main`). Until the owner agrees to put
`.github/workflows/desktop-macos.yml` on `main` (it does nothing there by itself: it has no branch
trigger), the button does not exist and a build is started for the owner with a tag, as above. Once
the file is on `main`:

1. Open the repository on github.com and click **Actions** (top of the page).
2. In the list on the left, click **Desktop (macOS)**.
3. Click **Run workflow** (on the right, above the list of runs). Under "Use workflow from", choose
   the branch to build; "Which downloads to build" offers **apple-silicon** only. Click the green
   **Run workflow** button.
4. The run appears in the list after a few seconds. A cold run takes roughly an hour (estimate).

### Where the downloads appear

Open the finished run (click its name in the list). At the bottom of its **Summary** page, under
**Artifacts**, is `alexandrine-oxiana-macos-apple-silicon`. It downloads as a `.zip` holding the
disk image (`.dmg`) and its SHA-256, and is kept for 30 days. It runs on a Mac whose Apple menu >
About This Mac says "Chip: Apple M…"; a Mac that says "Processor: …Intel…" cannot run it (R169).

The same list has `alexandrine-oxiana-browser-extension`: the browser extension for Chrome, Edge and
Firefox 128 or later, built on Linux by the run's `extension` job (Task 65), also kept for 30 days.
It holds `alexandrine-oxiana-browser-extension-<version>.zip` and its SHA-256, and the run's summary
gives both. The job does not wait for the Mac build and does not fail with it. How to load it:
`apps/browser-extension/README.md`, "Installing the extension from the download".

### Opening the unsigned app the first time ("Open Anyway", R151)

1. Open the downloaded `.zip` (Safari may already have unpacked it into a folder), then the `.dmg`,
   and drag **Alexandrine Oxiana** onto **Applications**.
2. Open it from Applications. macOS says it cannot check the app for malicious software. Click
   **Done** (not "Move to Trash").
3. Open **System Settings > Privacy & Security** and scroll down to **Security**. Next to the
   message that Alexandrine Oxiana was blocked, click **Open Anyway**, confirm with your password or
   Touch ID, then click **Open**. The button is offered only for a while (about an hour) after the
   blocked attempt; if it is gone, open the app again and repeat step 3.

This is needed once per download. From then on the app opens normally. On macOS 15 the older way
(Control-click the app, then Open) no longer skips this step.

### For Task 37g (signing and notarisation): written down, not enabled

`macos/signing.json` is the only place to change: `identity` (or the `APPLE_SIGNING_IDENTITY`
variable from a secret, with the certificate imported into a keychain by the workflow),
`hardenedRuntime: true`, and an entitlements file per part. With an identity every Mach-O file is
signed inside out, each with a secure timestamp. The entitlements each part is expected to need
under the hardened runtime (to be confirmed by trying, not added in advance):

- **the shell** (`app`): none expected; the web view's JavaScript runs in the system's own WebKit
  processes.
- **Node.js** (`node`): `com.apple.security.cs.allow-jit` for V8's compiler; possibly
  `com.apple.security.cs.allow-unsigned-executable-memory`. Not
  `com.apple.security.cs.disable-library-validation` while every `.node` file is signed with our
  Team ID, and never `com.apple.security.cs.allow-dyld-environment-variables` (R153). **Re-signing
  Node.js is required, not optional:** the ad-hoc build ships Node's official binary with its
  publisher's signature (Developer ID "Node.js Foundation"), whose entitlements include
  `allow-dyld-environment-variables`, `disable-library-validation` and `get-task-allow` (read from
  v22.23.4 darwin-arm64 in the Task 37f review). The shell never passes a `DYLD_*` variable (R153),
  so this is not reachable through the app, and the ad-hoc build is for the owner's own tests
  (R151); a build for anyone else must replace that signature with ours and our entitlements.
- **the worker** (`worker`): none at first; `com.apple.security.cs.allow-unsigned-executable-memory`
  only if a ctypes or cffi callback fails (ADR 0014).

Apple expects code in `Contents/MacOS`, `Contents/Frameworks` or `Contents/Helpers`, not in
`Contents/Resources`, where the helpers are today (`src-tauri/src/paths.rs`); if notarisation or the
signature check refuses that, the helpers move and `paths.rs` with them.
