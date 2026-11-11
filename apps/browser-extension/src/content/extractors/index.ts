/**
 * extractPage(doc, url): what the page shows, per platform. The page kind and post id come from the
 * address; every other field is read through selectors.json, and a field the selectors do not find
 * exactly is left out (never guessed).
 */
import defaultSelectors from "../selectors.json";
import type { ExtractedPage } from "../../types.js";
import { validateSelectors, type SelectorsConfig } from "../selectors-schema.js";
import { absoluteUrl, canonicalOn, readAll, readCommon } from "./engine.js";
import { extractGeneric } from "./generic.js";
import { instagram } from "./instagram.js";
import type { PlatformExtractor } from "./platform.js";
import { tiktok } from "./tiktok.js";
import { youtube } from "./youtube.js";

export const PLATFORM_EXTRACTORS: readonly PlatformExtractor[] = [instagram, tiktok, youtube];

/** The service takes at most 500 links per capture request. */
export const MAX_POST_LINKS = 500;

let bundled: SelectorsConfig | undefined;
const bundledSelectors = (): SelectorsConfig => (bundled ??= validateSelectors(defaultSelectors));

export function platformFor(url: string): PlatformExtractor | undefined {
  const u = absoluteUrl(url, url);
  return u ? PLATFORM_EXTRACTORS.find((p) => p.hosts.includes(u.hostname)) : undefined;
}

export function extractPage(doc: Document, url: string, selectors: SelectorsConfig = bundledSelectors()): ExtractedPage {
  const u = absoluteUrl(url, url);
  const platform = platformFor(url);
  const id = u && platform?.identify(u);
  if (!u || !platform) return extractGeneric(doc, url, selectors);
  if (!id) return { platform: platform.name, kind: "page", canonicalUrl: u.href, mediaUrls: [] };

  const page = selectors.platforms[platform.name].pages[id.kind];
  const common = readCommon(doc, url, page);
  const handle = common.handle ?? id.handle;
  return {
    platform: platform.name,
    kind: id.kind,
    canonicalUrl: canonicalOn(doc, url, page, platform.hosts) ?? id.canonical,
    ...(id.postId ? { postId: id.postId } : {}),
    ...(handle ? { handle } : {}),
    ...(common.displayName ? { displayName: common.displayName } : {}),
    ...(common.caption ? { caption: common.caption } : {}),
    ...(common.postedAt ? { postedAt: common.postedAt } : {}),
    ...(common.counts ? { counts: common.counts } : {}),
    mediaUrls: common.mediaUrls,
  };
}

/** Links to posts currently in the page (profile pages), in page order, deduplicated, on the platform only. */
export function collectPostLinks(doc: ParentNode, url: string, selectors: SelectorsConfig = bundledSelectors(), seen: Set<string> = new Set()): string[] {
  const u = absoluteUrl(url, url);
  const platform = platformFor(url);
  const id = u && platform?.identify(u);
  if (!platform || !id) return [];
  const alts = selectors.platforms[platform.name].pages[id.kind]?.postLinks ?? [];
  const out: string[] = [];
  for (const alt of alts) {
    for (const href of readAll(doc, alt)) {
      if (seen.size >= MAX_POST_LINKS) return out;
      const target = absoluteUrl(href, url);
      const link = target && platform.postLink(target);
      if (link && !seen.has(link)) {
        seen.add(link);
        out.push(link);
      }
    }
  }
  return out;
}
