# Alexandrine Oxiana

A local-first research workbench for social scientists: capture, transcription, translation, coding, citation, and verifiable data governance. The library is a portable folder of human-readable files.

Design: `docs/superpowers/specs/2026-11-09-research-workbench-design.md`. Decisions: `docs/adr/`.

## Layout

- `packages/core`, `packages/library`, `packages/ui` - shared TypeScript packages
- `apps/library-service`, `apps/cli` - local service and command-line tool
- `services/media-worker` - Python media worker (added in a later task)
- `scripts/` - test report and helpers

## Requirements

Node 22+, pnpm 10 (pnpm 9 or later works), Python 3.12+.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm -r typecheck` | Type-check every package |
| `pnpm test` | Run all TypeScript tests (writes `reports/vitest.json`) |
| `pnpm test:scripts` | Test the report script itself |
| `pnpm test:py` | Run Python tests (skips if the worker does not exist yet) |
| `pnpm e2e` | Run end-to-end tests (skips until the desktop app exists) |
| `pnpm report` | Write a plain-language summary to `reports/test-report.md` |

When you add a test file, add a line for it to the table at the top of `scripts/test-report.mjs` so the report uses a friendly area name.
