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
  setMeta,
} from "./db.js";
export type { IndexDb, IndexSourceOptions, SourceQuery, SourceRow } from "./db.js";
export { createIndexSink, indexUnlockedProject, recordStamps } from "./sink.js";
export { rebuildIndex, isIndexStale } from "./rebuild.js";
export type { RebuildOptions, RebuildResult } from "./rebuild.js";
export { search } from "./search.js";
export type { SearchQuery } from "./search.js";
