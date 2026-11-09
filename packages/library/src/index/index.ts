export {
  INDEX_FILE,
  createIndexSink,
  findSourceBy,
  getMeta,
  indexProject,
  indexSource,
  normalizeDoi,
  normalizeIsbn13,
  openIndex,
  recordStamps,
  removeSource,
  setMeta,
} from "./db.js";
export type { IndexDb, SourceQuery, SourceRow } from "./db.js";
export { rebuildIndex, isIndexStale } from "./rebuild.js";
export type { RebuildOptions, RebuildResult } from "./rebuild.js";
export { search } from "./search.js";
export type { SearchQuery } from "./search.js";
