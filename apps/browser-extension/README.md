# Alexandrine Oxiana browser capture extension

Captures the page you are viewing into your library on this computer (spec §5.1). It sends a full-page
screenshot, the page's HTML with scripts removed, and the fields it can read (handle, caption, date,
counts, media links). "Capture profile as I scroll" (spec §5.5) notes the post links a profile shows
while you scroll it yourself. What the extension reads is stored as `page-dom` evidence. When you also
use the downloader, the recheck compares that evidence with the platform's own data (spec §5.8).

Works in Chrome/Edge (Manifest V3 service worker) and in Firefox 128 or later (the same `background.js`
runs as a background script, and the code uses `webextension-polyfill`).

## Installing the extension from the download

You do not need to build anything. Every Mac build of the desktop app also makes the extension.

1. **Download it.** Open the same GitHub Actions run page you downloaded the Mac app from (workflow
   "Desktop (macOS)"). At the bottom of its **Summary** page, under **Artifacts**, click
   `alexandrine-oxiana-browser-extension`. It is kept for 30 days, like the Mac download.
2. **Unzip it.** The download is a `.zip` that holds another `.zip`,
   `alexandrine-oxiana-browser-extension-<version>.zip`, and a `.sha256` file with its checksum
   (Safari may already have opened the outer one into a folder). Open the inner `.zip`: on a Mac,
   double-click it; on Windows, right-click it and choose **Extract All**. You get a folder with
   `manifest.json` and a few other files directly inside it.
3. **Give the extension one folder that stays.** Make a folder in a place that is not cleaned up, for
   example **Documents › Alexandrine Oxiana extension** (not Downloads), and move the unzipped files
   into it, so that `manifest.json` is directly inside. Use this same folder for every later version
   (see "Updating" below): the browser knows the extension by the folder it was loaded from.

Then load it in your browser:

- **Chrome or Edge:** type `chrome://extensions` in the address bar (in Edge, `edge://extensions` also
  works) and press Return or Enter. Turn on **Developer mode** (a switch at the top right in Chrome, on
  the left in Edge). Click **Load unpacked** and pick the extension's folder (the one with
  `manifest.json` inside). Keep that folder: the browser loads the extension from it each time it
  starts, and the extension stops working if the folder is moved or deleted.
- **Firefox (version 128 or later):** type `about:debugging` in the address bar and press Return or
  Enter. Click **This Firefox**, then **Load Temporary Add-on…**, and pick the `manifest.json` file
  inside the extension's folder. Firefox removes a temporary add-on when it closes, so you load it again
  each time you start Firefox. If the popup then shows "Pair with the desktop app" again, pair it again
  (see "Pairing" below).
- **Safari** is not supported.

Next, pair it with the desktop app (see "Pairing" below).

**Checking the download (optional).** The run's Summary page lists the extension's SHA-256 under
"Browser extension". On a Mac, in Terminal, run `shasum -a 256` followed by a space and the inner
`.zip` (you can drag the file into the Terminal window), press Return, and compare the long number it
prints with the one on the Summary page. They must be the same.

### Updating to a newer download

Keep the same folder, so that the browser sees the same extension and its pairing is kept.

- **Chrome or Edge:** unzip the newer download as in step 2. Delete everything inside the extension's
  folder and move the newly unzipped files into it (again with `manifest.json` directly inside). Then,
  on `chrome://extensions` (or `edge://extensions`), find the **Alexandrine Oxiana capture** card and press its reload
  arrow (↻). You do not need to quit the browser or pair again.
- **Firefox:** unzip the newer download into the same folder in the same way, then load it again from
  `about:debugging` as above. Firefox treats it as the same add-on (the extension carries a fixed
  Firefox ID), but as after any restart, pair it again if the popup asks you to.

**If you loaded a second copy by mistake** (for example by choosing **Load unpacked** on a new
folder): Chrome and Edge treat a different folder as a different extension, so you now have two
**Alexandrine Oxiana capture** cards, and the new one is not paired while the old one still runs the old version.
The simplest way back to one copy: on `chrome://extensions`, click **Remove** on both **Alexandrine Oxiana capture**
cards, make sure the extension's one folder holds the newer files, choose **Load unpacked** on that
folder, and pair it (see "Pairing" below). The old copy's pairing stays listed in the desktop app
under **Browser extension**, **Paired browsers**; press **Revoke** next to the entries you no longer
use (the list shows each browser's extension address, not a name, so if unsure, revoke them all and
pair again).

## Build, load and test

```sh
pnpm --filter @ao/browser-extension build      # → apps/browser-extension/dist (unpacked)
pnpm --filter @ao/browser-extension run package # builds, then dist-zip/alexandrine-oxiana-browser-extension-<version>.zip and its .sha256
pnpm --filter @ao/browser-extension exec vitest run
node --test apps/browser-extension/scripts/package.test.mjs  # the packaging script's tests (also in pnpm test:scripts)
pnpm e2e -- --extension-only e2e/extension.spec.ts --trace off  # builds, then Playwright (headless Chromium)
```

