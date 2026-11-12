/**
 * A field where a folder or file path is typed, with "Choose folder…" or "Choose file…" beside it
 * (D12). Inside the desktop shell the button opens the native picker through the one bridge
 * (desktopShell.ts) and puts the chosen path in the field; outside the shell (tests, the end-to-end
 * harness, a plain browser) there is no button and the field is typed as before.
 *
 * A chosen path is only put in the field. It reaches the service when the screen sends the field
 * (Scan, Open, Check destination, …), and the service decides what may be read. The page asks the
 * shell for nothing but the open dialog.
 */
import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from "react";
import { desktopShell } from "../desktopShell";
import "./PathField.css";

export interface PathFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** What the picker chooses: a folder, or one file. */
  pick: "folder" | "file";
  /** The native picker's title, e.g. "Choose the Zotero data folder". */
  pickerTitle: string;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  /** The wrapper's class (the screen's own field layout); the label and the row inside are this component's. */
  className?: string | undefined;
  /** More ids that describe the field (a hint of the screen's). */
  describedBy?: string | undefined;
  /** The input's id, when the screen needs to refer to it. */
  id?: string | undefined;
  /** Other attributes for the input (dir, spellCheck, …). */
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "value" | "onChange" | "disabled" | "placeholder" | "aria-describedby">;
}

export function PathField({ label, value, onChange, pick, pickerTitle, disabled, placeholder, className, describedBy, id: givenId, inputProps }: PathFieldProps) {
  const ownId = useId();
  const id = givenId ?? `${ownId}-path`;
  const problemId = `${ownId}-problem`;
  const shell = desktopShell();
  const [picking, setPicking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  /** One picker at a time, however fast the clicks (state updates come a render later). */
  const open = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const latest = useRef(onChange);
  latest.current = onChange;

  const choose = async () => {
    if (!shell || open.current || disabled) return;
    open.current = true;
    setPicking(true);
    setProblem(null);
    try {
      const chosen = pick === "folder" ? await shell.pickFolder(pickerTitle) : ((await shell.pickFiles(pickerTitle, false))[0] ?? null);
      if (!mounted.current || !chosen) return;
      latest.current(chosen);
      input.current?.focus();
    } catch {
      if (mounted.current) setProblem(pick === "folder" ? "The folder picker could not be opened. Type the folder's full path instead." : "The file picker could not be opened. Type the file's full path instead.");
    } finally {
      open.current = false;
      if (mounted.current) setPicking(false);
    }
  };

  const described = [describedBy, problem ? problemId : undefined].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className ? `ao-pathfield ${className}` : "ao-pathfield"}>
      <label htmlFor={id}>{label}</label>
      <span className="ao-pathfield__row">
        <input
          type="text"
          spellCheck={false}
          autoComplete="off"
          {...inputProps}
          ref={input}
          id={id}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-describedby={described}
          onChange={(e) => {
            setProblem(null);
            onChange(e.target.value);
          }}
        />
        {shell && (
          <button type="button" disabled={disabled || picking} onClick={() => void choose()}>
            {pick === "folder" ? "Choose folder…" : "Choose file…"}
          </button>
        )}
      </span>
      {problem && (
        <span id={problemId} role="alert" className="ao-pathfield__problem">
          {problem}
        </span>
      )}
    </div>
  );
}
