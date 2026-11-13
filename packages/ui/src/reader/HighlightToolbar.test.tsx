/**
 * The colour toolbar shown for a text selection on a page (Task R10), and the small menu offered
 * where highlights overlap. Focus is asserted at every step (R145): reachable by Tab from the
 * selection, one stop in the tab order with the arrows inside, Escape and a press elsewhere close
 * it, and the focus goes back where it was.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HighlightToolbar, OverlapMenu, COLOUR_BUTTON_NAMES } from "./HighlightToolbar";

afterEach(cleanup);

const box = { left: 120, top: 300, width: 200, height: 14 };

/** The page with its selection, focused (the page box takes the focus when text on it is pressed); then `ui` comes. */
function withPage(ui: React.ReactNode) {
  const Screen = ({ children }: { children?: React.ReactNode }) => (
    <div>
      <div tabIndex={-1} role="region" aria-label="Page 1 of 3">
        Selected words
      </div>
      {children}
    </div>
  );
  const r = render(<Screen />);
  const page = screen.getByRole("region", { name: "Page 1 of 3" });
  page.focus();
  r.rerender(<Screen>{ui}</Screen>);
  return { ...r, page, gone: () => r.rerender(<Screen />) };
}

describe("HighlightToolbar (Task R10)", () => {
  it("the toolbar is reachable by Tab and closes on Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onHighlight = vi.fn();
    const { page } = withPage(<HighlightToolbar anchorBox={box} lastColour="yellow" onHighlight={onHighlight} onCancel={onCancel} />);
    expect(document.activeElement).toBe(page);
    await user.tab();
    const first = screen.getByRole("button", { name: "Highlight" });
    expect(document.activeElement).toBe(first);
    // One stop in the tab order: Shift+Tab leaves it at once (to before the page, which is not a tab stop).
    await user.tab({ shift: true });
    expect(screen.getByRole("toolbar").contains(document.activeElement)).toBe(false);
    page.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onHighlight).not.toHaveBeenCalled();
  });

  it("names its buttons as the plan gives them, says the last colour in words, and carries colour by class only", () => {
    render(<HighlightToolbar anchorBox={box} lastColour="green" onHighlight={() => {}} onCancel={() => {}} />);
    const bar = screen.getByRole("toolbar", { name: "Highlight the selected text" });
    const names = [...bar.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toEqual(["Highlight", ...COLOUR_BUTTON_NAMES, "Cancel"]);
    expect(COLOUR_BUTTON_NAMES).toEqual(["Highlight in Yellow", "Highlight in Red", "Highlight in Green", "Highlight in Blue", "Highlight in Purple", "Highlight in Magenta", "Highlight in Orange", "Highlight in Grey"]);
    const main = screen.getByRole("button", { name: "Highlight" });
    // The last colour is said in words, not by its swatch alone.
    expect(main.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(main.getAttribute("aria-describedby")!)!.textContent).toBe("in Green");
    for (const b of bar.querySelectorAll<HTMLElement>("button, span")) expect(b.getAttribute("style") ?? "").not.toMatch(/colou?r|background/i);
    expect(bar.querySelector(".ao-ann-swatch--green")).toBeTruthy();
    // Placed just below the selection's last line.
    expect(bar.style.left).toBe("120px");
    expect(parseFloat(bar.style.top)).toBeGreaterThanOrEqual(314);
  });

  it("Highlight takes the last colour, a colour button its own; a double press highlights once", async () => {
    const user = userEvent.setup();
    const onHighlight = vi.fn();
    const { unmount } = render(<HighlightToolbar anchorBox={box} lastColour="purple" onHighlight={onHighlight} onCancel={() => {}} />);
    const main = screen.getByRole("button", { name: "Highlight" });
    await user.dblClick(main);
    expect(onHighlight.mock.calls).toEqual([["purple"]]);
    unmount();
    const again = vi.fn();
    render(<HighlightToolbar anchorBox={box} lastColour="purple" onHighlight={again} onCancel={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Highlight in Blue" }));
    expect(again.mock.calls).toEqual([["blue"]]);
  });

  it("the arrows move between its buttons; Tab leaves it", async () => {
    const user = userEvent.setup();
    withPage(
      <>
        <HighlightToolbar anchorBox={box} lastColour="yellow" onHighlight={() => {}} onCancel={() => {}} />
        <button type="button">After</button>
      </>,
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Highlight" }));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Highlight in Yellow" }));
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Highlight" }));
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Highlight" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
  });

  it("a press elsewhere cancels it; a press on it does not; Cancel cancels and the focus goes back to the page", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const { page, gone } = withPage(<HighlightToolbar anchorBox={box} lastColour="yellow" onHighlight={() => {}} onCancel={onCancel} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Highlight in Red" }));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.mouseDown(page);
    expect(onCancel).toHaveBeenCalledTimes(1);
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    // The screen takes the toolbar away; the focus, which was in it, goes back to the page.
    gone();
    expect(document.activeElement).toBe(page);
  });
});