`package` writes a reproducible archive: the same built files always give the same SHA-256 (entries
sorted, stored without compression, one fixed date and file mode; see `scripts/package.mjs`). The Mac
build's workflow runs it on Linux and uploads the result (`.github/workflows/desktop-macos.yml`, job
`extension`). To run the end-to-end test against another unpacked folder, such as the unzipped
download, set `AO_EXTENSION_DIR` to that folder and run
`pnpm --filter @ao/browser-extension exec playwright test`.

To load the build:

- **Chrome:** open `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and pick `dist/`.
- **Firefox:** open `about:debugging`, choose "Load Temporary Add-on" and pick `dist/manifest.json`.

## Pairing

1. In the desktop app, with your library open, choose **Browser extension** at the top of the window,
   then **Show a pairing code**. The page shows the service's port and a 6-digit code
   (`POST /extension/pair`).
2. In the popup, type the port and the code. The popup posts the code to `POST /extension/pair/confirm`
   and keeps the token it gets back in `storage.local` (never `storage.sync`).
3. **Unpair** removes the token from the extension. The desktop app's list of paired extensions can
   revoke it on the service side.

The extension never scans for the port. Every request goes to `http://127.0.0.1:<port>` with the token in
the `Authorization` header only, never in a URL. No cookies are sent, and redirects are refused.

## Privacy and permissions (R110)

- **Permissions:** only `activeTab`, `scripting` and `storage`. Host access covers only
  `http://127.0.0.1/*` and `http://localhost/*`, so the extension can reach nothing but the local
  service. It has no `<all_urls>`, `tabs`, `history` or `cookies` permission, and incognito is not
  allowed.
- **When it runs:** nothing runs in a page until you click a button in the popup. That click grants
  `activeTab` for that tab, and only then is `content.js` injected (`scripting.executeScript`). There are
  no persistent content scripts and no resources exposed to pages.
- **Page text:** the popup renders anything that comes from a page or the service only as React text,
  never as HTML. The extension pages use the CSP `script-src 'self'`, with `connect-src` limited to the
  local service.
- **Profile links:** the link list from "profile as I scroll" lives only in `storage.session` (cleared
  when the browser closes) until it is sent or discarded.

## Selectors (`src/content/selectors.json`)

All CSS selectors live in this one file. When a platform changes its markup, fix it there. The background
loads the file and checks it against the schema in `src/content/selectors-schema.ts`, and the page checks
it again, including CSS syntax. If the file does not match the schema, it is refused as a whole.

Each field is a list of alternatives `{ css, read?: "text" | "attr:<name>", pattern? }`. The first
alternative that matches **exactly one** element and gives a valid value wins. If none does, the field is
left out and never guessed. The extractor also checks the values themselves:

- Counts must be whole numbers, so "12.4K" is left out.
- Dates must be ISO 8601 and are kept exactly as the page states them.
- Links must be `http(s)`, and a canonical link must stay on the platform.

The page kind and the post ID come from the address (`extractors/{instagram,tiktok,youtube}.ts`). Other
sites use `generic.ts`, which reads the canonical link, the Open Graph title and image, and the
publication time.

## Screenshot

`content/screenshot.ts` takes the screenshot in these steps:

1. Scroll one viewport at a time and take `tabs.captureVisibleTab` at most twice a second (the browser's
   limit, through one limiter shared by every capture the extension runs).
2. Hide fixed and sticky bars after the first frame, so they appear once.
3. Stitch the frames on an `OffscreenCanvas`.

Size limits:

- The image is at most 30,000 px high. A longer page is cut there, and the popup says so.
- The image's area stays within a memory budget based on `navigator.deviceMemory` and the canvas area
  limit. If the page would exceed it, the image is scaled down.
- The PNG is kept under 18 MB to fit the service's request limit.

The scroll position and anything hidden are restored afterwards, also on error. If another tab comes to
the front during the capture, the capture stops.

## Profile as I scroll

Profile capture is available only in projects whose rules allow both browser capture and the downloader,
because the links are queued for the downloader. The extension only listens to scroll events. It never
clicks, follows a link, scrolls or loads anything.

A small counter in the page has **Finish** and **Cancel**, and the popup shows the same counter. If the
page moves to another address that is not one of the profile's own tabs, which single-page sites do
without reloading, listening stops and the counter says so. The links noted so far are kept for Finish.

On Finish, the links (at most 500 per run) go to `POST /capture/browser/links` with
`{ projectId, urls }`. This extension-scoped route arrives in the service with R111.

If the service does not take a list, the reply names the reason:

- `FORBIDDEN`: the desktop app needs updating.
- `POLICY_DENIED`: the project's rule says why.

The list not taken is kept per project in session storage. A later list for the same project is merged
in, never written over. The popup offers **Try again**, **Copy list** and **Discard** for each project.

## Size limits

- **Request body:** a capture is measured in UTF-8 bytes against the service's 32 MB limit. If it is too
  big, the HTML snapshot is dropped first, then the extracted media links. If it is still too big, the
  extension refuses it with a message instead of sending it.
- **Media links:** at most 50, each at most 2,048 characters, and reading stops at 50.
- **Snapshot fetches:** the HTML snapshot is built in an inert document, so making it fetches nothing.
- **Selector patterns:** a pattern may not use backreferences or nested quantifiers, and it sees at most
  the first 20,000 characters of a value.
