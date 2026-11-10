export declare const FIXTURE_DOI: string;
export declare const FIXTURE_ISBN: string;
export declare function buildZip(entries: { name: string; data: Buffer | string; store?: boolean; declaredSize?: number }[]): Buffer;
export declare function tinyPng(): Buffer;
export declare function tinyTiff(): Buffer;
export declare function buildMobi(opts?: { exth?: [number, string][]; fullName?: string; corruptExth?: boolean }): Buffer;
export declare function buildPdf(opts?: { title?: string; author?: string; lines?: string[]; extra?: string }): Promise<Buffer>;
export declare function buildDoiPdf(): Promise<Buffer>;
export interface GeneratedFixtures {
  doiPdf: string;
  scannedPdf: string;
  scriptPdf: string;
  epub: string;
  traversalEpub: string;
  oversizeEpub: string;
  manyEntriesEpub: string;
  docx: string;
  html: string;
  mobi: string;
  corruptMobi: string;
  truncatedMobi: string;
  cameraTiff: string;
}
export declare function generateFixtures(outDir: string): Promise<GeneratedFixtures>;
