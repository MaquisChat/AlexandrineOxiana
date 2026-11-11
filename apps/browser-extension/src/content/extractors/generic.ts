/** Any other site: the page's own metadata (canonical link, Open Graph title/image, publication time). */
import type { ExtractedPage } from "../../types.js";
import type { SelectorsConfig } from "../selectors-schema.js";
import { absoluteUrl, canonicalOn, readCommon } from "./engine.js";

export function extractGeneric(doc: Document, url: string, selectors: SelectorsConfig): ExtractedPage {
  const page = selectors.platforms.generic.pages.page;
  const here = absoluteUrl(url, url);
  const common = readCommon(doc, url, page);
  return {
    platform: "web",
    kind: "page",
    // A canonical link is accepted only on the page's own host.
    canonicalUrl: canonicalOn(doc, url, page, here ? [here.hostname] : []) ?? here?.href ?? url,
    ...(common.caption ? { caption: common.caption } : {}),
    ...(common.postedAt ? { postedAt: common.postedAt } : {}),
    mediaUrls: common.mediaUrls,
  };
}
