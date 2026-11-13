/**
 * The annotation list beside the pages (Task R9, with Amendment A13): the accessible route to every
 * highlight and note of the file being read (the overlay on the page is hidden from assistive
 * technology, R8).
 *
 *  - A region "Annotations (N)" (N: this file's). Its list is sorted here with R1's
 *    `sortAnnotations` over each annotation's anchors on this file (A13: the service's order is not
 *    relied on; it is wrong for an annotation on two files). Then "On another file of this source
 *    (N)" (anchors only on another file, a PDF or an EPUB: read only, no "Delete" here) and "Not
 *    placed on a page (N)" (no anchor at all: A5's sentence, can be deleted). Each entry says its
 *    kind, its colour by name (beside a swatch: never by colour alone), its page (and printed label),
 *    the quote and the note through UserText, "Imported from Zotero" (no author for now, A13), and
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
 *    empty one removes the note: `null`). A CHANGED note is not abandoned without the question
 *    "Discard this note?" ("Discard", "Keep editing"; R192 e, A13): on Escape, on "Cancel", and on
 *    leaving through the app's own navigation (`blockNavigation`, the mechanism the recovery code
 *    uses, R134) or reloading. An unchanged note closes without a question; a list that goes (the
 *    reader ended) asks nothing and holds nothing.
 *  - The service decides: each change waits for the screen's answer (which shows the service's
 *    record); a refusal shows the service's sentence in an alert in the entry, and changes nothing.
 *    While a change of an entry is on its way, that entry says "Saving…" (said once in the live
 *    region) and its other change controls are disabled (`aria-disabled`, so the focus is kept); a
 *    late answer never closes or replaces a draft typed meanwhile (A13). Recolouring to the colour
 *    shown sends nothing (A5). An answer the screen dropped (`AnswerDropped`) shows nothing; an
 *    answer arriving after the list went or its file changed is ignored. `ListBroughtUpToDate` (the
 *    annotation was no longer there; the screen asks for the list again) is said for the list.
 *  - Every result is said in ONE polite live region: "Saving…", "Highlight recoloured: Green.",
 *    "Note saved.", "Note removed.", "Highlight deleted." ("Note …" for a note).
 *  - Read-only: only "Go to" is enabled; the others stay, disabled, and the panel says why once.
 *  - Past WINDOW_FROM entries a list is windowed: only the entries near the view (and those with the
 *    focus, an editor, a menu, a dialog or an alert) are in the page. Every entry has its own real,
 *    measured height (A13: nothing is ever cut off; a long note, an editor, larger text); entries not
 *    measured yet count ENTRY_ESTIMATE_PX. `offsetsOf` and `windowOf` are the arithmetic.
 *    `aria-setsize` and `aria-posinset` keep each entry's place in the whole list.
 *
 * A library search's words (Task R12): the list never holds them to match; the reader matches them with
 * R1's `matchAnnotations` and hands the list the ids (`filterIds`). Filtered, the heading reads
 * "Annotations matching your search (N)" with "Show all", the list keeps its groups (another file's and
 * unplaced annotations are not matches), its own sort, windowing and roving focus, and every count
 * (`aria-setsize` is the filtered count); "Show all" gives the full list back with the focus kept on the
 * same entry; a change made while filtered behaves as unfiltered. While the reader is still looking
 * (`filterWords` is set, no ids yet) the list says "Looking for the words…" (the words are not shown) and
 * lists everything; `searchNote` is a sentence from the reader (nothing matched exactly; the highlight
 * asked for is gone) shown above the full list; `focusRequest` puts the focus on an entry, once.
 */
import { sortAnnotations } from "@ao/core/annotations/sortIndex";
import { HIGHLIGHT_COLOUR_NAMES } from "@ao/shared";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import type { AnnotationKind, AnnotationRecord, HighlightColourName } from "../api/reader";
import { DialogShell } from "../components/ReasonDialog";
import { UserText } from "../components/UserText";
import { blockNavigation, navigate } from "../navigation";

/** R1's annotation shape, as `sortAnnotations` takes it (the root of @ao/core stays out of the interface). */
type Annotation = Parameters<typeof sortAnnotations>[0][number];

