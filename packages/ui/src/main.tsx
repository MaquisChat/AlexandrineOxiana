import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { takeServiceConnection } from "./serviceConnection";
import "./theme/tokens.css";
import "./theme/fonts.css";
import "./theme/base.css";

// Read the service URL and token handed over by the desktop shell, and remove them from window.
const service = takeServiceConnection(window);

const el = document.getElementById("root");
if (!el) throw new Error("index.html has no #root element");
createRoot(el).render(
  <StrictMode>
    <App {...(service ? { service } : {})} />
  </StrictMode>,
);
