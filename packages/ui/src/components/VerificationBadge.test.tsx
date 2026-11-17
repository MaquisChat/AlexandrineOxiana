import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FieldReview } from "@ao/shared";
import { describe, expect, it, vi } from "vitest";
import { FIELD_CREATORS_UNVERIFIED, FIELD_DOI_CONFIRMED, FIELD_ISSUED_CONFLICT, FIELD_PUBLISHER_SINGLE, FIELD_TITLE_VERIFIED } from "../test/verification";
import { isConfirmable } from "./FieldEvidencePopover";
import { FieldCheck, STATUS_WORDS, VerificationBadge } from "./VerificationBadge";

const noop = () => Promise.resolve();

describe("VerificationBadge", () => {
  it.each([
    [FIELD_TITLE_VERIFIED, "Title", "Verified"],
    [FIELD_PUBLISHER_SINGLE, "Publisher", "Single source"],
    [FIELD_CREATORS_UNVERIFIED, "Creators", "Unverified"],
    [FIELD_ISSUED_CONFLICT, "Date", "Conflict"],
    [FIELD_DOI_CONFIRMED, "DOI", "Confirmed by you"],
    [{ ...FIELD_TITLE_VERIFIED, status: "none" } as FieldReview, "Title", "Not checked"],
  ])("%#: shows the status in words, and its accessible name gives the field and the status", (review, label, words) => {
    render(<VerificationBadge review={review} label={label} expanded={false} onOpen={vi.fn()} />);
    const badge = screen.getByRole("button", { name: `${label}: ${words}` });
    expect(badge.textContent).toContain(words);
  });

  it("each status has its own shape (glyph and class), hidden from screen readers, so colour is never the only signal", () => {
    const seen = new Set<string>();
    for (const status of Object.keys(STATUS_WORDS) as Array<keyof typeof STATUS_WORDS>) {
      const { unmount } = render(<VerificationBadge review={{ ...FIELD_TITLE_VERIFIED, status }} label="Title" expanded={false} onOpen={vi.fn()} />);
      const badge = screen.getByRole("button");
      const glyph = badge.querySelector("[aria-hidden='true']");
      expect(glyph?.textContent?.trim()).toBeTruthy();
      expect(badge.className).toContain(`ao-verify--${status}`);
      seen.add(glyph!.textContent!);
      unmount();
    }
    expect(seen.size).toBe(Object.keys(STATUS_WORDS).length);
    // No role="img" anywhere: the picture count on the source screen stays the pictures' (e2e D3).
    expect(document.querySelector("[role='img']")).toBeNull();
  });
});

