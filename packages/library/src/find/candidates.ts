/**
 * Task F2 declares the candidates' module (search, merging, the decision). Task F3 needs only this type, to
 * give `FindEntry` its candidates; it is copied here exactly as F2's Interfaces give it, and the coordinator
 * keeps F2's file at the merge.
 */
import type { Creator, SourceType } from "@ao/core";

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
