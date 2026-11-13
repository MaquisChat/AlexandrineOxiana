import type { Creator, SourceType } from "@ao/core";

/**
 * A work a search service offered for a typed reference (Find and acquire, F2): merged across
 * services, every string bounded (title ≤ 1,000 characters, a name ≤ 200, at most 100 creators).
 * `id` is stable for the same work (derived from its DOI, else its ISBN, else title, first family
 * name and year); `providers` lists every service that gave it, in the order asked.
 */
export type WorkCandidate = {
  id: string;
  title: string;
  creators: Creator[];
  issued?: string;
  type: SourceType;
  container?: string;
  publisher?: string;
  identifiers: { doi?: string; isbn?: string[] };
  providers: string[];
};