/** Said while the reader looks for a search's words among the annotations (A4). */
export const SEARCH_LOOKING = "Looking for the words…";
/** Said when every annotation matching a search has been deleted. */
export const SEARCH_NONE_LEFT = "No annotation matching your search is left.";

/** Said of a highlight whose quote no longer matches the text under its rectangles (R8, A11). */
export const HIGHLIGHT_CHANGED_SENTENCE = "The text here has changed since this highlight was made.";
/** Said of a highlight on a page the open file does not have. */
export const missingPageSentence = (page: number) => `This highlight is on page ${page}, which this file does not have.`;
/** Said of a note on a page the open file does not have. */
export const missingNoteSentence = (page: number) => `This note is on page ${page}, which this file does not have.`;
/** Said of an annotation with no anchor at all (A5). */
export const PLACE_UNKNOWN = "This highlight's place in the document is no longer known.";
/** Said of a note with no anchor at all. */
export const NOTE_NOT_PLACED = "This note is not placed on a page.";
/** Said when the list of annotations could not be had (the service's own sentence follows). */
export const ANNOTATIONS_NOT_SHOWN = "The highlights of this file could not be shown";
/** Said once in the panel of a read-only library. */
export const ANNOTATIONS_READ_ONLY = "This library is read-only, so highlights cannot be changed.";
/** Said when a change found its annotation gone and the list was asked for again (A13). */
export const LIST_BROUGHT_UP_TO_DATE = "That highlight or note was no longer there. The list has been brought up to date.";
/** Said while a change is on its way. */
export const SAVING = "Saving…";
/** Said when a note is left (Escape, "Cancel") while its save is on its way. */
export const NOTE_BUSY = "The note is being saved. It can be closed once it is saved.";
/** Lists longer than this are windowed. */
export const WINDOW_FROM = 500;
/** The height counted for an entry of a windowed list not measured yet, in CSS pixels. */
export const ENTRY_ESTIMATE_PX = 136;
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

/** Thrown (rejected) by the screen when the annotation was no longer there and the list is being asked for again. */
export class ListBroughtUpToDate extends Error {
  override name = "ListBroughtUpToDate";
  constructor() {
    super(LIST_BROUGHT_UP_TO_DATE);
  }
}

/** The top of each entry and, last, the whole height: offsets[i] is where entry i starts. */
export function offsetsOf(heights: readonly number[]): number[] {
  const out = new Array<number>(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i++) out[i + 1] = out[i]! + heights[i]!;
  return out;
}

/** The first entry whose offset is above or at `y` (binary search; `offsets.length - 1` if none). */
function firstAt(offsets: readonly number[], y: number, from: number): number {
  let lo = from;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid]! >= y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The entries [from, to) that touch the view from `top` for `view` pixels, with `overscan` either side. */
export function windowOf(offsets: readonly number[], top: number, view: number, overscan: number): [number, number] {
  const n = offsets.length - 1;
  // The first entry whose bottom is below the view's top.
  let from = Math.max(0, firstAt(offsets, top, 0) - 1);
  while (from < n && offsets[from + 1]! <= top) from++;
  const to = Math.max(from, firstAt(offsets, top + view, from));
  return [Math.max(0, Math.min(from, to) - overscan), Math.min(n, to + overscan)];
}

export interface AnnotationListProps {
  /** The source's annotations (the list groups and sorts them itself). */
  annotations: AnnotationRecord[];
  /** The file being read. */
  assetId: string;
  selectedId?: string;
  readOnly: boolean;
  /** Task R12: the words of a search that the reader is still looking for among the annotations (set until it has the ids). */
  filterWords?: string;
  /** Task R12: the ids the reader matched; the list shows only these, under "Annotations matching your search (N)". */
  filterIds?: ReadonlySet<string>;
  /** Task R12: a sentence from the reader, said above the list. */
  searchNote?: string;
  /** Task R12: put the focus on this entry; a new `seq` asks again. */
  focusRequest?: { id: string; seq: number };
  /** Task R12: "Show all" was pressed. */
  onShowAll?(): void;
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
  /** The page shown (here: the first on this file; elsewhere: the first PDF page, if any). */
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
  const where = group === "unplaced" ? "not placed on a page" : group === "elsewhere" ? (page !== undefined ? `on page ${page} of another file` : "on another file") : `on page ${page}`;
  const words = a.quote || a.body;
  return `${a.colorName} ${kindLabel(a.kind).toLowerCase()} ${where}${words ? `, “${opening(words, NAME_WORDS)}”` : ""}`;
}

