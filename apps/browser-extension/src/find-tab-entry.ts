/**
 * Built as find-tab.js (one classic script, no imports), injected by the background into the active tab's top frame
 * with scripting.executeScript ONLY when the researcher presses "Send this tab's PDF" (R348 i, R110). It runs in the
 * extension's isolated world and reads `location.href` and `document.contentType`, nothing else (find-tab.ts). It
 * defines no global and leaves no listener behind once it has ended.
 */
import type { PortLike } from "./find-protocol.js";
import { readTabPdf } from "./find-tab.js";

type Runtime = { connect(info: { name: string }): PortLike };
const g = globalThis as unknown as { browser?: { runtime?: Runtime }; chrome?: { runtime?: Runtime } };
const runtime = g.browser?.runtime ?? g.chrome?.runtime;

if (runtime) {
  void readTabPdf({
    href: location.href,
    contentType: document.contentType,
    fetch: (input, init) => fetch(input, init),
    connect: (name) => runtime.connect({ name }),
  });
}
