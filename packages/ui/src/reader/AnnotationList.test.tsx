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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnnotationRecord, HighlightColourName } from "../api/reader";
import {
  ANNOTATIONS_NOT_SHOWN,
  ANNOTATIONS_READ_ONLY,
  AnnotationList,
  AnswerDropped,
  HIGHLIGHT_CHANGED_SENTENCE,
  missingNoteSentence,
  missingPageSentence,
  PLACE_UNKNOWN,
  WINDOW_FROM,
  type AnnotationListProps,
} from "./AnnotationList";

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
    expect(first.textContent).toContain("Ngozi Okafor");
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
    await user.click(colour);
    await user.click(screen.getByRole("menuitemradio", { name: "Blue" }));
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
    // Escape restores what was there; nothing is sent.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    expect(entry("a").textContent).toContain("old note");
    expect(entry("a").textContent).not.toContain("and more");
    expect(document.activeElement).toBe(edit);
    await user.click(edit);
    expect((screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement).value).toBe("old note");
    // Cancel too.
    await user.type(screen.getByRole("textbox", { name: "Note" }), "!");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
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

  it("a late answer after the list went is dropped quietly", async () => {
    let release: () => void = () => {};
    const errors = vi.spyOn(console, "error");
    const user = userEvent.setup();
    const r = list({ annotations: [rec({ id: "a" })], onRecolour: () => new Promise<void>((res) => (release = res)) });
    await user.click(within(entry("a")).getByRole("button", { name: /^Colour of/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "Red" }));
    r.unmount();
    await act(async () => release());
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
