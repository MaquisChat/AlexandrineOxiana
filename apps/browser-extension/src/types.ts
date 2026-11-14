/** What an extractor read from the page (the `extracted` field of POST /capture/browser). */
export interface ExtractedPage {
  platform: string;
  kind: string;
  canonicalUrl: string;
  postId?: string;
  handle?: string;
  displayName?: string;
  caption?: string;
  /** ISO 8601, exactly as the page states it. */
  postedAt?: string;
  counts?: { likes?: number; comments?: number; views?: number; shares?: number };
  mediaUrls: string[];
}

/** A project as GET /projects answers the extension. */
export interface ProjectChoice {
  id: string;
  name: string;
  captureMethods: string[];
}

/** POST /capture/browser body (apps/library-service/src/routes/capture.ts). */
export interface BrowserCaptureBody {
  projectId: string;
  url: string;
  extracted: ExtractedPage;
  /** PNG, standard base64. */
  screenshotPng?: string;
  html?: string;
  alsoDownload: boolean;
}

export interface BrowserCaptureResult {
  sourceId: string;
  status: "created" | "merged";
  htmlNote?: string;
}

/** Messages the popup and the page overlay send to the background. */
export type BackgroundRequest =
  | { type: "capture-page"; tabId: number; projectId: string; alsoDownload: boolean }
  | { type: "profile-start"; tabId: number; projectId: string }
  | { type: "profile-status"; tabId: number }
  | { type: "profile-finish"; tabId: number }
  | { type: "profile-cancel"; tabId: number }
  | { type: "pending-retry"; projectId: string }
  | { type: "pending-discard"; projectId: string }
  /** Find and acquire, the browser's fallback (R348 i; find.ts): the list, whether a sending runs, the last result (taken once), the sending. */
  | { type: "find-waiting" }
  | { type: "find-status" }
  | { type: "find-result" }
  | { type: "find-send"; tabId: number; ticket: string }
  /** From the in-page overlay (sender.tab is checked). */
  | { type: "overlay-finish"; urls: string[] }
  | { type: "overlay-cancel" };

export interface CaptureReply {
  ok: boolean;
  message: string;
  sourceId?: string;
}

export interface ProfileStatus {
  active: boolean;
  count: number;
  left?: boolean;
  projectId?: string;
}

