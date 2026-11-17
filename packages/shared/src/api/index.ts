/**
 * Request and response shapes of the service's routes, declared once for the service and the UI
 * (Task 34a starts this; Task 47 adds the capture, transcript, verification, review-queue,
 * media-ticket and pairing routes and the error codes). The service types each handler's answer by
 * these, and the interface's API modules use them, so a change on one side breaks the other's build.
 */
export * from "./fonts.js";
export * from "./import-setup.js";
export * from "./media.js";
export * from "./pairing.js";
export * from "./sources.js";
export * from "./transcripts.js";
export * from "./attention.js";
export * from "./tools.js";
export * from "./review.js";
export * from "./capture.js";
export * from "./errors.js";
export * from "./settings-reset.js";
export * from "./device-notices.js";
export * from "./annotations.js";
export * from "./documents.js";
export * from "./watched-folders.js";
export * from "./find.js";
export * from "./zotero-sync.js";
export * from "./search-settings.js";
export * from "./destruction.js";
