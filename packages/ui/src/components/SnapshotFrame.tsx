/**
 * Shows a captured web page (HTML snapshot) safely, for Tasks 33/34 (R105). The snapshot never runs
 * scripts and never gets the app's origin:
 *
 *  - an iframe with `sandbox=""` (no allow-scripts, no allow-same-origin, no forms/popups/navigation);
 *  - loaded from a `blob:` document (never srcdoc), which starts with a Content-Security-Policy meta
 *    tag (`script-src 'none'`, nothing fetched from the network) ahead of the snapshot's own markup;
 *  - no referrer; the blob URL is revoked when the snapshot changes or the frame goes away.
 *
 * The service already strips scripts from stored snapshots (Task 30); this is the second wall.
 */
import { useEffect, useState } from "react";
import "./SnapshotFrame.css";

/** Images and fonts may be inlined (data:/blob:); nothing else loads, nothing runs. */
export const SNAPSHOT_CSP = "default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; img-src data: blob:; font-src data:; media-src data: blob:; style-src 'unsafe-inline'";

/** The document the frame shows: the CSP first, then the snapshot. */
export function snapshotDocument(html: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_CSP}"><meta name="referrer" content="no-referrer">${html}`;
}

export interface SnapshotFrameProps {
  /** The snapshot's HTML (as stored by the service). */
  html: string;
  /** Accessible name of the frame, e.g. "Snapshot of example.org, 3 March 2026". */
  title: string;
  className?: string;
}

export function SnapshotFrame({ html, title, className }: SnapshotFrameProps) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([snapshotDocument(html)], { type: "text/html" }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [html]);
  if (!url) return null;
  return <iframe className={["ao-snapshot-frame", className].filter(Boolean).join(" ")} title={title} sandbox="" src={url} referrerPolicy="no-referrer" />;
}
