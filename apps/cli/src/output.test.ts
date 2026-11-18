import { describe, expect, it } from "vitest";
import { itemLines, itemView, safeUrl } from "./output.js";

describe("the command line prints the cleaned address (R379, WB1 M7)", () => {
  it("no user name, password, secret parameter, tracking parameter or fragment; the rest stays", () => {
    const url = "https://ana:hunter2@portal.example.org/case/7?id=7&access_token=SECRETTOKEN&sessionid=SESS&utm_source=x#frag";
    expect(safeUrl(url)).toBe("https://portal.example.org/case/7?id=7");
    const v = itemView({ url, status: "failed", reason: "This link is not a YouTube, Instagram or TikTok post." } as never);
    const printed = JSON.stringify(v) + itemLines(v).join("\n");
    for (const bad of ["ana", "hunter2", "SECRETTOKEN", "SESS", "utm_", "frag"]) expect(printed, bad).not.toContain(bad);
    expect(v.url).toBe("https://portal.example.org/case/7?id=7");
  });
});

describe("an address of another scheme is printed without its user information (R415 e, FR-A11 review 2 M4)", () => {
  it("the --json document's item holds no user name or password; plain text is printed as given", () => {
    const v = itemView({ url: "ftp://ana:hunter2@files.example.org/x", status: "failed", reason: "This link is not a YouTube, Instagram or TikTok post." } as never);
    const doc = JSON.stringify({ items: [v] }, null, 2);
    expect(doc).not.toMatch(/ana|hunter2/);
    expect(v.url).toBe("ftp://files.example.org/x");
    expect(safeUrl("sftp://ana:hunter2@host/a")).toBe("sftp://host/a");
    expect(safeUrl("plain words")).toBe("plain words");
    expect(safeUrl("mailto:ana@example.org")).toBe("mailto:ana@example.org");
  });
});
