# 0005. Governance checkpoint

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

The library holds material governed by IRB, GDPR, HIPAA and funder rules. Every action (capture, process, store, export, move, sync, ...) must pass one checkpoint so that rules are enforced in one place and cannot be bypassed by a new code path (spec 6.1, 6.3).

## Decision

- **Single entry point.** `evaluate(cfg, req)` is called before every action. It returns `allow`, `deny` with a reason, or `allow_with_conditions`; every variant carries `warnings`.
- **Strictest wins first.** `evaluate` computes `effectivePolicy(cfg).policy` and decides against that, so a project cannot be looser than its profiles. A profile violation does not deny by itself; it becomes a warning ("Governance setting <control> is stricter than configured because <profile> requires it").
- **Fail closed, never throw.** The whole evaluation is wrapped. A malformed config (shape is checked up front), a missing request payload, an unknown action or an unparseable date yields `deny` with `Policy could not be evaluated: <message>`.
- **Conditions, not silent changes.** When an action is allowed only if the caller does something (encrypt, pseudonymize file names, coarsen or strip location, export de-identified only), the decision lists those conditions in a fixed order (encrypt, pseudonymize-names, location, deidentified-only) and is `allow` only when there are none. Conditions are cumulative. The caller must apply them; the engine does not.
- **Residency.** A move needs the destination in the effective `residency.allowed`. For `cloud_folder` the folder must also be in `approvedCloudFolders` under HIPAA, or whenever that list is non-empty; with no HIPAA and an empty list any folder is allowed. HIPAA already removes `cloud_folder` from `allowed` when no folder is approved.
- **Processing.** The provider must be in the op's list, including `local`: a project may forbid even on-device processing.
- **Dates.** Expiry is compared as `now > protocol.expires` (a date-only value means 00:00 UTC of that day). Within 30 days (whole days, rounded up) the decision carries a warning.
- **Sync** is denied in Phase 1; `view`, `share` and `delete` are allowed and will be refined later.

## Consequences

- Every action added later must be a `PolicyAction` with a rule here, otherwise it is denied as unknown.
- The checkpoint is pure and synchronous, so it is cheap to call and simple to test, but it only decides: recording the decision in the audit log is the caller's job.
- Date-only expiry means a protocol expiring "today" is already expired after midnight UTC; this errs on the side of denial.
- The project name in the move reason is the request's `projectId` until the request carries a name.
