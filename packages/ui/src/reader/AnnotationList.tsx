/**
 * The annotation list beside the pages (Task R9): the accessible route to every highlight and note
 * of the file being read (the overlay on the page is hidden from assistive technology, R8).
 *
 *  - A region "Annotations (N)" (N: this file's), its list in the order the service gives it (the
 *    route orders by document, then `sortAnnotations`, R1 and A1: the list never reorders), then
 *    "On another file of this source (N)" and "Not placed on a page (N)". Each entry says its kind,
 *    its colour by name (beside a swatch: never by colour alone), its page (and printed label), the
 *    quote and the note through UserText, "Imported from Zotero", the author of an imported one, and
 *    the sentences that R8's temporary region used to say (A11): the text changed, the page missing,
 *    the place no longer known (A5).
 *  - Buttons "Go to", "Edit note" / "Add note", "Colour", "Delete", each named with the kind, colour
 *    and page ("Go to yellow highlight on page 7, “opening words”") so that entries can be told apart.
 *  - Keyboard: one entry in the tab order (roving); Up and Down move between entries, Home and End to
 *    the ends, Enter on an entry goes to it. The colour menu (eight items, the current one checked)
 *    takes the focus, moves with the arrows, closes on Escape or Tab and gives the focus back. The
 *    delete dialog moves the focus in (on "Keep it"), keeps it there, makes the rest inert and gives
 *    it back (R145); after a delete the focus goes to the next entry, the previous one for the last,
 *    the heading when none is left.
 *  - Nothing is saved by itself (R192): a note by "Save note" or Ctrl/Cmd+Enter, exactly as typed (an
 *    empty one removes the note: `null`); "Cancel" and Escape keep what was there.
 *  - The service decides: each change waits for the screen's answer (which shows the service's
 *    record); a refusal shows the service's sentence in an alert in the entry, and changes nothing.
 *    One request at a time per entry; recolouring to the colour shown sends nothing (A5). An answer
 *    the screen dropped (`AnswerDropped`: the reader ended, the file changed) shows nothing, and any
 *    answer arriving after the list went or its file changed is ignored.
 *  - Every result is said in ONE polite live region: "Highlight recoloured: Green.", "Note saved.",
 *    "Note removed.", "Highlight deleted." ("Note …" for a note).
 *  - Read-only: only "Go to" is enabled; the others stay, disabled, and the panel says why once.
 *  - Past WINDOW_FROM entries a list is windowed: only the entries near the view (and the one with
 *    the focus, the one being edited, any with a menu or an alert) are in the page, each in a slot of
 *    ENTRY_PX; an entry that grows (an editor, an alert) pushes those after it down by what it grew.
 *    `aria-setsize` and `aria-posinset` keep each entry's place in the whole list.
 *
 * `filterWords` is Task R12's (the list filtered to a search's words); it is accepted and not used yet.
 */
import { HIGHLIGHT_COLOUR_NAMES } from "@ao/shared";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import type { AnnotationKind, AnnotationRecord, HighlightColourName } from "../api/reader";
import { DialogShell } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";

/** Said of a highlight whose quote no longer matches the text under its rectangles (R8, A11). */
export const HIGHLIGHT_CHANGED_SENTENCE = "The text here has changed since this highlight was made.";
/** Said of a highlight on a page the open file does not have. */
export const missingPageSentence = (page: number) => `This highlight is on page ${page}, which this file does not have.`;
/** Said of a note on a page the open file does not have. */
export const missingNoteSentence = (page: number) => `This note is on page ${page}, which this file does not have.`;
/** Said of an annotation with no place at all (A5). */
export const PLACE_UNKNOWN = "This highlight's place in the document is no longer known.";
/** Said of a note with no place on a page. */
export const NOTE_NOT_PLACED = "This note is not placed on a page.";
/** Said when the list of annotations could not be had (the service's own sentence follows). */
export const ANNOTATIONS_NOT_SHOWN = "The highlights of this file could not be shown";
/** Said once in the panel of a read-only library. */
export const ANNOTATIONS_READ_ONLY = "This library is read-only, so highlights cannot be changed.";
/** Lists longer than this are windowed. */
export const WINDOW_FROM = 500;
/** The height of an entry's slot in a windowed list, in CSS pixels. */
export const ENTRY_PX = 136;
/** Entries kept in the page either side of the view, in a windowed list. */
const OVERSCAN = 6;
/** The list's view height when the page has no layout to measure (tests). */
const FALLBACK_VIEW_PX = 800;
/** Characters of a quote or note put into a button's name. */
const NAME_WORDS = 40;

