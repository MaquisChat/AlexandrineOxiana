/**
 * The shared dialog shell (DialogShell in ReasonDialog.tsx), tested through ChoiceDialog and
 * ConfirmDialog, which are built on it: focus enters the dialog on open, Tab and Shift+Tab stay
 * inside, Escape closes, focus returns to the opener, the background is inert while it is open,
 * and all of it holds under StrictMode's double effects.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { describe, expect, it } from "vitest";
import { ChoiceDialog, ConfirmDialog } from "./ReasonDialog";

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
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Go" }));
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
