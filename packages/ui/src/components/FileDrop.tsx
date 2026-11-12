/**
 * A drop target for documents (protocol approvals, consent forms). The service copies files from
 * their path on disk, so the drop needs paths, not file contents.
 *
 * Paths: a web page's DOM drop event carries File objects without a path. Inside the desktop shell
 * (desktopShell.ts) drops arrive instead as paths through the shell's drop event, and "Choose
 * file(s)…" opens the native picker; the DOM drop then only stops the web view from opening the
 * file. Outside the shell a DOM drop of Files that carry a `path` is taken, and one without paths
 * shows a message. For keyboard use the full path can always be typed instead.
 */
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { desktopShell } from "../desktopShell";

type WithPath = File & { path?: string };

export function FileDrop({
  prompt,
  fieldLabel,
  onPaths,
  disabled,
  single,
}: {
  prompt: string;
  fieldLabel: string;
  onPaths: (paths: string[]) => void;
  disabled?: boolean;
  /** Only one file at a time (e.g. a consent record's signed form): several dropped → a message, nothing added. */
  single?: { message: string };
}) {
  const id = useId();
  const [over, setOver] = useState(false);
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const shell = desktopShell();
  const zone = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  /** Paths from a drop or the picker: refused while disabled, and several when only one is taken. */
  const take = (paths: string[]) => {
    if (latest.current.disabled || !paths.length) return;
    if (latest.current.single && paths.length > 1) {
      setProblem(latest.current.single.message);
      return;
    }
    setProblem(null);
    latest.current.onPaths(paths);
  };
  const latest = useRef({ onPaths, disabled, single, take });
  latest.current = { onPaths, disabled, single, take };

  useEffect(() => {
    mounted.current = true;
    const el = zone.current;
    const undo =
      shell && el
        ? shell.dropTarget(el, {
            onPaths: (paths) => {
              setOver(false);
              latest.current.take(paths);
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
      const paths = await shell.pickFiles(prompt, !single);
      if (mounted.current) latest.current.take(paths);
    } catch {
      if (mounted.current) setProblem("The file picker could not be opened. Type the full path below instead.");
    } finally {
      if (mounted.current) setPicking(false);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    // Inside the shell the drop's paths come through the shell's drop event (above).
    if (disabled || shell) return;
    const files = [...(e.dataTransfer?.files ?? [])] as WithPath[];
    const paths = files.map((f) => f.path).filter((p): p is string => typeof p === "string" && p !== "");
    if (!files.length) return;
    if (single && files.length > 1) {
      setProblem(single.message);
      return;
    }
    if (paths.length !== files.length) {
      setProblem("Where these files are on disk could not be read. Type the full path below instead.");
      return;
    }
    setProblem(null);
    onPaths(paths);
  };

  return (
    <div className="ao-filedrop">
      <div
        ref={zone}
        className={over ? "ao-dropzone ao-dropzone--over" : "ao-dropzone"}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        {prompt}
      </div>
      {problem ? (
        <p className="ao-warning" role="alert">
          {problem}
        </p>
      ) : null}
      {shell && (
        <button type="button" disabled={disabled || picking} onClick={() => void choose()}>
          {single ? "Choose file…" : "Choose files…"}
        </button>
      )}
      <form
        className="ao-field"
        onSubmit={(e) => {
          e.preventDefault();
          const p = typed.trim();
          if (!p) return;
          onPaths([p]);
          setTyped("");
        }}
      >
        <label htmlFor={`${id}-path`}>{fieldLabel}</label>
        <input id={`${id}-path`} type="text" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={disabled} />
        <button type="submit" disabled={disabled || !typed.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}
