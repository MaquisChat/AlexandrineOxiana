/**
 * "Choose works" (Task F9; R145, R267, R271): one person's works, newest first, as checkboxes — each with its title,
 * year, kind and where it was published, all outside text through UserText (dir="auto"). The heading names the person
 * (`options.person`: name, and where they work or what they work on). A work already added from this entry (an entry
 * made from it is in the queue, R271 M5) is "Added" and cannot be ticked.
 *
 * Filters — "From year", "To year", "Kind" (Any, Article, Book, Chapter, Other) and "Filter by words" — narrow the
 * list on the screen only (no request); a `role="status"` line says how many works are shown ("12 of 200 works
 * shown"). Ticks survive a change of filter: a ticked work hidden by a filter stays ticked, is counted in the button
 * ("Add the chosen works (3)", disabled at 0) and is said under the list. At most FIND_CHOOSE_WORKS_MAX (50) at a
 * time: the 51st tick is refused with "Choose at most 50 at a time." and does not stay.
 *
 * Keyboard (a list of 200 works stays usable): the list is ONE tab stop — a roving tab stop over native checkboxes.
 * Only one checkbox has tabIndex 0 (the work last moved to, else the first shown); ArrowDown/ArrowRight and
 * ArrowUp/ArrowLeft move to the next and previous work, Home and End to the ends, PageDown and PageUp by ten; Space
 * ticks (the checkbox's own key). Native checkboxes keep each work's name, state and "Added" for a screen reader
 * without an `aria-activedescendant` pattern that VoiceOver in WebKit reads unevenly. Tab goes from the filters to
 * the list, then to the buttons; DialogShell keeps Tab and Shift+Tab inside, wrapping at the ends.
 *
 * The lists are the parent's: read from the entry's `options` when the dialog opens and never kept after it closes;
 * while they are read the dialog says so; a read that failed is the service's sentence (`loadError`). The parent sends
 * the request and owns `busy` and `error` (the service's sentence for a refusal; the ticks stay, nothing else changes).
 */
