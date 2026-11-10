/** Confidence scoring for imported metadata. Pure and platform-neutral. */

export type Evidence = {
  method:
    | "reference-metadata"
    | "embedded"
    | "identifier+lookup"
    | "sidecar"
    | "filename"
    | "filename+lookup"
    | "lookup-title-match"
    | "none";
  titleSimilarity?: number;
  /** For `embedded`: which fields were present. 0.70 needs both; otherwise 0.55. */
  hasTitle?: boolean;
  hasCreator?: boolean;
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function scoreConfidence(e: Evidence): number {
  switch (e.method) {
    case "reference-metadata": return 0.9;
    case "identifier+lookup": return 0.97;
    case "sidecar": return 0.85;
    case "embedded": return e.hasTitle === true && e.hasCreator === true ? 0.7 : 0.55;
    case "filename": return 0.5;
    case "filename+lookup":
    case "lookup-title-match": {
      const sim = Math.min(1, Math.max(0, e.titleSimilarity ?? 0)) || 0;
      return sim >= 0.9 ? round3(0.5 + 0.3 * sim) : 0.5;
    }
    case "none": return 0.2;
  }
}