/** This file's entries in R1's reading order, over each annotation's anchors on this file (A4, A13). */
function sortedHere(entries: Entry[], assetId: string): Entry[] {
  const proxies = entries.map((e) => ({
    id: e.a.id,
    createdAt: e.a.createdAt,
    anchors: e.a.pdfAnchors
      .filter((x) => x.assetId === assetId)
      .map((x) => ({ kind: "pdf" as const, id: x.id, assetId: x.assetId, page: x.page, rects: x.rects, ...(x.sortIndexDerived ? {} : { sortIndex: x.sortIndex }) })),
    entry: e,
  }));
  return sortAnnotations(proxies as unknown as Array<Annotation & { entry: Entry }>).map((p) => p.entry);
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
    } else if (a.pdfAnchors.length > 0 || a.otherAnchorKinds.length > 0) {
      // On another file of the source: a PDF, or another kind of anchor (an EPUB passage, …).
      groups.elsewhere.push({ ...base, group: "elsewhere", ...(a.pdfAnchors.length > 0 ? { page: Math.min(...a.pdfAnchors.map((x) => x.page)) } : {}) });
    } else groups.unplaced.push({ ...base, group: "unplaced" });
  }
  groups.here = sortedHere(groups.here, assetId);
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

/** The annotations lying on `assetId`, in the order the list shows them (R1's reading order): what a search's first match is taken from (Task R12). */
export const annotationsInReadingOrder = (list: AnnotationRecord[], assetId: string): AnnotationRecord[] => entriesOf(list, assetId, undefined).groups.here.map((e) => e.a);

const messageOf = (e: unknown) => (e instanceof Error && e.message ? e.message : "The library service did not answer.");

type FocusWant = { id: string; what: "entry" | "note" | "note-area" | "colour" | "delete" } | "heading";

/** What an entry's buttons do: one stable object, so that entries are drawn again only when their own inputs change. */
interface Actions {
  jump(id: string): void;
  edit(id: string): void;
  menu(id: string): void;
  confirm(id: string): void;
  saveNote(id: string, text: string): void;
  abandonNote(id: string, text: string): void;
  busy(): void;
  draft(id: string, text: string, dirty: boolean): void;
  choose(id: string, c: HighlightColourName): void;
  closeMenu(id: string, restore: boolean): void;
}

interface EntryViewProps {
  e: Entry;
  active: boolean;
  selected: boolean;
  editing: boolean;
  menuOpen: boolean;
  pending: boolean;
  error?: string;
  readOnly: boolean;
  changed: boolean;
  /** Absolutely placed in a windowed list, at its measured offset. */
  top?: number;
  act: Actions;
}