describe("OverlapMenu (Task R10)", () => {
  const items = [
    { id: "a", colorName: "yellow" as const, words: "informal markets of the upland villages" },
    { id: "b", colorName: "blue" as const, words: "markets" },
  ];

  it("is a real menu: named by its count, each highlight by colour and opening words, focus in, arrows, Escape, focus back", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onClose = vi.fn();
    const { page, gone } = withPage(<OverlapMenu at={{ left: 40, top: 60 }} items={items} onChoose={onChoose} onClose={onClose} />);
    const menu = screen.getByRole("menu", { name: "2 highlights here" });
    const entries = screen.getAllByRole("menuitem");
    expect(entries.map((e) => e.textContent)).toEqual(["Yellow: informal markets of the upland villages", "Blue: markets"]);
    // The words are the source's own text: shown through UserText (its own direction).
    expect(entries[0]!.querySelector("[dir='auto']")).toBeTruthy();
    expect(document.activeElement).toBe(entries[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(entries[1]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(entries[0]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(entries[1]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(entries[0]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(entries[1]);
    await user.keyboard("{Enter}");
    expect(onChoose).toHaveBeenCalledWith("b");
    expect(menu.closest<HTMLElement>(".ao-hl-menu")!.style.left).toBe("40px");
    // Escape closes; once it is gone the focus is back on the page.
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    gone();
    expect(document.activeElement).toBe(page);
  });

  it("Tab and a press elsewhere close it; a click on an entry chooses it", async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onClose = vi.fn();
    const { page } = withPage(<OverlapMenu at={{ left: 0, top: 0 }} items={items} onChoose={onChoose} onClose={onClose} />);
    await user.click(screen.getByRole("menuitem", { name: /^Blue/ }));
    expect(onChoose).toHaveBeenCalledWith("b");
    await user.keyboard("{Tab}");
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(page);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("long words are cut by characters with an ellipsis", () => {
    render(<OverlapMenu at={{ left: 0, top: 0 }} items={[{ id: "x", colorName: "red", words: "😀".repeat(80) }, { id: "y", colorName: "grey", words: "" }]} onChoose={() => {}} onClose={() => {}} />);
    const [a, b] = screen.getAllByRole("menuitem");
    expect(a!.textContent).toBe(`Red: ${"😀".repeat(40)}…`);
    expect(b!.textContent).toBe("Grey");
  });
});

describe("HighlightToolbar and OverlapMenu stay inside the pages' view (R223, M5)", () => {
  /** jsdom lays nothing out: every element is given this size. */
  function sized(w: number, h: number) {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(w);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(h);
  }
  afterEach(() => vi.restoreAllMocks());
  const bounds = { left: 10, top: 20, width: 400, height: 300 };
  const placed = (el: HTMLElement) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) });

  it("near the view's right and lower edges the toolbar is drawn above the line and within the view", () => {
    sized(200, 40);
    render(<HighlightToolbar anchorBox={{ left: 350, top: 290, width: 50, height: 14 }} bounds={bounds} lastColour="yellow" onHighlight={() => {}} onCancel={() => {}} />);
    const p = placed(screen.getByRole("toolbar"));
    expect(p.left).toBe(bounds.left + bounds.width - 200);
    // Below would pass the view's foot (290 + 14 + 6 + 40 > 320): above the line instead.
    expect(p.top).toBe(290 - 6 - 40);
  });

  it("a line scrolled out of the view keeps the toolbar inside it, on all four sides", () => {
    sized(200, 40);
    const { rerender } = render(<HighlightToolbar anchorBox={{ left: -100, top: 900, width: 50, height: 14 }} bounds={bounds} lastColour="yellow" onHighlight={() => {}} onCancel={() => {}} />);
    let p = placed(screen.getByRole("toolbar"));
    expect(p).toEqual({ left: 10, top: 20 + 300 - 40 });
    rerender(<HighlightToolbar anchorBox={{ left: 900, top: -400, width: 50, height: 14 }} bounds={bounds} lastColour="yellow" onHighlight={() => {}} onCancel={() => {}} />);
    p = placed(screen.getByRole("toolbar"));
    expect(p).toEqual({ left: 10 + 400 - 200, top: 20 });
  });

  it("the overlap menu too", () => {
    sized(180, 90);
    render(<OverlapMenu at={{ left: 395, top: 310 }} bounds={bounds} items={[{ id: "a", colorName: "red", words: "x" }, { id: "b", colorName: "blue", words: "y" }]} onChoose={() => {}} onClose={() => {}} />);
    const el = screen.getByRole("menu").closest<HTMLElement>(".ao-hl-menu")!;
    expect(placed(el)).toEqual({ left: 10 + 400 - 180, top: 20 + 300 - 90 });
  });
});

