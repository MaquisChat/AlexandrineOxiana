import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBanner, bannersFor, volumeOf } from "./StatusBanner";

describe("StatusBanner", () => {
  it("read-only, locked by another computer", () => {
    render(<StatusBanner variant={{ kind: "read-only-locked", hostname: "lab-mac" }} />);
    expect(screen.getByRole("status").textContent).toContain("Read-only — locked by lab-mac");
  });

  it("read-only, locked, holder unknown", () => {
    render(<StatusBanner variant={{ kind: "read-only-locked" }} />);
    expect(screen.getByRole("status").textContent).toContain("Read-only — locked by another device");
  });

  it("read-only, newer format", () => {
    render(<StatusBanner variant={{ kind: "read-only-newer-format" }} />);
    expect(screen.getByRole("status").textContent).toContain("Read-only — newer format");
  });

  it("offline, reconnecting when the volume returns", () => {
    render(<StatusBanner variant={{ kind: "offline", volume: "Fieldwork SSD" }} />);
    expect(screen.getByRole("status").textContent).toContain("Offline — reconnecting when Fieldwork SSD returns");
  });

  it("index rebuilding N/M", () => {
    render(<StatusBanner variant={{ kind: "index-rebuilding", done: 3, total: 10 }} />);
    expect(screen.getByRole("status").textContent).toContain("Index rebuilding 3/10");
  });

  it.each([
    ["backup-failed", /last automatic backup of Dissertation failed/],
    ["deleted-records-unreadable", /record of deleted items in Dissertation could not be read/],
    ["annotations-unreadable", /annotations in Dissertation could not be read/],
    ["destroy-incomplete", /destruction of raw data in Dissertation did not finish/],
    ["retention-due", /Dissertation has reached its retention date/],
    ["anchor-missing", /audit log may have been changed outside the app/],
  ])("warning %s in plain language", (warning, text) => {
    render(<StatusBanner variant={{ kind: "warning", warning, project: "Dissertation" }} />);
    expect(screen.getByRole("status").textContent).toMatch(text);
    // never the raw code
    expect(screen.getByRole("status").textContent).not.toContain(warning);
  });

  it("an unknown warning shows the service's own detail", () => {
    render(<StatusBanner variant={{ kind: "warning", warning: "txn-recovery-skipped", project: "library", detail: "a change was kept for review" }} />);
    expect(screen.getByRole("status").textContent).toContain("a change was kept for review");
  });
});

describe("bannersFor", () => {
  it("maps library state, warnings and index progress to banners", () => {
    const b = bannersFor(
      {
        mode: "read-only",
        readOnlyReason: "locked-by-other-device",
        integrityWarnings: [{ projectId: "*", project: "library", kind: "anchor-missing", detail: "x" }],
        projectWarnings: { p1: ["backup-failed"] },
      },
      { projectNames: { p1: "Dissertation" }, index: { done: 1, total: 4 }, volume: "Fieldwork SSD" },
    );
    expect(b.map((v) => v.kind)).toEqual(["read-only-locked", "index-rebuilding", "warning", "warning"]);
  });

  it("offline libraries name the volume", () => {
    expect(bannersFor({ mode: "read-only", readOnlyReason: "offline" }, { volume: "Fieldwork SSD" })).toEqual([{ kind: "offline", volume: "Fieldwork SSD" }]);
  });
});

describe("volumeOf", () => {
  it("names the drive a library lives on", () => {
    expect(volumeOf("/Volumes/Fieldwork SSD/Thesis library")).toBe("Fieldwork SSD");
    expect(volumeOf("/media/r/USB STICK/Lib")).toBe("USB STICK");
    expect(volumeOf("E:\\Research\\Lib")).toBe("E:");
    expect(volumeOf("\\\\nas\\share\\Lib")).toBe("\\\\nas\\share");
    expect(volumeOf("/home/r/Lib")).toBe("the drive holding Lib");
  });
});
