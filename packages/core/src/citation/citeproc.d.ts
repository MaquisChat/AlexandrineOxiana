// Minimal typings for citeproc-js (npm `citeproc`, pinned 2.4.63), the parts used by render.ts.
declare module "citeproc" {
  interface CiteprocSys {
    retrieveLocale(lang: string): string | undefined | false;
    retrieveItem(id: string): unknown;
  }
  interface BibliographyMeta {
    bibstart: string;
    bibend: string;
    [k: string]: unknown;
  }
  class Engine {
    constructor(sys: CiteprocSys, style: string, lang?: string, forceLang?: boolean);
    setOutputFormat(format: "text" | "html" | "rtf"): void;
    updateItems(ids: string[]): void;
    restoreProcessorState(citations: unknown[]): void;
    makeBibliography(): [BibliographyMeta, string[]] | false;
    makeCitationCluster(items: Array<{ id: string; locator?: string; label?: string }>): string;
  }
  const CSL: { Engine: typeof Engine };
  export default CSL;
}
