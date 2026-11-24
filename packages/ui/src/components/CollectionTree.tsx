/**
 * The project's collections as a tree (WAI-ARIA tree pattern, flat markup with aria-level): one tab
 * stop; Up/Down/Home/End move; Right expands a collapsed parent or moves to its first child; Left
 * collapses an expanded parent or moves to the parent; Enter or Space selects. Parents carry
 * aria-expanded and a collapsed parent hides its descendants. "All sources" clears the filter.
 * Collection names are user text (dir=auto). New collections go inside the selected one; the
 * selected collection can be renamed or deleted (off while the library is read-only).
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Collection } from "../api/library";
import { UserText } from "./UserText";
import "./library.css";
import { useReadableNote } from "./ReadableNameNote";

interface Row {
  id: string | undefined;
  name: string;
  level: number;
  parent: string | undefined;
  hasChildren: boolean;
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
      out.push({ id: c.id, name: c.name, level, parent, hasChildren: (byParent.get(c.id) ?? []).some((k) => !seen.has(k.id)) });
      walk(c.id, level + 1);
    }
  };
  walk(undefined, 1);
  // Anything left belongs to a cycle: shown flat rather than hidden.
  for (const c of collections) if (!seen.has(c.id)) out.push({ id: c.id, name: c.name, level: 1, parent: undefined, hasChildren: false });
  return out;
}

export interface CollectionTreeProps {
  collections: Collection[];
  selectedId: string | undefined;
  onSelect: (id: string | undefined) => void;
  readOnly?: boolean;
  onCreate?: (name: string, parentId: string | undefined) => void;
  onRename?: (id: string, name: string) => void;
  onDelete?: (id: string) => void;
  /** R362 h: the project is encrypted: the name field says its names can be read without the passphrase. */
  encrypted?: boolean;
}

