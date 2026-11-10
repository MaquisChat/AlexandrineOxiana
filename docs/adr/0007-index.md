# 0007. SQLite index: a rebuildable cache, with encrypted content kept in memory

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

`library.sqlite` gives fast multilingual search and duplicate lookup. The library's files are the durable record (spec 4.3); the database must be rebuildable from them. It is a plain file (plus WAL, free pages) next to encrypted projects, so anything we put in it is readable without the project key.

## Decision

- **Cache, not record.** Every table is a cache of files. `rebuildIndex` builds `library.sqlite.rebuild-<id>`, then closes the live connection, removes its WAL/SHM, atomically renames the new file over `library.sqlite`, reopens and swaps the connection held by `IndexHandle`. A failed checkpoint or any error before the rename leaves the old database untouched. A read-only library cannot rebuild.
- **R30: encrypted projects.** Only manifest-level fields (source id, type, issued year, folder, project id, locked flag) are written to the persistent database. Titles, creators, container, extracted text, CJK bigrams, dedupe keys (DOI, ISBN, platform post id, SHA-256), collection and tag names, participants, sessions and consents live only in the connection's in-memory `TEMP` schema (`temp_store = MEMORY`), loaded when the project is unlocked (`IndexSink.projectUnlocked`) and dropped when it is locked (`IndexSink.purgeProject`, called by `lockProject`). `search` and `findSourceBy` read both stores through TEMP views. The persistent database uses `secure_delete = ON`. Folder names come from the plaintext manifest and are as (un)identifying as the manifest itself.
- **`review_items`, `import_batches`, `jobs`.** Later tasks persist these in files of their own and the tables become rebuildable caches of those files. Until that exists the database is their only home, so a rebuild copies their rows into the new database instead of dropping them.
- **Staleness.** The index records a stamp per project: the newest change id where the change log is readable (unencrypted, or key in the ring; sealed lines are opened), otherwise the manifest's mtime. Any difference means stale. The sink updates only the affected project's stamp.
- **Extracted text.** Rebuild reads the newest derived asset of kind `ocr-text` (plain text) and `transcript` (`.vtt` stripped of headers, cue ids and timings), decrypting when needed.

## Consequences

- Locking by clearing the key ring without `lockProject` leaves in-memory content until the connection closes; the app must use `lockProject`.
- After a rebuild or an app restart, an unlocked encrypted project is searchable only once its content is reloaded (rebuild does this; the sink does it on unlock).

## Constraints on later tasks and exposure notes

- `review_items`, `import_batches` and `jobs` rows (including `payload_json`) for an encrypted project must never contain titles, creators or other identifying text. Later tasks must seal such payloads in files or keep them in the in-memory TEMP schema.
- `main.projects.name` for an encrypted project comes from the plaintext `project.json`, so it carries the same exposure as on disk.
- Loading an unlocked project into memory checks the key before every insert and purges if the project was locked meanwhile; a rebuild reloads every unlocked project even when the rebuild itself failed after the connection was closed, collecting errors per project.
