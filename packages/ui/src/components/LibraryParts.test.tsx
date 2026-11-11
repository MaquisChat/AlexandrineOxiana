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
    expect(onRenameWorkspace).toHaveBeenCalledWith("w1", "method");
    await user.click(screen.getByRole("button", { name: "Delete workspace tag methods" }));
    const confirm = screen.getByRole("group", { name: "Delete workspace tag methods?" });
    expect(confirm.textContent).toMatch(/every project/);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(onDeleteWorkspace).toHaveBeenCalledWith("w1");
  });

  it("workspace tag buttons are off while read-only", () => {
    render(<TagList tags={[]} workspaceTags={TAGS.workspaceTags} readOnly onSelect={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()} onRenameWorkspace={vi.fn()} onDeleteWorkspace={vi.fn()} onCreate={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Rename workspace tag methods" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Delete workspace tag methods" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

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
