/**
 * A drop target for documents (protocol approvals, consent forms). The service copies files from
 * their path on disk, so the drop needs paths, not file contents.
 *
 * Paths (Task 37, the Tauri shell): a webview's DOM drop event carries File objects without a path.
 * The shell is expected to handle drops itself (Tauri's drag-drop event, which gives absolute
 * paths) and either set `path` on the dropped File objects before this handler sees them, or call
 * `onPaths` directly. Until it does, a drop without paths shows a message, and for keyboard use the
 * full path can always be typed instead.
 */
import { useId, useState, type DragEvent } from "react";

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

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
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
