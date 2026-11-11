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

describe("TagList", () => {
  it("project tags can be renamed and deleted; workspace tags say where they are managed", async () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(<TagList tags={TAGS.tags} workspaceTags={TAGS.workspaceTags} onSelect={vi.fn()} onRename={onRename} onDelete={onDelete} onCreate={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Rename tag methods" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Rename tag to read" }));
    const field = screen.getByLabelText("New name for to read");
    await user.clear(field);
    await user.type(field, "reading{Enter}");
    expect(onRename).toHaveBeenCalledWith("t1", "reading");
    await user.click(screen.getByRole("button", { name: "Delete tag to read" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("t1");
    expect(screen.getByText(/Workspace tags are shared by every project/)).toBeTruthy();
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
