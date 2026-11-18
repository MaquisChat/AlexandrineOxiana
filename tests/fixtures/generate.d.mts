export declare const FIXTURE_DOI: string;
export declare const FIXTURE_ISBN: string;
export declare function buildZip(entries: { name: string; data: Buffer | string; store?: boolean; declaredSize?: number; unixMode?: number }[]): Buffer;
export declare function tinyPng(): Buffer;
export declare function tinyTiff(): Buffer;
export declare function buildMobi(opts?: { exth?: [number, string][]; fullName?: string; corruptExth?: boolean }): Buffer;
export declare function buildPdf(opts?: { title?: string; author?: string; lines?: string[]; extra?: string }): Promise<Buffer>;
export declare function buildDoiPdf(): Promise<Buffer>;
/** Reader fixtures (Task R6): see generate.mjs for what each page holds. */
export declare function buildTwoColumnPdf(): Promise<Buffer>;
export declare function buildScanPdf(pages: number): Promise<Buffer>;
export declare function buildRotatedCropPdf(): Promise<Buffer>;
export declare function buildMultiPagePdf(pages: number): Promise<Buffer>;
export declare function buildDamagedPdf(): Buffer;
export declare function buildRangeReadPdf(pages: number): Promise<Buffer>;
export declare function buildCjkPdf(): Promise<Buffer>;
export declare function buildCameraTiff(path: string): Promise<void>;
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
export interface ImportFolderFixture {
  doiPdf: string;
  zip: string;
  corruptPdf: string;
  duplicate: string;
  /** The 20 generated PDFs (the first is the DOI article; the second has a duplicate). */
  generated: string[];
  /** Importable items in the folder (24). */
  items: number;
}
export declare function buildImportFolder(dir: string): Promise<ImportFolderFixture>;
