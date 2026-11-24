/**
 * The page of the shell's closing window (FR-297, R470 c): a static page of the interface's build
 * with one sentence and no controls, which reaches neither the service nor the shell; its colours
 * follow light and dark from the theme's tokens.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setMedia } from "../test/media";
import { followSystemTheme } from "./closingPage";

const here = dirname(fileURLToPath(import.meta.url));
const UI = join(here, "..", "..");
const html = readFileSync(join(UI, "closing.html"), "utf8");

const TITLE = "Closing Alexandrine Oxiana";
const SENTENCE = "Your library is being closed safely. This can take up to a minute and a half.";

function pageDocument(): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("closing.html", () => {
  it("is titled “Closing Alexandrine Oxiana” and says one sentence, as real text", () => {
    const doc = pageDocument();
    expect(doc.title).toBe(TITLE);
    expect(doc.documentElement.lang).toBe("en");
    expect(doc.body.textContent!.replace(/\s+/g, " ").trim()).toBe(SENTENCE);
    expect(doc.querySelector("main p")?.textContent?.trim()).toBe(SENTENCE);
  });

  it("has no controls: nothing to press, type into, follow or submit", () => {
    const doc = pageDocument();
    expect(doc.querySelectorAll("button, a, input, select, textarea, form, details, [tabindex], [contenteditable], [role=button], [role=link], iframe, object, embed")).toHaveLength(0);
  });

  it("runs only its own theme script, and carries the app's content-security policy exactly", () => {
    const doc = pageDocument();
    const scripts = [...doc.querySelectorAll("script")];
    expect(scripts.map((s) => [s.getAttribute("type"), s.getAttribute("src"), s.textContent!.trim()])).toEqual([["module", "/src/closing/closing.ts", ""]]);
    const csp = (d: Document) => [...d.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')].map((m) => m.getAttribute("content"));
    const index = new DOMParser().parseFromString(readFileSync(join(UI, "index.html"), "utf8"), "text/html");
    expect(csp(doc)).toHaveLength(1);
    expect(csp(doc)).toEqual(csp(index));
  });

  it("its script imports only the theme's stylesheets and the theme switch: no service, no shell, no app code", () => {
    const imports = (file: string) => [...readFileSync(join(here, file), "utf8").matchAll(/^\s*import\s+(?:[^"']*\sfrom\s+)?["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports("closing.ts")).toEqual(["../theme/tokens.css", "../theme/fonts.css", "../theme/base.css", "./closing.css", "./closingPage"]);
    expect(imports("closingPage.ts")).toEqual([]);
    for (const f of ["closing.ts", "closingPage.ts"]) {
      const src = readFileSync(join(here, f), "utf8");
      for (const word of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "__TAURI", "invoke", "innerHTML", "localStorage"]) expect(src, `${f}: ${word}`).not.toContain(word);
    }
  });

  it("the build makes it a page of its own beside the app (vite.config.ts)", () => {
    const config = readFileSync(join(UI, "vite.config.ts"), "utf8");
    expect(config).toMatch(/closing:\s*fileURLToPath\(new URL\("\.\/closing\.html", import\.meta\.url\)\)/);
  });
});

describe("followSystemTheme", () => {
  it("puts the system's light or dark on the page's root, and follows a change", () => {
    setMedia({ dark: false });
    const root = document.documentElement;
    followSystemTheme(window);
    expect(root.dataset.theme).toBe("light");
    setMedia({ dark: true });
    expect(root.dataset.theme).toBe("dark");
    setMedia({ dark: false });
    expect(root.dataset.theme).toBe("light");
  });

  it("starts dark when the system is dark", () => {
    setMedia({ dark: true });
    followSystemTheme(window);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
