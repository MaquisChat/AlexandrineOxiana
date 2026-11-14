/**
 * "Choose" (Task F6, R145): the candidates as a radio group with "None of these" last, "Use this one" and "Cancel";
 * focus moves in, is trapped (Tab and Shift+Tab), and returns to the control that opened it; the background is
 * inert; everything a search service sent is shown through UserText.
 */
import type { FindEntryView, FindWorkCandidate } from "@ao/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChooseWorkDialog } from "./ChooseWorkDialog";

const cand = (o: Partial<FindWorkCandidate> & { id: string }): FindWorkCandidate => ({
  title: "Distinction",
  creators: [{ family: "Bourdieu", given: "Pierre", role: "author" }],
  issued: "1984",
  type: "book",
  identifiers: {},
  providers: ["crossref"],
  ...o,
});

const ENTRY: FindEntryView = {
  id: "0190a000-0000-7000-8000-0000000000e1",
  projectId: "0190a000-0000-7000-8000-0000000000a1",
  typed: "Bourdieu, Distinction",
  state: "choose",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:01.000Z",
  attempts: 1,
  candidates: [
    cand({ id: "c1", publisher: "Harvard University Press", identifiers: { isbn: ["9780674212770"] } }),
    cand({
      id: "c2",
      title: "La distinction : critique sociale du jugement",
      issued: "1979-01",
      publisher: "Les Éditions de Minuit",
      creators: [
        { family: "Bourdieu", given: "Pierre", role: "author" },
        { literal: "Richard Nice", role: "translator" },
      ],
    }),
    cand({ id: "c3", title: "Distinction and taste", type: "article-journal", container: "Poetics", identifiers: { doi: "10.1016/example.1" }, issued: "2001" }),
  ],
};

function Harness(props: { entry?: FindEntryView; onChoose?: (id: string | null) => void; busy?: boolean; error?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Choose
      </button>
      <button type="button">Something else</button>
      {open && (
        <ChooseWorkDialog
          entry={props.entry ?? ENTRY}
          onChoose={(id) => props.onChoose?.(id)}
          onClose={() => setOpen(false)}
          {...(props.busy !== undefined ? { busy: props.busy } : {})}
          {...(props.error !== undefined ? { error: props.error } : {})}
        />
      )}
    </main>
  );
}

async function openIt(p: Parameters<typeof Harness>[0] = {}) {
  const user = userEvent.setup();
  const view = render(<Harness {...p} />);
  const opener = screen.getByRole("button", { name: "Choose" });
  await user.click(opener);
  const dialog = await screen.findByRole("dialog");
  return { user, opener, dialog, view };
}

