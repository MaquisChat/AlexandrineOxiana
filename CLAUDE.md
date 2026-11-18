# Alexandrine Oxiana — notes for agents

**Start with `docs/handoff/HANDOFF.md`.** Then read `docs/handoff/PROCESS.md`, then `docs/PLAN.md` (the working plan: what to do next and each task's status).

The binding rules (rulings R1–R119, with new ones appended from R120) are in `docs/handoff/LEDGER.md`, which is kept in git and appended to directly. They override defaults. `docs/handoff/LEDGER-INDEX.md` is a one-line-per-ruling lookup; grep the ledger by ruling number.

- **Spec:** `docs/handoff/SPEC.md`.
- **Plan:** `docs/PLAN.md` is the working plan; `docs/superpowers/plans/2026-11-09-phase-1-foundation.md` remains the specification for the original tasks.

Conventions in short:
- **Stack:** pnpm 10, Node 22, TypeScript strict, ESM, Vitest. The rule is to pin dependencies exactly (the root `package.json` dev tools still use `^` ranges). Python 3.13 media worker in `services/media-worker`.
- **Development:**
  - Write tests first.
  - Every library mutation is governed and audited, and crash-safe through the txn marker (R26).
- **UI:**
  - Colours come from theme tokens only.
  - Show user and source text with `UserText`. Never use `innerHTML`.
  - Show archived HTML only through `SnapshotFrame`.
- **Branch:** work on the session's working branch (currently `claude/amanuensis-handoff-0x6u5m`). `main` is the approved state and changes only with the owner's approval. The `claude/eager-sagan-ndp8ku*` branches are frozen. Push the working branch after every completed task.
- **Commits:** every commit ends with the Co-Authored-By and Claude-Session trailers of the session that makes it (given by that session's own instructions); never copy a previous session's link. Apart from those trailers, never include model identifiers in repository files or commits.
