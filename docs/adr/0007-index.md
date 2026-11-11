# 0007. SQLite index: a rebuildable cache, with encrypted content kept in memory

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

`library.sqlite` gives fast multilingual search and duplicate lookup. The library's files are the durable record (spec 4.3); the database must be rebuildable from them. It is a plain file (plus WAL, free pages) next to encrypted projects, so anything we put in it is readable without the project key.

## Decision

- **Cache, not record.** Every table is a cache of files. `rebuildIndex` builds `library.sqlite.rebuild-<id>`, then closes the live connection, removes its WAL/SHM, atomically renames the new file over `library.sqlite`, reopens and swaps the connection held by `IndexHandle`. A failed checkpoint or any error before the rename leaves the old database untouched. A read-only library cannot rebuild.
- **R30: encrypted projects.** Only manifest-level fields (source id, type, issued year, folder, project id, locked flag) are written to the persistent database. Titles, creators, container, extracted text, CJK bigrams, dedupe keys (DOI, ISBN, platform post id, SHA-256), collection and tag names, participants, sessions and consents live only in the connection's in-memory `TEMP` schema (`temp_store = MEMORY`), loaded when the project is unlocked (`IndexSink.projectUnlocked`) and dropped when it is locked (`IndexSink.purgeProject`, called by `lockProject`). `search` and `findSourceBy` read both stores through TEMP views. The persistent database uses `secure_delete = ON`. Folder names come from the plaintext manifest and are as (un)identifying as the manifest itself.
- **`review_items` and `jobs` are caches of files (R31).** Review items: `Projects/<p>/review/pending.jsonl`, append-only, one entry per line (a later line with the same id supersedes an earlier one), every line sealed with the project key in encrypted projects. A rebuild reads it for every project whose key is available and those rows replace the old database's; review rows of locked encrypted projects are copied over from the old database as they were (their file cannot be read). For encrypted projects the indexed `payload_json` holds only field names and statuses (no reasons, which quote titles and names).
- **Jobs** (Task 51): `Projects/<p>/jobs/journal.jsonl`, the same format (sealed lines, AAD `ao-jobs|<projectId>`); each line is a whole snapshot of one job, appended durably before the row changes, and the file wins when the two disagree. The row keeps id, project id, job type, status, created_at and `payload_json` with at most a fixed error code, for every project; the job itself (input, output, parameters, entity), which resubmission needs, is only in the journal, and a finished job's line drops it. A rebuild fills `jobs` from the journals alone; jobs of a locked encrypted project are unknown to the index until it is unlocked, when the sink loads them. Resubmission at launch reads the journals, repairs the rows and compacts a journal whose lines are mostly superseded (atomic rewrite keeping the newest line per job). A database written before the journal existed is marked by migration 0002 and its rows are written into the journals once (`upgradeLegacyJobs`, at rebuild, unlock and launch); rows of locked projects wait in the database until then — the only rows a rebuild still copies over. Job parameters named like secrets (tokens, passwords, cookie values …) are refused.
- **`import_batches`** was never written (batches live in `imports/batch-NNNN/`); migration 0002 drops it.
- **Staleness.** The index records a stamp per project: the newest change id where the change log is readable (unencrypted, or key in the ring; sealed lines are opened), otherwise the manifest's mtime. Any difference means stale. The sink updates only the affected project's stamp.
- **Extracted text.** Rebuild reads the newest derived asset of kind `ocr-text` (plain text) and `transcript` (`.vtt` stripped of headers, cue ids and timings), decrypting when needed.

## Consequences

- Locking by clearing the key ring without `lockProject` leaves in-memory content until the connection closes; the app must use `lockProject`.
- After a rebuild or an app restart, an unlocked encrypted project is searchable only once its content is reloaded (rebuild does this; the sink does it on unlock).

## Constraints on later tasks and exposure notes

- `review_items` and `jobs` rows (including `payload_json`) for an encrypted project must never contain titles, creators or other identifying text. Later tasks must seal such payloads in files or keep them in the in-memory TEMP schema.
- A restored backup copy starts with no job journal: its records point at the original's files.
- `main.projects.name` for an encrypted project comes from the plaintext `project.json`, so it carries the same exposure as on disk.
- Loading an unlocked project into memory checks the key before every insert and purges if the project was locked meanwhile; a rebuild reloads every unlocked project even when the rebuild itself failed after the connection was closed, collecting errors per project.
