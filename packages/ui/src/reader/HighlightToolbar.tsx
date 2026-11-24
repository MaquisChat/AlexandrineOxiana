/**
 * Making highlights with the mouse (Task R10): the colour toolbar shown for a text selection on a
 * page, and the small menu offered where highlights overlap.
 *
 * HighlightToolbar — a toolbar "Highlight the selected text" placed just below the selection's last
 * line (`anchorBox`, in the coordinates of its positioned parent): "Highlight" (in the last colour
 * used, said in words beside it), the eight colours "Highlight in Yellow" … "Highlight in Grey", and
 * "Cancel".
 *  - Reachable by Tab from the selection (it is the next stop after the page in the tab order) and
 *    one stop in the tab order; Left and Right (and Home and End) move between its buttons.
 *  - Escape and "Cancel" cancel; so does a press anywhere else (the press may begin a new selection).
 *  - One choice a toolbar: a double press highlights once.
 *  - The colour comes from a class (`ao-ann-swatch--<name>`, the `--hl-*` tokens), never a style.
 *  - When it goes while the focus is in it, the focus goes back where it was before (the page).
 *
 * OverlapMenu — "2 highlights here": a menu listing each highlight under a click by its colour and
 * opening words (the source's own text, through UserText). The focus moves into it; Up and Down
 * (with wrap), Home and End move; Enter or a click chooses; Escape, Tab or a press elsewhere close
 * it; the focus goes back where it was.
 */
import { HIGHLIGHT_COLOUR_NAMES } from "@ao/shared";
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import type { HighlightColourName } from "../api/reader";
import { UserText } from "../components/UserText";
import type { Box } from "./geometry";
import "./HighlightToolbar.css";

const label = (c: HighlightColourName) => c.charAt(0).toUpperCase() + c.slice(1);

/** The eight colour buttons' names, in the toolbar's order. */
export const COLOUR_BUTTON_NAMES: readonly string[] = HIGHLIGHT_COLOUR_NAMES.map((c) => `Highlight in ${label(c)}`);

/** The space between the selection's last line and the toolbar, in CSS pixels. */
const BELOW_PX = 6;
/** How many characters of a highlight's words the overlap menu shows. */
const MENU_WORDS = 40;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/**
 * Places `el` at (`left`, `top`) kept inside `bounds` (R223, M5: the pages' view, in the same
 * coordinates), measured as it is drawn; `above` is where it goes instead when it would pass the
 * view's foot (the toolbar: above the selection's line).
 */
function placeInside(el: HTMLElement, left: number, top: number, bounds: Box | undefined, above?: number): void {
  if (bounds) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const bottom = bounds.top + bounds.height;
    if (above !== undefined && top + h > bottom) top = above - h;
    left = clamp(left, bounds.left, bounds.left + bounds.width - w);
    top = clamp(top, bounds.top, bottom - h);
  }
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/**
 * Gives the focus back, when the component goes while the focus is in it (or nowhere), to the element
 * that had it when the component came — if that is still in the page.
 */
