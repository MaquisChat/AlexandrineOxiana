/**
 * The project's collections as a tree (WAI-ARIA tree pattern, flat markup with aria-level): one tab
 * stop, arrow keys / Home / End move, Enter or Space selects. "All sources" clears the filter.
 * Collection names are user text (dir=auto). New collections go inside the selected one.
 */
import { useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Collection } from "../api/library";
import { UserText } from "./UserText";
import "./library.css";

interface Row {
  id: string | undefined;
  name: string;
  level: number;
}

/** Depth-first order; collections whose parent is missing (or in a cycle) are shown at the top level. */
export function flattenCollections(collections: Collection[]): Row[] {
  const byParent = new Map<string | undefined, Collection[]>();
  const ids = new Set(collections.map((c) => c.id));
  for (const c of collections) {
    const parent = c.parentId && ids.has(c.parentId) && c.parentId !== c.id ? c.parentId : undefined;
    byParent.set(parent, [...(byParent.get(parent) ?? []), c]);
  }
  const out: Row[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | undefined, level: number) => {
    for (const c of byParent.get(parent) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ id: c.id, name: c.name, level });
      walk(c.id, level + 1);
    }
  };
  walk(undefined, 1);
  // Anything left belongs to a cycle: shown flat rather than hidden.
  for (const c of collections) if (!seen.has(c.id)) out.push({ id: c.id, name: c.name, level: 1 });
  return out;
}

export interface CollectionTreeProps {
  collections: Collection[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  readOnly?: boolean;
  onCreate?: (name: string, parentId: string | undefined) => void;
}

export function CollectionTree({ collections, selectedId, onSelect, readOnly = false, onCreate }: CollectionTreeProps) {
  // "All sources" sits beside the top-level collections (level 1).
  const rows = useMemo<Row[]>(() => [{ id: undefined, name: "All sources", level: 1 }, ...flattenCollections(collections)], [collections]);
  const [focus, setFocus] = useState(0);
  const refs = useRef<Array<HTMLLIElement | null>>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const fieldId = useId();
  const tabStop = Math.min(focus, rows.length - 1);

  const move = (i: number) => {
    const n = Math.max(0, Math.min(rows.length - 1, i));
    setFocus(n);
    refs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent, i: number) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(i + 1),
      ArrowUp: () => move(i - 1),
      Home: () => move(0),
      End: () => move(rows.length - 1),
      Enter: () => onSelect(rows[i]!.id),
      " ": () => onSelect(rows[i]!.id),
    };
    const f = keys[e.key];
    if (f) {
      e.preventDefault();
      f();
    }
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || readOnly) return;
    onCreate?.(n, selectedId);
    setName("");
    setCreating(false);
  };
  const parentName = rows.find((r) => r.id === selectedId && r.id !== undefined)?.name;

  return (
    <div className="ao-collections">
      <h2 className="ao-pane-title" id={`${fieldId}-h`}>
        Collections
      </h2>
      <ul role="tree" aria-labelledby={`${fieldId}-h`} className="ao-plain-list ao-tree">
        {rows.map((r, i) => (
          <li
            key={r.id ?? "*"}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="treeitem"
            aria-level={r.level}
            aria-selected={r.id === selectedId}
            tabIndex={i === tabStop ? 0 : -1}
            className={`ao-tree__item ao-tree__item--l${Math.min(r.level, 6)}`}
            onClick={() => {
              setFocus(i);
              onSelect(r.id);
            }}
            onKeyDown={(e) => onKey(e, i)}
            onFocus={() => setFocus(i)}
          >
            {r.id === undefined ? r.name : <UserText>{r.name}</UserText>}
          </li>
        ))}
      </ul>
      {onCreate && (
        <>
          <button type="button" disabled={readOnly} aria-expanded={creating} onClick={() => setCreating((c) => !c)}>
            New collection
          </button>
          {creating && !readOnly && (
            <form onSubmit={create} className="ao-inline-form">
              <label htmlFor={fieldId}>{parentName ? `Collection name (inside ${parentName})` : "Collection name"}</label>
              <input id={fieldId} dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
              <button type="submit">Create</button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