const EntryView = memo(function EntryView({ e, active, selected, editing, menuOpen, pending, error, readOnly, changed, top, act }: EntryViewProps) {
  const { a } = e;
  const id = a.id;
  const tab = active ? 0 : -1;
  const sentences: string[] = [];
  for (const p of e.missing) sentences.push(a.kind === "note" ? missingNoteSentence(p) : missingPageSentence(p));
  if (changed) sentences.push(HIGHLIGHT_CHANGED_SENTENCE);
  if (e.group === "unplaced") sentences.push(a.kind === "note" ? NOTE_NOT_PLACED : PLACE_UNKNOWN);
  // Another file's annotation is read only here; one with no anchor can only be deleted (A5, A13).
  const noChange = readOnly || e.group !== "here";
  const label = a.pageLabel !== undefined && a.pageLabel !== "" && a.pageLabel !== String(e.page) ? a.pageLabel : undefined;
  const classes = ["ao-ann-entry"];
  if (selected) classes.push("ao-ann-entry--selected");
  if (top !== undefined) classes.push("ao-ann-entry--slot");
  // Its colour menu lies over the entries after it.
  if (menuOpen) classes.push("ao-ann-entry--open");
  const held = pending || undefined;
  return (
    <li
      data-entry={id}
      tabIndex={tab}
      aria-setsize={e.size}
      aria-posinset={e.pos}
      aria-current={selected || undefined}
      aria-busy={held}
      className={classes.join(" ")}
      style={{ top: top !== undefined ? `${top}px` : undefined }}
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
      {a.imported && <p className="ao-ann-meta">Imported from Zotero</p>}
      {sentences.map((s) => (
        <p key={s} className="ao-ann-sentence">
          {s}
        </p>
      ))}
      {pending && <p className="ao-ann-saving">{SAVING}</p>}
      {error !== undefined && (
        <p role="alert" className="ao-ann-error">
          {error}
        </p>
      )}
      {editing && (
        <NoteEditor
          saved={a.body ?? ""}
          pending={pending}
          onSave={(t) => act.saveNote(id, t)}
          onAbandon={(t) => act.abandonNote(id, t)}
          onBusy={() => act.busy()}
          onDraft={(t, dirty) => act.draft(id, t, dirty)}
        />
      )}
      <div className="ao-ann-actions">
        <button type="button" tabIndex={tab} data-act="go" disabled={e.goPage === undefined} aria-label={`Go to ${e.desc}`} onClick={() => act.jump(id)}>
          Go to
        </button>
        <button
          type="button"
          tabIndex={tab}
          data-act="note"
          disabled={noChange || editing}
          aria-disabled={held}
          aria-label={a.body ? `Edit note of ${e.desc}` : `Add note to ${e.desc}`}
          onClick={() => !pending && act.edit(id)}
        >
          {a.body ? "Edit note" : "Add note"}
        </button>
        <span className="ao-ann-menu-anchor">
          <button
            type="button"
            tabIndex={tab}
            data-act="colour"
            disabled={noChange}
            aria-disabled={held}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Colour of ${e.desc}`}
            onClick={() => (pending ? undefined : menuOpen ? act.closeMenu(id, true) : act.menu(id))}
          >
            Colour
          </button>
          {menuOpen && <ColourMenu label={`Colour of ${e.desc}`} current={a.colorName} onChoose={(c) => act.choose(id, c)} onClose={(restore) => act.closeMenu(id, restore)} />}
        </span>
        {e.group !== "elsewhere" && (
          <button type="button" tabIndex={tab} data-act="delete" disabled={readOnly} aria-disabled={held} aria-label={`Delete ${e.desc}`} onClick={() => !pending && act.confirm(id)}>
            Delete
          </button>
        )}
      </div>
    </li>
  );
});

/**
 * The note's text area: "Save note" or Ctrl/Cmd+Enter save it as typed; "Cancel" or Escape abandon
 * it (the list asks first when it was changed). While a save is on its way the text can still be
 * typed in; "Save note" and "Cancel" wait for the answer.
 */
function NoteEditor({ saved, pending, onSave, onAbandon, onBusy, onDraft }: { saved: string; pending: boolean; onSave(text: string): void; onAbandon(text: string): void; onBusy(): void; onDraft(text: string, dirty: boolean): void }) {
  const id = useId();
  const [text, setText] = useState(saved);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const draft = useRef(onDraft);
  draft.current = onDraft;
  useEffect(() => {
    draft.current(text, text !== saved);
  }, [text, saved]);
  const onKey = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      if (!pending) onSave(text);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      if (pending) onBusy();
      else onAbandon(text);
    }
  };
  return (
    <div className="ao-ann-editor">
      <label htmlFor={`${id}-note`}>Note</label>
      <textarea id={`${id}-note`} ref={ref} data-act="note-area" dir="auto" rows={4} value={text} onChange={(ev) => setText(ev.target.value)} onKeyDown={onKey} />
      <div className="ao-ann-actions">
        <button type="button" aria-disabled={pending || undefined} onClick={() => !pending && onSave(text)}>
          Save note
        </button>
        <button type="button" aria-disabled={pending || undefined} onClick={() => (pending ? onBusy() : onAbandon(text))}>
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

/** A question with a dangerous answer and a safe one; the focus starts on the safe one (R145). */
function Question({ title, yes, no, onYes, onNo }: { title: string; yes: string; no: string; onYes(): void; onNo(): void }) {
  const id = useId();
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    safe.current?.focus();
  }, []);
  return (
    <DialogShell labelledBy={`${id}-t`} onCancel={onNo} className="ao-ann-dialog">
      <h2 id={`${id}-t`}>{title}</h2>
      <div className="ao-ann-actions">
        <button type="button" className="ao-danger" onClick={onYes}>
          {yes}
        </button>
        <button type="button" ref={safe} onClick={onNo}>
          {no}
        </button>
      </div>
    </DialogShell>
  );
}

const GROUP_TITLES: Record<Exclude<Group, "here">, string> = { elsewhere: "On another file of this source", unplaced: "Not placed on a page" };
const count = (n: number) => n.toLocaleString("en-GB");

export function AnnotationList({ annotations, assetId, selectedId, readOnly, onJump, onSaveNote, onRecolour, onDelete, changed, pageCount, loadError, onRetry, filterWords, filterIds, searchNote, focusRequest, onShowAll }: AnnotationListProps) {
  const hid = useId();
  // Filtered: only the matched annotations are entries at all, so groups, positions and set sizes are the filtered list's own.
  const shown = useMemo(() => (filterIds ? annotations.filter((a) => filterIds.has(a.id)) : annotations), [annotations, filterIds]);
  const { groups, flat } = useMemo(() => entriesOf(shown, assetId, pageCount), [shown, assetId, pageCount]);
  const byId = useMemo(() => new Map(flat.map((e) => [e.a.id, e])), [flat]);
  const [activeChoice, setActiveId] = useState<string | undefined>(undefined);
  const activeId = activeChoice !== undefined && byId.has(activeChoice) ? activeChoice : flat[0]?.a.id;
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [confirmFor, setConfirmFor] = useState<string | undefined>(undefined);
  /** The question "Discard this note?", with what a Discard does. */
  const [discardAsk, setDiscardAsk] = useState<{ id: string; then: () => void } | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, true>>({});
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [said, setSaid] = useState<{ text: string; n: number } | undefined>(undefined);
  const [scroll, setScroll] = useState({ top: 0, view: FALLBACK_VIEW_PX });
  /** Measured heights of windowed entries, by id; `heightsSeen` moves on when one changes. */
  const heights = useRef(new Map<string, number>());
  const [heightsSeen, setHeightsSeen] = useState(0);
  const [, setTick] = useState(0);
  /** Whether the note being edited differs from what is saved (the way out is then held, R192 e). */
  const [dirty, setDirty] = useState(false);
  const draftNow = useRef<{ id: string; text: string } | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const lists = useRef<Partial<Record<Group, HTMLUListElement | null>>>({});
  const busy = useRef(new Set<string>());
  const mounted = useRef(true);
  /** Moves on when the file changes: answers to changes asked before are ignored. */
  const epoch = useRef(0);
  const want = useRef<FocusWant | undefined>(undefined);
  /** An entry whose change found it gone: where the focus goes if it leaves the list. */
  const goneFocus = useRef<{ id: string; after?: string } | undefined>(undefined);
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
    draftNow.current = undefined;
  }
  useEffect(() => {
    setEditing(undefined);
    setMenuFor(undefined);
    setConfirmFor(undefined);
    setDiscardAsk(undefined);
    setErrors({});
    setPending({});
    setNotice(undefined);
    setSaid(undefined);
    setDirty(false);
  }, [assetId]);

  const view = () => scroller.current?.clientHeight || FALLBACK_VIEW_PX;

  /** The measured offsets of each windowed group's entries. */
  const offsets = useMemo(() => {
    const out: Partial<Record<Group, number[]>> = {};
    for (const g of ["here", "elsewhere", "unplaced"] as const) if (groups[g].length > WINDOW_FROM) out[g] = offsetsOf(groups[g].map((e) => heights.current.get(e.a.id) ?? ENTRY_ESTIMATE_PX));
    return out;
    // `heightsSeen` stands for the measured heights.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, heightsSeen]);

  /** Scrolls the list so that entry `id` is in view (in a windowed list, so that it is in the page at all). */
  const reveal = (id: string) => {
    const el = scroller.current;
    const e = byId.get(id);
    if (!el || !e) return;
    let top: number;
    let height: number;
    const o = offsets[e.group];
    if (o) {
      top = (lists.current[e.group]?.offsetTop ?? 0) + o[e.pos - 1]!;
      height = o[e.pos]! - o[e.pos - 1]!;
    } else {
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
  };

  const focusLater = (w: FocusWant) => {
    want.current = w;
    setTick((n) => n + 1);
  };

  // The reader asks for an entry to take the focus (a search's first match): once per request.
  const lastFocusSeq = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!focusRequest || lastFocusSeq.current === focusRequest.seq || !byId.has(focusRequest.id)) return;
    lastFocusSeq.current = focusRequest.seq;
    setActiveId(focusRequest.id);
    focusLater({ id: focusRequest.id, what: "entry" });
    // `focusLater` only sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest, byId]);

  // Focus placed where it was asked for, once the entry is in the page (revealing it first in a
  // windowed list). A passive effect: it runs after a closing dialog has given the focus back.
  useEffect(() => {
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

  // An entry whose change found it gone, and now gone from the list: the focus to the next one.
  useEffect(() => {
    const g = goneFocus.current;
    if (!g || byId.has(g.id)) return;
    goneFocus.current = undefined;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    if (g.after !== undefined && byId.has(g.after)) {
      setActiveId(g.after);
      focusLater({ id: g.after, what: "entry" });
    } else focusLater("heading");
  }, [byId]);

  // In a windowed list every entry in the page is measured, and measured again when its size changes
  // (an editor, an alert, larger text): its real height places the ones after it (A13).
  const resized = useRef<ResizeObserver | undefined>(undefined);
  useEffect(() => {
    if (!anyWindowed || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setTick((n) => n + 1));
    resized.current = ro;
    return () => {
      ro.disconnect();
      resized.current = undefined;
    };
  }, [anyWindowed]);
  useLayoutEffect(() => {
    if (!anyWindowed) return;
    let moved = false;
    /** What entries above the view grew (or shrank) by: the view moves with them, so nothing in it jumps. */
    let above = 0;
    const el = scroller.current;
    const ro = resized.current;
    ro?.disconnect();
    for (const li of el?.querySelectorAll<HTMLElement>(".ao-ann-entry--slot") ?? []) {
      ro?.observe(li);
      const id = li.dataset.entry;
      const h = li.offsetHeight;
      // No layout (0: not measurable here) keeps the estimate.
      if (id !== undefined && h > 0 && heights.current.get(id) !== h) {
        const e = byId.get(id);
        const o = e ? offsets[e.group] : undefined;
        if (el && e && o && (lists.current[e.group]?.offsetTop ?? 0) + o[e.pos]! <= el.scrollTop) above += h - (heights.current.get(id) ?? ENTRY_ESTIMATE_PX);
        heights.current.set(id, h);
        moved = true;
      }
    }
    if (el && above !== 0) {
      el.scrollTop += above;
      setScroll({ top: el.scrollTop, view: el.clientHeight || FALLBACK_VIEW_PX });
    }
    if (moved) setHeightsSeen((n) => n + 1);
  });

  // A highlight chosen on the page: its entry is marked and the list scrolls to it, the focus left where it is.
  useEffect(() => {
    if (selectedId === undefined || !byId.has(selectedId)) return;
    setActiveId(selectedId);
    reveal(selectedId);
    // Only when the choice changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // An entry being edited that is no longer in the list (deleted here or elsewhere, a list fetched
  // again without it): its editor, its draft and any question about it go (I5).
  useEffect(() => {
    if (editing !== undefined && !byId.has(editing)) closeEditor(editing);
    if (discardAsk !== undefined && !byId.has(discardAsk.id)) setDiscardAsk(undefined);
    // `closeEditor` only sets state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [byId, editing, discardAsk]);

  /**
   * The one place the hold is decided (I5): held while, and only while, a CHANGED, unsaved note is on
   * screen: the entry being edited is in this file's list and its text differs from what is saved.
   * The entry leaving the list, the file changing, the list going (the reader ended): no hold, nothing asked.
   */
  const holding = dirty && editing !== undefined && byId.get(editing)?.group === "here" && draftNow.current?.id === editing;

  // A changed note holds the app's own way out until it is saved or discarded (R192 e): in-app links
  // and navigate() are refused and ask "Discard this note?"; a reload asks the browser's question; Back
  // and Forward land on a copy of this address and ask too: the way TranscriptViewer holds unsaved edits.
  const askDiscard = useRef<(then: () => void) => void>(() => {});
  askDiscard.current = (then) => {
    const id = draftNow.current?.id ?? editing;
    if (id === undefined) return;
    setDiscardAsk({
      id,
      then: () => {
        closeEditor(id);
        then();
      },
    });
  };
  useEffect(() => {
    if (!holding) return;
    let released = false;
    let release = () => {};
    const go = (href: string) => () => {
      release();
      navigate(href);
    };
    const unblock = blockNavigation((href: string) => askDiscard.current(go(href)));
    const onUnload = (ev: BeforeUnloadEvent) => {
      ev.preventDefault();
      ev.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.history.pushState(null, "", here);
    let restoring = false;
    const onPop = () => {
      if (restoring) return;
      // Where Back (or Forward) went: gone to after a Discard.
      const went = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      restoring = true;
      window.history.pushState(null, "", here);
      // Screens that already followed the address follow it back (in the same task, before React renders).
      window.dispatchEvent(new PopStateEvent("popstate"));
      restoring = false;
      askDiscard.current(go(went));
    };
    window.addEventListener("popstate", onPop);
    release = () => {
      if (released) return;
      released = true;
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("popstate", onPop);
      unblock();
    };
    return release;
  }, [holding]);

  const say = (text: string) => setSaid((s) => ({ text, n: (s?.n ?? 0) + 1 }));
  const clearError = (id: string) =>
    setErrors((m) => {
      if (!(id in m)) return m;
      const { [id]: _gone, ...rest } = m;
      return rest;
    });
  const setPendingOf = (id: string, on: boolean) =>
    setPending((m) => {
      if (on === !!m[id]) return m;
      if (on) return { ...m, [id]: true };
      const { [id]: _done, ...rest } = m;
      return rest;
    });
  const closeEditor = (id: string) => {
    setEditing((x) => (x === id ? undefined : x));
    if (draftNow.current?.id === id) draftNow.current = undefined;
    setDirty(false);
  };

  /**
   * One change of entry `id`: one at a time, the entry saying "Saving…" meanwhile; its answer ignored
   * once the list went or its file changed.
   */
  const run = async (id: string, call: () => Promise<void>, ok: () => void) => {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    const at = epoch.current;
    const i = latest.current.flat.findIndex((x) => x.a.id === id);
    const after = (latest.current.flat[i + 1] ?? latest.current.flat[i - 1])?.a.id;
    clearError(id);
    setNotice(undefined);
    setPendingOf(id, true);
    say(SAVING);
    const current = () => mounted.current && epoch.current === at;
    try {
      await call();
    } catch (err) {
      if (!current()) return;
      setSaid(undefined);
      if (err instanceof AnswerDropped) return;
      if (err instanceof ListBroughtUpToDate) {
        setNotice(err.message);
        goneFocus.current = { id, ...(after !== undefined ? { after } : {}) };
      } else setErrors((m) => ({ ...m, [id]: messageOf(err) }));
      return;
    } finally {
      if (epoch.current === at) {
        busy.current.delete(id);
        if (mounted.current) setPendingOf(id, false);
      }
    }
    if (!current()) return;
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
        if (latest.current.readOnly || busy.current.has(id)) return;
        clearError(id);
        setEditing(id);
      },
      draft: (id, text, isDirty) => {
        draftNow.current = { id, text };
        setDirty(isDirty);
      },
      busy: () => say(NOTE_BUSY),
      abandonNote: (id, text) => {
        const e = latest.current.byId.get(id);
        const close = () => {
          closeEditor(id);
          focusLater({ id, what: "note" });
        };
        // Unchanged: closes at once. Changed: asked first (R192 e).
        if (!e || text === (e.a.body ?? "")) close();
        else setDiscardAsk({ id, then: close });
      },
      saveNote: (id, text) => {
        const e = latest.current.byId.get(id);
        if (!e || latest.current.readOnly || busy.current.has(id)) return;
        // Exactly as typed: nothing trimmed; an empty note removes it.
        const body = text === "" ? null : text;
        if (body === (e.a.body ?? null)) {
          closeEditor(id);
          focusLater({ id, what: "note" });
          return;
        }
        void run(
          id,
          () => latest.current.onSaveNote(id, body),
          () => {
            // A draft typed on meanwhile is kept, open, to be saved or discarded (A13).
            if (draftNow.current?.id !== id || draftNow.current.text === text) {
              closeEditor(id);
              focusLater({ id, what: "note" });
            }
            say(body === null ? "Note removed." : "Note saved.");
          },
        );
      },
      menu: (id) => {
        if (latest.current.readOnly || busy.current.has(id)) return;
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

  const view_ = (e: Entry, top?: number) => (
    <EntryView
      key={e.a.id}
      e={e}
      active={e.a.id === activeId}
      selected={e.a.id === selectedId}
      editing={editing === e.a.id}
      menuOpen={menuFor === e.a.id}
      pending={pending[e.a.id] === true}
      {...(errors[e.a.id] !== undefined ? { error: errors[e.a.id] } : {})}
      readOnly={readOnly}
      changed={changed?.has(e.a.id) ?? false}
      {...(top !== undefined ? { top } : {})}
      act={act}
    />
  );

  const renderGroup = (g: Group, labelId: string) => {
    const items = groups[g];
    const ref = (el: HTMLUListElement | null) => {
      lists.current[g] = el;
    };
    const o = offsets[g];
    if (!o) {
      return (
        <ul ref={ref} aria-labelledby={labelId} className="ao-ann-list">
          {items.map((e) => view_(e))}
        </ul>
      );
    }
    // Windowed: the entries near the view, and those that must stay (focus, editor, menu, dialog, alert).
    const listTop = lists.current[g]?.offsetTop ?? 0;
    const [from, to] = windowOf(o, scroll.top - listTop, scroll.view, OVERSCAN);
    const keep = new Set<number>();
    for (let i = from; i < to; i++) keep.add(i);
    const stay = [activeId, editing, menuFor, confirmFor, discardAsk?.id, want.current !== undefined && want.current !== "heading" ? want.current.id : undefined, ...Object.keys(errors), ...Object.keys(pending)];
    for (const id of stay) {
      const e = id !== undefined ? byId.get(id) : undefined;
      if (e && e.group === g) keep.add(e.pos - 1);
    }
    return (
      <ul ref={ref} aria-labelledby={labelId} className="ao-ann-list ao-ann-list--windowed" style={{ height: `${o[items.length]}px` }}>
        {[...keep].sort((x, y) => x - y).map((i) => view_(items[i]!, o[i]))}
      </ul>
    );
  };

  const n = groups.here.length;
  const filtered = filterIds !== undefined;
  /** "Show all": the focus goes to the entry that is current, which the full list still holds. */
  const showAll = () => {
    if (activeId !== undefined) focusLater({ id: activeId, what: "entry" });
    onShowAll?.();
  };
  const deleting = confirmFor !== undefined ? byId.get(confirmFor) : undefined;
  return (
    <section className="ao-ann" aria-labelledby={hid}>
      <h2 id={hid} ref={heading} tabIndex={-1}>
        {filtered ? "Annotations matching your search" : "Annotations"} ({count(n)})
      </h2>
      {filtered && (
        <p>
          <button type="button" onClick={showAll}>
            Show all
          </button>
        </p>
      )}
      {!filtered && filterWords !== undefined && <p role="status" className="ao-ann-find">{SEARCH_LOOKING}</p>}
      {searchNote !== undefined && <p role="status" className="ao-ann-find">{searchNote}</p>}
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
      {notice !== undefined && (
        <p role="alert" className="ao-ann-load-error">
          {notice}
        </p>
      )}
      <p role="status" className="ao-ann-live">
        {said && <span key={said.n}>{said.text}</span>}
      </p>
      <div className="ao-ann-scroll" ref={scroller} onScroll={onScroll} onKeyDown={onKey} onFocus={onFocusIn}>
        {n === 0 && loadError === undefined && <p className="ao-ann-empty">{filtered ? SEARCH_NONE_LEFT : "This file has no highlights or notes yet."}</p>}
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
      {deleting && <Question title={deleting.a.kind === "note" ? "Delete this note?" : "Delete this highlight?"} yes="Delete" no="Keep it" onYes={() => doDelete(deleting.a.id)} onNo={() => setConfirmFor(undefined)} />}
      {discardAsk && (
        <Question
          title="Discard this note?"
          yes="Discard"
          no="Keep editing"
          onYes={() => {
            const then = discardAsk.then;
            setDiscardAsk(undefined);
            then();
          }}
          onNo={() => {
            const id = discardAsk.id;
            setDiscardAsk(undefined);
            focusLater({ id, what: "note-area" });
          }}
        />
      )}
    </section>
  );
}
