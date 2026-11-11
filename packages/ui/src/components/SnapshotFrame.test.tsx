import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SNAPSHOT_CSP, SnapshotFrame, snapshotDocument } from "./SnapshotFrame";

describe("<SnapshotFrame> (captured web pages, for Tasks 33/34)", () => {
  const blobs = new Map<string, Blob>();
  let n = 0;
  beforeEach(() => {
    blobs.clear();
    URL.createObjectURL = vi.fn((b: Blob) => {
      const url = `blob:http://localhost/${++n}`;
      blobs.set(url, b);
      return url;
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn((u: string) => void blobs.delete(u)) as typeof URL.revokeObjectURL;
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders the snapshot in a fully sandboxed iframe (no scripts, no same-origin) from a blob: document", () => {
    render(<SnapshotFrame html="<p>Captured</p>" title="Snapshot of example.org" />);
    const frame = screen.getByTitle("Snapshot of example.org") as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("src")).toMatch(/^blob:/);
    expect(frame.getAttribute("srcdoc")).toBeNull();
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("the document carries a CSP with script-src 'none' before any snapshot content", async () => {
    expect(SNAPSHOT_CSP).toMatch(/script-src 'none'/);
    expect(SNAPSHOT_CSP).toMatch(/default-src 'none'/);
    const doc = snapshotDocument('<html><head><meta http-equiv="Content-Security-Policy" content="script-src *"></head><body><script>alert(1)</script></body></html>');
    const csp = doc.indexOf(`content="${SNAPSHOT_CSP}"`);
    expect(csp).toBeGreaterThan(-1);
    expect(csp).toBeLessThan(doc.indexOf("<html>"));
    render(<SnapshotFrame html="<b>x</b>" title="t" />);
    const url = (screen.getByTitle("t") as HTMLIFrameElement).getAttribute("src")!;
    const text = await new Promise<string>((resolve) => {
      const fr = new FileReader(); // jsdom's Blob has no .text()
      fr.onload = () => resolve(String(fr.result));
      fr.readAsText(blobs.get(url)!);
    });
    expect(text.startsWith("<!doctype html>")).toBe(true);
    expect(text).toContain(SNAPSHOT_CSP);
    expect(blobs.get(url)!.type).toBe("text/html");
  });

  it("revokes the blob URL when unmounted or when the snapshot changes", () => {
    const { rerender, unmount } = render(<SnapshotFrame html="<p>a</p>" title="t" />);
    const first = (screen.getByTitle("t") as HTMLIFrameElement).getAttribute("src")!;
    rerender(<SnapshotFrame html="<p>b</p>" title="t" />);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(first);
    const second = (screen.getByTitle("t") as HTMLIFrameElement).getAttribute("src")!;
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(second);
  });
});
