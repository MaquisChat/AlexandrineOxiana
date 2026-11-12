export {
  INDEX_FILE,
  IndexHandle,
  findSourceBy,
  getMeta,
  indexProject,
  indexSource,
  normalizeDoi,
  normalizeIsbn13,
  openIndex,
  purgeProject,
  removeSource,
  deleteMeta,
  setMeta,
} from "./db.js";
export type { IndexDb, IndexSourceOptions, SourceQuery, SourceRow } from "./db.js";
export { createIndexSink, indexUnlockedProject, recordStamps } from "./sink.js";
export { rebuildIndex, indexIsPartial, isIndexStale, openIndexChecked, rebuildIndexIfNeeded } from "./rebuild.js";
export type { CheckedIndex, IndexRebuildNeed, RebuildIfNeededOptions, RebuildOptions, RebuildResult } from "./rebuild.js";
export { search } from "./search.js";
export type { SearchQuery, SearchResult } from "./search.js";
