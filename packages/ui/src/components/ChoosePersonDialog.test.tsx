/**
 * "Choose the person" (Task F9; R145, R267, R270, R271): the people an author's name may mean, read from the entry's
 * `options` when the dialog opens, as a radio group — name, affiliation, the subjects they work on and how many works
 * — all outside text through UserText; "This is the person" and "Cancel"; focus moves in, is trapped (Tab and
 * Shift+Tab), and returns to the control that opened it; the background is inert.
 */
import type { FindEntryView, FindPersonCandidate } from "@ao/shared";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChoosePersonDialog } from "./ChoosePersonDialog";

const person = (o: Partial<FindPersonCandidate> & { id: string; name: string }): FindPersonCandidate => ({ worksCount: 10, subjects: [], ...o });

const PEOPLE: FindPersonCandidate[] = [
  person({ id: "A5055013655", name: "David Stark", worksCount: 160, subjects: ["Post-Communist Economic and Political Transition", "Eastern European Communism and Reforms", "Management and Organizational Studies"] }),
  person({ id: "A5108208998", name: "David Stark", affiliation: "The People of the United Methodist Church", worksCount: 46, subjects: ["Colonialism, slavery, and trade"] }),
  person({ id: "A5126427330", name: "Đặng Thị Thu Hà", affiliation: "Université de Montréal", worksCount: 1, subjects: [] }),
];

const ENTRY: FindEntryView = {
  id: "0190a000-0000-7000-8000-0000000000e1",
  projectId: "0190a000-0000-7000-8000-0000000000a1",
  typed: "David Stark",
  state: "choose-person",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:01.000Z",
  attempts: 1,
  peopleCount: 3,
};

type HarnessProps = { entry?: FindEntryView; people?: FindPersonCandidate[] | undefined; loadError?: string; onChoose?: (id: string) => void; busy?: boolean; error?: string };

