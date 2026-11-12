/**
 * Drop files here to attach them (spec 5.1). The desktop shell supplies OS file paths; the e2e
 * browser build injects them through the same `onPaths` prop. Dropped items are read as
 * `text/uri-list` file URLs or, where the shell sets it, each File's `path`. For keyboard users (and
 * anyone without a pointer) "Attach files…" takes paths typed one per line.
 *
 * Inside the desktop shell (desktopShell.ts) "Choose files…" opens the native file picker, and files
 * dropped on the area arrive as paths through the shell's drop event; the DOM drop then only stops
 * the web view from opening the file, so nothing is attached twice.
 */
import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent } from "react";
import { desktopShell } from "../desktopShell";
import "./library.css";

/** A file:// URL as a local path ("" for anything else). */
function fileUrlToPath(u: string): string {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return "";
  }
  if (url.protocol !== "file:") return "";
  let p: string;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    return "";
  }
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1); // file:///C:/x → C:/x
  if (url.host && url.host !== "localhost") p = `//${url.host}${p}`; // file://server/share → //server/share
  return p.includes("\0") ? "" : p;
}

/** Local paths carried by a drop: file URLs in text/uri-list and Files that carry a `path`. */
export function pathsFromDataTransfer(dt: DataTransfer): string[] {
  const out: string[] = [];
  const types = Array.from(dt.types ?? []);
  if (types.includes("text/uri-list")) {
    for (const line of dt.getData("text/uri-list").split(/\r\n|\r|\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const p = fileUrlToPath(t);
      if (p) out.push(p);
    }
  }
  for (const f of Array.from(dt.files ?? [])) {
    const p = (f as File & { path?: unknown }).path;
    if (typeof p === "string" && p) out.push(p);
  }
  return [...new Set(out)];
}

export interface DropZoneProps {
  onPaths: (paths: string[]) => void;
  disabled?: boolean;
  /** Shown while disabled, e.g. "This library is read-only." */
  disabledReason?: string;
  /** What the files go to, for the label (default "this project"). */
  target?: string;
}

export function DropZone({ onPaths, disabled = false, disabledReason, target = "this project" }: DropZoneProps) {
  const [over, setOver] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [picking, setPicking] = useState(false);
  const fieldId = useId();
  const hintId = useId();
  const shell = desktopShell();
  const zone = useRef<HTMLElement>(null);
  // The latest props, for the shell's drop events and the picker's answer.
  const latest = useRef({ onPaths, disabled });
  latest.current = { onPaths, disabled };
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const el = zone.current;
    const undo =
      shell && el
        ? shell.dropTarget(el, {
            onPaths: (paths) => {
              setOver(false);
              if (!latest.current.disabled && paths.length) latest.current.onPaths(paths);
            },
            onOver: (o) => setOver(o && !latest.current.disabled),
          })
        : undefined;
    return () => {
      mounted.current = false;
      undo?.();
    };
  }, [shell]);

  const choose = async () => {
    if (!shell || picking || disabled) return;
    setPicking(true);
    try {
      const paths = await shell.pickFiles(`Attach files to ${target}`, true);
      if (mounted.current && paths.length && !latest.current.disabled) latest.current.onPaths(paths);
    } catch {
      // The picker could not be opened: the typed-path way below stays available.
    } finally {
      if (mounted.current) setPicking(false);
    }
  };

  const onDragOver = (e: DragEvent) => {
    // Always prevented, even while disabled: otherwise the webview would navigate to the dropped file.
    e.preventDefault();
    if (disabled) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
      return;
    }
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    setOver(true);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    // Inside the shell the drop's paths come through the shell's drop event (above).
    if (disabled || !e.dataTransfer || shell) return;
    const paths = pathsFromDataTransfer(e.dataTransfer);
    if (paths.length) onPaths(paths);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const paths = [...new Set(typed.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean))];
    if (!paths.length || disabled) return;
    onPaths(paths);
    setTyped("");
    setTyping(false);
  };

  return (
    <section
      ref={zone}
      aria-label={`Attach files to ${target}`}
      aria-describedby={hintId}
      aria-disabled={disabled ? "true" : undefined}
      className={`ao-drop${over ? " ao-drop--over" : ""}${disabled ? " ao-drop--disabled" : ""}`}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <p id={hintId} className="ao-drop__hint">
        {disabled ? (disabledReason ?? "Attaching files is off.") : "Drop PDFs, EPUBs, images, audio or video here to attach them."}
      </p>
      {shell && (
        <button type="button" disabled={disabled || picking} onClick={() => void choose()}>
          Choose files…
        </button>
      )}
      <button type="button" disabled={disabled} aria-expanded={typing} onClick={() => setTyping((t) => !t)}>
        Attach files…
      </button>
      {typing && !disabled && (
        <form className="ao-drop__form" onSubmit={submit}>
          <label htmlFor={fieldId}>File paths, one per line</label>
          <textarea id={fieldId} rows={3} value={typed} onChange={(e) => setTyped(e.target.value)} dir="auto" />
          <div className="ao-row">
            <button type="submit">Attach</button>
            <button type="button" onClick={() => setTyping(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
