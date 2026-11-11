/**
 * "Capture profile as I scroll" (spec 5.5): while the researcher scrolls a profile themselves, note
 * the links to posts that the page has shown. It only listens: it never clicks, follows a link,
 * scrolls or loads anything. A small counter in the page shows how many links were noted, with
 * Finish and Cancel; the list goes to the service on Finish.
 */
import { collectPostLinks, MAX_POST_LINKS } from "./extractors/index.js";
import type { SelectorsConfig } from "./selectors-schema.js";

export class ProfileCollector {
  private readonly seen = new Set<string>();
  private readonly urls: string[] = [];
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly throttleMs: number;
  private readonly onScroll = () => {
    if (!this.running) return;
    if (this.throttleMs === 0) return this.observe();
    if (this.timer === undefined) this.timer = setTimeout(() => {
      this.timer = undefined;
      this.observe();
    }, this.throttleMs);
  };

  constructor(
    private readonly doc: Document,
    private readonly win: Window,
    private readonly url: string,
    private readonly selectors: SelectorsConfig,
    private readonly onChange: (count: number) => void,
    opts: { throttleMs?: number } = {},
  ) {
    this.throttleMs = opts.throttleMs ?? 250;
  }

  get count(): number {
    return this.urls.length;
  }

  get full(): boolean {
    return this.urls.length >= MAX_POST_LINKS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Passive listeners: noting links never delays or changes the user's scrolling.
    this.win.addEventListener("scroll", this.onScroll, { passive: true, capture: true });
    this.observe();
  }

  /** Stops listening and returns the links noted, in the order they appeared. */
  stop(): string[] {
    this.running = false;
    this.win.removeEventListener("scroll", this.onScroll, { capture: true });
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    return [...this.urls];
  }

  private observe(): void {
    const added = collectPostLinks(this.doc, this.url, this.selectors, this.seen);
    if (!added.length) return;
    this.urls.push(...added);
    this.onChange(this.urls.length);
  }
}

/** The in-page counter with Finish and Cancel. Text only (textContent); in a closed shadow root. */
export class ProfileOverlay {
  private readonly host: HTMLElement;
  private readonly counter: HTMLElement;
  private readonly note: HTMLElement;
  private readonly row: HTMLElement;

  constructor(doc: Document, handlers: { finish(): void; cancel(): void }) {
    this.host = doc.createElement("div");
    this.host.style.setProperty("all", "initial");
    this.host.style.setProperty("position", "fixed", "important");
    this.host.style.setProperty("z-index", "2147483647", "important");
    this.host.style.setProperty("right", "16px", "important");
    this.host.style.setProperty("bottom", "16px", "important");
    const root = this.host.attachShadow({ mode: "closed" });
    const box = doc.createElement("div");
    box.setAttribute("role", "status");
    box.style.cssText = "font:14px/1.4 system-ui,sans-serif;background:#1f2328;color:#f6f8fa;padding:10px 12px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:280px";
    const title = doc.createElement("div");
    title.textContent = "Alexandrine Oxiana: noting posts as you scroll";
    this.counter = doc.createElement("div");
    this.counter.style.cssText = "font-weight:600;margin:4px 0";
    this.note = doc.createElement("div");
    this.note.style.cssText = "font-size:12px;opacity:.85";
    const row = (this.row = doc.createElement("div"));
    row.style.cssText = "display:flex;gap:8px;margin-top:6px";
    const button = (label: string, onClick: () => void) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = "font:inherit;padding:4px 10px;border-radius:6px;border:1px solid #8b949e;background:#2d333b;color:inherit;cursor:pointer";
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return b;
    };
    row.append(button("Finish", handlers.finish), button("Cancel", handlers.cancel));
    box.append(title, this.counter, this.note, row);
    root.append(box);
    this.setCount(0, false);
    doc.documentElement.append(this.host);
  }

  setCount(n: number, full: boolean): void {
    this.counter.textContent = `${n} post${n === 1 ? "" : "s"} noted`;
    this.note.textContent = full ? "That is the most one list can hold. Finish to send it." : "Scroll the profile yourself; nothing is clicked or opened for you.";
  }

  /** Listening has ended: hide the buttons and show `text`. */
  done(text: string): void {
    this.row.remove();
    this.note.textContent = text;
  }

  remove(): void {
    this.host.remove();
  }
}
