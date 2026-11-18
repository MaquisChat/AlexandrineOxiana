/**
 * The guards of the review queue's deciding controls (R313, R318, R319, R322, R323, R327), shared by the found files'
 * cards and by the panel for the queue's other kinds of entry (R362 d, defect D28): a press is taken only where the
 * pointer last MOVED over that control, a held or repeated key never decides, a quiet after the list changed, and a
 * scroll settles first. Each part that uses them keeps its own quiet and says a press not taken in its own words.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

/**
 * R313 c, R318 b, R319 d: the quiet. While it is in force no deciding control acts — by key or by pointer. It lasts this
 * long from the LATEST of the moments its user starts it (the list laid out or changed, a press not taken). Long enough
 * for a double click or a quick second key press; short enough not to slow deliberate work.
 */
export const DECIDE_SETTLE_MS = 600;
/** R322 a: how far (in CSS pixels, either way, on each axis) a control may stand from where it stood and still be "where it stood" (rounding). */
export const PRESS_PLACE_TOLERANCE_PX = 1;
/**
 * R327 c: how long after a scroll of the page a mouse press is not taken (a control passing under the pointer of a page
 * still moving was not pointed at): a mouse press whose pointer-down comes less than this after the last scroll is
 * refused as "moved". Keyboard presses and touch or pen presses are not affected (touch has its own stillness rule).
 */
export const SCROLL_SETTLE_MS = 250;
/**
 * R327 c: one sentence for each cause of a press not taken on a found file's card, shown on the card under its controls
 * (until the pointer moves over the card, or a press there is taken) and said, the same, in the polite region.
 *  - `moved`: a mouse press not taken for its place, the pointer's movement or a scroll;
 *  - `touch`: a tap or pen press on a control that had not stood still;
 *  - `quiet`: a press inside the quiet (any pointer, or the keyboard).
 */
export const PRESS_SHOWN_TEXT = {
  moved: "Not taken. Look at the file, then move the pointer and press again.",
  touch: "Not taken: the page had just moved. Look at the file, then tap again.",
  quiet: "Not taken: the list had just changed. Look at the file, then press again.",
} as const;
export type PressNotice = keyof typeof PRESS_SHOWN_TEXT;
/** R362 d: the same sentences for the panel of the queue's other kinds of entry ("entry" where the cards say "file"). */
export const PRESS_SHOWN_TEXT_ENTRY: Readonly<Record<PressNotice, string>> = {
  moved: "Not taken. Look at the entry, then move the pointer and press again.",
  touch: "Not taken: the page had just moved. Look at the entry, then tap again.",
  quiet: "Not taken: the list had just changed. Look at the entry, then press again.",
};

/**
 * R323 a: what the screen knows of the pointer, shared by every deciding control.
 *  - `moved`: the `pointermove` events in which the pointer really moved — its `clientX`/`clientY` differ from the last
 *    ones the screen saw for that `pointerId` (window listener, capture phase, so it sees every pointermove first).
 *    Client coordinates, not `movementX`/`movementY`: WebKit sends pointermoves after a scroll at the same point (with
 *    movement 0), and the engines do not agree on what `movementX/Y` hold; the same point twice is no movement in
 *    both. The first pointermove the screen sees of a pointer has nothing to differ from: it is not a movement.
 *  - `lastScrollAt`: the time of the last of those scrolls (R327 b: SCROLL_SETTLE_MS).
 *  - `scrolls`: moved on by every `scroll` event of the window or of any element (capture phase, so an inner scroller
 *    is seen too): a place remembered before it is forgotten.
 */
export interface Pointing {
  moved: WeakSet<Event>;
  last: Map<number, { x: number; y: number }>;
  scrolls: number;
  /** R327 b: when (Date.now()) the last scroll was seen. */
  lastScrollAt: number;
}

