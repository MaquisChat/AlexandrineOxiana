/**
 * The project's tags and the workspace tags shared by every project. A tag filters the sources
 * (toggle). Project tags can be renamed and deleted (with a confirmation); the service has no
 * rename or delete for workspace tags yet (R97 deferral), so those are listed only.
 */
import { useId, useState, type FormEvent } from "react";
import type { Tag } from "../api/library";
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
  onCreate: (name: string, scope: "project" | "workspace") => void;
}

function TagRow({ tag, selected, onSelect, readOnly, onRename, onDelete }: { tag: Tag; selected: boolean; onSelect: () => void; readOnly: boolean; onRename?: (name: string) => void; onDelete?: () => void }) {
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
        <UserText>{tag.name}</UserText>
      </button>
      {onRename && (
        <button
          type="button"
          className="ao-small"
          aria-label={`Rename tag ${tag.name}`}
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
        <button type="button" className="ao-small" aria-label={`Delete tag ${tag.name}`} disabled={readOnly} onClick={() => setMode("delete")}>
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
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setMode("view");
            }}
          />
          <button type="submit">Save</button>
          <button type="button" onClick={() => setMode("view")}>
            Cancel
          </button>
        </form>
      )}
      {mode === "delete" && !readOnly && (
        <div role="group" aria-label={`Delete tag ${tag.name}?`} className="ao-inline-form">
          <span>
            Delete the tag <UserText>{tag.name}</UserText>? Sources keep everything else.
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

export function TagList({ tags, workspaceTags, selectedId, onSelect, readOnly = false, onRename, onDelete, onCreate }: TagListProps) {
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
        {tags.map((t) => (
          <TagRow key={t.id} tag={t} selected={selectedId === t.id} onSelect={() => toggle(t.id)} readOnly={readOnly} onRename={(n) => onRename(t.id, n)} onDelete={() => onDelete(t.id)} />
        ))}
      </ul>
      {workspaceTags.length > 0 && (
        <>
          <h3 className="ao-pane-subtitle">Workspace tags</h3>
          <ul className="ao-plain-list">
            {workspaceTags.map((t) => (
              <TagRow key={t.id} tag={t} selected={selectedId === t.id} onSelect={() => toggle(t.id)} readOnly={readOnly} />
            ))}
          </ul>
          <p className="ao-muted ao-small-text">Workspace tags are shared by every project. Renaming or deleting them is not available yet.</p>
        </>
      )}
      <button type="button" disabled={readOnly} aria-expanded={creating} onClick={() => setCreating((c) => !c)}>
        New tag
      </button>
      {creating && !readOnly && (
        <form onSubmit={create} className="ao-inline-form">
          <label htmlFor={fieldId}>Tag name</label>
          <input id={fieldId} dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
          <label htmlFor={scopeId}>For</label>
          <select id={scopeId} value={scope} onChange={(e) => setScope(e.target.value as "project" | "workspace")}>
            <option value="project">This project</option>
            <option value="workspace">Every project (workspace tag)</option>
          </select>
          <button type="submit">Create</button>
        </form>
      )}
    </section>
  );
}
