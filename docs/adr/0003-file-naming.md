# 0003. Human-readable, portable file naming

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

Library files must stay readable in a plain file manager and survive copying between Windows, macOS and Linux, cloud-synced folders and NAS shares (spec 4.2, 4.4). Each platform forbids different characters and reserved names, and limits file names (255 bytes on most file systems, not 255 characters) and total path length (260 characters on legacy Windows).

## Decision

- **Scheme.** Source folders: `<year|date> <creator> - <short title> [<4-char id>]`. Derived files: `<source> - <kind> - <lang> - <tool> - modified <YYYY-MM-DD HHmm>.<ext>`. Edits produce a new dated file; nothing is overwritten.
- **Configurable.** Both formats are string templates (`NamingTemplates`, `defaultTemplates`) with placeholders, overridable per workspace. Empty optional values (date, language) are dropped together with their separator.
- **Sanitizing (`sanitizeSegment`).** NFC normalization; `<>:"/\|?*` and C0/C1 control characters become `-`; bidi override/embedding/isolate controls are stripped (LRM/RLM kept); whitespace collapses; trailing dots and spaces are removed; Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without extension) get a `_` prefix. Non-Latin scripts are kept as-is.
- **Byte limit.** Segments are capped at 150 UTF-8 bytes (not characters), truncated on a grapheme boundary (`Intl.Segmenter`) with `…`, so the result is never over the cap and never splits an emoji or combining sequence. 150 leaves room for the rest of a derived name inside the 255-byte file name limit, and keeps typical library paths well below the Windows path limit. Derived and original file names additionally shrink the source part so the base name stays within 246 bytes (255 minus 4 for `.enc` and 5 for a ` (99)` collision suffix), and `encName` / `withCollisionSuffix` re-shrink the stem on a grapheme boundary if a name is still too long, so every final on-disk name is at most 255 bytes.
- **Collisions.** `withCollisionSuffix` appends ` (2)`, ` (3)` before the extension; for `.enc` names the suffix goes before the inner extension (`x (2).vtt.enc`). Extensions are `.<1-5 alphanumerics>` or `.tar.gz/bz2/xz`, optionally followed by `.enc`; folders pass `{ isFile: false }`.
- **Pseudonymization (spec 4.4).** In identifiable-data projects, `@handle` tokens in names are replaced with codes like `P-014`. Text and keys are NFC-normalized, empty keys are ignored, and a matched handle with no mapping throws rather than leaking. Replacement is by whole token and case-insensitive, so `@maria.cocina` never matches inside `@maria.cocinas`. The mapping lives in the encrypted key file, not in names. Encrypted files append `.enc` (`encName`).
- **Platform neutrality.** `@ao/core` uses only `Intl` and `TextEncoder`, no `node:` imports. Time zone is injectable for deterministic names.

## Consequences

- Names are predictable and testable; users can re-template without code changes.
- Truncation is lossy; the `[id]` in the folder name (and `source.json`) remains the identity.
- Romanized fallbacks for file systems that cannot store a script are not implemented here.