/** Thrown (rejected) by the screen for an answer it dropped: the list shows nothing for it. */
export class AnswerDropped extends Error {
  override name = "AnswerDropped";
  constructor() {
    super("The answer came after the reader moved on.");
  }
}

export interface AnnotationListProps {
  /** The source's annotations, in the service's order. */
  annotations: AnnotationRecord[];
  /** The file being read. */
  assetId: string;
  selectedId?: string;
  readOnly: boolean;
  /** Task R12. */
  filterWords?: string;
  onJump(id: string): void;
  onSaveNote(id: string, body: string | null): Promise<void>;
  onRecolour(id: string, colour: HighlightColourName): Promise<void>;
  onDelete(id: string): Promise<void>;
  /** Annotations whose text has changed under them (R8). */
  changed?: ReadonlySet<string>;
  /** The file's page count: a place beyond it cannot be gone to. */
  pageCount?: number;
  /** The service's sentence when the list could not be had (A11); with "Try again". */
  loadError?: string;
  onRetry?(): void;
}

const KIND_LABELS: Record<AnnotationKind, string> = {
  highlight: "Highlight",
  underline: "Underline",
  note: "Note",
  image: "Area",
  ink: "Drawing",
  "coded-segment": "Coded segment",
  clip: "Clip",
  screenshot: "Screenshot",
};
export const kindLabel = (k: AnnotationKind): string => KIND_LABELS[k] ?? "Annotation";
export const colourLabel = (c: HighlightColourName): string => c.charAt(0).toUpperCase() + c.slice(1);
/** "Highlight" or "Note", as the live region and the dialog say it. */
const noun = (k: AnnotationKind) => (k === "note" ? "Note" : "Highlight");

type Group = "here" | "elsewhere" | "unplaced";

interface Entry {
  a: AnnotationRecord;
  group: Group;
  /** The page shown (here: the first on this file; elsewhere: the first of all). */
  page?: number;
  /** The page "Go to" goes to (none: it cannot). */
  goPage?: number;
  /** Pages on this file the file does not have. */
  missing: number[];
  pos: number;
  size: number;
  flat: number;
  /** What the buttons' names say of it. */
  desc: string;
}

/** Cut by characters (code points), never inside one. */
function opening(s: string, n: number): string {
  const chars = [...s.replace(/\s+/g, " ").trim()];
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : chars.join("");
}

function describe(a: AnnotationRecord, group: Group, page: number | undefined): string {
  const where = group === "unplaced" ? "not placed on a page" : group === "elsewhere" ? `on page ${page} of another file` : `on page ${page}`;
  const words = a.quote || a.body;
  return `${a.colorName} ${kindLabel(a.kind).toLowerCase()} ${where}${words ? `, “${opening(words, NAME_WORDS)}”` : ""}`;
}

