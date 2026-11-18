/**
 * The project's tags and the workspace tags shared by every project. A tag filters the sources
 * (toggle). Both can be renamed and deleted (with a confirmation); a workspace tag's change reaches
 * every project (R118), and its buttons and confirmation say so.
 */
import { useId, useState, type FormEvent } from "react";
import type { Tag } from "../api/library";
import { CodeSwatch } from "./CodeSwatch";
import { useReadableNote } from "./ReadableNameNote";
import { UserText } from "./UserText";
import "./library.css";

export interface TagListProps {
  tags: Tag[];
  workspaceTags: Tag[];
  selectedId?: string | undefined;
  onSelect: (id: string | undefined) => void;
  readOnly?: boolean;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  /** A workspace tag's new name (every project sees it). */
  onRenameWorkspace: (id: string, name: string) => void;
  /** Deletes a workspace tag from every project. */
  onDeleteWorkspace: (id: string) => void;
  onCreate: (name: string, scope: "project" | "workspace") => void;
  /** R362 h: the project is encrypted: every tag name field says its names can be read without the passphrase. */
  encrypted?: boolean;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

interface TagRowProps {
  tag: Tag;
  position: number;
  selected: boolean;
  onSelect: () => void;
  readOnly: boolean;
  onRename?: (name: string) => void;
  onDelete?: () => void;
  workspace?: boolean;
  encrypted?: boolean;
}

function TagRow({ tag, position, selected, onSelect, readOnly, onRename, onDelete, workspace = false, encrypted }: TagRowProps) {
  const readable = useReadableNote(encrypted);
  const what = workspace ? "workspace tag" : "tag";
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [name, setName] = useState(tag.name);
  const fieldId = useId();
  const save = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n && n !== tag.name) onRename?.(n);
    setMode("view");
  };
  return (
    <li className="ao-tag">
      <button type="button" className="ao-chip" aria-pressed={selected} onClick={onSelect}>
        {/* A tag's own colour only as a validated #rrggbb, through CodeSwatch (shape + name, never colour alone). */}
        {typeof tag.color === "string" && HEX.test(tag.color) ? <CodeSwatch index={position} name={tag.name} color={tag.color} /> : <UserText>{tag.name}</UserText>}
      </button>
      {onRename && (
        <button
          type="button"
          className="ao-small"
          aria-label={`Rename ${what} ${tag.name}`}
          disabled={readOnly}
          onClick={() => {
            setName(tag.name);
            setMode("rename");
          }}
        >
          Rename
        </button>
      )}
      {onDelete && (
        <button type="button" className="ao-small" aria-label={`Delete ${what} ${tag.name}`} disabled={readOnly} onClick={() => setMode("delete")}>
          Delete
        </button>
      )}
      {mode === "rename" && !readOnly && (
        <form onSubmit={save} className="ao-inline-form">
          <label htmlFor={fieldId}>New name for {tag.name}</label>
          <input
            id={fieldId}
            dir="auto"
            value={name}
            autoFocus
            aria-describedby={readable.describedBy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setMode("view");
            }}
          />
          <button type="submit">Save</button>
          <button type="button" onClick={() => setMode("view")}>
            Cancel
          </button>
          {readable.note}
        </form>
      )}
      {mode === "delete" && !readOnly && (
        <div role="group" aria-label={`Delete ${what} ${tag.name}?`} className="ao-inline-form">
          <span>
            {workspace ? (
              <>
                Delete the workspace tag <UserText>{tag.name}</UserText> from every project? Sources keep everything else.
              </>
            ) : (
              <>
                Delete the tag <UserText>{tag.name}</UserText>? Sources keep everything else.
              </>
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              setMode("view");
              onDelete?.();
            }}
          >
            Delete
          </button>
          <button type="button" onClick={() => setMode("view")}>
            Keep
          </button>
        </div>
      )}
    </li>
  );
}

export function TagList({ tags, workspaceTags, selectedId, onSelect, readOnly = false, onRename, onDelete, onRenameWorkspace, onDeleteWorkspace, onCreate, encrypted }: TagListProps) {
  const readable = useReadableNote(encrypted);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"project" | "workspace">("project");
  const fieldId = useId();
  const scopeId = useId();
  const toggle = (id: string) => onSelect(selectedId === id ? undefined : id);
  const create = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || readOnly) return;
    onCreate(n, scope);
    setName("");
    setCreating(false);
  };

  return (
    <section aria-label="Tags" className="ao-tags">
      <h2 className="ao-pane-title">Tags</h2>
      {tags.length === 0 && workspaceTags.length === 0 && <p className="ao-muted">No tags yet.</p>}
      <ul className="ao-plain-list">
        {tags.map((t, i) => (
          <TagRow key={t.id} tag={t} position={i + 1} selected={selectedId === t.id} onSelect={() => toggle(t.id)} readOnly={readOnly} onRename={(n) => onRename(t.id, n)} onDelete={() => onDelete(t.id)} encrypted={encrypted} />
        ))}
      </ul>
      {workspaceTags.length > 0 && (
        <>
          <h3 className="ao-pane-subtitle">Workspace tags</h3>
          <ul className="ao-plain-list">
            {workspaceTags.map((t, i) => (
              <TagRow
                key={t.id}
                tag={t}
                workspace
                position={tags.length + i + 1}
                selected={selectedId === t.id}
                onSelect={() => toggle(t.id)}
                readOnly={readOnly}
                onRename={(n) => onRenameWorkspace(t.id, n)}
                onDelete={() => onDeleteWorkspace(t.id)}
                encrypted={encrypted}
              />
            ))}
          </ul>
          <p className="ao-muted ao-small-text">Workspace tags are shared by every project: renaming or deleting one changes it everywhere.</p>
        </>
      )}
      <button type="button" disabled={readOnly} aria-expanded={creating} onClick={() => setCreating((c) => !c)}>
        New tag
      </button>
      {creating && !readOnly && (
        <form onSubmit={create} className="ao-inline-form">
          <label htmlFor={fieldId}>Tag name</label>
          <input id={fieldId} dir="auto" value={name} aria-describedby={readable.describedBy} onChange={(e) => setName(e.target.value)} />
          <label htmlFor={scopeId}>For</label>
          <select id={scopeId} value={scope} onChange={(e) => setScope(e.target.value as "project" | "workspace")}>
            <option value="project">This project</option>
            <option value="workspace">Every project (workspace tag)</option>
          </select>
          <button type="submit">Create</button>
          {readable.note}
        </form>
      )}
    </section>
  );
}
