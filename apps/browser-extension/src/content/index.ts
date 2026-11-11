/**
 * The content script, injected only when the user clicks a capture button (scripting.executeScript,
 * on the tab the popup was opened on; no persistent content scripts). It installs one object in the
 * extension's isolated world that the background calls step by step:
 *  - collect(selectors): extracted fields + the HTML snapshot (scripts removed here; the service
 *    strips again, authoritatively);
 *  - the screenshot's page-side steps (measure, scroll, hide fixed bars, restore);
 *  - profile as I scroll: start / status / stop.
 */
import type { ExtractedPage } from "../types.js";
import { extractPage } from "./extractors/index.js";
import { ProfileCollector, ProfileOverlay } from "./profile-scroll.js";
import { PageScroller, type PageMetrics } from "./screenshot.js";
import { validateSelectors } from "./selectors-schema.js";

/** The service refuses HTML snapshots over 5 MB characters. */
export const MAX_HTML_CHARS = 5 * 1024 * 1024;

const URL_ATTRS = ["href", "src", "action", "formaction", "xlink:href", "poster", "data", "background"];

/** document.documentElement.outerHTML of a copy without scripts, event handlers or javascript: URLs. */
export function snapshotHtml(doc: Document): string {
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  for (const el of Array.from(root.querySelectorAll("script, noscript"))) el.remove();
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(a.name);
      else if (URL_ATTRS.includes(name) && /^\s*(javascript|vbscript):/i.test(a.value)) el.removeAttribute(a.name);
    }
  }
  return `<!DOCTYPE html>\n${root.outerHTML}`;
}

export interface Collected {
  url: string;
  extracted: ExtractedPage;
  html?: string;
  htmlNote?: string;
}

export interface ProfileState {
  active: boolean;
  count: number;
}

export interface ContentApi {
  collect(selectors: unknown): Collected;
  screenshotStart(): PageMetrics;
  screenshotScroll(y: number): Promise<number>;
  screenshotHideFixed(): void;
  screenshotRestore(): void;
  profileStart(selectors: unknown): ProfileState;
  profileStatus(): ProfileState;
  profileStop(): string[];
}

export interface PageMessenger {
  finish(urls: string[]): Promise<{ ok: boolean; message: string } | undefined>;
  cancel(): void;
}

export function createContentApi(win: Window, messenger: PageMessenger): ContentApi {
  let scroller: PageScroller | undefined;
  let profile: { collector: ProfileCollector; overlay: ProfileOverlay } | undefined;

  const endProfile = (): string[] => {
    if (!profile) return [];
    const urls = profile.collector.stop();
    profile.overlay.remove();
    profile = undefined;
    return urls;
  };

  return {
    collect(selectors) {
      const s = validateSelectors(selectors);
      const doc = win.document;
      const url = win.location.href;
      const extracted = extractPage(doc, url, s);
      const html = snapshotHtml(doc);
      return html.length <= MAX_HTML_CHARS ? { url, extracted, html } : { url, extracted, htmlNote: "The page's HTML is larger than 5 MB, so only the screenshot was kept." };
    },
    screenshotStart() {
      scroller?.restore();
      scroller = new PageScroller(win);
      return scroller.metrics();
    },
    screenshotScroll(y) {
      if (!scroller) throw new Error("No screenshot in progress.");
      return scroller.scrollTo(y);
    },
    screenshotHideFixed() {
      scroller?.hideFixed();
    },
    screenshotRestore() {
      scroller?.restore();
      scroller = undefined;
    },
    profileStart(selectors) {
      const s = validateSelectors(selectors);
      if (!profile) {
        const overlay = new ProfileOverlay(win.document, {
          finish: () => {
            const p = profile;
            if (!p) return;
            profile = undefined;
            const urls = p.collector.stop();
            p.overlay.done(`Sending ${urls.length} link${urls.length === 1 ? "" : "s"}…`);
            const close = (text: string) => {
              p.overlay.done(text);
              setTimeout(() => p.overlay.remove(), 8000);
            };
            messenger.finish(urls).then(
              (r) => close(r?.message ?? "Sent."),
              () => close("The extension could not be reached. Open it to try again."),
            );
          },
          cancel: () => {
            endProfile();
            messenger.cancel();
          },
        });
        const collector = new ProfileCollector(win.document, win, win.location.href, s, (n) => overlay.setCount(n, collector.full));
        profile = { collector, overlay };
        collector.start();
      }
      return { active: true, count: profile.collector.count };
    },
    profileStatus() {
      return { active: !!profile, count: profile?.collector.count ?? 0 };
    },
    profileStop: endProfile,
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __aoCapture: ContentApi | undefined;
}