/** R323 a: the screen's watch of the pointer's real movements and of the scrolls (see Pointing). */
export function usePointing(): Pointing {
  const pointing = useMemo<Pointing>(() => ({ moved: new WeakSet(), last: new Map(), scrolls: 0, lastScrollAt: Number.NEGATIVE_INFINITY }), []);
  useEffect(() => {
    const onMove = (e: globalThis.PointerEvent) => {
      const was = pointing.last.get(e.pointerId);
      if (was && (was.x !== e.clientX || was.y !== e.clientY)) pointing.moved.add(e);
      pointing.last.set(e.pointerId, { x: e.clientX, y: e.clientY });
    };
    const onScroll = () => {
      pointing.scrolls++;
      pointing.lastScrollAt = Date.now();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [pointing]);
  return pointing;
}

/** R313 c, R318 b: a quiet — until a time (Date.now()) no deciding control of its part acts. */
export interface Quiet {
  /** R318 b: the quiet runs (again) for DECIDE_SETTLE_MS from `now`. */
  hold(now: number): void;
  /** Whether the quiet is in force at `now`. */
  active(now: number): boolean;
}

export function useQuiet(): Quiet {
  const until = useRef(0);
  return useMemo<Quiet>(
    () => ({
      hold: (now) => void (until.current = Math.max(until.current, now + DECIDE_SETTLE_MS)),
      active: (now) => now < until.current,
    }),
    [],
  );
}

/**
 * R322 a, R327 c: what a control found of a press — taken as built ("ok"), by a mouse not where it was pointed
 * ("moved"), or by touch or pen on a control that had not stood still ("moved-touch").
 */
export type PressCheck = "ok" | "moved" | "moved-touch";

/**
 * The verdict on a press that reached a deciding control: null when it is taken; else why it is not. A press not taken
 * for its place (R322 a) starts no quiet; a press inside the quiet starts it again from this press (R318 b).
 */
export function pressVerdict(how: PressCheck, now: number, quiet: Quiet): PressNotice | null {
  if (how !== "ok") return how === "moved" ? "moved" : "touch";
  if (quiet.active(now)) {
    quiet.hold(now);
    return "quiet";
  }
  return null;
}

/** R322 a: where a control stands, in the viewport (as the pointer sees it) or in the page (scrolling left out). */
export interface Spot {
  x: number;
  y: number;
}
export const spotOf = (el: Element, page: boolean): Spot => {
  const r = el.getBoundingClientRect();
  return page ? { x: r.left + window.scrollX, y: r.top + window.scrollY } : { x: r.left, y: r.top };
};
export const sameSpot = (a: Spot, b: Spot): boolean => Math.abs(a.x - b.x) <= PRESS_PLACE_TOLERANCE_PX && Math.abs(a.y - b.y) <= PRESS_PLACE_TOLERANCE_PX;

/** What a deciding control is given to be guarded: put on the button as they are. */
export interface GuardedHandlers {
  ref(el: HTMLButtonElement | null): void;
  onPointerMove(e: PointerEvent<HTMLButtonElement>): void;
  onPointerDown(e: PointerEvent<HTMLButtonElement>): void;
  onKeyDown(e: KeyboardEvent<HTMLButtonElement>): void;
  onKeyUp(e: KeyboardEvent<HTMLButtonElement>): void;
}

export interface PressGuard<K extends string> {
  /** The handlers of the control named `k`. */
  bind(k: K): GuardedHandlers;
  /** At the control's click: null when the click is a held key's (R313 b: not a press at all); else how the press came. */
  check(k: K, e: MouseEvent<HTMLButtonElement>): PressCheck | null;
}

/**
 * The per-control half of the guards, for the deciding controls of one card or panel (each named by a key).
 *  - `seen`: where the control stood in the viewport when a mouse last MOVED over it (pointermove). A mouse press is
 *    taken only if the mouse moved over this control and it still stands there (± PRESS_PLACE_TOLERANCE_PX), and no
 *    scroll came since (nor within SCROLL_SETTLE_MS before the press). So a control that slid under a resting pointer
 *    takes no press until the pointer moves over it again. With `forgetOn`, a change of that value (the list changed)
 *    forgets every place seen: the pointer must move over the control again.
 *  - `still`: where it stood in the page (scrolling left out) and since when, measured after every render and again at
 *    a touch or pen pointerdown. A touch or pen press is taken only if the control has stood still for DECIDE_SETTLE_MS.
 *  - `down`: the pointerdown seen on this control for the click to come. A click with no pointerdown before it is the
 *    click a key (or an assistive tool) makes: taken as built. A click whose own event says it came from a pointer but
 *    whose pointerdown was not seen is not taken.
 *  - R313 b: a repeated keydown (Enter or Space) is cancelled, and so is the click a browser makes of it.
 */
export function usePressGuard<K extends string>(pointing: Pointing, forgetOn?: unknown): PressGuard<K> {
  const repeating = useRef(false);
  const seen = useRef<Partial<Record<K, Spot & { scrolls: number }>>>({});
  const still = useRef<Partial<Record<K, Spot & { since: number }>>>({});
  const down = useRef<{ k: K; type: string; still: boolean; at: number } | null>(null);
  const buttons = useRef<Partial<Record<K, HTMLButtonElement | null>>>({});
  const forgot = useRef(forgetOn);
  if (forgot.current !== forgetOn) {
    forgot.current = forgetOn;
    seen.current = {};
  }
  /** Measures where a control stands now: true when it has stood there for the quiet's time; a change is a move, now. */
  const measure = (k: K, now: number): boolean => {
    const el = buttons.current[k];
    if (!el) return false;
    const at = spotOf(el, true);
    const was = still.current[k];
    if (was && sameSpot(was, at)) return now - was.since >= DECIDE_SETTLE_MS;
    still.current[k] = { ...at, since: now };
    return false;
  };
  // After every render (and so at every change the screen knows of).
  useLayoutEffect(() => {
    const now = Date.now();
    for (const k of Object.keys(buttons.current) as K[]) measure(k, now);
  });
  const bind = (k: K): GuardedHandlers => ({
    ref: (el) => {
      if (el) buttons.current[k] = el;
      else delete buttons.current[k];
    },
    // R323 a: only a pointermove in which the pointer really moved is pointing.
    onPointerMove: (e) => {
      if (e.pointerType === "mouse" && pointing.moved.has(e.nativeEvent)) seen.current[k] = { ...spotOf(e.currentTarget, false), scrolls: pointing.scrolls };
    },
    onPointerDown: (e) => {
      const at = Date.now();
      down.current = { k, type: e.pointerType, still: e.pointerType !== "mouse" && measure(k, at), at };
    },
    onKeyDown: (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      // A key on this control: a pointerdown seen before is not this press's.
      down.current = null;
      if (e.repeat) {
        e.preventDefault();
        repeating.current = true;
      } else repeating.current = false;
    },
    onKeyUp: (e) => {
      // Space makes its click on keyup, after this: a held Space still presses once, when it is let go.
      if (e.key === "Enter" || e.key === " ") repeating.current = false;
    },
  });
  const check = (k: K, e: MouseEvent<HTMLButtonElement>): PressCheck | null => {
    if (repeating.current) return null;
    const p = down.current;
    down.current = null;
    const type = (e.nativeEvent as { pointerType?: unknown }).pointerType;
    if (p && p.k === k) {
      if (p.type === "mouse") {
        const was = seen.current[k];
        // R327 b: and not within SCROLL_SETTLE_MS after a scroll of the page.
        return was && was.scrolls === pointing.scrolls && sameSpot(was, spotOf(e.currentTarget, false)) && p.at - pointing.lastScrollAt >= SCROLL_SETTLE_MS ? "ok" : "moved";
      }
      return p.still ? "ok" : "moved-touch";
    }
    if (type === "mouse") return "moved";
    if (type === "touch" || type === "pen") return "moved-touch";
    return "ok";
  };
  return { bind, check };
}
