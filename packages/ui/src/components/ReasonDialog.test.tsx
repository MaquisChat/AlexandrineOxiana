/**
 * The shared dialog shell (DialogShell in ReasonDialog.tsx), tested through ChoiceDialog and
 * ConfirmDialog, which are built on it: focus enters the dialog on open, Tab and Shift+Tab stay
 * inside, Escape closes, focus returns to the opener, the background is inert while it is open,
 * and all of it holds under StrictMode's double effects.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ChoiceDialog, ConfirmDialog, ReasonDialog } from "./ReasonDialog";

function Host({ kind = "choice" }: { kind?: "choice" | "confirm" }) {
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <a href="#x">Other link</a>
      {open && kind === "choice" ? (
        <ChoiceDialog title="Sure?" action="Go" onConfirm={() => setOpen(false)} onCancel={() => setOpen(false)}>
          <p>Body</p>
        </ChoiceDialog>
      ) : null}
      {open && kind === "confirm" ? (
        <ConfirmDialog title="Type it" word="yes" action="Go" onConfirm={() => setOpen(false)} onCancel={() => setOpen(false)}>
          <p>Body</p>
        </ConfirmDialog>
      ) : null}
    </main>
  );
}

const variants = [
  ["plain", (ui: React.ReactElement) => ui],
  ["StrictMode", (ui: React.ReactElement) => <StrictMode>{ui}</StrictMode>],
] as const;

describe.each(variants)("the dialog shell (%s)", (_name, wrap) => {
  it("moves focus inside on open", async () => {
    const user = userEvent.setup();
    render(wrap(<Host />));
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Sure?" }));
  });

  it("focuses the first field of a dialog that has one", async () => {
    const user = userEvent.setup();
    render(wrap(<Host kind="confirm" />));
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog");
    expect(document.activeElement).toBe(within(dialog).getByRole("textbox"));
  });

  it("Tab and Shift+Tab stay inside", async () => {
    const user = userEvent.setup();
    render(wrap(<Host />));
    await user.click(screen.getByRole("button", { name: "Open" }));
    const dialog = await screen.findByRole("dialog");
    for (let i = 0; i < 4; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 4; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("Escape closes and focus returns to the element that opened it", async () => {
    const user = userEvent.setup();
    render(wrap(<Host />));
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("makes the background inert while open and releases it on close", async () => {
    const user = userEvent.setup();
    const { container } = render(wrap(<Host />));
    await user.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog");
    expect(container.hasAttribute("inert")).toBe(true);
    await user.keyboard("{Escape}");
    expect(container.hasAttribute("inert")).toBe(false);
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });
});

/** FR-A9 (R376 c): a held or repeated Enter on the opener confirms nothing; first focus is the heading. */
describe.each(variants)("ChoiceDialog opened from the keyboard (%s)", (_name, wrap) => {
  function Opener({ onConfirm }: { onConfirm: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <main>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        {open ? (
          <ChoiceDialog title="Sure?" action="Go" onConfirm={onConfirm} onCancel={() => setOpen(false)}>
            <p>Body</p>
          </ChoiceDialog>
        ) : null}
      </main>
    );
  }

  it("a held Enter on the opener opens it with focus on the heading and confirms nothing", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(wrap(<Opener onConfirm={onConfirm} />));
    screen.getByRole("button", { name: "Open" }).focus();
    await user.keyboard("{Enter>4}{/Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Sure?" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Sure?" }));
  });

  it("Enter pressed twice on the opener confirms nothing", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(wrap(<Opener onConfirm={onConfirm} />));
    screen.getByRole("button", { name: "Open" }).focus();
    await user.keyboard("{Enter}{Enter}");
    await screen.findByRole("dialog", { name: "Sure?" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("Tab from the heading reaches the action, and Enter there confirms exactly once", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(wrap(<Opener onConfirm={onConfirm} />));
    screen.getByRole("button", { name: "Open" }).focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Sure?" });
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Go" }));
    await user.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Shift+Tab from the heading reaches the last control (Cancel)", async () => {
    const user = userEvent.setup();
    render(wrap(<Opener onConfirm={() => {}} />));
    screen.getByRole("button", { name: "Open" }).focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Sure?" });
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
  });

  it("Escape closes it and focus returns to the opener", async () => {
    const user = userEvent.setup();
    render(wrap(<Opener onConfirm={() => {}} />));
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "Sure?" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("the reason dialog (R421 a)", () => {
  it("a reason or an approver of only white space and invisible characters keeps the button off", () => {
    const onConfirm = vi.fn();
    render(<ReasonDialog message="Needs a reason." onConfirm={onConfirm} onCancel={() => {}} />);
    const reason = screen.getByRole("textbox", { name: "Reason" });
    const by = screen.getByRole("textbox", { name: "Approved by" });
    const button = screen.getByRole("button", { name: "Record reason" }) as HTMLButtonElement;
    fireEvent.change(reason, { target: { value: " \u200B\u2060\uFEFF " } });
    fireEvent.change(by, { target: { value: "Ana" } });
    expect(button.disabled).toBe(true);
    fireEvent.change(reason, { target: { value: "Pilot" } });
    fireEvent.change(by, { target: { value: "\u200B\u00AD" } });
    expect(button.disabled).toBe(true);
    fireEvent.submit(button.closest("form")!);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(by, { target: { value: "Ana" } });
    expect(button.disabled).toBe(false);
  });
});