export function CollectionTree({ collections, selectedId, onSelect, readOnly = false, onCreate, onRename, onDelete, encrypted }: CollectionTreeProps) {
  const readable = useReadableNote(encrypted);
  const all = useMemo<Row[]>(() => [{ id: undefined, name: "All sources", level: 1, parent: undefined, hasChildren: false }, ...flattenCollections(collections)], [collections]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Visible rows: nothing under a collapsed parent.
  const rows = useMemo(() => {
    const out: Row[] = [];
    let hideBelow: number | undefined;
    for (const r of all) {
      if (hideBelow !== undefined && r.level > hideBelow) continue;
      hideBelow = r.id !== undefined && r.hasChildren && collapsed.has(r.id) ? r.level : undefined;
      out.push(r);
    }
    return out;
  }, [all, collapsed]);
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const refs = useRef(new Map<string, HTMLLIElement | null>());
  const [mode, setMode] = useState<"none" | "create" | "rename" | "delete">("none");
  const [name, setName] = useState("");
  const fieldId = useId();
  const key = (id: string | undefined) => id ?? "*";
  const focusIndex = Math.max(0, rows.findIndex((r) => r.id === focusId));
  const selected = all.find((r) => r.id !== undefined && r.id === selectedId);

  const focusRow = (r: Row | undefined) => {
    if (!r) return;
    setFocusId(r.id);
    refs.current.get(key(r.id))?.focus();
  };
  const setOpen = (id: string, open: boolean) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (open) n.delete(id);
      else n.add(id);
      return n;
    });

  const onKey = (e: KeyboardEvent, i: number) => {
    const r = rows[i]!;
    const expanded = r.id !== undefined && r.hasChildren && !collapsed.has(r.id);
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusRow(rows[Math.min(rows.length - 1, i + 1)]),
      ArrowUp: () => focusRow(rows[Math.max(0, i - 1)]),
      Home: () => focusRow(rows[0]),
      End: () => focusRow(rows[rows.length - 1]),
      ArrowRight: () => {
        if (r.id === undefined || !r.hasChildren) return;
        if (!expanded) setOpen(r.id, true);
        else focusRow(rows[i + 1]);
      },
      ArrowLeft: () => {
        if (expanded) setOpen(r.id!, false);
        else if (r.parent) focusRow(rows.find((x) => x.id === r.parent));
      },
      Enter: () => onSelect(r.id),
      " ": () => onSelect(r.id),
    };
    const f = keys[e.key];
    if (f) {
      e.preventDefault();
      f();
    }
  };

  // Rename and delete belong to the collection they were opened for: another selection closes them (41b1 M2).
  useEffect(() => {
    setMode((m) => (m === "rename" || m === "delete" ? "none" : m));
  }, [selectedId]);

  const start = (m: "create" | "rename" | "delete") => {
    setName(m === "rename" ? (selected?.name ?? "") : "");
    setMode((cur) => (cur === m ? "none" : m));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || readOnly) return;
    if (mode === "create") onCreate?.(n, selectedId);
    if (mode === "rename" && selected?.id && n !== selected.name) onRename?.(selected.id, n);
    setName("");
    setMode("none");
  };

  return (
    <div className="ao-collections">
      <h2 className="ao-pane-title" id={`${fieldId}-h`}>
        Collections
      </h2>
      <ul role="tree" aria-labelledby={`${fieldId}-h`} className="ao-plain-list ao-tree">
        {rows.map((r, i) => (
          <li
            key={key(r.id)}
            ref={(el) => {
              refs.current.set(key(r.id), el);
            }}
            role="treeitem"
            aria-level={r.level}
            aria-selected={r.id === selectedId}
            aria-expanded={r.id !== undefined && r.hasChildren ? !collapsed.has(r.id) : undefined}
            tabIndex={i === focusIndex ? 0 : -1}
            className={`ao-tree__item ao-tree__item--l${Math.min(r.level, 6)}`}
            onClick={() => {
              setFocusId(r.id);
              onSelect(r.id);
            }}
            onKeyDown={(e) => onKey(e, i)}
            onFocus={() => setFocusId(r.id)}
          >
            {r.id !== undefined && r.hasChildren && (
              // A mouse can expand or collapse here (FR-162); the keyboard uses Left and Right on the
              // row, so the twisty stays out of the tab order and out of the accessible name.
              <span
                aria-hidden="true"
                className="ao-tree__twisty"
                onClick={(e) => {
                  e.stopPropagation(); // toggling is not choosing the collection
                  setFocusId(r.id);
                  setOpen(r.id!, collapsed.has(r.id!));
                }}
              >
                {collapsed.has(r.id) ? "▸" : "▾"}
              </span>
            )}
            {r.id === undefined ? r.name : <UserText>{r.name}</UserText>}
          </li>
        ))}
      </ul>
      <div className="ao-row">
        {onCreate && (
          <button type="button" disabled={readOnly} aria-expanded={mode === "create"} onClick={() => start("create")}>
            New collection
          </button>
        )}
        {selected?.id && onRename && (
          <button type="button" disabled={readOnly} aria-label={`Rename collection ${selected.name}`} aria-expanded={mode === "rename"} onClick={() => start("rename")}>
            Rename
          </button>
        )}
        {selected?.id && onDelete && (
          <button type="button" disabled={readOnly} aria-label={`Delete collection ${selected.name}`} onClick={() => start("delete")}>
            Delete
          </button>
        )}
      </div>
      {(mode === "create" || (mode === "rename" && selected)) && !readOnly && (
        <form onSubmit={submit} className="ao-inline-form">
          <label htmlFor={fieldId}>
            {mode === "rename" ? `New name for ${selected!.name}` : selected ? `Collection name (inside ${selected.name})` : "Collection name"}
          </label>
          <input
            id={fieldId}
            dir="auto"
            value={name}
            aria-describedby={readable.describedBy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setMode("none");
            }}
          />
          <button type="submit">{mode === "rename" ? "Save" : "Create"}</button>
          {readable.note}
        </form>
      )}
      {mode === "delete" && selected?.id && !readOnly && (
        <div role="group" aria-label={`Delete collection ${selected.name}?`} className="ao-inline-form">
          <span>
            Delete the collection <UserText>{selected.name}</UserText>? Its sources stay in the project.
          </span>
          <button
            type="button"
            onClick={() => {
              setMode("none");
              onDelete?.(selected.id!);
            }}
          >
            Delete
          </button>
          <button type="button" onClick={() => setMode("none")}>
            Keep
          </button>
        </div>
      )}
    </div>
  );
}