function useFocusReturn(root: React.RefObject<HTMLElement | null>) {
  const before = useRef<Element | null>(null);
  useLayoutEffect(() => {
    before.current = document.activeElement;
    const el = root.current;
    return () => {
      const now = document.activeElement;
      const back = before.current;
      if ((now === null || now === document.body || (el?.contains(now) ?? false) || !now.isConnected) && back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [root]);
}

/** Calls `away` on a press anywhere outside `root`. */
function usePressElsewhere(root: React.RefObject<HTMLElement | null>, away: () => void) {
  const latest = useRef(away);
  latest.current = away;
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Node && root.current?.contains(e.target)) return;
      latest.current();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [root]);
}

/** Up/Down or Left/Right (wrapping), Home and End over `items`; true when the key was one of them. */
function moveFocus(e: KeyboardEvent, items: HTMLElement[], along: "row" | "column"): boolean {
  const i = items.indexOf(document.activeElement as HTMLElement);
  const [back, fwd] = along === "row" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  let to: number | undefined;
  if (e.key === fwd) to = (i + 1) % items.length;
  else if (e.key === back) to = (i - 1 + items.length) % items.length;
  else if (e.key === "Home") to = 0;
  else if (e.key === "End") to = items.length - 1;
  if (to === undefined || items.length === 0) return false;
  e.preventDefault();
  items[to]!.focus();
  return true;
}

export interface HighlightToolbarProps {
  /** The selection's last line, in the coordinates of the toolbar's positioned parent. */
  anchorBox: Box;
  /** The pages' view in the same coordinates: the toolbar stays inside it (R223, M5). */
  bounds?: Box;
  lastColour: HighlightColourName;
  onHighlight(c: HighlightColourName): void;
  onCancel(): void;
}

export function HighlightToolbar({ anchorBox, bounds, lastColour, onHighlight, onCancel }: HighlightToolbarProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const chosen = useRef(false);
  /** The button that is the toolbar's one stop in the tab order. */
  const stop = useRef(0);
  useFocusReturn(root);
  usePressElsewhere(root, onCancel);
  useLayoutEffect(() => {
    if (root.current) placeInside(root.current, anchorBox.left, anchorBox.top + anchorBox.height + BELOW_PX, bounds, anchorBox.top - BELOW_PX);
  });

  const choose = (c: HighlightColourName) => {
    if (chosen.current) return;
    chosen.current = true;
    onHighlight(c);
  };
  const buttons = () => [...(root.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys pressed in the toolbar are the toolbar's (not the page area's: Home, End, + and -).
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (moveFocus(e, buttons(), "row")) {
      const all = buttons();
      stop.current = Math.max(0, all.indexOf(document.activeElement as HTMLButtonElement));
      for (const [i, b] of all.entries()) b.tabIndex = i === stop.current ? 0 : -1;
    }
  };
  const tab = (i: number) => (i === stop.current ? 0 : -1);

  return (
    <div ref={root} role="toolbar" aria-label="Highlight the selected text" className="ao-hl-toolbar" style={{ left: `${anchorBox.left}px`, top: `${anchorBox.top + anchorBox.height + BELOW_PX}px` }} onKeyDown={onKeyDown}>
      <button type="button" tabIndex={tab(0)} className="ao-hl-toolbar__main" aria-describedby={`${id}-last`} onClick={() => choose(lastColour)}>
        <span className={`ao-ann-swatch ao-ann-swatch--${lastColour}`} aria-hidden="true" />
        Highlight
      </button>
      <span id={`${id}-last`} className="ao-hl-toolbar__last">
        in {label(lastColour)}
      </span>
      {HIGHLIGHT_COLOUR_NAMES.map((c, i) => (
        <button key={c} type="button" tabIndex={tab(i + 1)} aria-label={COLOUR_BUTTON_NAMES[i]} title={COLOUR_BUTTON_NAMES[i]} className="ao-hl-toolbar__colour" onClick={() => choose(c)}>
          <span className={`ao-ann-swatch ao-ann-swatch--${c}`} aria-hidden="true" />
        </button>
      ))}
      <button type="button" tabIndex={tab(HIGHLIGHT_COLOUR_NAMES.length + 1)} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

export interface OverlapMenuItem {
  id: string;
  colorName: HighlightColourName;
  /** The highlight's quote or note (the source's text); its opening words are shown. */
  words: string;
}

export interface OverlapMenuProps {
  /** Where the click was, in the coordinates of the menu's positioned parent. */
  at: { left: number; top: number };
  /** The pages' view in the same coordinates: the menu stays inside it (R223, M5). */
  bounds?: Box;
  items: OverlapMenuItem[];
  onChoose(id: string): void;
  onClose(): void;
}

/** Cut by characters (code points), never inside one. */
function opening(s: string, n: number): string {
  const chars = [...s.replace(/\s+/gu, " ").trim()];
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : chars.join("");
}

export function OverlapMenu({ at, bounds, items, onChoose, onClose }: OverlapMenuProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  useFocusReturn(root);
  usePressElsewhere(root, onClose);
  useLayoutEffect(() => {
    if (root.current) placeInside(root.current, at.left, at.top, bounds);
  });
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true });
  }, []);
  const entries = () => [...(root.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys pressed in the menu are the menu's (not the page area's).
    e.stopPropagation();
    if (e.key === "Escape" || e.key === "Tab") {
      // Tab too: the focus goes back where it was (R145), not on past it.
      e.preventDefault();
      onClose();
      return;
    }
    moveFocus(e, entries(), "column");
  };
  return (
    <div ref={root} className="ao-hl-menu" style={{ left: `${at.left}px`, top: `${at.top}px` }} onKeyDown={onKeyDown}>
      <p id={`${id}-title`} className="ao-hl-menu__title">
        {items.length} highlights here
      </p>
      <div role="menu" aria-labelledby={`${id}-title`}>
        {items.map((it) => {
          const words = opening(it.words, MENU_WORDS);
          return (
            <button key={it.id} type="button" role="menuitem" tabIndex={-1} className="ao-hl-menu__item" onClick={() => onChoose(it.id)}>
              <span className={`ao-ann-swatch ao-ann-swatch--${it.colorName}`} aria-hidden="true" />
              {label(it.colorName)}
              {words !== "" && (
                <>
                  {": "}
                  <UserText>{words}</UserText>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
