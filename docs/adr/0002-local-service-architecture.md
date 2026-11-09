# 0002. Node library service as a sidecar behind a thin Tauri shell

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

The desktop app owns a local library folder (SQLite index plus files). Other tools (browser capture extension, Word add-in, Obsidian plugin, Scrivener scan tool) also need to read the library and resolve citations while the desktop app is open. Putting library logic inside the Tauri (Rust) shell would duplicate the TypeScript core and make it hard to reach from other tools.

## Decision

- The library is served by a Node process, `@ao/library-service`, run as a sidecar that the Tauri shell launches and supervises. The shell stays thin: windowing, OS integration, and starting or stopping the service.
- The service binds to localhost only and uses the TypeScript `core` and `@ao/library` packages directly.
- The same service is the local citation service described in spec section 8.2, so integrations talk to one stable local API.

## Consequences

- One code path for library access, whether from the desktop UI, the CLI (`@ao/cli`), or integrations.
- The service must authenticate local callers and respect each project's governance settings; this is designed in later tasks.
- Packaging must bundle a Node runtime with the desktop app.
- The service can later run headless without the desktop shell.