import { FIND_CHOOSE_WORKS_MAX, type FindChosenPerson, type FindEntryView, type FindPersonWork } from "@ao/shared";
import { memo, useCallback, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { kindWords, wellFormedCandidate, wherePublished, yearOf } from "../api/find";
import { DialogShell } from "./ReasonDialog";
import { UserText } from "./UserText";

export const CHOOSE_WORKS_TEXT = {
  loading: "Reading this person's works…",
  describe: "Tick the works to add. Each becomes an entry of its own in the queue, and its record is made for you.",
  more: "More works exist than are listed here.",
  limit: `Choose at most ${FIND_CHOOSE_WORKS_MAX} at a time.`,
  none: "No works are listed for this person.",
  added: "Added",
} as const;

export const KIND_FILTERS = ["Any", "Article", "Book", "Chapter", "Other"] as const;
type KindFilter = (typeof KIND_FILTERS)[number];

/** Which filter a work's kind falls under: a journal article is "Article", a book "Book", a chapter "Chapter"; anything else "Other". */
const kindFilterOf = (type: string): Exclude<KindFilter, "Any"> => (type === "article-journal" ? "Article" : type === "book" ? "Book" : type === "chapter" ? "Chapter" : "Other");

/** Lower case, without accents: "Économie" and "economie" are the same words to the filter. */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();

const yearNumber = (s: string): number | undefined => (/^\s*\d{1,4}\s*$/.test(s) ? Number(s) : undefined);

export const shownText = (shown: number, total: number) => `${shown} of ${total} ${total === 1 ? "work" : "works"} shown`;
const hiddenText = (k: number) => (k === 1 ? "1 chosen work is not shown by these filters." : `${k} chosen works are not shown by these filters.`);

export interface ChooseWorksDialogProps {
  entry: FindEntryView;
  /** The person's works, newest first, from `options`; absent while they are read. */
  works?: FindPersonWork[];
  /** Whose works they are (`options.person`). */
  person?: FindChosenPerson;
  /** The list could not be read: the service's sentence. */
  loadError?: string;
  /** The ticked works' ids, in the list's order. */
  onAdd(workIds: string[]): void;
  onClose(): void;
  busy?: boolean;
  error?: string;
}

interface Item {
  w: FindPersonWork;
  year: number | undefined;
  kind: Exclude<KindFilter, "Any">;
  /** Folded text the words filter looks in: title, where published, year. */
  hay: string;
}

/** One work of the list. Memoised: a tick re-renders only the work ticked and the one that loses the tab stop. */
const WorkItem = memo(function WorkItem(props: { item: Item; ticked: boolean; stop: boolean; detailsId: string; onTick: (id: string, on: boolean) => void; onFocus: (id: string) => void }) {
  const { item, ticked, stop, detailsId, onTick, onFocus } = props;
  const w = item.w;
  const added = w.added === true;
  const year = yearOf(w.issued);
  const kind = kindWords(w.type);
  const where = wherePublished(w);
  const parts: Array<{ key: string; node: ReactNode }> = [];
  if (year) parts.push({ key: "y", node: <UserText>{year}</UserText> });
  if (kind) parts.push({ key: "k", node: kind });
  if (where) parts.push({ key: "w", node: <UserText>{where}</UserText> });
  return (
    <li className="ao-find__candidate" data-work-id={w.id}>
      <label className="ao-find__option">
        <input
          type="checkbox"
          data-work={w.id}
          checked={!added && ticked}
          tabIndex={stop ? 0 : -1}
          aria-disabled={added || undefined}
          aria-describedby={detailsId}
          onFocus={() => onFocus(w.id)}
          onChange={(e) => {
            if (added) return;
            onTick(w.id, e.currentTarget.checked);
          }}
        />
        <span>
          <span className="ao-find__candidate-title">
            <UserText>{w.title}</UserText>
          </span>
          <span id={detailsId} className="ao-find__candidate-details">
            {added && <strong className="ao-find__added">{CHOOSE_WORKS_TEXT.added}</strong>}
            {parts.map((p, i) => (
              <span key={p.key}>
                {(i > 0 || added) && " · "}
                {p.node}
              </span>
            ))}
          </span>
        </span>
      </label>
    </li>
  );
});

export function ChooseWorksDialog({ entry, works, person, loadError, onAdd, onClose, busy = false, error }: ChooseWorksDialogProps) {
  const id = useId();
  const items = useMemo<Item[] | undefined>(
    () =>
      works?.filter(wellFormedCandidate).map((w) => {
        const y = yearOf(w.issued);
        return { w, year: y === undefined ? undefined : Number(y), kind: kindFilterOf(w.type), hay: fold([w.title, wherePublished(w) ?? "", y ?? ""].join(" ")) };
      }),
    [works],
  );
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [kind, setKind] = useState<KindFilter>("Any");
  const [words, setWords] = useState("");
  /** The ticked works, whatever the filters show. */
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [limitHit, setLimitHit] = useState(false);
  /** The work that holds the list's one tab stop. */
  const [active, setActive] = useState<string | undefined>();

  const shown = useMemo(() => {
    if (!items) return [];
    const lo = yearNumber(from);
    const hi = yearNumber(to);
    const want = fold(words).split(/\s+/).filter(Boolean);
    return items.filter((it) => {
      if (lo !== undefined && (it.year === undefined || it.year < lo)) return false;
      if (hi !== undefined && (it.year === undefined || it.year > hi)) return false;
      if (kind !== "Any" && it.kind !== kind) return false;
      return want.every((x) => it.hay.includes(x));
    });
  }, [items, from, to, kind, words]);

  const stopId = shown.some((it) => it.w.id === active) ? active : shown[0]?.w.id;
  const tickable = useMemo(() => new Set((items ?? []).filter((it) => it.w.added !== true).map((it) => it.w.id)), [items]);
  const chosenIds = useMemo(() => (items ?? []).filter((it) => ticked.has(it.w.id) && tickable.has(it.w.id)).map((it) => it.w.id), [items, ticked, tickable]);
  const shownIds = useMemo(() => new Set(shown.map((it) => it.w.id)), [shown]);
  const hiddenChosen = chosenIds.filter((x) => !shownIds.has(x)).length;

  const tickedRef = useRef(ticked);
  tickedRef.current = ticked;
  const onTick = useCallback((wid: string, on: boolean) => {
    const cur = tickedRef.current;
    if (on === cur.has(wid)) return;
    if (on && cur.size >= FIND_CHOOSE_WORKS_MAX) {
      // The 51st: refused, said, and the tick does not stay (the checkbox is controlled).
      setLimitHit(true);
      return;
    }
    const next = new Set(cur);
    if (on) next.add(wid);
    else next.delete(wid);
    tickedRef.current = next;
    setTicked(next);
    setLimitHit(false);
  }, []);
  const onItemFocus = useCallback((wid: string) => setActive(wid), []);

  /** The arrow keys, Home, End, PageDown and PageUp move between the works shown. */
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const keys: Record<string, number | "home" | "end"> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, PageDown: 10, PageUp: -10, Home: "home", End: "end" };
    const step = keys[e.key];
    if (step === undefined || e.altKey || e.ctrlKey || e.metaKey) return;
    const cbs = [...e.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    if (!cbs.length) return;
    e.preventDefault();
    const at = Math.max(0, cbs.indexOf(document.activeElement as HTMLInputElement));
    const to = step === "home" ? 0 : step === "end" ? cbs.length - 1 : Math.min(cbs.length - 1, Math.max(0, at + step));
    const next = cbs[to]!;
    setActive(next.dataset.work);
    next.focus();
  };

  const close = () => {
    if (!busy) onClose();
  };
  const total = items?.length ?? 0;
  const affiliationLine = [person?.affiliation].filter((x): x is string => typeof x === "string" && x.trim() !== "");
  const subjects = (person?.subjects ?? []).filter((s): s is string => typeof s === "string" && s.trim() !== "");

  return (
    <DialogShell labelledBy={`${id}-t`} describedBy={`${id}-d`} onCancel={close} busy={busy} className="ao-find__dialog ao-find__works-dialog">
      <h2 id={`${id}-t`}>
        {person && typeof person.name === "string" ? (
          <>
            Choose works by <UserText>{person.name}</UserText>
          </>
        ) : (
          <>
            Choose works for “<UserText>{entry.typed}</UserText>”
          </>
        )}
      </h2>
      {(affiliationLine.length > 0 || subjects.length > 0) && (
        <p className="ao-find__person">
          {affiliationLine.length > 0 && (
            <span className="ao-find__line">
              <UserText>{affiliationLine[0]}</UserText>
            </span>
          )}
          {subjects.length > 0 && (
            <span className="ao-find__line">
              Works on: <UserText>{subjects.join(", ")}</UserText>
            </span>
          )}
        </p>
      )}
      <p id={`${id}-d`}>{CHOOSE_WORKS_TEXT.describe}</p>
      <div className="ao-find__filters">
        <label className="ao-find__field">
          From year
          <input type="text" inputMode="numeric" autoComplete="off" size={6} maxLength={4} value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="ao-find__field">
          To year
          <input type="text" inputMode="numeric" autoComplete="off" size={6} maxLength={4} value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="ao-find__field">
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as KindFilter)}>
            {KIND_FILTERS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="ao-find__field">
          Filter by words
          <input type="text" autoComplete="off" value={words} onChange={(e) => setWords(e.target.value)} />
        </label>
      </div>
      {!items && !loadError && <p className="ao-find__loading">{CHOOSE_WORKS_TEXT.loading}</p>}
      {loadError && (
        <p role="alert" className="ao-error">
          <UserText>{loadError}</UserText>
        </p>
      )}
      {items && (
        <>
          <p role="status" className="ao-find__count">
            {shownText(shown.length, total)}
          </p>
          {total === 0 && <p>{CHOOSE_WORKS_TEXT.none}</p>}
          <ul className="ao-find__candidates ao-find__works" aria-labelledby={`${id}-t`} onKeyDown={onListKey}>
            {shown.map((it) => (
              <WorkItem key={it.w.id} item={it} ticked={ticked.has(it.w.id)} stop={it.w.id === stopId} detailsId={`${id}-w-${it.w.id}`} onTick={onTick} onFocus={onItemFocus} />
            ))}
          </ul>
          {hiddenChosen > 0 && <p className="ao-find__note">{hiddenText(hiddenChosen)}</p>}
        </>
      )}
      {entry.moreWorks === true && <p className="ao-find__note">{CHOOSE_WORKS_TEXT.more}</p>}
      {limitHit && (
        <p role="alert" className="ao-error">
          {CHOOSE_WORKS_TEXT.limit}
        </p>
      )}
      {error && (
        <p role="alert" className="ao-error">
          <UserText>{error}</UserText>
        </p>
      )}
      <div className="ao-actions">
        <button
          type="button"
          disabled={chosenIds.length === 0}
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => {
            if (busy || chosenIds.length === 0) return;
            onAdd(chosenIds);
          }}
        >
          {busy ? "Adding…" : `Add the chosen works (${chosenIds.length})`}
        </button>
        <button type="button" aria-disabled={busy || undefined} onClick={close}>
          Cancel
        </button>
      </div>
    </DialogShell>
  );
}
