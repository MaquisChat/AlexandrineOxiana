# Alexandrine Oxiana browser capture extension

Captures the page you are viewing into your library on this computer (spec §5.1). It sends a full-page
screenshot, the page's HTML with scripts removed, and the fields it can read (handle, caption, date,
counts, media links). "Capture profile as I scroll" (spec §5.5) notes the post links a profile shows
while you scroll it yourself. What the extension reads is stored as `page-dom` evidence. When you also
use the downloader, the recheck compares that evidence with the platform's own data (spec §5.8).

Works in Chrome/Edge (Manifest V3 service worker) and in Firefox 128 or later (the same `background.js`
runs as a background script, and the code uses `webextension-polyfill`).

## Build, load and test

```sh
pnpm --filter @ao/browser-extension build      # → apps/browser-extension/dist (unpacked)
pnpm --filter @ao/browser-extension exec vitest run
pnpm e2e -- e2e/extension.spec.ts --trace off  # builds, then Playwright (headless Chromium)
```

To load the build:

- **Chrome:** open `chrome://extensions`, turn on Developer mode, choose "Load unpacked" and pick `dist/`.
- **Firefox:** open `about:debugging`, choose "Load Temporary Add-on" and pick `dist/manifest.json`.

## Pairing

1. In the desktop app, open Settings → Browser extension. It shows the service's port and a 6-digit code
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
   limit).
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

The extension only listens to scroll events. It never clicks, follows a link, scrolls or loads anything.
A small counter in the page has **Finish** and **Cancel**, and the popup shows the same counter. On
Finish, the links (at most 500, the service's limit per request) go to `POST /projects/:id/capture`.

**Current limitation:** the service accepts the extension token only for `POST /capture/browser` and
`GET /projects` (R96), so Finish gets 403. The list is then kept in session storage, and the popup offers
**Try again**, **Copy list** and **Discard** until the service accepts it.
