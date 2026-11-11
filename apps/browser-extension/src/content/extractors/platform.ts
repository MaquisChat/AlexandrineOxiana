/** What each platform module provides: recognising its pages from the address (not the DOM). */
export interface PageIdentity {
  kind: string;
  postId?: string;
  /** The account named in the address, if any. */
  handle?: string;
  /** The page's address in its plain form, used when the page has no usable canonical link. */
  canonical: string;
}

export interface PlatformExtractor {
  name: "instagram" | "tiktok" | "youtube";
  hosts: readonly string[];
  identify(u: URL): PageIdentity | undefined;
  /** A link to one of the platform's posts/videos, in its plain form; undefined for anything else. */
  postLink(u: URL): string | undefined;
}