describe("ChooseWorkDialog", () => {
  it("focus on open, Tab, Shift+Tab and after close (R145)", async () => {
    const { user, opener, dialog } = await openIt();
    const radios = within(dialog).getAllByRole("radio");
    const use = within(dialog).getByRole("button", { name: "Use this one" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    // On open: the first candidate.
    expect(document.activeElement).toBe(radios[0]);
    // Nothing chosen: "Use this one" is not a stop; Tab goes to Cancel, then wraps to the group.
    expect((use as HTMLButtonElement).disabled).toBe(true);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(radios[0]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);
    // Choose the second: the group's stop is the chosen radio; Tab reaches "Use this one", Shift+Tab wraps.
    await user.click(radios[1]!);
    expect(document.activeElement).toBe(radios[1]);
    expect((use as HTMLButtonElement).disabled).toBe(false);
    await user.tab();
    expect(document.activeElement).toBe(use);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(radios[1]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(use);
    // The background is inert while it is open.
    expect(opener.closest("[inert]")).not.toBeNull();
    // Escape closes it; focus is back on the control that opened it.
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

  it("the candidates are a radio group with None of these last; each names authors, year, kind, where published and the identifier", async () => {
    const { dialog } = await openIt();
    const group = within(dialog).getByRole("radiogroup");
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(4);
    expect(radios[3]!.getAttribute("aria-label") ?? radios[3]!.closest("label")?.textContent).toContain("None of these");
    const opts = within(group).getAllByRole("listitem").length ? within(group).getAllByRole("listitem") : [];
    expect(opts.length).toBe(4);
    const first = opts[0]!;
    expect(first.textContent).toContain("Distinction");
    expect(first.textContent).toContain("Pierre Bourdieu");
    expect(first.textContent).toContain("1984");
    expect(first.textContent).toContain("Book");
    expect(first.textContent).toContain("Harvard University Press");
    expect(first.textContent).toContain("ISBN 9780674212770");
    const second = opts[1]!;
    expect(second.textContent).toContain("Richard Nice (translator)");
    expect(second.textContent).toContain("1979");
    expect(second.textContent).toContain("Les Éditions de Minuit");
    const third = opts[2]!;
    expect(third.textContent).toContain("Journal article");
    expect(third.textContent).toContain("Poetics");
    expect(third.textContent).toContain("DOI 10.1016/example.1");
    expect(opts[3]!.textContent).toContain("None of these");
    // Outside text through UserText (dir="auto").
    for (const t of ["Distinction", "Pierre Bourdieu", "Harvard University Press", "9780674212770", "Poetics", "10.1016/example.1"]) {
      const el = within(group).getAllByText(t, { exact: false }).find((e) => e.getAttribute("dir") === "auto");
      expect(el, t).toBeTruthy();
    }
    // The typed text is in the dialog's name, through UserText.
    expect(screen.getByRole("dialog").getAttribute("aria-labelledby")).toBeTruthy();
    const heading = within(dialog).getByRole("heading", { level: 2 });
    expect(heading.textContent).toContain("Bourdieu, Distinction");
    expect(within(heading).getByText("Bourdieu, Distinction").getAttribute("dir")).toBe("auto");
  });

  it("Use this one sends the chosen candidate; None of these sends null", async () => {
    const onChoose = vi.fn();
    const { user, dialog } = await openIt({ onChoose });
    const radios = within(dialog).getAllByRole("radio");
    await user.click(radios[2]!);
    await user.click(within(dialog).getByRole("button", { name: "Use this one" }));
    expect(onChoose).toHaveBeenLastCalledWith("c3");
    await user.click(radios[3]!);
    await user.click(within(dialog).getByRole("button", { name: "Use this one" }));
    expect(onChoose).toHaveBeenLastCalledWith(null);
  });

  it("while busy the press is shown and ignored; a refusal is said in the dialog in the service's words", async () => {
    const onChoose = vi.fn();
    const { user, dialog } = await openIt({ onChoose, busy: true, error: "This entry is no longer waiting for that. Nothing was changed." });
    await user.click(within(dialog).getAllByRole("radio")[0]!);
    const use = within(dialog).getByRole("button", { name: /Use this one|Using/ });
    expect(use.getAttribute("aria-busy")).toBe("true");
    await user.click(use);
    expect(onChoose).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert").textContent).toBe("This entry is no longer waiting for that. Nothing was changed.");
  });

  it("right-to-left and very long text keep their direction and wrap", async () => {
    const long = "ق".repeat(1000);
    const entry: FindEntryView = { ...ENTRY, typed: "مقدمة ابن خلدون", candidates: [cand({ id: "c1", title: long, creators: [{ literal: "ابن خلدون", role: "author" }] })] };
    const { dialog } = await openIt({ entry });
    expect(within(dialog).getByText(long).getAttribute("dir")).toBe("auto");
    const names = within(dialog).getAllByText("ابن خلدون", { exact: false });
    expect(names.length).toBe(2); // the typed text in the heading, the author in the candidate
    for (const n of names) expect(n.getAttribute("dir")).toBe("auto");
    expect(dialog.className).toContain("ao-find__dialog");
  });
});
