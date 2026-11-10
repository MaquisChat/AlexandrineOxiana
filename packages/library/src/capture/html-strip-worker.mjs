// Runs stripHtml for one snapshot off the main event loop (R101 N2); the parent caps its heap and time.
import { parentPort, workerData } from "node:worker_threads";
import { SnapshotRefused, stripHtml } from "./html-strip.mjs";

try {
  parentPort.postMessage({ ok: true, html: stripHtml(workerData.html) });
} catch (err) {
  parentPort.postMessage({ ok: false, refused: err instanceof SnapshotRefused, reason: err instanceof SnapshotRefused ? err.message : undefined });
}
