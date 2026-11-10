export declare const SCHEMA: string;
export declare const NOTE_HTML: string;
export declare function buildZoteroFixture(
  dir: string,
  o: { pdf: Buffer; linkedPdf: Buffer; linkedDir: string; trashedPdf?: Buffer; bbt?: boolean },
): { dir: string; db: string; bbtDb?: string; storagePdf: string; linkedPdf: string };
