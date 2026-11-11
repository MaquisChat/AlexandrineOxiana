/**
 * A drop target for documents (protocol approvals, consent forms). The desktop shell gives dropped
 * files their path on disk; the service copies them from there. For keyboard use (and when a path
 * is not available) the full path can be typed instead.
 */
import { useId, useState, type DragEvent } from "react";

type WithPath = File & { path?: string };

export function FileDrop({ prompt, fieldLabel, onPaths, disabled }: { prompt: string; fieldLabel: string; onPaths: (paths: string[]) => void; disabled?: boolean }) {
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
