/**
 * PathField (D12): a labelled path field with "Choose…" beside it. Inside the desktop shell the
 * button opens the native folder or file picker (desktopShell.ts) and puts the chosen path in the
 * field; outside it there is no button and the typed field works as before.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeShell, type FakeShell } from "../test/desktopShell";
import { PathField, type PathFieldProps } from "./PathField";

const fake = vi.hoisted(() => ({ shell: undefined as FakeShell | undefined }));
vi.mock("../desktopShell", () => ({ desktopShell: () => fake.shell, inDesktopShell: () => fake.shell !== undefined }));

afterEach(() => {
  fake.shell = undefined;
});

function Host(props: Partial<PathFieldProps> & { initial?: string; onValue?: (v: string) => void }) {
  const { initial = "", onValue, ...rest } = props;
  const [value, setValue] = useState(initial);
  return (
    <PathField
      label="Zotero data folder"
      pick="folder"
      pickerTitle="Choose the Zotero data folder"
      {...rest}
      value={value}
      onChange={(v) => {
        setValue(v);
        onValue?.(v);
      }}
    />
  );
}

describe("PathField", () => {
  it("outside the shell: a labelled typed field and no button", async () => {
    render(<Host />);
    const field = screen.getByRole("textbox", { name: "Zotero data folder" });
    expect(screen.queryByRole("button")).toBeNull();
    await userEvent.setup().type(field, "/Users/r/Zotero");
    expect((field as HTMLInputElement).value).toBe("/Users/r/Zotero");
  });

  it("in the shell, Choose folder… opens the native folder picker and puts the chosen path in the field, then focus goes to the field", async () => {
    const shell = (fake.shell = fakeShell());
    shell.pickFolder.mockResolvedValueOnce("/Users/r/Zotero");
    const onValue = vi.fn();
    const user = userEvent.setup();
    render(<Host onValue={onValue} />);
    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    expect(shell.pickFolder).toHaveBeenCalledWith("Choose the Zotero data folder");
    const field = screen.getByRole("textbox", { name: "Zotero data folder" }) as HTMLInputElement;
    await waitFor(() => expect(field.value).toBe("/Users/r/Zotero"));
    expect(onValue).toHaveBeenLastCalledWith("/Users/r/Zotero");
    expect(document.activeElement).toBe(field);
    expect(shell.pickFiles).not.toHaveBeenCalled();
  });

  it("a file field opens the file picker for one file", async () => {
    const shell = (fake.shell = fakeShell());
    shell.pickFiles.mockResolvedValueOnce(["/Users/r/Desktop/titles.json"]);
    const user = userEvent.setup();
    render(<Host label="File path" pick="file" pickerTitle="Choose the reference file" />);
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    expect(shell.pickFiles).toHaveBeenCalledWith("Choose the reference file", false);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "File path" }) as HTMLInputElement).value).toBe("/Users/r/Desktop/titles.json"));
  });

  it("the button is reached by keyboard and works with Enter", async () => {
    const shell = (fake.shell = fakeShell());
    shell.pickFolder.mockResolvedValueOnce("/Volumes/Drive/Library");
    const user = userEvent.setup();
    render(<Host />);
    screen.getByRole("textbox", { name: "Zotero data folder" }).focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Choose folder…" }));
    await user.keyboard("{Enter}");
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Zotero data folder" }) as HTMLInputElement).value).toBe("/Volumes/Drive/Library"));
  });

  it("a cancelled picker leaves the typed path; a failed one says so in plain words; the field keeps working", async () => {
    const shell = (fake.shell = fakeShell());
    const user = userEvent.setup();
    render(<Host initial="/typed" />);
    shell.pickFolder.mockResolvedValueOnce(null);
    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    await act(async () => {});
    expect((screen.getByRole("textbox", { name: "Zotero data folder" }) as HTMLInputElement).value).toBe("/typed");
    expect(screen.queryByRole("alert")).toBeNull();
    shell.pickFolder.mockRejectedValueOnce(new Error("portal gone"));
    await user.click(screen.getByRole("button", { name: "Choose folder…" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The folder picker could not be opened. Type the folder's full path instead.");
    expect(screen.getByRole("textbox", { name: "Zotero data folder" }).getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    // Typing again clears the message.
    await user.type(screen.getByRole("textbox", { name: "Zotero data folder" }), "/x");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a double click opens one picker", async () => {
    const shell = (fake.shell = fakeShell());
    let answer!: (v: string | null) => void;
    shell.pickFolder.mockImplementation(() => new Promise((r) => (answer = r)));
    render(<Host />);
    const button = screen.getByRole("button", { name: "Choose folder…" });
    act(() => {
      button.click();
      button.click();
    });
    expect(shell.pickFolder).toHaveBeenCalledTimes(1);
    await act(async () => answer("/a"));
  });

  it("a choice that arrives after the field went away is dropped", async () => {
    const shell = (fake.shell = fakeShell());
    let answer!: (v: string | null) => void;
    shell.pickFolder.mockImplementation(() => new Promise((r) => (answer = r)));
    const onValue = vi.fn();
    const view = render(<Host onValue={onValue} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Choose folder…" }));
    view.unmount();
    await act(async () => answer("/late"));
    expect(onValue).not.toHaveBeenCalled();
  });

  it("a disabled field has a disabled button", () => {
    fake.shell = fakeShell();
    render(<Host disabled />);
    expect((screen.getByRole("button", { name: "Choose folder…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("textbox", { name: "Zotero data folder" }) as HTMLInputElement).disabled).toBe(true);
  });
});
