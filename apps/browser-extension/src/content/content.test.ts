import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import rawSelectors from "./selectors.json";
import { validateSelectors } from "./selectors-schema.js";
import { snapshotHtml } from "./index.js";
import { ProfileCollector } from "./profile-scroll.js";

const selectors = validateSelectors(rawSelectors);
const fixtureHtml = (name: string) => readFileSync(join(process.env.AO_FIXTURE_PAGES!, name), "utf8");

describe("snapshotHtml (pre-strip in the page; the service strips again)", () => {
  it("drops scripts, event handlers and javascript: links, leaving the page itself untouched", () => {
    const doc = new DOMParser().parseFromString(fixtureHtml("instagram-post.html"), "text/html");
    doc.body.insertAdjacentHTML("beforeend", `<a id="j" href=" javascript:alert(1)">x</a><img id="i" src="/a.png" onerror="alert(1)"><noscript><img src="/track"></noscript>`);
    const html = snapshotHtml(doc);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<noscript/i);
    expect(html).not.toContain("should-be-stripped");
    expect(html).not.toContain("also-stripped");
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).toContain("Morning light over the estuary.");
    expect(html).toContain('id="i"');
    // The live document is not modified.
    expect(doc.querySelectorAll("script")).toHaveLength(2);
    expect(doc.body.getAttribute("onload")).toBe("void 0");
  });
});

describe("ProfileCollector (profile as I scroll)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("only observes: counts post links as the user scrolls, never clicks, follows or scrolls", () => {
    document.open();
    document.write(fixtureHtml("instagram-profile.html"));
    document.close();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    const click = vi.spyOn(HTMLElement.prototype, "click");
    const intoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = intoView;
    const counts: number[] = [];
    const c = new ProfileCollector(document, window, "https://www.instagram.com/fieldnotes.example/", selectors, (n) => counts.push(n), { throttleMs: 0 });
    c.start();
    expect(c.count).toBe(6);

    // The user scrolls and the page loads more posts.
    const row = document.createElement("div");
    row.innerHTML = `<a href="/p/C0FAKEPOST7/"></a><a href="/p/C0FAKEPOST1/"></a>`;
    document.querySelector("main")!.append(row);
    window.dispatchEvent(new Event("scroll"));
    expect(c.count).toBe(7);
    expect(counts.at(-1)).toBe(7);

    const urls = c.stop();
    expect(urls).toHaveLength(7);
    expect(urls.at(-1)).toBe("https://www.instagram.com/p/C0FAKEPOST7/");
    // Stopped: further scrolling adds nothing.
    row.insertAdjacentHTML("beforeend", `<a href="/p/C0FAKEPOST8/"></a>`);
    window.dispatchEvent(new Event("scroll"));
    expect(c.count).toBe(7);

    expect(scrollTo).not.toHaveBeenCalled();
    expect(scrollBy).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(intoView).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain("/p/");
  });

  it("stops at 500 links (the service's per-request limit)", () => {
    document.open();
    document.write(`<main>${Array.from({ length: 600 }, (_, i) => `<a href="/p/P${String(i).padStart(5, "0")}/"></a>`).join("")}</main>`);
    document.close();
    const c = new ProfileCollector(document, window, "https://www.instagram.com/someone/", selectors, () => {}, { throttleMs: 0 });
    c.start();
    expect(c.count).toBe(500);
    expect(c.full).toBe(true);
    c.stop();
  });
});