function entriesOf(list: AnnotationRecord[], assetId: string, pageCount: number | undefined): { groups: Record<Group, Entry[]>; flat: Entry[] } {
  const groups: Record<Group, Entry[]> = { here: [], elsewhere: [], unplaced: [] };
  for (const a of list) {
    const pages = a.pdfAnchors.filter((x) => x.assetId === assetId).map((x) => x.page);
    const base = { a, missing: [] as number[], pos: 0, size: 0, flat: 0, desc: "" };
    if (pages.length > 0) {
      const page = Math.min(...pages);
      const present = pages.filter((p) => pageCount === undefined || p <= pageCount);
      const missing = pageCount === undefined ? [] : [...new Set(pages.filter((p) => p > pageCount))].sort((x, y) => x - y);
      groups.here.push({ ...base, group: "here", page, ...(present.length > 0 ? { goPage: Math.min(...present) } : {}), missing });
    } else if (a.pdfAnchors.length > 0) groups.elsewhere.push({ ...base, group: "elsewhere", page: Math.min(...a.pdfAnchors.map((x) => x.page)) });
    else groups.unplaced.push({ ...base, group: "unplaced" });
  }
  const flat: Entry[] = [];
  for (const g of ["here", "elsewhere", "unplaced"] as const) {
    const size = groups[g].length;
    groups[g].forEach((e, i) => {
      e.pos = i + 1;
      e.size = size;
      e.flat = flat.length;
      e.desc = describe(e.a, e.group, e.page);
      flat.push(e);
    });
  }
  return { groups, flat };
}

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "The library service did not answer.");

type FocusWant = { id: string; what: "entry" | "note" | "colour" | "delete" } | "heading";

/** What an entry's buttons do: one stable object, so that entries are drawn again only when their own inputs change. */
interface Actions {
  jump(id: string): void;
  edit(id: string): void;
  menu(id: string): void;
  confirm(id: string): void;
  saveNote(id: string, text: string): void;
  cancelNote(id: string): void;
  choose(id: string, c: HighlightColourName): void;
  closeMenu(id: string, restore: boolean): void;
}

interface EntryViewProps {
  e: Entry;
  active: boolean;
  selected: boolean;
  editing: boolean;
  menuOpen: boolean;
  error?: string;
  readOnly: boolean;
  changed: boolean;
  /** Absolutely placed in a windowed list: its top, and whether it may grow beyond its slot. */
  slot?: { top: number; grow: boolean };
  act: Actions;
}

