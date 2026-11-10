export declare function stripHtml(html: string): string;
export declare function stripOnce(html: string): string;
export declare function prescan(html: string): string | null;
export declare function cleanUrl(value: string): string | null;
export declare function cleanCss(css: string): string;
export declare const SNAPSHOT_CSP: string;
export declare const PRESCAN_LIMITS: { depth: number; attributes: number; elements: number };
export declare class SnapshotRefused extends Error {}
