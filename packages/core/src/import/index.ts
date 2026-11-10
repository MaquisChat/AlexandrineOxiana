export { findIdentifiers, toIsbn13 } from "./identifiers.js";
export type { FoundIdentifiers } from "./identifiers.js";
export { MAX_NAME_LENGTH, MAX_PATTERN_LENGTH, parseFileName, parsedFromGroups, patternSubject, vetFileNamePattern } from "./filename-patterns.js";
export type { FileNamePattern, ParsedFileName, PatternVetting } from "./filename-patterns.js";
export { scoreConfidence } from "./confidence.js";
export type { Evidence } from "./confidence.js";
export { FUZZY_THRESHOLD, findDuplicate } from "./dedupe.js";
export type { DupKey, DupMatch } from "./dedupe.js";
