/**
 * Built as content.js (one classic script, no imports), injected by the background with
 * scripting.executeScript when the user clicks a capture button. Lives in the extension's isolated
 * world: the page's own scripts cannot see globalThis.__aoCapture.
 */
import browser from "webextension-polyfill";
import { createContentApi } from "./index.js";

globalThis.__aoCapture ??= createContentApi(window, {
  finish: (urls) => browser.runtime.sendMessage({ type: "overlay-finish", urls }) as Promise<{ ok: boolean; message: string } | undefined>,
  cancel: () => void browser.runtime.sendMessage({ type: "overlay-cancel" }),
});
