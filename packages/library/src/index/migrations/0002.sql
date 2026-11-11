-- Index schema v2 (Task 51, R31).
--
-- import_batches: nothing ever wrote this table (import batches live in their batch folders,
-- imports/batch-NNNN/, which are read from there). It is dropped.
--
-- jobs: the table is now a cache of each project's job journal (<Project>/jobs/journal.jsonl).
-- A database that already holds job rows was written before the journal existed: it is marked so
-- that those rows are written into the journals once (job-journal.ts, upgradeLegacyJobs) before
-- anything relies on the journals alone.
DROP TABLE IF EXISTS import_batches;
INSERT OR REPLACE INTO meta (key, value) SELECT 'jobsLegacy', '1' WHERE EXISTS (SELECT 1 FROM jobs);
