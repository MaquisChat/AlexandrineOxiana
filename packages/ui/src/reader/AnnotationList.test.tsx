/**
 * The annotation list beside the pages (Task R9): its entries, in the order the service gives them,
 * with the colour said by name; "Go to", the note, the colour menu and the delete dialog, each by
 * keyboard, with focus asserted where it is (R145); the one polite live region; refusals shown in an
 * alert with nothing changed; read-only; the sentences that replaced R8's temporary region (A11);
 * the windowing of a long list.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationRecord, HighlightColourName } from "../api/reader";
import {
  ANNOTATIONS_NOT_SHOWN,
  ANNOTATIONS_READ_ONLY,
  AnnotationList,
  AnswerDropped,
  HIGHLIGHT_CHANGED_SENTENCE,
  ListBroughtUpToDate,
  LIST_BROUGHT_UP_TO_DATE,
  missingNoteSentence,
  missingPageSentence,
  offsetsOf,
  PLACE_UNKNOWN,
  WINDOW_FROM,
  windowOf,
  type AnnotationListProps,
} from "./AnnotationList";
import { navigate } from "../navigation";

afterEach(() => cleanup());

let made = 0;
function rec(o: Partial<AnnotationRecord> & { page?: number; assetId?: string } = {}): AnnotationRecord {
  const id = o.id ?? `an-${++made}`;
  const { page = 1, assetId = "a1", ...rest } = o;
  return {
    id,
    sourceId: "s1",
    kind: "highlight",
    pdfAnchors: [{ id: `${id}-a`, assetId, page, rects: [{ x: 50, y: 700, w: 100, h: 10 }], sortIndex: "00000|000000|00000", sortIndexDerived: false }],
    otherAnchorKinds: [],
    quote: `Words of ${id}`,
    colorName: "yellow",
    imported: false,
    author: "me",
    createdAt: "2026-11-13T10:00:00Z",
    ...rest,
  };
}

const noop = () => Promise.resolve();
function list(props: Partial<AnnotationListProps> & { annotations: AnnotationRecord[] }) {
  return render(<AnnotationList assetId="a1" readOnly={false} pageCount={20} onJump={() => {}} onSaveNote={noop} onRecolour={noop} onDelete={noop} {...props} />);
}

/** A list whose changes are answered by a stand-in service: `answer` decides each one. */
function Harness(p: { initial: AnnotationRecord[]; answer?: (what: string) => Promise<void> | void; readOnly?: boolean; selectedId?: string; onJump?: (id: string) => void }) {
  const [items, setItems] = useState(p.initial);
  const answer = async (what: string) => {
    await p.answer?.(what);
  };
  return (
    <AnnotationList
      annotations={items}
      assetId="a1"
      readOnly={p.readOnly ?? false}
      pageCount={20}
      {...(p.selectedId !== undefined ? { selectedId: p.selectedId } : {})}
      onJump={p.onJump ?? (() => {})}
      onSaveNote={async (id, body) => {
        await answer(`note ${id} ${JSON.stringify(body)}`);
        setItems((l) => l.map((a) => (a.id !== id ? a : body === null ? (({ body: _b, ...r }) => r)(a) : { ...a, body })));
      }}
      onRecolour={async (id, c) => {
        await answer(`colour ${id} ${c}`);
        setItems((l) => l.map((a) => (a.id === id ? { ...a, colorName: c } : a)));
      }}
      onDelete={async (id) => {
        await answer(`delete ${id}`);
        setItems((l) => l.filter((a) => a.id !== id));
      }}
    />
  );
}

const entries = () => within(screen.getByRole("list", { name: /^Annotations/ })).queryAllByRole("listitem");
const entry = (id: string) => document.querySelector<HTMLElement>(`[data-entry="${id}"]`)!;
const live = () => screen.getByRole("status");

