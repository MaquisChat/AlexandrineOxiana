/**
 * R362 h: in an ENCRYPTED project the names of its collections and tags are kept in the project's readable part: where
 * such a name is typed the field says so, tied to the field (aria-describedby). In a project that is not: nothing.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CollectionTree } from "./CollectionTree";
import { TagList } from "./TagList";

const NAME_NOTE = "In an encrypted project this name can be read without the passphrase. Do not put a person's name in it.";

/** The field's description, through aria-describedby. */
const described = (el: HTMLElement) =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

const COLLECTIONS = [{ id: "c1", name: "Chapter 1" }] as never[];
const TAGS = [{ id: "t1", name: "to read" }] as never[];
const WORKSPACE = [{ id: "w1", name: "shared" }] as never[];

function tagList(encrypted: boolean | undefined) {
  render(<TagList tags={TAGS} workspaceTags={WORKSPACE} onSelect={() => {}} onRename={() => {}} onDelete={() => {}} onRenameWorkspace={() => {}} onDeleteWorkspace={() => {}} onCreate={() => {}} {...(encrypted === undefined ? {} : { encrypted })} />);
}

describe("R362 h: the note where a collection's or a tag's name is typed", () => {
  for (const encrypted of [true, false]) {
    const expectNote = (field: HTMLElement) => {
      if (encrypted) {
        expect(described(field)).toBe(NAME_NOTE);
        expect(screen.getByText(NAME_NOTE)).toBeTruthy();
      } else {
        expect(field.getAttribute("aria-describedby")).toBeNull();
        expect(screen.queryByText(NAME_NOTE)).toBeNull();
      }
    };

    it(`a new collection's name, and a collection renamed — ${encrypted ? "encrypted: the note" : "not encrypted: nothing"}`, async () => {
      const user = userEvent.setup();
      const { rerender } = render(<CollectionTree collections={COLLECTIONS} selectedId={undefined} onSelect={() => {}} onCreate={() => {}} onRename={() => {}} encrypted={encrypted} />);
      await user.click(screen.getByRole("button", { name: "New collection" }));
      expectNote(screen.getByRole("textbox", { name: "Collection name" }));
      rerender(<CollectionTree collections={COLLECTIONS} selectedId="c1" onSelect={() => {}} onCreate={() => {}} onRename={() => {}} encrypted={encrypted} />);
      await user.click(screen.getByRole("button", { name: "Rename collection Chapter 1" }));
      expectNote(screen.getByRole("textbox", { name: "New name for Chapter 1" }));
    });

    it(`a new tag's name — ${encrypted ? "encrypted: the note" : "not encrypted: nothing"}`, async () => {
      const user = userEvent.setup();
      tagList(encrypted);
      await user.click(screen.getByRole("button", { name: "New tag" }));
      expectNote(screen.getByRole("textbox", { name: "Tag name" }));
    });

    it(`a tag renamed, and a workspace tag renamed — ${encrypted ? "encrypted: the note" : "not encrypted: nothing"}`, async () => {
      const user = userEvent.setup();
      tagList(encrypted);
      await user.click(screen.getByRole("button", { name: "Rename tag to read" }));
      expectNote(screen.getByRole("textbox", { name: "New name for to read" }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await user.click(screen.getByRole("button", { name: "Rename workspace tag shared" }));
      expectNote(screen.getByRole("textbox", { name: "New name for shared" }));
    });
  }

  it("without being told the project is encrypted, nothing is said (a project that is not encrypted)", async () => {
    const user = userEvent.setup();
    tagList(undefined);
    await user.click(screen.getByRole("button", { name: "New tag" }));
    expect(screen.queryByText(NAME_NOTE)).toBeNull();
  });
});