function Harness(props: HarnessProps & { loaded?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Choose the person
      </button>
      <button type="button">Something else</button>
      {open && (
        <ChoosePersonDialog
          entry={props.entry ?? ENTRY}
          {...("people" in props ? (props.people ? { people: props.people } : {}) : { people: PEOPLE })}
          {...(props.loadError !== undefined ? { loadError: props.loadError } : {})}
          onChoose={(id) => props.onChoose?.(id)}
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
  const opener = screen.getByRole("button", { name: "Choose the person" });
  await user.click(opener);
  const dialog = await screen.findByRole("dialog");
  return { user, opener, dialog, view };
}

describe("ChoosePersonDialog", () => {
  it("focus on open, Tab, Shift+Tab, Escape and after close (R145)", async () => {
    const { user, opener, dialog } = await openIt();
    const radios = within(dialog).getAllByRole("radio");
    const yes = within(dialog).getByRole("button", { name: "This is the person" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    // On open: the first person.
    expect(document.activeElement).toBe(radios[0]);
    // Nothing chosen: "This is the person" is not a stop; Tab goes to Cancel, then wraps to the group.
    expect((yes as HTMLButtonElement).disabled).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(radios[0]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);
    // Choose the second: the group's stop is the chosen radio.
    await user.click(radios[1]!);
    expect((yes as HTMLButtonElement).disabled).toBe(false);
    await user.tab();
    expect(document.activeElement).toBe(yes);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(radios[1]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(yes);
    // The background is inert while it is open.
    expect(opener.closest("[inert]")).not.toBeNull();
    // Escape closes it without a choice; focus is back on the opener.
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(opener.closest("[inert]")).toBeNull();
    // Cancel too.
    await user.click(opener);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("while the people are read, the dialog says so and focus is on Cancel; when they come, focus moves to the first person", async () => {
    function Loading() {
      const [people, setPeople] = useState<FindPersonCandidate[] | undefined>();
      return (
        <main>
          <button type="button" onClick={() => setPeople(PEOPLE)}>
            Load
          </button>
          <ChoosePersonDialog entry={ENTRY} {...(people ? { people } : {})} onChoose={() => {}} onClose={() => {}} />
        </main>
      );
    }
    render(<Loading />);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Reading the people of this name…")).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    act(() => (screen.getByRole("button", { name: "Load", hidden: true }) as HTMLButtonElement).click());
    expect(within(dialog).queryByText("Reading the people of this name…")).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getAllByRole("radio")[0]);
  });

  it("subjects, affiliation and works count shown; no sample titles; each person is a radio named by the name", async () => {
    const { dialog } = await openIt();
    const group = within(dialog).getByRole("radiogroup");
    const items = within(group).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain("David Stark");
    expect(items[0]!.textContent).toContain("Works on: Post-Communist Economic and Political Transition, Eastern European Communism and Reforms, Management and Organizational Studies");
    expect(items[0]!.textContent).toContain("160 works");
    expect(items[1]!.textContent).toContain("The People of the United Methodist Church");
    expect(items[1]!.textContent).toContain("Works on: Colonialism, slavery, and trade");
    expect(items[1]!.textContent).toContain("46 works");
    // No subjects: no "Works on" line; one work in the singular.
    expect(items[2]!.textContent).not.toContain("Works on");
    expect(items[2]!.textContent).toContain("1 work");
    expect(items[2]!.textContent).not.toContain("1 works");
    // No sample titles: nothing but these lines.
    expect(dialog.textContent).not.toMatch(/Sample|titles/i);
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("value"))).toEqual(PEOPLE.map((p) => p.id));
    expect(within(group).getAllByRole("radio", { name: "David Stark" })).toHaveLength(2);
    // Described by the details, so the two of one name can be told apart.
    expect(radios[1]!.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(radios[1]!.getAttribute("aria-describedby")!)!.textContent).toContain("The People of the United Methodist Church");
  });

  it("affiliations render through UserText: diacritics, right-to-left scripts, and 200-character names that wrap", async () => {
    const long = "Ó".repeat(200);
    const people = [
      person({ id: "A1", name: "Đặng Thị Thu Hà", affiliation: "École des hautes études en sciences sociales", subjects: ["Sociologie économique"] }),
      person({ id: "A2", name: "ابن خلدون", affiliation: "جامعة القرويين", subjects: ["تاريخ"] }),
      person({ id: "A3", name: long, affiliation: "<b>Institute</b> & <img src=x>".padEnd(200, "x") }),
    ];
    const { dialog } = await openIt({ people, entry: { ...ENTRY, typed: "ابن خلدون" } });
    for (const t of ["Đặng Thị Thu Hà", "École des hautes études en sciences sociales", "Sociologie économique", "ابن خلدون", "جامعة القرويين", "تاريخ", long]) {
      const el = within(dialog)
        .getAllByText(t, { exact: false })
        .find((e) => e.getAttribute("dir") === "auto");
      expect(el, t).toBeTruthy();
    }
    expect(dialog.querySelector("b, img")).toBeNull();
    expect(dialog.textContent).toContain("<b>Institute</b> & <img src=x>");
    // The typed name in the heading, through UserText.
    expect(within(within(dialog).getByRole("heading", { level: 2 })).getByText("ابن خلدون").getAttribute("dir")).toBe("auto");
    expect(dialog.className).toContain("ao-find__dialog");
  });

  it("the sentence about choosing another person, always; the one about more people when the entry says so", async () => {
    const { dialog, view } = await openIt();
    expect(dialog.textContent).toContain("To choose another person later, remove this entry and type the name again.");
    expect(dialog.textContent).not.toContain("More people have this name");
    view.unmount();
    const { dialog: d2 } = await openIt({ entry: { ...ENTRY, morePeople: true } });
    expect(d2.textContent).toContain("More people have this name; add a word from a title to narrow it.");
    expect(d2.textContent).toContain("To choose another person later, remove this entry and type the name again.");
  });

  it("This is the person sends the chosen id; while busy the press is shown and ignored; a refusal is said in the service's words", async () => {
    const onChoose = vi.fn();
    const { user, dialog, view } = await openIt({ onChoose });
    await user.click(within(dialog).getAllByRole("radio")[1]!);
    await user.click(within(dialog).getByRole("button", { name: "This is the person" }));
    expect(onChoose).toHaveBeenCalledWith("A5108208998");
    view.unmount();
    const onChoose2 = vi.fn();
    const busy = await openIt({ onChoose: onChoose2, busy: true, error: "This entry is no longer waiting for that. Nothing was changed." });
    await busy.user.click(within(busy.dialog).getAllByRole("radio")[0]!);
    const yes = within(busy.dialog).getByRole("button", { name: /This is the person|Choosing/ });
    expect(yes.getAttribute("aria-busy")).toBe("true");
    await busy.user.click(yes);
    expect(onChoose2).not.toHaveBeenCalled();
    expect(within(busy.dialog).getByRole("alert").textContent).toBe("This entry is no longer waiting for that. Nothing was changed.");
  });

  it("a list that could not be read: the service's sentence, no person, and This is the person stays disabled", async () => {
    const { dialog } = await openIt({ people: undefined, loadError: "That entry is no longer in the queue." });
    expect(within(dialog).getByRole("alert").textContent).toBe("That entry is no longer in the queue.");
    expect(within(dialog).queryAllByRole("radio")).toHaveLength(0);
    expect(within(dialog).queryByText("Reading the people of this name…")).toBeNull();
    expect((within(dialog).getByRole("button", { name: "This is the person" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  });
});
