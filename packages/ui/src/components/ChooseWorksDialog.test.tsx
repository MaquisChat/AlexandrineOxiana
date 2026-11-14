/**
 * "Choose works" (Task F9; R145, R267, R271): one person's works, read from the entry's `options` when the dialog
 * opens, newest first, as checkboxes — title, year, kind and where published, through UserText; a work already added
 * from this entry is "Added" and cannot be ticked; the filters narrow the list on the screen only, and a status line
 * counts what is shown; ticks survive a filter; at most 50 at a time. Keyboard: the list is ONE tab stop (a roving
 * tab stop over the checkboxes: the arrow keys move between works, Space ticks), so a list of 200 works never puts 200
 * stops between the filters and the buttons.
 */
import type { FindChosenPerson, FindEntryView, FindPersonWork, FindSourceType } from "@ao/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChooseWorksDialog } from "./ChooseWorksDialog";

const work = (o: Partial<FindPersonWork> & { id: string; title: string }): FindPersonWork => ({
  creators: [{ family: "Stark", role: "author" }],
  issued: "2015",
  type: "article-journal",
  identifiers: {},
  providers: ["openalex"],
  ...o,
});

/** David Stark's works as OpenAlex lists them (true titles, years, kinds and venues), newest first. */
const WORKS: FindPersonWork[] = [
  work({ id: "W3015927993", title: "Put to the test: For a new sociology of testing", issued: "2020-04-19", container: "British Journal of Sociology" }),
  work({ id: "W2621405455", title: "For What It’s Worth", issued: "2017-06-01", type: "chapter", container: "Research in the sociology of organizations" }),
  work({ id: "W2038217319", title: "Game Changer: The Topology of Creativity", issued: "2015-01-01", container: "American Journal of Sociology", added: true }),
  work({ id: "W1902009078", title: "Structural Folds: Generative Disruption in Overlapping Groups", issued: "2010-01-01", container: "American Journal of Sociology" }),
  work({ id: "W2588831772", title: "The Sense of Dissonance: Accounts of Worth in Economic Life", issued: "2009-12-31", type: "book", container: "Princeton University Press eBooks" }),
  work({ id: "W2144414458", title: "How to Recognize Opportunities: Heterarchical Search in a Trading Room", issued: "2004-10-14", type: "chapter", container: "Oxford University Press eBooks" }),
  work({ id: "W2065401570", title: "Recombinant Property in East European Capitalism", issued: "1996-01-01", container: "American Journal of Sociology" }),
  work({ id: "W2332360861", title: "Redistributive Injustice", issued: "1985-07-01", type: "other", container: "Contemporary Sociology A Journal of Reviews" }),
];
const PERSON: FindChosenPerson = { name: "David Stark", subjects: ["Post-Communist Economic and Political Transition", "Management and Organizational Studies"] };

const ENTRY: FindEntryView = {
  id: "0190a000-0000-7000-8000-0000000000e1",
  projectId: "0190a000-0000-7000-8000-0000000000a1",
  typed: "David Stark",
  state: "choose-works",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:01.000Z",
  attempts: 1,
  peopleCount: 1,
  worksCount: 8,
  addedCount: 1,
  chosen: "A5055013655",
};

type HarnessProps = { entry?: FindEntryView; works?: FindPersonWork[]; person?: FindChosenPerson; onAdd?: (ids: string[]) => void; busy?: boolean; error?: string; loadError?: string };

function Harness(props: HarnessProps) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Choose works
      </button>
      {open && (
        <ChooseWorksDialog
          entry={props.entry ?? ENTRY}
          {...(props.loadError === undefined ? { works: props.works ?? WORKS, person: props.person ?? PERSON } : { loadError: props.loadError })}
          onAdd={(ids) => props.onAdd?.(ids)}
          onClose={() => setOpen(false)}
          {...(props.busy !== undefined ? { busy: props.busy } : {})}
          {...(props.error !== undefined ? { error: props.error } : {})}
        />
      )}
    </main>
  );
}

async function openIt(p: HarnessProps = {}) {
  const user = userEvent.setup();
  const view = render(<Harness {...p} />);
  const opener = screen.getByRole("button", { name: "Choose works" });
  await user.click(opener);
  const dialog = await screen.findByRole("dialog");
  return { user, opener, dialog, view };
}

