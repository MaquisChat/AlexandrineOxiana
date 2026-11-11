import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * index.html carries the app's Content-Security-Policy (R105). The dev server injects inline scripts
 * (React refresh, HMR client) that this policy refuses, so in `vite` dev mode only the tag is
 * dropped; builds keep it.
 */
function dropCspInDev(): Plugin {
  return {
    name: "ao-drop-csp-in-dev",
    apply: "serve",
    transformIndexHtml: (html) => html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, ""),
  };
}

// The desktop shell (Tauri, Task 37) loads the built app and hands it the service URL and token at
// start-up; the token is never put in a URL.
export default defineConfig({
  plugins: [react(), dropCspInDev()],
  server: { host: "127.0.0.1", strictPort: true },
});
