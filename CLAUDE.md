# Alexandrine Oxiana — notes for agents

**Start with `docs/handoff/HANDOFF.md`.** Then read `docs/handoff/PROCESS.md`.

The binding rules (rulings R1–R119) are in `docs/handoff/LEDGER.md`. They override defaults. Grep the ledger by ruling number.

- **Spec:** `docs/handoff/SPEC.md`.
- **Plan:** `docs/superpowers/plans/2026-11-09-phase-1-foundation.md`.

Conventions in short:
- **Stack:** pnpm 10, Node 22, TypeScript strict, ESM, Vitest. Pin dependencies exactly. Python 3.13 media worker in `services/media-worker`.
- **Development:**
  - Write tests first.
  - Every library mutation is governed and audited, and crash-safe through the txn marker (R26).
- **UI:**
  - Colours come from theme tokens only.
  - Show user and source text with `UserText`. Never use `innerHTML`.
  - Show archived HTML only through `SnapshotFrame`.
- **Branch:** `claude/eager-sagan-ndp8ku`.
- **Commits:** every commit ends with the Co-Authored-By and Claude-Session trailers given in PROCESS.md. Never include model identifiers in repository files or commits.