const EntryView = memo(function EntryView({ e, active, selected, editing, menuOpen, error, readOnly, changed, slot, act }: EntryViewProps) {
  const { a } = e;
  const id = a.id;
  const tab = active ? 0 : -1;
  const sentences: string[] = [];
  for (const p of e.missing) sentences.push(a.kind === "note" ? missingNoteSentence(p) : missingPageSentence(p));
  if (changed) sentences.push(HIGHLIGHT_CHANGED_SENTENCE);
  if (e.group === "unplaced") sentences.push(a.kind === "note" ? NOTE_NOT_PLACED : PLACE_UNKNOWN);
  const fixedOnly = e.group === "unplaced";
  const label = a.pageLabel !== undefined && a.pageLabel !== "" && a.pageLabel !== String(e.page) ? a.pageLabel : undefined;
  const classes = ["ao-ann-entry"];
  if (selected) classes.push("ao-ann-entry--selected");
  if (slot) classes.push(slot.grow ? "ao-ann-entry--slot ao-ann-entry--grown" : "ao-ann-entry--slot");
  // Its colour menu is not cut off by a windowed slot.
  if (menuOpen) classes.push("ao-ann-entry--open");
  return (
    <li
      data-entry={id}
      tabIndex={tab}
      aria-setsize={e.size}
      aria-posinset={e.pos}
      aria-current={selected || undefined}
      className={classes.join(" ")}
      style={{ top: slot ? `${slot.top}px` : undefined, height: slot && !slot.grow ? `${ENTRY_PX}px` : undefined }}
    >
      <p className="ao-ann-head">
        <span className={`ao-ann-swatch ao-ann-swatch--${a.colorName}`} aria-hidden="true" />
        <span>{kindLabel(a.kind)}</span>
        {", "}
        <span>{colourLabel(a.colorName)}</span>
        {e.page !== undefined && (
          <>
            {", "}
            <span>
              Page {e.page}
              {label !== undefined && (
                <>
                  {" ("}
                  <UserText>{label}</UserText>)
                </>
              )}
            </span>
          </>
        )}
      </p>
      {a.quote && (
        <UserText as="blockquote" className="ao-ann-quote">
          {a.quote}
        </UserText>
      )}
      {a.body && !editing && (
        <UserText as="p" className="ao-ann-note">
          {a.body}
        </UserText>
      )}
      {a.imported && (
        <p className="ao-ann-meta">
          Imported from Zotero
          {a.author.trim() !== "" && (
            <>
              {", by "}
              <UserText>{a.author}</UserText>
            </>
          )}
        </p>
      )}
      {sentences.map((s) => (
        <p key={s} className="ao-ann-sentence">
          {s}
        </p>
      ))}
      {error !== undefined && (
        <p role="alert" className="ao-ann-error">
          {error}
        </p>
      )}
      {editing && <NoteEditor initial={a.body ?? ""} onSave={(t) => act.saveNote(id, t)} onCancel={() => act.cancelNote(id)} />}
      <div className="ao-ann-actions">
        <button type="button" tabIndex={tab} data-act="go" disabled={e.goPage === undefined} aria-label={`Go to ${e.desc}`} onClick={() => act.jump(id)}>
          Go to
        </button>
        <button type="button" tabIndex={tab} data-act="note" disabled={readOnly || fixedOnly || editing} aria-label={a.body ? `Edit note of ${e.desc}` : `Add note to ${e.desc}`} onClick={() => act.edit(id)}>
          {a.body ? "Edit note" : "Add note"}
        </button>
        <span className="ao-ann-menu-anchor">
          <button
            type="button"
            tabIndex={tab}
            data-act="colour"
            disabled={readOnly || fixedOnly}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Colour of ${e.desc}`}
            onClick={() => (menuOpen ? act.closeMenu(id, true) : act.menu(id))}
          >
            Colour
          </button>
          {menuOpen && <ColourMenu label={`Colour of ${e.desc}`} current={a.colorName} onChoose={(c) => act.choose(id, c)} onClose={(restore) => act.closeMenu(id, restore)} />}
        </span>
        <button type="button" tabIndex={tab} data-act="delete" disabled={readOnly} aria-label={`Delete ${e.desc}`} onClick={() => act.confirm(id)}>
          Delete
        </button>
      </div>
    </li>
  );
});

/** The note's text area: "Save note" or Ctrl/Cmd+Enter save it as typed; "Cancel" or Escape keep what was there. */
function NoteEditor({ initial, onSave, onCancel }: { initial: string; onSave(text: string): void; onCancel(): void }) {
  const id = useId();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const onKey = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      onSave(text);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      onCancel();
    }
  };
  return (
    <div className="ao-ann-editor">
      <label htmlFor={`${id}-note`}>Note</label>
      <textarea id={`${id}-note`} ref={ref} dir="auto" rows={4} value={text} onChange={(ev) => setText(ev.target.value)} onKeyDown={onKey} />
      <div className="ao-ann-actions">
        <button type="button" onClick={() => onSave(text)}>
          Save note
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The eight colours, the current one checked; arrows, Home and End move; Escape and Tab close and give the focus back. */
function ColourMenu({ label, current, onChoose, onClose }: { label: string; current: HighlightColourName; onChoose(c: HighlightColourName): void; onClose(restore: boolean): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
  useEffect(() => {
    items()[HIGHLIGHT_COLOUR_NAMES.indexOf(current)]?.focus();
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A press outside closes it, leaving the focus where the press put it.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (ev: MouseEvent) => {
      const anchor = ref.current?.parentElement;
      if (anchor && ev.target instanceof Node && !anchor.contains(ev.target)) close.current(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  const onKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let to: number | undefined;
    if (ev.key === "ArrowDown") to = (i + 1) % list.length;
    else if (ev.key === "ArrowUp") to = (i - 1 + list.length) % list.length;
    else if (ev.key === "Home") to = 0;
    else if (ev.key === "End") to = list.length - 1;
    else if (ev.key === "Escape" || ev.key === "Tab") {
      ev.preventDefault();
      ev.stopPropagation();
      onClose(true);
      return;
    } else {
      if (ev.key === "Enter" || ev.key === " ") ev.stopPropagation();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    list[to]?.focus();
  };
  return (
    <div ref={ref} role="menu" aria-label={label} className="ao-ann-menu" onKeyDown={onKey}>
      {HIGHLIGHT_COLOUR_NAMES.map((c) => (
        <button key={c} type="button" role="menuitemradio" aria-checked={c === current} tabIndex={-1} onClick={() => onChoose(c)}>
          <span className={`ao-ann-swatch ao-ann-swatch--${c}`} aria-hidden="true" />
          {colourLabel(c)}
        </button>
      ))}
    </div>
  );
}

/** "Delete this highlight?" with "Delete" and "Keep it"; the focus starts on "Keep it". */
function DeleteDialog({ kind, onConfirm, onCancel }: { kind: AnnotationKind; onConfirm(): void; onCancel(): void }) {
  const id = useId();
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    keep.current?.focus();
  }, []);
  return (
    <DialogShell labelledBy={`${id}-t`} onCancel={onCancel} className="ao-ann-dialog">
      <h2 id={`${id}-t`}>{kind === "note" ? "Delete this note?" : "Delete this highlight?"}</h2>
      <div className="ao-ann-actions">
        <button type="button" className="ao-danger" onClick={onConfirm}>
          Delete
        </button>
        <button type="button" ref={keep} onClick={onCancel}>
          Keep it
        </button>
      </div>
    </DialogShell>
  );
}

const GROUP_TITLES: Record<Exclude<Group, "here">, string> = { elsewhere: "On another file of this source", unplaced: "Not placed on a page" };
const count = (n: number) => n.toLocaleString("en-GB");

export function AnnotationList({ annotations, assetId, selectedId, readOnly, onJump, onSaveNote, onRecolour, onDelete, changed, pageCount, loadError, onRetry }: AnnotationListProps) {
  const hid = useId();
  const { groups, flat } = useMemo(() => entriesOf(annotations, assetId, pageCount), [annotations, assetId, pageCount]);
  const byId = useMemo(() => new Map(flat.map((e) => [e.a.id, e])), [flat]);
  const [activeChoice, setActiveId] = useState<string | undefined>(undefined);
  const activeId = activeChoice !== undefined && byId.has(activeChoice) ? activeChoice : flat[0]?.a.id;
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [confirmFor, setConfirmFor] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [said, setSaid] = useState<{ text: string; n: number } | undefined>(undefined);
  const [scroll, setScroll] = useState({ top: 0, view: FALLBACK_VIEW_PX });
  const [grows, setGrows] = useState<Record<string, number>>({});
  const [, setTick] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const lists = useRef<Partial<Record<Group, HTMLUListElement | null>>>({});
  const busy = useRef(new Set<string>());
  const mounted = useRef(true);
  /** Moves on when the file changes: answers to changes asked before are ignored. */
  const epoch = useRef(0);
  const want = useRef<FocusWant | undefined>(undefined);
  const windowed = (g: Group) => groups[g].length > WINDOW_FROM;
  const anyWindowed = windowed("here") || windowed("elsewhere") || windowed("unplaced");

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A new file: nothing of the last one's editing, menus, alerts or answers.
  const lastAsset = useRef(assetId);
  if (lastAsset.current !== assetId) {
    lastAsset.current = assetId;
    epoch.current++;
    busy.current.clear();
    want.current = undefined;
  }
  useEffect(() => {
    setEditing(undefined);
    setMenuFor(undefined);
    setConfirmFor(undefined);
    setErrors({});
    setSaid(undefined);
    setGrows({});
  }, [assetId]);

  const view = () => scroller.current?.clientHeight || FALLBACK_VIEW_PX;

  /** The top of entry `i` of a windowed group, within its list. */
  const topIn = useCallback(
    (g: Group, i: number) => {
      let top = i * ENTRY_PX;
      for (const [id, px] of Object.entries(grows)) {
        const e = byId.get(id);
        if (e && e.group === g && e.pos - 1 < i) top += px;
      }
      return top;
    },
    [grows, byId],
  );

  /** Scrolls the list so that entry `id` is in view (in a windowed list, so that it is in the page at all). */
  const reveal = useCallback(
    (id: string) => {
      const el = scroller.current;
      const e = byId.get(id);
      if (!el || !e) return;
      let top: number;
      let height = ENTRY_PX;
      if (windowed(e.group)) top = (lists.current[e.group]?.offsetTop ?? 0) + topIn(e.group, e.pos - 1);
      else {
        const li = [...el.querySelectorAll<HTMLElement>("[data-entry]")].find((x) => x.dataset.entry === id);
        if (!li) return;
        const at = li.getBoundingClientRect();
        top = at.top - el.getBoundingClientRect().top + el.scrollTop;
        height = at.height;
      }
      const v = view();
      const now = el.scrollTop;
      const next = top < now ? top : top + height > now + v ? top + height - v : now;
      if (next !== now) el.scrollTop = next;
      if (anyWindowed) setScroll({ top: next, view: v });
    },
    // `windowed` reads `groups`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byId, topIn, groups, anyWindowed],
  );

  const focusLater = (w: FocusWant) => {
    want.current = w;
    setTick((n) => n + 1);
  };

  // Focus placed where it was asked for, once the entry is in the page (revealing it first in a windowed list).
  useLayoutEffect(() => {
    const w = want.current;
    if (!w) return;
    if (w === "heading") {
      want.current = undefined;
      heading.current?.focus();
      return;
    }
    if (!byId.has(w.id)) {
      want.current = undefined;
      return;
    }
    const li = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-entry]") ?? [])].find((x) => x.dataset.entry === w.id);
    if (!li) {
      reveal(w.id);
      return;
    }
    const target = w.what === "entry" ? li : li.querySelector<HTMLElement>(`[data-act="${w.what}"]`);
    want.current = undefined;
    target?.focus();
  });

  // In a windowed list, an entry that grew beyond its slot (an editor, an alert) pushes the next ones down.
  useLayoutEffect(() => {
    if (!anyWindowed) return;
    const next: Record<string, number> = {};
    for (const li of scroller.current?.querySelectorAll<HTMLElement>(".ao-ann-entry--grown") ?? []) {
      const px = Math.max(0, li.offsetHeight - ENTRY_PX);
      if (px > 0 && li.dataset.entry) next[li.dataset.entry] = px;
    }
    const same = Object.keys(next).length === Object.keys(grows).length && Object.entries(next).every(([k, v]) => grows[k] === v);
    if (!same) setGrows(next);
  });

  // A highlight chosen on the page: its entry is marked and the list scrolls to it, the focus left where it is.
  useEffect(() => {
    if (selectedId === undefined || !byId.has(selectedId)) return;
    setActiveId(selectedId);
    reveal(selectedId);
    // Only when the choice changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const say = (text: string) => setSaid((s) => ({ text, n: (s?.n ?? 0) + 1 }));
  const clearError = (id: string) =>
    setErrors((m) => {
      if (!(id in m)) return m;
      const { [id]: _gone, ...rest } = m;
      return rest;
    });

  /** One change of entry `id`: one at a time; its answer ignored once the list went or its file changed. */
  const run = async (id: string, call: () => Promise<void>, ok: () => void) => {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    const at = epoch.current;
    clearError(id);
    try {
      await call();
    } catch (err) {
      if (!mounted.current || epoch.current !== at || err instanceof AnswerDropped) return;
      setErrors((m) => ({ ...m, [id]: messageOf(err) }));
      return;
    } finally {
      if (epoch.current === at) busy.current.delete(id);
    }
    if (!mounted.current || epoch.current !== at) return;
    ok();
  };

  const latest = useRef({ byId, flat, readOnly, onJump, onSaveNote, onRecolour, onDelete });
  latest.current = { byId, flat, readOnly, onJump, onSaveNote, onRecolour, onDelete };

  const act = useMemo<Actions>(
    () => ({
      jump: (id) => {
        const e = latest.current.byId.get(id);
        if (e?.goPage !== undefined) latest.current.onJump(id);
      },
      edit: (id) => {
        if (latest.current.readOnly) return;
        clearError(id);
        setEditing(id);
      },
      cancelNote: (id) => {
        setEditing((x) => (x === id ? undefined : x));
        focusLater({ id, what: "note" });
      },
      saveNote: (id, text) => {
        const e = latest.current.byId.get(id);
        if (!e || latest.current.readOnly) return;
        // Exactly as typed: nothing trimmed; an empty note removes it.
        const body = text === "" ? null : text;
        if (body === (e.a.body ?? null)) {
          setEditing((x) => (x === id ? undefined : x));
          focusLater({ id, what: "note" });
          return;
        }
        void run(
          id,
          () => latest.current.onSaveNote(id, body),
          () => {
            setEditing((x) => (x === id ? undefined : x));
            focusLater({ id, what: "note" });
            say(body === null ? "Note removed." : "Note saved.");
          },
        );
      },
      menu: (id) => {
        if (latest.current.readOnly) return;
        setMenuFor(id);
      },
      closeMenu: (id, restore) => {
        setMenuFor((x) => (x === id ? undefined : x));
        if (restore) focusLater({ id, what: "colour" });
      },
      choose: (id, c) => {
        const e = latest.current.byId.get(id);
        setMenuFor(undefined);
        focusLater({ id, what: "colour" });
        // The colour it shows already: no change, nothing sent (A5).
        if (!e || latest.current.readOnly || e.a.colorName === c) return;
        const kind = e.a.kind;
        void run(
          id,
          () => latest.current.onRecolour(id, c),
          () => say(`${noun(kind)} recoloured: ${colourLabel(c)}.`),
        );
      },
      confirm: (id) => {
        if (latest.current.readOnly || busy.current.has(id)) return;
        clearError(id);
        setConfirmFor(id);
      },
    }),
    // The dispatcher reads the latest props through `latest`; it never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const doDelete = (id: string) => {
    const e = byId.get(id);
    setConfirmFor(undefined);
    if (!e || readOnly) return;
    const kind = e.a.kind;
    // The next entry, else the previous one, else the heading: taken from the list as it is when the
    // delete is asked (the screen may have drawn the list without it before its answer is read here).
    const i = flat.findIndex((x) => x.a.id === id);
    const after = (flat[i + 1] ?? flat[i - 1])?.a.id;
    void run(
      id,
      () => onDelete(id),
      () => {
        const next = after !== undefined && latest.current.byId.has(after) ? after : undefined;
        if (next !== undefined) {
          setActiveId(next);
          focusLater({ id: next, what: "entry" });
        } else focusLater("heading");
        say(`${noun(kind)} deleted.`);
      },
    );
  };

  const move = (to: number) => {
    const e = flat[Math.max(0, Math.min(flat.length - 1, to))];
    if (!e) return;
    setActiveId(e.a.id);
    focusLater({ id: e.a.id, what: "entry" });
  };

  const onKey = (ev: KeyboardEvent<HTMLDivElement>) => {
    const t = ev.target as HTMLElement;
    if (t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || t.closest('[role="menu"]')) return;
    const li = t.closest<HTMLElement>("[data-entry]");
    const e = li?.dataset.entry !== undefined ? byId.get(li.dataset.entry) : undefined;
    if (!e) return;
    if (ev.key === "ArrowDown") move(e.flat + 1);
    else if (ev.key === "ArrowUp") move(e.flat - 1);
    else if (ev.key === "Home") move(0);
    else if (ev.key === "End") move(flat.length - 1);
    else if (ev.key === "Enter" && t === li) act.jump(e.a.id);
    else return;
    ev.preventDefault();
  };

  const onFocusIn = (ev: { target: EventTarget }) => {
    const li = (ev.target as HTMLElement).closest?.<HTMLElement>("[data-entry]");
    const id = li?.dataset.entry;
    if (id !== undefined && id !== activeId && byId.has(id)) setActiveId(id);
  };

  const onScroll = (ev: UIEvent<HTMLDivElement>) => {
    if (!anyWindowed) return;
    const el = ev.currentTarget;
    setScroll({ top: el.scrollTop, view: el.clientHeight || FALLBACK_VIEW_PX });
  };

  const view_ = (e: Entry, slot?: EntryViewProps["slot"]) => (
    <EntryView
      key={e.a.id}
      e={e}
      active={e.a.id === activeId}
      selected={e.a.id === selectedId}
      editing={editing === e.a.id}
      menuOpen={menuFor === e.a.id}
      {...(errors[e.a.id] !== undefined ? { error: errors[e.a.id] } : {})}
      readOnly={readOnly}
      changed={changed?.has(e.a.id) ?? false}
      {...(slot ? { slot } : {})}
      act={act}
    />
  );

  const renderGroup = (g: Group, labelId: string) => {
    const items = groups[g];
    const ref = (el: HTMLUListElement | null) => {
      lists.current[g] = el;
    };
    if (!windowed(g)) {
      return (
        <ul ref={ref} aria-labelledby={labelId} className="ao-ann-list">
          {items.map((e) => view_(e))}
        </ul>
      );
    }
    // Windowed: the entries near the view, and those that must stay (focus, editor, menu, dialog, alert).
    const listTop = lists.current[g]?.offsetTop ?? 0;
    const from = Math.max(0, Math.floor((scroll.top - listTop) / ENTRY_PX) - OVERSCAN);
    const to = Math.min(items.length, Math.ceil((scroll.top - listTop + scroll.view) / ENTRY_PX) + OVERSCAN);
    const keep = new Set<number>();
    for (let i = from; i < to; i++) keep.add(i);
    for (const id of [activeId, editing, menuFor, confirmFor, want.current !== undefined && want.current !== "heading" ? want.current.id : undefined, ...Object.keys(errors)]) {
      const e = id !== undefined ? byId.get(id) : undefined;
      if (e && e.group === g) keep.add(e.pos - 1);
    }
    const total = topIn(g, items.length);
    return (
      <ul ref={ref} aria-labelledby={labelId} className="ao-ann-list ao-ann-list--windowed" style={{ height: `${total}px` }}>
        {[...keep]
          .sort((x, y) => x - y)
          .map((i) => {
            const e = items[i]!;
            return view_(e, { top: topIn(g, i), grow: editing === e.a.id || errors[e.a.id] !== undefined });
          })}
      </ul>
    );
  };

  const n = groups.here.length;
  const deleting = confirmFor !== undefined ? byId.get(confirmFor) : undefined;
  return (
    <section className="ao-ann" aria-labelledby={hid}>
      <h2 id={hid} ref={heading} tabIndex={-1}>
        Annotations ({count(n)})
      </h2>
      {readOnly && <p className="ao-ann-readonly">{ANNOTATIONS_READ_ONLY}</p>}
      {loadError !== undefined && (
        <div className="ao-ann-load-error">
          <p role="alert">
            {ANNOTATIONS_NOT_SHOWN}: <UserText>{loadError}</UserText>
          </p>
          <button type="button" onClick={() => onRetry?.()}>
            Try again
          </button>
        </div>
      )}
      <p role="status" className="ao-ann-live">
        {said && <span key={said.n}>{said.text}</span>}
      </p>
      <div className="ao-ann-scroll" ref={scroller} onScroll={onScroll} onKeyDown={onKey} onFocus={onFocusIn}>
        {n === 0 && loadError === undefined && <p className="ao-ann-empty">This file has no highlights or notes yet.</p>}
        {renderGroup("here", hid)}
        {(["elsewhere", "unplaced"] as const).map((g) =>
          groups[g].length === 0 ? null : (
            <div key={g} className="ao-ann-group">
              <h3 id={`${hid}-${g}`}>
                {GROUP_TITLES[g]} ({count(groups[g].length)})
              </h3>
              {renderGroup(g, `${hid}-${g}`)}
            </div>
          ),
        )}
      </div>
      {deleting && <DeleteDialog kind={deleting.a.kind} onConfirm={() => doDelete(deleting.a.id)} onCancel={() => setConfirmFor(undefined)} />}
    </section>
  );
}
