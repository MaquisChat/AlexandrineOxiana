/**
 * Built as find-tab.js (one classic script, no imports), injected by the background into the active tab's top frame
 * with scripting.executeScript ONLY when the researcher presses "Send this tab's PDF" (R348 i, R110). It runs in the
 * extension's isolated world and reads `location.href` and `document.contentType`, nothing else (find-tab.ts). It
 * defines no global and leaves no listener behind once it has ended.
 */
import { extensionRuntime, readTabPdf } from "./find-tab.js";

// chrome.runtime first, then browser.runtime, and only one with a connect function (R357 g); else nothing is done.
const runtime = extensionRuntime(globalThis);

if (runtime) {
  void readTabPdf({
    href: location.href,
    contentType: document.contentType,
    fetch: (input, init) => fetch(input, init),
    connect: (name) => runtime.connect({ name }),
  });
}
