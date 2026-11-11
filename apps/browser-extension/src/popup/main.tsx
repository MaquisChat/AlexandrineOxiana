import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import browser from "webextension-polyfill";
import { createApi } from "../api.js";
import type { PendingLinks } from "../types.js";
import { Popup, type PopupBridge } from "./Popup.js";
import "./popup.css";

const bridge: PopupBridge = {
  api: createApi({ fetch: (input, init) => fetch(input, init), storage: browser.storage.local }),
  async activeTabId() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return typeof tab?.id === "number" ? tab.id : undefined;
  },
  send: (msg) => browser.runtime.sendMessage(msg) as never,
  async pendingLinks() {
    return (await browser.storage.session.get("pendingLinks")).pendingLinks as PendingLinks | undefined;
  },
  copy: (text) => navigator.clipboard.writeText(text),
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Popup bridge={bridge} />
  </StrictMode>,
);
