// Runs stripHtml for one snapshot off the main event loop (R101 N2); the parent caps its heap and time.
import { parentPort, workerData } from "node:worker_threads";
import { stripHtml } from "./html-strip.mjs";

try {
  parentPort.postMessage({ ok: true, html: stripHtml(workerData.html) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err instanceof Error ? err.name : "error" });
}
