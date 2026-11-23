import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { COLLECTIONS, PROJECTS, SOURCES, TAGS } from "../test/service";
import { CollectionTree } from "./CollectionTree";
import { JobsIndicator } from "./JobsIndicator";
import { ProjectNav } from "./ProjectNav";
import { SourceTable } from "./SourceTable";
import { TagList } from "./TagList";

describe("ProjectNav", () => {
  it("marks the current project and selects another", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<ProjectNav projects={PROJECTS.projects} profiles={{ p1: ["irb"] }} selectedId="p1" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: /Dissertation/ }).getAttribute("aria-current")).toBe("true");
    await user.click(screen.getByRole("button", { name: /Clinic interviews/ }));
    expect(onSelect).toHaveBeenCalledWith("p2");
  });
});

describe("CollectionTree", () => {
  it("arrow keys move between items and Enter selects", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<CollectionTree collections={COLLECTIONS.collections} selectedId={undefined} onSelect={onSelect} />);
    const all = screen.getByRole("treeitem", { name: "All sources" });
    all.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "Chapter 1" }));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("c2");
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "Chapter 2" }));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(all);
  });
});

describe("CollectionTree expand, collapse, rename, delete", () => {
  it("an open rename closes when another collection is selected, so it never renames the wrong one (41b1 M2)", async () => {
    const onRename = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<CollectionTree collections={COLLECTIONS.collections} selectedId="c1" onSelect={vi.fn()} onRename={onRename} />);
    await user.click(screen.getByRole("button", { name: "Rename collection Chapter 1" }));
    expect(screen.getByLabelText("New name for Chapter 1")).toBeTruthy();
    rerender(<CollectionTree collections={COLLECTIONS.collections} selectedId="c4" onSelect={vi.fn()} onRename={onRename} />);
    expect(screen.queryByLabelText(/New name for/)).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("parents carry aria-expanded; Left collapses (hiding children) and Right expands", async () => {
    const user = userEvent.setup();
    render(<CollectionTree collections={COLLECTIONS.collections} selectedId={undefined} onSelect={vi.fn()} />);
    const ch1 = screen.getByRole("treeitem", { name: "Chapter 1" });
    expect(ch1.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("treeitem", { name: "Chapter 2" }).hasAttribute("aria-expanded")).toBe(false);
    ch1.focus();
    await user.keyboard("{ArrowLeft}");
    expect(ch1.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: "Interviews" })).toBeNull();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "Chapter 2" }));
    await user.keyboard("{ArrowUp}{ArrowRight}");
    expect(ch1.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "Interviews" }));
    // Interviews has a child: the first Left collapses it, the second moves to its parent
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("treeitem", { name: "Interviews" }).getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(ch1);
  });

  it("a mouse click on a parent's twisty collapses and expands it without selecting it (FR-162)", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<CollectionTree collections={COLLECTIONS.collections} selectedId={undefined} onSelect={onSelect} />);
    const ch1 = screen.getByRole("treeitem", { name: "Chapter 1" });
    const twisty = ch1.querySelector(".ao-tree__twisty") as HTMLElement;
    await user.click(twisty);
    expect(ch1.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: "Interviews" })).toBeNull();
    await user.click(twisty);
    expect(ch1.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("treeitem", { name: "Interviews" })).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("the selected collection can be renamed and deleted (with a confirmation); read-only turns both off", async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<CollectionTree collections={COLLECTIONS.collections} selectedId="c4" onSelect={vi.fn()} onRename={onRename} onDelete={onDelete} />);
    await user.click(screen.getByRole("button", { name: "Rename collection Chapter 2" }));
    const field = screen.getByLabelText("New name for Chapter 2");
    await user.clear(field);
    await user.type(field, "Chapter Two{Enter}");
    expect(onRename).toHaveBeenCalledWith("c4", "Chapter Two");
    await user.click(screen.getByRole("button", { name: "Delete collection Chapter 2" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("c4");
    rerender(<CollectionTree collections={COLLECTIONS.collections} selectedId="c4" onSelect={vi.fn()} onRename={onRename} onDelete={onDelete} readOnly />);
    expect((screen.getByRole("button", { name: "Rename collection Chapter 2" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Delete collection Chapter 2" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("TagList", () => {
  it("a tag's own colour is shown as a swatch only when it is a valid #rrggbb", () => {
    render(
      <TagList
        tags={[
          { id: "a", scope: "p1", name: "red tag", color: "#aa0000" },
          { id: "b", scope: "p1", name: "bad colour", color: "red; background: url(x)" },
        ]}
        workspaceTags={[]}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onRenameWorkspace={vi.fn()}
        onDeleteWorkspace={vi.fn()}
        onCreate={vi.fn()}
      />,
    );
    const swatches = screen.getAllByTestId("code-swatch");
    expect(swatches).toHaveLength(1);
    expect(swatches[0]!.textContent).toContain("red tag");
  });

  it("project tags can be renamed and deleted", async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(<TagList tags={TAGS.tags} workspaceTags={TAGS.workspaceTags} onSelect={vi.fn()} onRename={onRename} onDelete={onDelete} onRenameWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()} onCreate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Rename tag to read" }));
    const field = screen.getByLabelText("New name for to read");
    await user.clear(field);
    await user.type(field, "reading{Enter}");
    expect(onRename).toHaveBeenCalledWith("t1", "reading");
    await user.click(screen.getByRole("button", { name: "Delete tag to read" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("t1");
  });

  it("workspace tags can be renamed and deleted too (R118), with a confirmation that names every project", async () => {
    const onRenameWorkspace = vi.fn();
    const onDeleteWorkspace = vi.fn();
    const user = userEvent.setup();
    render(
      <TagList tags={TAGS.tags} workspaceTags={TAGS.workspaceTags} onSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onRenameWorkspace={onRenameWorkspace} onDeleteWorkspace={onDeleteWorkspace} onCreate={vi.fn()} />,
    );
    expect(screen.queryByText(/not available yet/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Rename workspace tag methods" }));
    const field = screen.getByLabelText("New name for methods");
    await user.clear(field);
    await user.type(field, "method{Enter}");
    // A workspace tag's rename reaches every project, so it is confirmed first (FR-165), in a dialog (R468).
    expect(onRenameWorkspace).not.toHaveBeenCalled();
    const ask = screen.getByRole("dialog", { name: "Rename the workspace tag methods to method?" });
    expect(ask.textContent).toMatch(/every project/);
    await user.click(within(ask).getByRole("button", { name: "Rename" }));
    expect(onRenameWorkspace).toHaveBeenCalledWith("w1", "method");
    await user.click(screen.getByRole("button", { name: "Delete workspace tag methods" }));
    const confirm = screen.getByRole("group", { name: "Delete workspace tag methods?" });
    expect(confirm.textContent).toMatch(/every project/);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(onDeleteWorkspace).toHaveBeenCalledWith("w1");
  });

  it("cancelling a workspace tag's rename confirmation renames nothing (FR-165)", async () => {
    const onRenameWorkspace = vi.fn();
    const user = userEvent.setup();
    render(<TagList tags={TAGS.tags} workspaceTags={TAGS.workspaceTags} onSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onRenameWorkspace={onRenameWorkspace} onDeleteWorkspace={vi.fn()} onCreate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Rename workspace tag methods" }));
    const field = screen.getByLabelText("New name for methods");
    await user.clear(field);
    await user.type(field, "method{Enter}");
    await user.click(within(screen.getByRole("dialog", { name: "Rename the workspace tag methods to method?" })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onRenameWorkspace).not.toHaveBeenCalled();
  });

  // R468 (I1): the rename's confirmation is one of the app's dialogs — focus goes in (to its heading,
  // so the Enter that opened it, held or pressed again, confirms nothing: R376 c), Escape and Cancel
  // close it, and afterwards focus is on the tag's Rename button (the name field is closed by then).
  describe("the workspace tag rename confirmation's focus (FR-165, R468)", () => {
    const open = async () => {
      const onRenameWorkspace = vi.fn();
      const user = userEvent.setup();
      render(<TagList tags={TAGS.tags} workspaceTags={TAGS.workspaceTags} onSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onRenameWorkspace={onRenameWorkspace} onDeleteWorkspace={vi.fn()} onCreate={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: "Rename workspace tag methods" }));
      const field = screen.getByLabelText("New name for methods");
      await user.clear(field);
      await user.type(field, "method{Enter}");
      const dialog = screen.getByRole("dialog", { name: "Rename the workspace tag methods to method?" });
      return { user, onRenameWorkspace, dialog };
    };
    const renameButton = () => screen.getByRole("button", { name: "Rename workspace tag methods" });

    it("focus goes to the dialog's heading, and the Enter that opened it, pressed again, confirms nothing", async () => {
      const { user, onRenameWorkspace, dialog } = await open();
      expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Rename the workspace tag methods to method?" }));
      await user.keyboard("{Enter}{Enter}");
      expect(onRenameWorkspace).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog")).toBe(dialog);
    });

    it("Tab then Enter confirms once, and focus is back on the tag's Rename button", async () => {
      const { user, onRenameWorkspace, dialog } = await open();
      await user.tab();
      expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Rename" }));
      await user.keyboard("{Enter}");
      expect(onRenameWorkspace).toHaveBeenCalledTimes(1);
      expect(onRenameWorkspace).toHaveBeenCalledWith("w1", "method");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(renameButton());
    });

    it("Escape closes it as Cancel does, and focus is back on the tag's Rename button", async () => {
      const { user, onRenameWorkspace } = await open();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onRenameWorkspace).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(renameButton());
    });

    it("Cancel closes it, and focus is back on the tag's Rename button", async () => {
      const { user, onRenameWorkspace, dialog } = await open();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(onRenameWorkspace).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(renameButton());
    });
  });

  it("workspace tag buttons are off while read-only", () => {
    render(<TagList tags={[]} workspaceTags={TAGS.workspaceTags} readOnly onSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onRenameWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()} onCreate={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Rename workspace tag methods" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Delete workspace tag methods" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// Task 69 (M2): the date is shown in the researcher's own time zone, so the expected day comes from
// the machine's zone (getDate, not the formatter under test). Mid-November keeps month and year the
// same in every zone, so the test checks the local day and the wording wherever it runs.
const NOTICED_AT = "2026-11-15T12:00:00.000Z";
const NOTICED_TEXT = `No longer available at its source, noticed on Nov ${new Date(NOTICED_AT).getDate()}, 2026`;

describe("SourceTable", () => {
  it("shows title, creators and year; the title opens the source", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<SourceTable items={SOURCES.items} total={2} onOpen={onOpen} />);
    const table = screen.getByRole("table", { name: "Sources" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]!.textContent).toContain("Smith, Jane");
    expect(rows[1]!.textContent).toContain("2019");
    await user.click(within(table).getByRole("button", { name: "Ethnography at Work" }));
    expect(onOpen).toHaveBeenCalledWith("s1");
  });

  it("locked sources read as locked, with no title", () => {
    render(<SourceTable items={[{ id: "x", projectId: "p2", type: "book", title: "", creatorsText: "", folder: "f", needsReview: false, locked: true }]} total={1} onOpen={vi.fn()} />);
    expect(screen.getByText("Locked source")).toBeTruthy();
  });

  it("says in words when a source was found through its annotations (Task 58)", () => {
    const base = { projectId: "p1", type: "book", creatorsText: "", folder: "f", needsReview: false, locked: false };
    render(
      <SourceTable
        items={[
          { ...base, id: "a", title: "Found by annotation", matchedIn: "annotation" },
          { ...base, id: "b", title: "Found by title" },
        ]}
        total={2}
        onOpen={vi.fn()}
      />,
    );
    const rows = within(screen.getByRole("table", { name: "Sources" })).getAllByRole("row");
    expect(rows[1]!.textContent).toContain("Found in an annotation");
    expect(rows[2]!.textContent).not.toContain("annotation");
  });

  it("marks in words a source no longer available at its source, with the date it was noticed; nothing for an available, incomplete or unknown status (Task 69, D17)", () => {
    const base = { projectId: "p1", type: "social-post", creatorsText: "", folder: "f", needsReview: false, locked: false };
    render(
      <SourceTable
        items={[
          { ...base, id: "a", title: "Gone post", availability: { status: "unavailable-on-platform", firstNoticedAt: NOTICED_AT } },
          { ...base, id: "b", title: "Gone, date unknown", availability: { status: "unavailable-on-platform" } },
          { ...base, id: "c", title: "Present post", availability: { status: "available" } },
          { ...base, id: "d", title: "Part saved", availability: { status: "incomplete", firstNoticedAt: NOTICED_AT } },
          { ...base, id: "e", title: "Future", availability: { status: "some-future-status" } },
          { ...base, id: "f", title: "No field" },
        ]}
        total={6}
        onOpen={vi.fn()}
      />,
    );
    const rows = within(screen.getByRole("table", { name: "Sources" })).getAllByRole("row");
    const marks = screen.getAllByRole("note");
    expect(marks.map((m) => m.getAttribute("aria-label"))).toEqual([NOTICED_TEXT, "No longer available at its source"]);
    expect(within(rows[1]!).getByRole("note", { name: NOTICED_TEXT }).textContent).toBe(NOTICED_TEXT);
    expect(within(rows[2]!).getByRole("note").textContent).toBe("No longer available at its source");
    for (const r of rows.slice(3)) expect(r.textContent).not.toMatch(/available|noticed/i);
    // Words, not colour alone: a badge from the theme's classes.
    expect(marks[0]!.className).toContain("ao-badge");
  });

  it("the mark's words are set apart from \"Needs review\" in the row's text (Task 69 M4)", () => {
    const base = { projectId: "p1", type: "social-post", creatorsText: "", folder: "f", locked: false };
    render(<SourceTable items={[{ ...base, id: "a", title: "Gone post", needsReview: true, availability: { status: "unavailable-on-platform" } }]} total={1} onOpen={vi.fn()} reviewHref={(id) => `#/review/${id}`} />);
    const row = within(screen.getByRole("table", { name: "Sources" })).getAllByRole("row")[1]!;
    expect(row.textContent).toContain("Needs review No longer available at its source");
    expect(screen.getByRole("link", { name: "Needs review: Gone post" })).toBeTruthy();
  });

  it("says when only part of a source's annotations is searchable, when the index is incomplete, and when search covers titles only (R161)", () => {
    const base = { projectId: "p1", type: "book", creatorsText: "", folder: "f", needsReview: false, locked: false };
    const { rerender } = render(
      <SourceTable items={[{ ...base, id: "a", title: "Long one", matchedIn: "annotation", annotationsPartial: true }, { ...base, id: "b", title: "Short one" }]} total={2} onOpen={vi.fn()} />,
    );
    const rows = within(screen.getByRole("table", { name: "Sources" })).getAllByRole("row");
    expect(rows[1]!.textContent).toContain("Only part of its annotations is searchable");
    expect(rows[2]!.textContent).not.toContain("part of its annotations");
    expect(screen.queryByRole("note")).toBeNull();
    rerender(<SourceTable items={[]} total={0} onOpen={vi.fn()} incomplete />);
    // N3: a state and its remedy, not a rebuild that is not running.
    const note = screen.getByRole("note").textContent;
    expect(note).toMatch(/Annotations are not searchable yet: this library's search index needs rebuilding/);
    expect(note).toMatch(/rebuild-index/);
    expect(note).not.toMatch(/being/);
    rerender(<SourceTable items={[]} total={0} onOpen={vi.fn()} incomplete rebuilding />);
    expect(screen.getByRole("note").textContent).toMatch(/The search index is being rebuilt: annotations become searchable when it finishes/);
    rerender(<SourceTable items={[]} total={0} onOpen={vi.fn()} limited />);
    expect(screen.getByRole("note").textContent).toMatch(/only titles are searched/i);
  });
});

describe("JobsIndicator", () => {
  it("lists running background jobs with progress", () => {
    render(<JobsIndicator jobs={[{ key: "recheck:j1", label: "Rechecking sources", done: 2, total: 5 }]} />);
    const s = screen.getByRole("status", { name: "Background jobs" });
    expect(s.textContent).toContain("Rechecking sources 2/5");
    const bar = within(s).getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
  });

  it("is empty and silent with no jobs", () => {
    render(<JobsIndicator jobs={[]} />);
    expect(screen.getByRole("status", { name: "Background jobs" }).textContent).toBe("");
  });
});
