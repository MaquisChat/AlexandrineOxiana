/**
 * The address classifier lives in @ao/core (packages/core/src/capture/platforms.ts): one definition
 * for the library and the interface (R146, Task 63). Re-exported here for the capture modules.
 */
export { classifyUrl, isCollectionLink, isPostLink, isWebAddress } from "@ao/core";
export type { ClassifiedUrl, LinkKind, Platform } from "@ao/core";