describe("FieldCheck: the badge and its evidence popover", () => {
  it("opens from the keyboard, lists each evidence source with its value, quote and date, and Escape closes it back to the badge", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">before</button>
        <FieldCheck review={FIELD_CREATORS_UNVERIFIED} label="Creators" value={[{ family: "Smith", given: "Jane" }]} readOnly={false} onConfirm={noop} />
      </>,
    );
    await user.tab();
    await user.tab();
    const badge = screen.getByRole("button", { name: "Creators: Unverified" });
    expect(document.activeElement).toBe(badge);
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{Enter}");
    const pop = screen.getByRole("dialog", { name: "Creators: evidence" });
    expect(badge.getAttribute("aria-expanded")).toBe("true");
    expect(pop.contains(document.activeElement)).toBe(true);
    expect(within(pop).getByText(/suggested by AI, but the passage it quoted/)).toBeTruthy();
    const items = within(pop).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(within(items[0]!).getByText("an AI suggestion").closest("[dir=auto]")).toBeTruthy();
    expect(within(items[0]!).getByText("Smith, Jane").closest("[dir=auto]")).toBeTruthy();
    const quote = within(items[0]!).getByText("by J. Smith and colleagues");
    expect(quote.closest("[dir=auto]")).toBeTruthy();
    expect(quote.closest("blockquote")).toBeTruthy();
    expect(within(items[0]!).getByText(/2026-11-01/)).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(badge);
  });

  it("Tab stays inside the open popover", async () => {
    const user = userEvent.setup();
    render(<FieldCheck review={FIELD_TITLE_VERIFIED} label="Title" value={{ variants: [{ kind: "original", value: "Ethnography at Work" }] }} readOnly={false} onConfirm={noop} />);
    await user.click(screen.getByRole("button", { name: "Title: Verified" }));
    const pop = screen.getByRole("dialog");
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(pop.contains(document.activeElement)).toBe(true);
    }
  });

  it("Confirm records the value on the record as the researcher's confirmation", async () => {
    const onConfirm = vi.fn(noop);
    const user = userEvent.setup();
    render(<FieldCheck review={FIELD_PUBLISHER_SINGLE} label="Publisher" value="University Press" readOnly={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Publisher: Single source" }));
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    expect(onConfirm).toHaveBeenCalledWith("/publisher", "University Press");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a conflict shows the competing values with their sources; choosing one confirms it", async () => {
    const onConfirm = vi.fn(noop);
    const user = userEvent.setup();
    render(<FieldCheck review={FIELD_ISSUED_CONFLICT} label="Date" value="2019" readOnly={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Date: Conflict" }));
    const pop = screen.getByRole("dialog", { name: "Date: evidence" });
    const choices = within(pop).getByRole("radiogroup", { name: "Which value is right?" });
    const recorded = within(choices).getByRole("radio", { name: /2019.*recorded here/ });
    const lookup = within(choices).getByRole("radio", { name: /2018.*an online lookup \(crossref\)/ });
    expect((recorded as HTMLInputElement).checked).toBe(true);
    await user.click(lookup);
    await user.click(within(pop).getByRole("button", { name: "Confirm this value" }));
    expect(onConfirm).toHaveBeenCalledWith("/issued", "2018");
  });

  it("a conflict can be resolved by typing another value", async () => {
    const onConfirm = vi.fn(noop);
    const user = userEvent.setup();
    render(<FieldCheck review={FIELD_ISSUED_CONFLICT} label="Date" value="2019" readOnly={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Date: Conflict" }));
    await user.click(screen.getByRole("radio", { name: "Type another value" }));
    await user.type(screen.getByRole("textbox", { name: "Your value" }), "2018-05");
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    expect(onConfirm).toHaveBeenCalledWith("/issued", "2018-05");
  });

  it("creators with no value (Task 67 fix round 1, I1): names can be typed, separated by semicolons, and are recorded as a list of creators", async () => {
    const onConfirm = vi.fn(noop);
    const user = userEvent.setup();
    const review: FieldReview = { field: "/creators", status: "unverified", checks: [], reason: "No creator was found.", evidence: [] };
    render(<FieldCheck review={review} label="Creators" value={[]} readOnly={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Creators: Unverified" }));
    const box = screen.getByRole("textbox", { name: "Your value" });
    expect(document.activeElement === box || screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    expect(screen.getByText(/separate names with a semicolon/i)).toBeTruthy();
    await user.type(box, "Harbour Collective;  Ana Souza ; ");
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    expect(onConfirm).toHaveBeenCalledWith("/creators", [
      { literal: "Harbour Collective", role: "author" },
      { literal: "Ana Souza", role: "author" },
    ]);
  });

  it("creators in conflict (fix round 2, N2): no typing is offered; the chosen competing value keeps its structure", async () => {
    const onConfirm = vi.fn(noop);
    const user = userEvent.setup();
    const recorded = [{ family: "Souza", given: "Ana", role: "author" }];
    const other = [{ handle: "@harbourco", literal: "Harbour Collective", role: "uploader" }];
    const review: FieldReview = {
      field: "/creators",
      status: "conflict",
      checks: ["sources-agree"],
      values: [{ value: other, from: { kind: "platform-json", label: "the platform's data" } }],
      evidence: [],
    };
    render(<FieldCheck review={review} label="Creators" value={recorded} readOnly={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Creators: Conflict" }));
    expect(screen.queryByRole("radio", { name: "Type another value" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Your value" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: /Harbour Collective/ }));
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    expect(onConfirm).toHaveBeenCalledWith("/creators", other);
  });

  it("an empty typed value is not sent", async () => {
    const onConfirm = vi.fn(noop);
    const user = userEvent.setup();
    render(<FieldCheck review={FIELD_ISSUED_CONFLICT} label="Date" value="2019" readOnly={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Date: Conflict" }));
    await user.click(screen.getByRole("radio", { name: "Type another value" }));
    expect((screen.getByRole("button", { name: "Confirm this value" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("a title chosen from a source keeps the title's languages and kinds: only the first variant's text changes", async () => {
    const onConfirm = vi.fn(noop);
    const user = userEvent.setup();
    const review: FieldReview = {
      ...FIELD_TITLE_VERIFIED,
      status: "conflict",
      values: [{ value: "Ethnography at Work: A Study", from: { kind: "lookup", label: "an online lookup (crossref)", provider: "crossref" } }],
    };
    const value = { variants: [{ lang: "en", kind: "original", value: "Ethnography at Work" }, { lang: "fr", kind: "translated", value: "L'ethnographie" }] };
    render(<FieldCheck review={review} label="Title" value={value} readOnly={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Title: Conflict" }));
    await user.click(screen.getByRole("radio", { name: /A Study/ }));
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    expect(onConfirm).toHaveBeenCalledWith("/title", { variants: [{ lang: "en", kind: "original", value: "Ethnography at Work: A Study" }, { lang: "fr", kind: "translated", value: "L'ethnographie" }] });
  });

  it("a failed confirm says why in plain words and keeps the popover, the choice and the typed text", async () => {
    let fail = true;
    const onConfirm = vi.fn(async () => {
      if (fail) throw new Error("This library is read-only, so nothing was changed.");
    });
    const user = userEvent.setup();
    render(<FieldCheck review={FIELD_ISSUED_CONFLICT} label="Date" value="2019" readOnly={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Date: Conflict" }));
    await user.click(screen.getByRole("radio", { name: "Type another value" }));
    await user.type(screen.getByRole("textbox", { name: "Your value" }), "2017");
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The confirmation was not saved");
    expect(alert.textContent).toContain("read-only");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Type another value" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("textbox", { name: "Your value" }) as HTMLInputElement).value).toBe("2017");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    expect(onConfirm).toHaveBeenLastCalledWith("/issued", "2017");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("while a confirm is being saved, Escape does not close the popover and the button is off", async () => {
    let finish: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const user = userEvent.setup();
    render(<FieldCheck review={FIELD_PUBLISHER_SINGLE} label="Publisher" value="University Press" readOnly={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Publisher: Single source" }));
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeTruthy();
    finish();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("read-only library: the evidence can be read, but Confirm is off and says why", async () => {
    const user = userEvent.setup();
    render(<FieldCheck review={FIELD_ISSUED_CONFLICT} label="Date" value="2019" readOnly onConfirm={noop} />);
    await user.click(screen.getByRole("button", { name: "Date: Conflict" }));
    const confirm = screen.getByRole("button", { name: "Confirm this value" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(/read-only/)).toBeTruthy();
  });

  it("an identifier (R149): Confirm posts the badge's own key, /identifiers/doi, unchanged", async () => {
    const onConfirm = vi.fn(noop);
    const user = userEvent.setup();
    render(<FieldCheck review={{ ...FIELD_DOI_CONFIRMED, status: "unverified" }} label="DOI" value="10.1000/xyz" readOnly={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "DOI: Unverified" }));
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    expect(onConfirm).toHaveBeenCalledWith("/identifiers/doi", "10.1000/xyz");
  });

  it("an identifier conflict with no evidence entries still shows the competing value and its source, and choosing it posts it (R149)", async () => {
    const onConfirm = vi.fn(noop);
    const user = userEvent.setup();
    const review: FieldReview = {
      field: "/identifiers/doi",
      status: "conflict",
      checks: ["doi-lookup"],
      reason: "The DOI resolves to a different work.",
      values: [{ value: "10.1/other", from: { kind: "lookup", label: "an online lookup (crossref)", provider: "crossref" } }],
      evidence: [],
    };
    render(<FieldCheck review={review} label="DOI" value="10.1/mine" readOnly={false} onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "DOI: Conflict" }));
    const pop = screen.getByRole("dialog", { name: "DOI: evidence" });
    expect(pop.textContent).not.toContain("Edit details");
    const other = within(pop).getByRole("radio", { name: /10\.1\/other.*an online lookup \(crossref\)/ });
    await user.click(other);
    await user.click(within(pop).getByRole("button", { name: "Confirm this value" }));
    expect(onConfirm).toHaveBeenCalledWith("/identifiers/doi", "10.1/other");
  });

  it("a conflict on a field that cannot be confirmed here still lists the competing values with their sources (never hidden), without false advice", async () => {
    const user = userEvent.setup();
    const review: FieldReview = {
      field: "/caseAttributes/site",
      status: "conflict",
      checks: ["cross-source"],
      values: [{ value: "North clinic", from: { kind: "zotero", label: "the Zotero record" } }],
      evidence: [],
    };
    render(<FieldCheck review={review} label="Site" value="South clinic" readOnly={false} onConfirm={noop} />);
    await user.click(screen.getByRole("button", { name: "Site: Conflict" }));
    const pop = screen.getByRole("dialog");
    const list = within(pop).getByRole("list", { name: "Values the sources give for Site" });
    expect(within(list).getByText("North clinic").closest("[dir=auto]")).toBeTruthy();
    expect(within(list).getByText("the Zotero record")).toBeTruthy();
    expect(within(pop).queryByRole("button", { name: "Confirm this value" })).toBeNull();
    expect(pop.textContent).not.toContain("Edit details");
    expect(pop.textContent).toContain("cannot be confirmed from this screen");
  });

  it("is a modal dialog (R113, R145): the rest of the page is inert while it is open, and only one is open at a time", async () => {
    const user = userEvent.setup();
    const outside = vi.fn();
    render(
      <>
        <button type="button" onClick={outside}>
          Edit details
        </button>
        <FieldCheck review={FIELD_PUBLISHER_SINGLE} label="Publisher" value="University Press" readOnly={false} onConfirm={noop} />
        <FieldCheck review={FIELD_ISSUED_CONFLICT} label="Date" value="2019" readOnly={false} onConfirm={noop} />
      </>,
    );
    const background = screen.getByRole("button", { name: "Edit details" });
    await user.click(screen.getByRole("button", { name: "Publisher: Single source" }));
    const pop = screen.getByRole("dialog", { name: "Publisher: evidence" });
    expect(pop.getAttribute("aria-modal")).toBe("true");
    expect(background.closest("[inert]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Date: Conflict" }).closest("[inert]")).toBeTruthy();
    expect(pop.closest("[inert]")).toBeNull();
    await user.keyboard("{Escape}");
    expect(document.querySelector("[inert]")).toBeNull();
  });

  it("focus (R145, R371 a): moves in on open to the dialog's heading (never to a control that confirms), Tab and Shift+Tab stay inside and wrap, and Close returns it to the badge", async () => {
    const user = userEvent.setup();
    render(<FieldCheck review={FIELD_ISSUED_CONFLICT} label="Date" value="2019" readOnly={false} onConfirm={noop} />);
    const badge = screen.getByRole("button", { name: "Date: Conflict" });
    await user.click(badge);
    const pop = screen.getByRole("dialog");
    const heading = within(pop).getByRole("heading", { name: "Date: evidence" });
    const first = within(pop).getByRole("radio", { name: /2019/ });
    const close = within(pop).getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(first);
    heading.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);
    for (let i = 0; i < 5; i++) {
      await user.tab({ shift: true });
      expect(pop.contains(document.activeElement)).toBe(true);
    }
    await user.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(badge));
  });

  it("focus (R145): after a successful Confirm it returns to the badge", async () => {
    const user = userEvent.setup();
    render(<FieldCheck review={FIELD_PUBLISHER_SINGLE} label="Publisher" value="University Press" readOnly={false} onConfirm={noop} />);
    const badge = screen.getByRole("button", { name: "Publisher: Single source" });
    await user.click(badge);
    await user.click(screen.getByRole("button", { name: "Confirm this value" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(badge));
  });

  it("a value that is not text is never shown as raw JSON", async () => {
    const user = userEvent.setup();
    const review: FieldReview = { ...FIELD_PUBLISHER_SINGLE, evidence: [{ value: { odd: { nested: true } }, from: { kind: "embedded", label: "the file's own metadata" }, at: "" }] };
    render(<FieldCheck review={review} label="Publisher" value="University Press" readOnly={false} onConfirm={noop} />);
    await user.click(screen.getByRole("button", { name: "Publisher: Single source" }));
    const pop = screen.getByRole("dialog");
    expect(pop.textContent).not.toContain("{");
    expect(pop.textContent).toContain("a value that cannot be shown as text");
  });

  describe("R371 a: the key that opened the dialog never confirms in it", () => {
    const openConflict = () => {
      const onConfirm = vi.fn(noop);
      const user = userEvent.setup();
      render(<FieldCheck review={FIELD_ISSUED_CONFLICT} label="Date" value="2019" readOnly={false} onConfirm={onConfirm} />);
      const badge = screen.getByRole("button", { name: "Date: Conflict" });
      badge.focus();
      return { onConfirm, user, badge };
    };

    it("Enter held on the badge opens the dialog and confirms nothing; focus is on the heading", async () => {
      const { onConfirm, user } = openConflict();
      await user.keyboard("{Enter>4}{/Enter}");
      const pop = screen.getByRole("dialog", { name: "Date: evidence" });
      expect(document.activeElement).toBe(within(pop).getByRole("heading", { name: "Date: evidence" }));
      await new Promise((r) => setTimeout(r, 20));
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("Enter twice on the badge confirms nothing (the second lands on the heading)", async () => {
      const { onConfirm, user } = openConflict();
      await user.keyboard("{Enter}{Enter}");
      const pop = screen.getByRole("dialog", { name: "Date: evidence" });
      expect(document.activeElement).toBe(within(pop).getByRole("heading", { name: "Date: evidence" }));
      await new Promise((r) => setTimeout(r, 20));
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("a keyboard user loses nothing: Tab to the value, an arrow key to choose, Tab to Confirm, Enter — one confirmation", async () => {
      const { onConfirm, user } = openConflict();
      await user.keyboard("{Enter}");
      const pop = screen.getByRole("dialog", { name: "Date: evidence" });
      await user.tab();
      expect(document.activeElement).toBe(within(pop).getByRole("radio", { name: /2019/ }));
      await user.keyboard("{ArrowDown}");
      const other = within(pop).getByRole("radio", { name: /2018/ }) as HTMLInputElement;
      expect(other.checked).toBe(true);
      await user.tab();
      expect(document.activeElement).toBe(within(pop).getByRole("button", { name: "Confirm this value" }));
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onConfirm).toHaveBeenCalledWith("/issued", "2018");
    });

    it("Space chooses a value as well, and Enter on the chosen value confirms it once", async () => {
      const { onConfirm, user } = openConflict();
      await user.keyboard("{Enter}");
      const pop = screen.getByRole("dialog", { name: "Date: evidence" });
      await user.tab();
      const other = within(pop).getByRole("radio", { name: /2018/ }) as HTMLInputElement;
      other.focus();
      await user.keyboard(" ");
      expect(other.checked).toBe(true);
      await user.keyboard("{Enter}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onConfirm).toHaveBeenCalledWith("/issued", "2018");
    });

    it("a repeated keydown inside the dialog never submits (its default is prevented on a value and on Confirm)", async () => {
      const { onConfirm, user } = openConflict();
      await user.click(screen.getByRole("button", { name: "Date: Conflict" }));
      const pop = screen.getByRole("dialog", { name: "Date: evidence" });
      const radio = within(pop).getByRole("radio", { name: /2019/ });
      const confirm = within(pop).getByRole("button", { name: "Confirm this value" });
      expect(fireEvent.keyDown(radio, { key: "Enter", code: "Enter", repeat: true })).toBe(false);
      expect(fireEvent.keyDown(confirm, { key: "Enter", code: "Enter", repeat: true })).toBe(false);
      expect(fireEvent.keyDown(confirm, { key: " ", code: "Space", repeat: true })).toBe(false);
      expect(onConfirm).not.toHaveBeenCalled();
      // A fresh press is taken.
      radio.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    });

    it("a key already down when the dialog opened does not count until it has been released", async () => {
      const { onConfirm, user } = openConflict();
      await user.keyboard("{Enter>}");
      const pop = screen.getByRole("dialog", { name: "Date: evidence" });
      const radio = within(pop).getByRole("radio", { name: /2019/ });
      radio.focus();
      // The same key, still down (a platform that does not mark its repeat): not taken.
      expect(fireEvent.keyDown(radio, { key: "Enter", code: "Enter" })).toBe(false);
      expect(onConfirm).not.toHaveBeenCalled();
      // Released, then pressed: taken, once.
      await user.keyboard("{/Enter}");
      await user.keyboard("{Enter}");
      await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
      expect(onConfirm).toHaveBeenCalledWith("/issued", "2019");
    });

    it("a mouse double click on the badge confirms nothing", async () => {
      const { onConfirm, user, badge } = openConflict();
      await user.dblClick(badge);
      await new Promise((r) => setTimeout(r, 20));
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it("Escape closes it from the heading and focus returns to the badge", async () => {
      const { onConfirm, user, badge } = openConflict();
      await user.keyboard("{Enter}");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(badge));
      expect(onConfirm).not.toHaveBeenCalled();
    });
  });

  it("identifiers are confirmable one at a time, never as the whole object (re-review N3, R149)", () => {
    expect(isConfirmable("/identifiers/doi")).toBe(true);
    expect(isConfirmable("/identifiers")).toBe(false);
    expect(isConfirmable("/publisher")).toBe(true);
  });
});
