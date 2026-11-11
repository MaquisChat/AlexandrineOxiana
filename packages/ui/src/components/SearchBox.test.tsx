import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchBox } from "./SearchBox";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SearchBox", () => {
  it("calls onSearch once, 250 ms after the last change", () => {
    const onSearch = vi.fn();
    render(<SearchBox label="Search sources" onSearch={onSearch} />);
    const box = screen.getByRole("searchbox", { name: "Search sources" });
    fireEvent.change(box, { target: { value: "e" } });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.change(box, { target: { value: "et" } });
    act(() => vi.advanceTimersByTime(249));
    expect(onSearch).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith("et");
  });

  it("Escape clears the search at once", () => {
    const onSearch = vi.fn();
    render(<SearchBox label="Search sources" onSearch={onSearch} />);
    const box = screen.getByRole("searchbox", { name: "Search sources" }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "abc" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.value).toBe("");
    expect(onSearch).toHaveBeenCalledWith("");
    act(() => vi.advanceTimersByTime(500));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });
});