const boxes = (dialog: HTMLElement) => within(dialog).queryAllByRole("checkbox") as HTMLInputElement[];
const titleOf = (cb: HTMLElement) => cb.closest("li")!.querySelector(".ao-find__candidate-title")!.textContent;
const countLine = (dialog: HTMLElement) => within(dialog).getByRole("status").textContent;

describe("ChooseWorksDialog", () => {
  it("names the person; the works newest first, each with title, year, kind and where published, through UserText", async () => {
    const { dialog } = await openIt();
    expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe("Choose works by David Stark");
    expect(dialog.textContent).toContain("Works on: Post-Communist Economic and Political Transition, Management and Organizational Studies");
    const cbs = boxes(dialog);
    expect(cbs).toHaveLength(8);
    expect(cbs.map(titleOf)).toEqual(WORKS.map((w) => w.title));
    const first = cbs[0]!.closest("li")!;
    expect(first.textContent).toContain("2020");
    expect(first.textContent).toContain("Journal article");
    expect(first.textContent).toContain("British Journal of Sociology");
    expect(cbs[4]!.closest("li")!.textContent).toContain("Book");
    for (const t of ["Put to the test: For a new sociology of testing", "British Journal of Sociology", "David Stark"]) {
      const el = within(dialog)
        .getAllByText(t, { exact: false })
        .find((e) => e.getAttribute("dir") === "auto");
      expect(el, t).toBeTruthy();
    }
    // Each checkbox is named by its work's title.
    expect(within(dialog).getByRole("checkbox", { name: /^Structural Folds/ })).toBe(cbs[3]);
    expect(countLine(dialog)).toBe("8 of 8 works shown");
  });

  it("a work already added from this entry is shown as Added and cannot be ticked", async () => {
    const onAdd = vi.fn();
    const { user, dialog } = await openIt({ onAdd });
    const added = within(dialog).getByRole("checkbox", { name: /^Game Changer/ }) as HTMLInputElement;
    expect(added.closest("li")!.textContent).toContain("Added");
    expect(added.getAttribute("aria-disabled")).toBe("true");
    await user.click(added);
    expect(added.checked).toBe(false);
    added.focus();
    await user.keyboard(" ");
    expect(added.checked).toBe(false);
    expect((within(dialog).getByRole("button", { name: "Add the chosen works (0)" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("filters narrow the list and the count is said: From year, To year, Kind and Filter by words, on the screen only", async () => {
    const { user, dialog } = await openIt();
    await user.type(within(dialog).getByRole("textbox", { name: "From year" }), "2010");
    expect(boxes(dialog).map(titleOf)).toEqual(WORKS.slice(0, 4).map((w) => w.title));
    expect(countLine(dialog)).toBe("4 of 8 works shown");
    await user.type(within(dialog).getByRole("textbox", { name: "To year" }), "2016");
    expect(boxes(dialog).map(titleOf)).toEqual(["Game Changer: The Topology of Creativity", "Structural Folds: Generative Disruption in Overlapping Groups"]);
    await user.clear(within(dialog).getByRole("textbox", { name: "From year" }));
    await user.clear(within(dialog).getByRole("textbox", { name: "To year" }));
    const kind = within(dialog).getByRole("combobox", { name: "Kind" }) as HTMLSelectElement;
    expect([...kind.options].map((o) => o.text)).toEqual(["Any", "Article", "Book", "Chapter", "Other"]);
    await user.selectOptions(kind, "Chapter");
    expect(boxes(dialog).map(titleOf)).toEqual(["For What It’s Worth", "How to Recognize Opportunities: Heterarchical Search in a Trading Room"]);
    await user.selectOptions(kind, "Book");
    expect(boxes(dialog).map(titleOf)).toEqual(["The Sense of Dissonance: Accounts of Worth in Economic Life"]);
    expect(countLine(dialog)).toBe("1 of 8 works shown");
    await user.selectOptions(kind, "Other");
    expect(boxes(dialog).map(titleOf)).toEqual(["Redistributive Injustice"]);
    await user.selectOptions(kind, "Article");
    expect(boxes(dialog)).toHaveLength(4);
    await user.selectOptions(kind, "Any");
    // Words: every word must be found (title or where published), without regard to case or accents.
    await user.type(within(dialog).getByRole("textbox", { name: "Filter by words" }), "AMERICAN journal");
    expect(boxes(dialog).map(titleOf)).toEqual(["Game Changer: The Topology of Creativity", "Structural Folds: Generative Disruption in Overlapping Groups", "Recombinant Property in East European Capitalism"]);
    await user.clear(within(dialog).getByRole("textbox", { name: "Filter by words" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Filter by words" }), "worth");
    expect(boxes(dialog)).toHaveLength(2);
    await user.clear(within(dialog).getByRole("textbox", { name: "Filter by words" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Filter by words" }), "nothing like this");
    expect(boxes(dialog)).toHaveLength(0);
    expect(countLine(dialog)).toBe("0 of 8 works shown");
  });

  it("ticks survive a change of filter: a ticked work hidden by a filter stays ticked and is counted in the button", async () => {
    const onAdd = vi.fn();
    const { user, dialog } = await openIt({ onAdd });
    await user.click(within(dialog).getByRole("checkbox", { name: /^The Sense of Dissonance/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /^Put to the test/ }));
    await user.type(within(dialog).getByRole("textbox", { name: "From year" }), "2015");
    expect(within(dialog).queryByRole("checkbox", { name: /^The Sense of Dissonance/ })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Add the chosen works (2)" })).toBeTruthy();
    expect(dialog.textContent).toContain("1 chosen work is not shown by these filters.");
    await user.click(within(dialog).getByRole("checkbox", { name: /^For What/ }));
    await user.clear(within(dialog).getByRole("textbox", { name: "From year" }));
    expect((within(dialog).getByRole("checkbox", { name: /^The Sense of Dissonance/ }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Add the chosen works (3)" }));
    // In the list's order (newest first), whatever order they were ticked in.
    expect(onAdd).toHaveBeenCalledWith(["W3015927993", "W2621405455", "W2588831772"]);
  });

  it("the 51st tick is refused with the sentence, and the tick does not stay", async () => {
    const many = Array.from({ length: 60 }, (_, i) => work({ id: `W${1000 + i}`, title: `Work number ${i + 1}`, issued: String(2020 - i) }));
    const { user, dialog } = await openIt({ works: many, entry: { ...ENTRY, worksCount: 60, addedCount: undefined } as FindEntryView });
    const cbs = boxes(dialog);
    for (let i = 0; i < 50; i++) fireEvent.click(cbs[i]!);
    expect(within(dialog).getByRole("button", { name: "Add the chosen works (50)" })).toBeTruthy();
    expect(within(dialog).queryByText("Choose at most 50 at a time.")).toBeNull();
    await user.click(cbs[50]!);
    expect(cbs[50]!.checked).toBe(false);
    expect(within(dialog).getByRole("alert").textContent).toBe("Choose at most 50 at a time.");
    expect(within(dialog).getByRole("button", { name: "Add the chosen works (50)" })).toBeTruthy();
    // One untick makes room again.
    await user.click(cbs[0]!);
    await user.click(cbs[50]!);
    expect(cbs[50]!.checked).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Add the chosen works (50)" })).toBeTruthy();
  });

  it("the list is one tab stop; the arrows move between works, Home and End to the ends; Space ticks", async () => {
    const { user, dialog } = await openIt();
    const from = within(dialog).getByRole("textbox", { name: "From year" });
    const to = within(dialog).getByRole("textbox", { name: "To year" });
    const kind = within(dialog).getByRole("combobox", { name: "Kind" });
    const words = within(dialog).getByRole("textbox", { name: "Filter by words" });
    const cbs = boxes(dialog);
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(from);
    await user.tab();
    expect(document.activeElement).toBe(to);
    await user.tab();
    expect(document.activeElement).toBe(kind);
    await user.tab();
    expect(document.activeElement).toBe(words);
    // ONE stop for the list.
    await user.tab();
    expect(document.activeElement).toBe(cbs[0]);
    expect(cbs.filter((c) => c.tabIndex === 0)).toHaveLength(1);
    // Nothing ticked: "Add" is disabled, so the next stop is Cancel.
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cbs[0]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(cbs[1]);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(document.activeElement).toBe(cbs[3]);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(cbs[2]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(cbs[7]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(cbs[0]);
    await user.keyboard("{ArrowDown}");
    await user.keyboard(" ");
    expect(cbs[1]!.checked).toBe(true);
    // The stop is the work last moved to.
    expect(cbs.filter((c) => c.tabIndex === 0)).toEqual([cbs[1]]);
    const add = within(dialog).getByRole("button", { name: "Add the chosen works (1)" });
    await user.tab();
    expect(document.activeElement).toBe(add);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    // Wraps at either end.
    await user.tab();
    expect(document.activeElement).toBe(from);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(add);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cbs[1]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(words);
  });

  it("focus on open, Tab, Shift+Tab, Escape and after close (R145)", async () => {
    const { user, opener, dialog } = await openIt();
    const from = within(dialog).getByRole("textbox", { name: "From year" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(from);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(from);
    expect(opener.closest("[inert]")).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(opener.closest("[inert]")).toBeNull();
    await user.click(opener);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("while the works are read the dialog says so; More works exist than are listed here when the entry says so; a refusal in the service's words; busy ignores a press", async () => {
    function Loading() {
      return <ChooseWorksDialog entry={{ ...ENTRY, moreWorks: true }} onAdd={() => {}} onClose={() => {}} />;
    }
    const view = render(<Loading />);
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Reading this person's works…")).toBeTruthy();
    expect(within(dialog).getByRole("heading", { level: 2 }).textContent).toBe("Choose works for “David Stark”");
    expect(dialog.textContent).toContain("More works exist than are listed here.");
    view.unmount();
    const second = await openIt();
    expect(second.dialog.textContent).not.toContain("More works exist than are listed here.");
    second.view.unmount();
    const onAdd = vi.fn();
    const busy = await openIt({ onAdd, busy: true, error: "The queue holds 500 entries. Remove some finished ones first." });
    dialog = busy.dialog;
    fireEvent.click(boxes(dialog)[0]!);
    const add = within(dialog).getByRole("button", { name: /Add the chosen works|Adding/ });
    expect(add.getAttribute("aria-busy")).toBe("true");
    await busy.user.click(add);
    expect(onAdd).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert").textContent).toBe("The queue holds 500 entries. Remove some finished ones first.");
  });

  it("200 works stay usable: rendered once, a tick re-renders quickly (measured), and the list is still one stop", async () => {
    const kinds: FindSourceType[] = ["article-journal", "book", "chapter", "other"];
    const many = Array.from({ length: 200 }, (_, i) =>
      work({ id: `W${10_000 + i}`, title: `Ethnographic fieldwork notes, part ${i + 1} — ${"long title words ".repeat(8)}`, issued: `${2025 - Math.floor(i / 4)}-01-01`, type: kinds[i % 4]!, container: `Journal of Things ${i}` }),
    );
    const commits: Array<{ phase: string; ms: number }> = [];
    const user = userEvent.setup();
    const t0 = performance.now();
    render(
      <Profiler id="works" onRender={(_id, phase, ms) => commits.push({ phase, ms })}>
        <ChooseWorksDialog entry={{ ...ENTRY, worksCount: 200, addedCount: undefined } as FindEntryView} works={many} person={PERSON} onAdd={() => {}} onClose={() => {}} />
      </Profiler>,
    );
    const dialog = await screen.findByRole("dialog");
    const mounted = performance.now() - t0;
    expect(boxes(dialog)).toHaveLength(200);
    expect(boxes(dialog).filter((c) => c.tabIndex === 0)).toHaveLength(1);
    const before = commits.length;
    const t1 = performance.now();
    await user.click(boxes(dialog)[100]!);
    const ticked = performance.now() - t1;
    expect(boxes(dialog)[100]!.checked).toBe(true);
    const tickCommits = commits.slice(before);
    // Reported, not a limit (R173: no timing limit on a loaded machine).
    console.info(`[F9 measure] 200 works: mount ${mounted.toFixed(0)} ms (first commit ${commits[0]!.ms.toFixed(0)} ms); a tick ${ticked.toFixed(0)} ms wall, commits ${tickCommits.map((c) => c.ms.toFixed(1)).join(", ")} ms`);
    expect(tickCommits.length).toBeGreaterThan(0);
  });
});
