import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The desktop shell (Tauri, Task 37) loads the built app and hands it the service URL and token at
// start-up; the token is never put in a URL.
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", strictPort: true },
});
