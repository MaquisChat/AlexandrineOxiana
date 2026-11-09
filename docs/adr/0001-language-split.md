# 0001. TypeScript core plus a Python media worker

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

The workbench needs one shared domain model (data model, governance engine, audit log, citation engine, coding, change log) used by a desktop app, a future web app and server, and integrations. It also needs media processing: video download (yt-dlp), OCR, language detection, transcription (faster-whisper), translation, and media conversion. The strongest libraries for that work are in Python. The owner has limited coding experience and will later collaborate with other programmers, so technology should be conventional and well documented.

## Decision

- All domain logic lives in a single TypeScript `core` (strict mode, ESM only), shared by every shell (desktop, web, server, integrations).
- Media processing lives in a separate Python `media-worker` service, called only through a documented HTTP/JSON job API. It has no dependency on `core`.
- The monorepo uses pnpm workspaces; Vitest tests TypeScript and pytest tests Python. Both report through one plain-language test report.

## Consequences

- One implementation of governance and citation rules, so behaviour cannot drift between shells.
- The worker can run locally or on a server as governance permits, and can be replaced or extended independently.
- Contributors need Node (22+) and Python (3.12+). CI runs against Python 3.12 and 3.13.
- The HTTP/JSON job API is a contract that must be documented and versioned.

See spec section 2 (Architecture).