describe("AnnotationList (Task R9)", () => {
  it("entries are in sort order and say colour by name", () => {
    // In the service's reading order (sortAnnotations, R1): the list never reorders it.
    const items = [
      rec({ id: "p1-first", page: 1, colorName: "green", imported: true, author: "Ngozi Okafor", quote: "informal markets", body: "key claim", pageLabel: "vii" }),
      rec({ id: "p1-second", page: 1, kind: "underline", colorName: "purple" }),
      rec({ id: "p7", page: 7, kind: "note", quote: undefined, body: "check the numbers" }),
      rec({ id: "other-file", assetId: "a2", page: 2, colorName: "blue" }),
      rec({ id: "nowhere", pdfAnchors: [], quote: "a place lost", colorName: "grey" }),
    ];
    list({ annotations: items });
    expect(screen.getByRole("region", { name: "Annotations (3)" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Annotations (3)" })).toBeTruthy();
    expect(entries().map((e) => e.dataset.entry)).toEqual(["p1-first", "p1-second", "p7"]);
    const first = entries()[0]!;
    expect(first.textContent).toContain("Highlight");
    expect(first.textContent).toContain("Green");
    expect(first.textContent).toContain("Page 1 (vii)");
    expect(first.textContent).toContain("Imported from Zotero");
    // No author for now (A13): the importer cannot tell Zotero's author from the computer's user.
    expect(first.textContent).not.toContain("Ngozi Okafor");
    expect(first.textContent).not.toContain(" by ");
    // The quote and the note through UserText (dir="auto").
    expect(within(first).getByText("informal markets").getAttribute("dir")).toBe("auto");
    expect(within(first).getByText("key claim").getAttribute("dir")).toBe("auto");
    expect(entries()[1]!.textContent).toContain("Underline");
    expect(entries()[1]!.textContent).toContain("Purple");
    expect(entries()[2]!.textContent).toContain("Note");
    expect(entries()[2]!.textContent).toContain("Page 7");
    expect(entries()[1]!.textContent).not.toContain("Imported from Zotero");
    // Buttons named with kind, colour and page, so that entries can be told apart.
    expect(within(first).getByRole("button", { name: /^Go to green highlight on page 1/ })).toBeTruthy();
    expect(within(first).getByRole("button", { name: /^Edit note of green highlight on page 1/ })).toBeTruthy();
    expect(within(first).getByRole("button", { name: /^Colour of green highlight on page 1/ })).toBeTruthy();
    expect(within(first).getByRole("button", { name: /^Delete green highlight on page 1/ })).toBeTruthy();
    expect(within(entries()[1]!).getByRole("button", { name: /^Add note to purple underline on page 1/ })).toBeTruthy();
    // The further groups, with their counts.
    expect(screen.getByRole("list", { name: "On another file of this source (1)" }).textContent).toContain("Blue");
    const nowhere = screen.getByRole("list", { name: "Not placed on a page (1)" });
    expect(nowhere.textContent).toContain(PLACE_UNKNOWN);
    expect(PLACE_UNKNOWN).toBe("This highlight's place in the document is no longer known.");
    // Positions in each list.
    expect(entries().map((e) => [e.getAttribute("aria-posinset"), e.getAttribute("aria-setsize")])).toEqual([
      ["1", "3"],
      ["2", "3"],
      ["3", "3"],
    ]);
  });

  it("Up and Down move between entries, Home and End to the ends, Enter goes to the highlight", async () => {
    const onJump = vi.fn();
    const user = userEvent.setup();
    list({ annotations: [rec({ id: "a" }), rec({ id: "b", page: 2 }), rec({ id: "c", page: 3 })], onJump });
    // One entry in the tab order (roving focus).
    expect(entries().map((e) => e.tabIndex)).toEqual([0, -1, -1]);
    entry("a").focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(entry("b"));
    expect(entries().map((e) => e.tabIndex)).toEqual([-1, 0, -1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(entry("c"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(entry("c"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(entry("a"));
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(entry("a"));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onJump).toHaveBeenCalledWith("b");
    await user.click(within(entry("c")).getByRole("button", { name: /^Go to/ }));
    expect(onJump).toHaveBeenLastCalledWith("c");
  });

  it("the colour menu manages focus", async () => {
    const answers: string[] = [];
    const user = userEvent.setup();
    render(<Harness initial={[rec({ id: "a", imported: true }), rec({ id: "b" })]} answer={(w) => void answers.push(w)} />);
    const button = within(entry("a")).getByRole("button", { name: /^Colour of yellow highlight/ });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    await user.click(button);
    const menu = screen.getByRole("menu", { name: /^Colour of yellow highlight/ });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["Yellow", "Red", "Green", "Blue", "Purple", "Magenta", "Orange", "Grey"]);
    expect(items.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false", "false", "false", "false", "false"]);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // Focus on the current one; arrows move and wrap; Home and End.
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(items[1]);
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(items[7]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(items[7]);
    // Tab and Shift+Tab close the menu and give focus back to its button.
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(within(screen.getByRole("menu")).getAllByRole("menuitemradio")[0]);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    // Escape closes it and gives focus back.
    await user.keyboard("{Enter}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    // Green: chosen, the menu closes, focus on the button, announced; still imported.
    await user.keyboard("{Enter}{ArrowDown}{ArrowDown}{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(live().textContent).toBe("Highlight recoloured: Green."));
    expect(answers).toEqual(["colour a green"]);
    expect(document.activeElement).toBe(within(entry("a")).getByRole("button", { name: /^Colour of green highlight/ }));
    expect(entry("a").textContent).toContain("Green");
    expect(entry("a").textContent).toContain("Imported from Zotero");
  });

  it("recolouring to the same colour sends nothing", async () => {
    const onRecolour = vi.fn(noop);
    const user = userEvent.setup();
    list({ annotations: [rec({ id: "a", colorName: "blue" })], onRecolour });
    const button = within(entry("a")).getByRole("button", { name: /^Colour of/ });
    await user.click(button);
    expect(document.activeElement?.textContent).toBe("Blue");
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(onRecolour).not.toHaveBeenCalled();
    expect(live().textContent).toBe("");
  });

  it("a refusal is shown as an alert, leaves the entry as it was and focus where the researcher can act", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[rec({ id: "a", body: "old note" })]} answer={() => Promise.reject(new Error("This project's rules do not allow it."))} />);
    const colour = within(entry("a")).getByRole("button", { name: /^Colour of/ });
    await user.click(colour);
    await user.click(screen.getByRole("menuitemradio", { name: "Red" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("This project's rules do not allow it.");
    expect(entry("a").contains(alert)).toBe(true);
    expect(entry("a").textContent).toContain("Yellow");
    expect(entry("a").textContent).not.toContain("Red");
    expect(document.activeElement).toBe(colour);
    expect(live().textContent).toBe("");
    // A note refused: the editor stays open with what was typed.
    await user.click(within(entry("a")).getByRole("button", { name: /^Edit note of/ }));
    const area = screen.getByRole("textbox", { name: "Note" });
    await user.clear(area);
    await user.type(area, "new words");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("This project's rules do not allow it."));
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("new words");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save note" }));
    // A delete refused: the entry stays, focus back on its Delete button.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(within(entry("a")).getByRole("button", { name: /^Delete/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("This project's rules do not allow it."));
    expect(entry("a")).toBeTruthy();
    expect(document.activeElement).toBe(within(entry("a")).getByRole("button", { name: /^Delete/ }));
  });

  it("an answer dropped by the screen (the reader ended, the file changed) shows nothing", async () => {
    const user = userEvent.setup();
    list({ annotations: [rec({ id: "a" })], onRecolour: () => Promise.reject(new AnswerDropped()) });
    await user.click(within(entry("a")).getByRole("button", { name: /^Colour of/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Red" }));
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(live().textContent).toBe("");
  });

  it("a change asked twice quickly sends one request", async () => {
    let release: () => void = () => {};
    const onRecolour = vi.fn(() => new Promise<void>((r) => (release = r)));
    const user = userEvent.setup();
    list({ annotations: [rec({ id: "a" })], onRecolour });
    const colour = within(entry("a")).getByRole("button", { name: /^Colour of/ });
    await user.click(colour);
    await user.click(screen.getByRole("menuitemradio", { name: "Red" }));
    // While it is on its way the entry says so and its Colour waits (A13): no second menu, no second request.
    expect(colour.getAttribute("aria-disabled")).toBe("true");
    await user.click(colour);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onRecolour).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  it("the note: Save note sends the text exactly as typed; empty removes it; Ctrl+Enter saves; Escape restores the old text", async () => {
    const answers: string[] = [];
    const user = userEvent.setup();
    render(<Harness initial={[rec({ id: "a", body: "old note" }), rec({ id: "b" })]} answer={(w) => void answers.push(w)} />);
    const edit = within(entry("a")).getByRole("button", { name: /^Edit note of/ });
    await user.click(edit);
    const area = screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(area);
    expect(area.value).toBe("old note");
    await user.type(area, " and more");
    // Escape restores what was there (after the question, the text having changed); nothing is sent.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    expect(entry("a").textContent).toContain("old note");
    expect(entry("a").textContent).not.toContain("and more");
    expect(document.activeElement).toBe(edit);
    await user.click(edit);
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("old note");
    // Cancel too.
    await user.type(screen.getByRole("textbox", { name: "Note" }), "!");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(entry("a").textContent).not.toContain("old note!");
    expect(answers).toEqual([]);
    // While one note is edited, the other entries stay usable.
    await user.click(edit);
    await user.click(within(entry("b")).getByRole("button", { name: /^Colour of/ }));
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("textbox", { name: "Note" })).toBeTruthy();
    // Spaces kept as typed; saved by the button.
    const area2 = screen.getByRole("textbox", { name: "Note" });
    await user.clear(area2);
    await user.type(area2, "  two spaces  ");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() => expect(live().textContent).toBe("Note saved."));
    expect(answers).toEqual([`note a "  two spaces  "`]);
    expect(document.activeElement).toBe(within(entry("a")).getByRole("button", { name: /^Edit note of/ }));
    // Empty: the note removed (null), with Ctrl+Enter.
    await user.click(within(entry("a")).getByRole("button", { name: /^Edit note of/ }));
    await user.clear(screen.getByRole("textbox", { name: "Note" }));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(live().textContent).toBe("Note removed."));
    expect(answers[1]).toBe("note a null");
    expect(within(entry("a")).getByRole("button", { name: /^Add note to/ })).toBeTruthy();
    // Cmd+Enter saves too.
    await user.click(within(entry("b")).getByRole("button", { name: /^Add note to/ }));
    await user.type(screen.getByRole("textbox", { name: "Note" }), "line one{Shift>}{Enter}{/Shift}line two");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(answers[2]).toBe(`note b "line one\\nline two"`));
  });

  it("a 10,000-character note does not widen the list", () => {
    const body = "x".repeat(10_000);
    list({ annotations: [rec({ id: "a", body })] });
    const note = within(entry("a")).getByText(body);
    expect(note.className).toContain("ao-ann-note");
  });

  it("a quote with markup in it is shown as text, and a button's name cuts it by characters, never inside one", () => {
    list({ annotations: [rec({ id: "a", quote: "<b>informal</b> markets" }), rec({ id: "e", quote: `${"a".repeat(39)}${"😀".repeat(5)}` })] });
    expect(entry("a").querySelector("b")).toBeNull();
    expect(within(entry("a")).getByText("<b>informal</b> markets")).toBeTruthy();
    const name = within(entry("e")).getByRole("button", { name: /^Go to/ }).getAttribute("aria-label")!;
    expect(name).toBe(`Go to yellow highlight on page 1, “${"a".repeat(39)}😀…”`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name)).toBe(false);
  });

  it("a right-to-left quote keeps its direction", () => {
    list({ annotations: [rec({ id: "a", quote: "השווקים הבלתי פורמליים" })] });
    expect(within(entry("a")).getByText("השווקים הבלתי פורמליים").getAttribute("dir")).toBe("auto");
  });

  it("the delete dialog manages focus and returns it to the next entry", async () => {
    const answers: string[] = [];
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Outside</button>
        <Harness initial={[rec({ id: "a" }), rec({ id: "b", kind: "note", quote: undefined, body: "a note" }), rec({ id: "c" })]} answer={(w) => void answers.push(w)} />
      </div>,
    );
    const del = within(entry("b")).getByRole("button", { name: /^Delete yellow note on page 1/ });
    await user.click(del);
    const dialog = screen.getByRole("dialog", { name: "Delete this note?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const [yes, no] = [within(dialog).getByRole("button", { name: "Delete" }), within(dialog).getByRole("button", { name: "Keep it" })];
    // Focus moves in, on "Keep it"; Tab and Shift+Tab stay inside.
    expect(document.activeElement).toBe(no);
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(yes);
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(no);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(yes);
    // The background is inert.
    expect(screen.getByRole("button", { name: "Outside", hidden: true }).closest("[inert]")).not.toBeNull();
    // Escape keeps it, focus back on its Delete button.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(del);
    expect(document.querySelector("[inert]")).toBeNull();
    // "Keep it" too.
    await user.click(del);
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(document.activeElement).toBe(del);
    expect(answers).toEqual([]);
    // Delete: gone, announced, focus on the next entry.
    await user.click(del);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(entries().map((e) => e.dataset.entry)).toEqual(["a", "c"]));
    expect(answers).toEqual(["delete b"]);
    await waitFor(() => expect(document.activeElement).toBe(entry("c")));
    expect(live().textContent).toBe("Note deleted.");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Annotations (2)");
  });

  it("after a delete focus goes to the next entry, the previous one for the last, the heading for the only one", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[rec({ id: "a" }), rec({ id: "b" })]} />);
    await user.click(within(entry("b")).getByRole("button", { name: /^Delete/ }));
    expect(screen.getByRole("dialog", { name: "Delete this highlight?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(document.activeElement).toBe(entry("a")));
    expect(live().textContent).toBe("Highlight deleted.");
    await user.click(within(entry("a")).getByRole("button", { name: /^Delete/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2, name: "Annotations (0)" })));
  });

  it("after a delete the focus is right even when the screen draws the list without it before the answer is read", async () => {
    function DrawsFirst() {
      const [items, setItems] = useState([rec({ id: "h" }), rec({ id: "n", kind: "note", page: 3 })]);
      return (
        <AnnotationList
          annotations={items}
          assetId="a1"
          readOnly={false}
          pageCount={1}
          onJump={() => {}}
          onSaveNote={noop}
          onRecolour={noop}
          onDelete={async (id) => {
            // As the screen does: the service's answer applied, then a moment before the promise settles.
            setItems((l) => l.filter((a) => a.id !== id));
            await new Promise((r) => setTimeout(r, 20));
          }}
        />
      );
    }
    const user = userEvent.setup();
    render(<DrawsFirst />);
    await user.click(within(entry("n")).getByRole("button", { name: /^Delete/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(live().textContent).toBe("Note deleted."));
    await waitFor(() => expect(document.activeElement).toBe(entry("h")));
    expect(entry("h").tabIndex).toBe(0);
  });

  it("an annotation with no place is listed at the end, says so and can be deleted (A5)", async () => {
    const answers: string[] = [];
    const user = userEvent.setup();
    render(<Harness initial={[rec({ id: "here" }), rec({ id: "lost", pdfAnchors: [], quote: "a place lost", body: "its note" })]} answer={(w) => void answers.push(w)} />);
    const group = screen.getByRole("list", { name: "Not placed on a page (1)" });
    const lost = entry("lost");
    expect(group.contains(lost)).toBe(true);
    expect(lost.textContent).toContain(PLACE_UNKNOWN);
    expect(lost.textContent).toContain("its note");
    expect((within(lost).getByRole("button", { name: /^Go to/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(lost).getByRole("button", { name: /^Delete yellow highlight not placed on a page/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(answers).toEqual(["delete lost"]));
    await waitFor(() => expect(document.activeElement).toBe(entry("here")));
  });

  it("an entry of the changed set says so; one not judged says nothing; a missing page says so and cannot be gone to", () => {
    list({
      annotations: [
        rec({ id: "changed" }),
        rec({ id: "unjudged" }),
        rec({ id: "far", page: 412 }),
        rec({ id: "far-note", kind: "note", page: 77, quote: undefined, body: "check" }),
      ],
      changed: new Set(["changed"]),
    });
    expect(HIGHLIGHT_CHANGED_SENTENCE).toBe("The text here has changed since this highlight was made.");
    expect(entry("changed").textContent).toContain(HIGHLIGHT_CHANGED_SENTENCE);
    expect(entry("unjudged").textContent).not.toContain(HIGHLIGHT_CHANGED_SENTENCE);
    expect(missingPageSentence(412)).toBe("This highlight is on page 412, which this file does not have.");
    expect(missingNoteSentence(77)).toBe("This note is on page 77, which this file does not have.");
    expect(entry("far").textContent).toContain(missingPageSentence(412));
    expect(entry("far-note").textContent).toContain(missingNoteSentence(77));
    expect((within(entry("far")).getByRole("button", { name: /^Go to/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(entry("far-note")).getByRole("button", { name: /^Go to/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(entry("changed")).getByRole("button", { name: /^Go to/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("read-only offers Go to only and says why", () => {
    list({ annotations: [rec({ id: "a", body: "n" }), rec({ id: "b" })], readOnly: true });
    expect(screen.getAllByText(ANNOTATIONS_READ_ONLY)).toHaveLength(1);
    expect(ANNOTATIONS_READ_ONLY).toBe("This library is read-only, so highlights cannot be changed.");
    const enabled = screen.getAllByRole("button").filter((b) => !(b as HTMLButtonElement).disabled);
    expect(enabled.map((b) => b.textContent)).toEqual(["Go to", "Go to"]);
    // The others are there, disabled, not hidden.
    expect(screen.getAllByRole("button", { name: /^(Edit note|Add note|Colour|Delete)/ })).toHaveLength(6);
  });

  it("a list that could not be had says so in an alert and offers Try again", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    list({ annotations: [], loadError: "The library is busy.", onRetry });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(`${ANNOTATIONS_NOT_SHOWN}: The library is busy.`);
    expect(ANNOTATIONS_NOT_SHOWN).toBe("The highlights of this file could not be shown");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("a highlight chosen on the page marks its entry and scrolls the list to it, without taking the focus", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    const items = [rec({ id: "a" }), rec({ id: "b" })];
    const r = list({ annotations: items });
    r.rerender(<AnnotationList annotations={items} assetId="a1" readOnly={false} pageCount={20} selectedId="b" onJump={() => {}} onSaveNote={noop} onRecolour={noop} onDelete={noop} />);
    expect(entry("b").getAttribute("aria-current")).toBe("true");
    expect(entry("a").getAttribute("aria-current")).toBeNull();
    expect(entry("b").tabIndex).toBe(0);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("a late answer after the file changed, or after the list went, is dropped quietly", async () => {
    let release: () => void = () => {};
    let refuse: (e: Error) => void = () => {};
    const errors = vi.spyOn(console, "error");
    const user = userEvent.setup();
    const both = rec({ id: "a" });
    both.pdfAnchors.push({ id: "a-b", assetId: "a2", page: 1, rects: [{ x: 1, y: 1, w: 1, h: 1 }], sortIndex: "00000|000000|00000", sortIndexDerived: false });
    const onRecolour = vi.fn(() => new Promise<void>((res, rej) => ((release = res), (refuse = rej))));
    const props = { annotations: [both], readOnly: false, pageCount: 20, onJump: () => {}, onSaveNote: noop, onRecolour, onDelete: noop };
    const r = render(<AnnotationList assetId="a1" {...props} />);
    await user.click(within(entry("a")).getByRole("button", { name: /^Colour of/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Red" }));
    // The other file: the answer to the first file's change says nothing here, and blocks nothing.
    r.rerender(<AnnotationList assetId="a2" {...props} />);
    await act(async () => release());
    expect(live().textContent).toBe("");
    await user.click(within(entry("a")).getByRole("button", { name: /^Colour of/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Blue" }));
    expect(onRecolour).toHaveBeenCalledTimes(2);
    r.rerender(<AnnotationList assetId="a1" {...props} />);
    await act(async () => refuse(new Error("A refusal for the file before.")));
    expect(screen.queryByRole("alert")).toBeNull();
    r.unmount();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("10,000 entries: the DOM holds a window, the counts and positions are right, End reaches the last", async () => {
    expect(WINDOW_FROM).toBe(500);
    const many = Array.from({ length: 10_000 }, (_, i) => rec({ id: `n${i}`, page: 1 + Math.floor(i / 20), quote: `Quote ${i}` }));
    const onJump = vi.fn();
    const user = userEvent.setup();
    const r = list({ annotations: many, pageCount: 600, onJump });
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Annotations (10,000)");
    const shown = entries();
    expect(shown.length).toBeGreaterThan(5);
    expect(shown.length).toBeLessThan(120);
    expect(shown[0]!.getAttribute("aria-setsize")).toBe("10000");
    expect(shown[0]!.getAttribute("aria-posinset")).toBe("1");
    entry("n0").focus();
    await user.keyboard("{End}");
    await waitFor(() => expect(document.activeElement).toBe(entry("n9999")));
    expect(entry("n9999").getAttribute("aria-posinset")).toBe("10000");
    expect(entries().length).toBeLessThan(120);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(entry("n9998"));
    expect(entry("n9998").getAttribute("aria-posinset")).toBe("9999");
    await user.keyboard("{Enter}");
    expect(onJump).toHaveBeenCalledWith("n9998");
    await user.keyboard("{Home}");
    await waitFor(() => expect(document.activeElement).toBe(entry("n0")));
    // A highlight chosen on the page far down the list: its entry is brought into the window.
    r.rerender(<AnnotationList annotations={many} assetId="a1" readOnly={false} pageCount={600} selectedId="n4312" onJump={() => {}} onSaveNote={noop} onRecolour={noop} onDelete={noop} />);
    await waitFor(() => expect(entry("n4312")).toBeTruthy());
    expect(entry("n4312").getAttribute("aria-posinset")).toBe("4313");
    expect(entries().length).toBeLessThan(120);
    // Scrolling the list moves the window.
    const scroller = document.querySelector<HTMLElement>(".ao-ann-scroll")!;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(document.querySelector('[data-entry="n0"]')).not.toBeNull());
  });

  it("the colour menu's swatches are drawn by class, never by a style colour", async () => {
    const user = userEvent.setup();
    list({ annotations: [rec({ id: "a" })] });
    await user.click(within(entry("a")).getByRole("button", { name: /^Colour of/ }));
    const names: HighlightColourName[] = ["yellow", "red", "green", "blue", "purple", "magenta", "orange", "grey"];
    const swatches = [...screen.getByRole("menu").querySelectorAll<HTMLElement>(".ao-ann-swatch")];
    expect(swatches.map((s) => [...s.classList].find((c) => c.startsWith("ao-ann-swatch--")))).toEqual(names.map((n) => `ao-ann-swatch--${n}`));
    for (const s of swatches) expect(s.getAttribute("style")).toBeNull();
    expect(entry("a").querySelector(".ao-ann-swatch--yellow")).not.toBeNull();
  });
});

describe("AnnotationList, fix round 1 (A13, Ruling R216)", () => {
  const discardDialog = () => screen.getByRole("dialog", { name: "Discard this note?" });

  it("a changed note asks Discard this note? before Escape or Cancel abandon it; the dialog manages focus (R192 e, R145)", async () => {
    const answers: string[] = [];
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Outside</button>
        <Harness initial={[rec({ id: "a", body: "old note" })]} answer={(w) => void answers.push(w)} />
      </div>,
    );
    const edit = within(entry("a")).getByRole("button", { name: /^Edit note of/ });
    // Unchanged: Escape closes at once, no question.
    await user.click(edit);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    expect(document.activeElement).toBe(edit);
    // Changed, then Escape: the question.
    await user.click(edit);
    const area = screen.getByRole("textbox", { name: "Note" });
    await user.type(area, " and more");
    await user.keyboard("{Escape}");
    const dialog = discardDialog();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const [discard, keep] = [within(dialog).getByRole("button", { name: "Discard" }), within(dialog).getByRole("button", { name: "Keep editing" })];
    expect(document.activeElement).toBe(keep);
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(discard);
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(keep);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(discard);
    expect(screen.getByRole("button", { name: "Outside", hidden: true }).closest("[inert]")).not.toBeNull();
    // Keep editing: the text is still there, the focus back in it.
    await user.click(keep);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector("[inert]")).toBeNull();
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("old note and more");
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Note" }));
    // Escape in the question keeps editing too.
    await user.keyboard("{Escape}");
    expect(discardDialog()).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Note" }));
    // Cancel asks too; Discard abandons it: the old note, the focus on its button, nothing sent.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(within(discardDialog()).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    expect(entry("a").textContent).toContain("old note");
    expect(entry("a").textContent).not.toContain("and more");
    expect(document.activeElement).toBe(edit);
    expect(answers).toEqual([]);
  });

  it("leaving through the app's navigation with a changed note asks first; an unchanged note or a list that went asks nothing", async () => {
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
    const user = userEvent.setup();
    const r = render(<Harness initial={[rec({ id: "a", body: "old note" })]} />);
    await user.click(within(entry("a")).getByRole("button", { name: /^Edit note of/ }));
    // Unchanged: nothing holds the way out.
    act(() => navigate("/reader?project=p1&source=s1&asset=a2"));
    expect(window.location.search).toBe("?project=p1&source=s1&asset=a2");
    act(() => window.history.replaceState(null, "", "/reader?project=p1&source=s1"));
    await user.type(screen.getByRole("textbox", { name: "Note" }), "!");
    // The way out taken from elsewhere (the focus no longer in the note), as a link in another part of the app would be.
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => navigate("/"));
    expect(window.location.pathname).toBe("/reader");
    expect(document.activeElement).toBe(within(discardDialog()).getByRole("button", { name: "Keep editing" }));
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(window.location.pathname).toBe("/reader");
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("old note!");
    // "Keep editing" puts the focus back in the note (M-c).
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Note" })));
    act(() => navigate("/"));
    await user.click(within(discardDialog()).getByRole("button", { name: "Discard" }));
    expect(window.location.pathname).toBe("/");
    // A list that goes (the reader ended) with a changed draft asks nothing and holds nothing.
    act(() => window.history.replaceState(null, "", "/reader?project=p1&source=s1"));
    await user.click(within(entry("a")).getByRole("button", { name: /^Edit note of/ }));
    await user.type(screen.getByRole("textbox", { name: "Note" }), "?");
    r.unmount();
    act(() => navigate("/"));
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("dialog")).toBeNull();
    window.history.replaceState(null, "", "/");
  });

  it("while a save is pending the entry's other controls are disabled and it says Saving…; recolour and delete pressed meanwhile do nothing unseen", async () => {
    let release: () => void = () => {};
    const answers: string[] = [];
    const user = userEvent.setup();
    render(
      <Harness
        initial={[rec({ id: "a", body: "old" }), rec({ id: "b" })]}
        answer={(w) => {
          answers.push(w);
          if (w.startsWith("note")) return new Promise<void>((r) => (release = r));
        }}
      />,
    );
    await user.click(within(entry("a")).getByRole("button", { name: /^Edit note of/ }));
    await user.type(screen.getByRole("textbox", { name: "Note" }), " new");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    expect(entry("a").textContent).toContain("Saving…");
    expect(live().textContent).toBe("Saving…");
    const colour = within(entry("a")).getByRole("button", { name: /^Colour of/ });
    const del = within(entry("a")).getByRole("button", { name: /^Delete/ });
    expect(colour.getAttribute("aria-disabled")).toBe("true");
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Save note" }).getAttribute("aria-disabled")).toBe("true");
    await user.click(colour);
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(del);
    expect(screen.queryByRole("dialog")).toBeNull();
    // The other entries stay usable.
    expect(within(entry("b")).getByRole("button", { name: /^Colour of/ }).getAttribute("aria-disabled")).toBeNull();
    await act(async () => release());
    await waitFor(() => expect(live().textContent).toBe("Note saved."));
    expect(entry("a").textContent).not.toContain("Saving…");
    expect(within(entry("a")).getByRole("button", { name: /^Colour of/ }).getAttribute("aria-disabled")).toBeNull();
    expect(answers).toEqual([`note a "old new"`]);
  });

  it("a save answered after a newer draft was begun keeps the newer draft", async () => {
    let release: () => void = () => {};
    const user = userEvent.setup();
    render(<Harness initial={[rec({ id: "a", body: "old" })]} answer={() => new Promise<void>((r) => (release = r))} />);
    await user.click(within(entry("a")).getByRole("button", { name: /^Edit note of/ }));
    const area = screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
    await user.clear(area);
    await user.type(area, "first");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    // Typing on while it is on its way.
    await user.type(area, " and second");
    await act(async () => release());
    await waitFor(() => expect(live().textContent).toBe("Note saved."));
    const still = screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
    expect(still.value).toBe("first and second");
    expect(screen.getByRole("button", { name: "Save note" }).getAttribute("aria-disabled")).toBeNull();
    // The draft is changed against what was saved: leaving it asks.
    await user.keyboard("{Escape}");
    expect(discardDialog()).toBeTruthy();
  });

  it("an annotation on another file of the source (a PDF or an EPUB) is read only there, with no Delete and no sentence of a lost place; only one with no anchor is Not placed on a page (A13)", () => {
    list({
      annotations: [
        rec({ id: "here" }),
        rec({ id: "epub", pdfAnchors: [], otherAnchorKinds: ["epub-cfi"], quote: "an EPUB passage", imported: true }),
        rec({ id: "pdf2", assetId: "a2", page: 4 }),
        rec({ id: "none", pdfAnchors: [], otherAnchorKinds: [], quote: "a place lost" }),
      ],
    });
    const other = screen.getByRole("list", { name: "On another file of this source (2)" });
    for (const id of ["epub", "pdf2"]) {
      const e = entry(id);
      expect(other.contains(e)).toBe(true);
      expect(e.textContent).not.toContain(PLACE_UNKNOWN);
      expect(within(e).queryByRole("button", { name: /^Delete/ })).toBeNull();
      for (const b of within(e).getAllByRole("button")) expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    expect(within(entry("epub")).getByRole("button", { name: /^Go to/ }).getAttribute("aria-label")).toMatch(/^Go to yellow highlight on another file/);
    const nowhere = screen.getByRole("list", { name: "Not placed on a page (1)" });
    expect(nowhere.contains(entry("none"))).toBe(true);
    expect(entry("none").textContent).toContain(PLACE_UNKNOWN);
  });

  it("the list sorts itself by R1's rule, over the anchors on the file being read (A13)", () => {
    const at = (id: string, page: number, sortIndex: string, assetId = "a1") => ({ id: `${id}-${assetId}`, assetId, page, rects: [{ x: 50, y: 700, w: 10, h: 10 }], sortIndex, sortIndexDerived: false });
    const p5 = rec({ id: "p5", pdfAnchors: [at("p5", 5, "00004|000000|00100")] });
    const p1b = rec({ id: "p1b", pdfAnchors: [at("p1b", 1, "00000|000500|00100")] });
    const p1a = rec({ id: "p1a", pdfAnchors: [at("p1a", 1, "00000|000010|00100")] });
    // On page 1 of another file and page 3 of this one: the service puts it after page 5 of this file.
    const two = rec({ id: "two", pdfAnchors: [at("two", 1, "00000|000000|00000", "a2"), at("two", 3, "00002|000000|00100")] });
    list({ annotations: [p5, p1b, p1a, two] });
    expect(entries().map((e) => e.dataset.entry)).toEqual(["p1a", "p1b", "two", "p5"]);
    expect(entry("two").textContent).toContain("Page 3");
  });

  it("a change answered 'no longer there' says so for the list, which the screen brings up to date", async () => {
    const user = userEvent.setup();
    list({ annotations: [rec({ id: "a" }), rec({ id: "b" })], onRecolour: () => Promise.reject(new ListBroughtUpToDate()) });
    expect(LIST_BROUGHT_UP_TO_DATE).toBe("That highlight or note was no longer there. The list has been brought up to date.");
    await user.click(within(entry("a")).getByRole("button", { name: /^Colour of/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Red" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(LIST_BROUGHT_UP_TO_DATE);
    expect(entry("a").contains(alert)).toBe(false);
  });

  it("the window's arithmetic: offsets from measured heights, and the entries in view", () => {
    expect(offsetsOf([10, 20, 30])).toEqual([0, 10, 30, 60]);
    const offsets = offsetsOf([100, 400, 100, 100, 100, 100]);
    // A view of 150 px from 50: entries 0 and 1 (0-100, 100-500), with no overscan.
    expect(windowOf(offsets, 50, 150, 0)).toEqual([0, 2]);
    // From 520: entries 2 (500-600) and 3 (600-700).
    expect(windowOf(offsets, 520, 150, 0)).toEqual([2, 4]);
    expect(windowOf(offsets, 520, 150, 1)).toEqual([1, 5]);
    // Past the end, and before the start.
    expect(windowOf(offsets, 5000, 150, 2)).toEqual([4, 6]);
    expect(windowOf(offsets, -100, 50, 0)).toEqual([0, 0]);
  });

  it("past 500, an entry has its own measured height: nothing is cut off, the next one starts below it", async () => {
    // Ids that sort in their order (same page, no stored index: the order falls to the id).
    const many = Array.from({ length: 600 }, (_, i) => rec({ id: `n${String(i).padStart(3, "0")}`, quote: `Quote ${i}` }));
    // Heights as a browser would measure them: entry 1 is tall (a long note).
    const spy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.entry === "n001" ? 900 : this.dataset.entry ? 120 : 0;
    });
    list({ annotations: many });
    await waitFor(() => expect(entry("n002").style.top).toBe("1020px"));
    expect(entry("n001").style.top).toBe("120px");
    expect(entry("n001").style.height).toBe("");
    expect(getComputedStyle(entry("n001")).overflow).not.toBe("hidden");
    spy.mockRestore();
  });
});

describe("AnnotationList, fix round 2", () => {
  const discardDialog = () => screen.queryByRole("dialog", { name: "Discard this note?" });
  /** Whether the way out is free: in-app navigation goes, a reload is not held, and nothing is asked. */
  function expectFree() {
    act(() => navigate("/elsewhere"));
    expect(window.location.pathname).toBe("/elsewhere");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    expect(discardDialog()).toBeNull();
    window.history.replaceState(null, "", "/reader?project=p1&source=s1");
  }
  /** Opens the note of entry `id` and changes it: the way out is held. */
  async function changeNote(user: ReturnType<typeof userEvent.setup>, id: string) {
    await user.click(within(entry(id)).getByRole("button", { name: /^(Edit|Add) note/ }));
    await user.type(screen.getByRole("textbox", { name: "Note" }), " changed");
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
  }
  beforeEach(() => window.history.replaceState(null, "", "/reader?project=p1&source=s1"));
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("I5: the entry being edited deleted by its own Delete frees the way out", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[rec({ id: "a", body: "old" }), rec({ id: "b" })]} />);
    await changeNote(user, "a");
    await user.click(within(entry("a")).getByRole("button", { name: /^Delete/ }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(document.querySelector('[data-entry="a"]')).toBeNull());
    expectFree();
  });

  it("I5: the entry being edited gone from a list fetched again (deleted elsewhere, a 404) frees the way out", async () => {
    const user = userEvent.setup();
    const both = [rec({ id: "a", body: "old" }), rec({ id: "b" })];
    const props = { assetId: "a1", readOnly: false, pageCount: 20, onJump: () => {}, onSaveNote: () => Promise.reject(new ListBroughtUpToDate()), onRecolour: noop, onDelete: noop };
    const r = render(<AnnotationList annotations={both} {...props} />);
    await changeNote(user, "a");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    await screen.findByText(LIST_BROUGHT_UP_TO_DATE);
    // The list as the service now gives it: without "a".
    r.rerender(<AnnotationList annotations={[both[1]!]} {...props} />);
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    expectFree();
    // And if it came back, its editor does not reopen with the lost text.
    r.rerender(<AnnotationList annotations={both} {...props} />);
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
  });

  it("I5: a change of file frees the way out", async () => {
    const user = userEvent.setup();
    const list = [rec({ id: "a", body: "old" })];
    const props = { annotations: list, readOnly: false, pageCount: 20, onJump: () => {}, onSaveNote: noop, onRecolour: noop, onDelete: noop };
    const r = render(<AnnotationList assetId="a1" {...props} />);
    await changeNote(user, "a");
    r.rerender(<AnnotationList assetId="a2" {...props} />);
    expectFree();
  });

  it("I5: the list going (the reader ended) frees the way out", async () => {
    const user = userEvent.setup();
    const r = render(<Harness initial={[rec({ id: "a", body: "old" })]} />);
    await changeNote(user, "a");
    r.unmount();
    expectFree();
  });

  it("Back and Forward are held for a changed note, as the transcript holds unsaved edits; Discard then goes where Back went", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[rec({ id: "a", body: "old" })]} />);
    await changeNote(user, "a");
    // Back from the browser: the address it lands on is put back, and the question is asked.
    act(() => {
      window.history.replaceState(null, "", "/?project=p1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(window.location.pathname).toBe("/reader");
    expect(window.location.search).toBe("?project=p1&source=s1");
    expect(document.activeElement).toBe(within(discardDialog()!).getByRole("button", { name: "Keep editing" }));
    await user.click(within(discardDialog()!).getByRole("button", { name: "Keep editing" }));
    expect(window.location.pathname).toBe("/reader");
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("old changed");
    act(() => {
      window.history.replaceState(null, "", "/?project=p1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await user.click(within(discardDialog()!).getByRole("button", { name: "Discard" }));
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).toBe("?project=p1");
  });

  it("Escape during a pending save says why nothing happens", async () => {
    let release: () => void = () => {};
    const user = userEvent.setup();
    render(<Harness initial={[rec({ id: "a", body: "old" })]} answer={() => new Promise<void>((r) => (release = r))} />);
    await user.click(within(entry("a")).getByRole("button", { name: /^Edit note of/ }));
    await user.type(screen.getByRole("textbox", { name: "Note" }), " new");
    await user.click(screen.getByRole("button", { name: "Save note" }));
    expect(live().textContent).toBe("Saving…");
    const before = live().firstElementChild;
    await user.click(screen.getByRole("textbox", { name: "Note" }));
    await user.keyboard("{Escape}");
    expect(live().textContent).toBe("The note is being saved. It can be closed once it is saved.");
    expect(live().firstElementChild).not.toBe(before);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(live().textContent).toBe("The note is being saved. It can be closed once it is saved.");
    await act(async () => release());
    await waitFor(() => expect(live().textContent).toBe("Note saved."));
  });

  it("a height measured late above the view keeps the entries in view where they were (the list does not jump)", async () => {
    const many = Array.from({ length: 600 }, (_, i) => rec({ id: `n${String(i).padStart(3, "0")}`, quote: `Quote ${i}` }));
    let tall = "";
    const spy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.dataset.entry ? (this.dataset.entry === tall ? 416 : 136) : 0;
    });
    list({ annotations: many });
    const scroller = document.querySelector<HTMLElement>(".ao-ann-scroll")!;
    act(() => {
      scroller.scrollTop = 300 * 136;
      fireEvent.scroll(scroller);
    });
    await waitFor(() => expect(entry("n300").style.top).toBe("40800px"));
    const at = () => parseFloat(entry("n300").style.top) - scroller.scrollTop;
    expect(at()).toBe(0);
    // An entry above the view grows (an alert, larger text) and is measured again.
    tall = "n297";
    act(() => fireEvent.scroll(scroller));
    await waitFor(() => expect(entry("n300").style.top).toBe("41080px"));
    expect(at()).toBe(0);
    spy.mockRestore();
  });
});
