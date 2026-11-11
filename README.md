# Alexandrine Oxiana

A local-first research workbench for social scientists: capture, transcription, translation, coding, citation, and verifiable data governance. The library is a portable folder of human-readable files.

**New here?** Read `docs/handoff/HANDOFF.md`, then `docs/PLAN.md` (the working plan and each task's status).

Design: `docs/superpowers/specs/2026-11-09-research-workbench-design.md`. Decisions: `docs/adr/`.

## What you can use today

The command-line tool: run `pnpm ao --help` (see `apps/cli/README.md`). The desktop app is not built yet (`apps/desktop` is planned), and the interface in `packages/ui` cannot yet be started together with the service.

## Layout

- `packages/core`, `packages/library`, `packages/shared`, `packages/ui` - shared TypeScript packages (domain model, library engine, small shared rules, user interface)
- `apps/library-service`, `apps/cli`, `apps/browser-extension` - local service, command-line tool and browser extension
- `services/media-worker` - Python media worker (transcription, downloads, proxies, OCR)
- `apps/desktop` - the desktop app: planned, not built yet
- `scripts/` - test report and helpers

## Requirements

Node 22+, pnpm 10 (pnpm 9 or later works), Python 3.12+.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm setup:py` | Set up the Python environment for the media worker |
| `pnpm fetch-fixtures` | Download the test fixtures (DNG and CR3 sample files) |
| `pnpm fetch-csl` | Build the citation style bundle (`packages/core/csl/`: pinned CSL styles and locales, CC BY-SA 3.0; not committed, needed by the citation tests and the app) |
| `pnpm -r typecheck` | Type-check every package |
| `pnpm test` | Run all TypeScript tests (writes `reports/vitest.json`) |
| `pnpm test:scripts` | Test the report script itself |
| `pnpm test:scale` | Run the 10,000-item import test on its own (slow: about two minutes) |
| `pnpm test:py` | Run the media worker's Python tests |
| `pnpm e2e` | Run end-to-end tests: the browser-extension suite today; it will also run the app suite once that exists |
| `pnpm ao` | Run the command-line tool, for example `pnpm ao --help` |
| `pnpm --filter @ao/ui run build` | Build the user interface |
| `pnpm --filter @ao/ui run lint:css` and `lint:colours` | Check the interface's styles and colours follow the theme rules |
| `pnpm report` | Write a plain-language summary to `reports/test-report.md` |

When you add a test file, add a line for it to the table at the top of `scripts/test-report.mjs` so the report uses a friendly area name.
