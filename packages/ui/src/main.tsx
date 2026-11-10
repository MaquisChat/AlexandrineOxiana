import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, type ServiceConnection } from "./App";
import "./theme/tokens.css";
import "./theme/fonts.css";
import "./theme/base.css";

declare global {
  interface Window {
    /**
     * Set by the desktop shell (Task 37) before the app loads: the local service's URL and the UI
     * token, which is only ever sent in the Authorization header.
     */
    __AO_SERVICE__?: ServiceConnection;
  }
}

const el = document.getElementById("root");
if (!el) throw new Error("index.html has no #root element");
createRoot(el).render(
  <StrictMode>
    <App {...(window.__AO_SERVICE__ ? { service: window.__AO_SERVICE__ } : {})} />
  </StrictMode>,
);
