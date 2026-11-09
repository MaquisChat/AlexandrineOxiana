# 0004. Ids and change log

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

Sync is switched on in Phase 5, but every repository write from now on must append to a change log, so the format and merge rules are fixed now (spec 2.3). Devices work offline and merge later without a central server.

## Decision

- **Ids.** UUIDv7 (`newId`): globally unique without coordination and sortable by creation time, so ids double as a stable tiebreak and make logs and indexes append-friendly.
- **Change.** `{ id, at, author, device, projectId, entity, op, field?, value?, prev? , removed? }`. `create` carries the whole object (`value`) and `delete` carries it as `prev`; neither has a `field`. `at` must be UTC ISO with milliseconds and `Z` (`toISOString()` form), validated in `diffToChanges`, because it is compared as a string. `update` is per leaf field, addressed by an RFC 6901 JSON pointer (`~` as `~0`, `/` as `~1`). Arrays are leaf values (one change replaces the array); nested plain objects are recursed into. `prev` supports conflict display and auditing.
- **Removed keys.** `undefined` does not survive JSON, so removing a key is `{ op: 'update', prev, removed: true }`; an added key is an update with no `prev`.
- **Merge (`mergeConcurrent`).** Input is the two change lists since the common ancestor. Per entity, pointers that overlap (equal, or one an ancestor of the other, e.g. `/a` and `/a/x`) form a cluster resolved as a unit, so a child edit never lands on a removed or replaced parent. Within a cluster, last writer wins by `(at, device)`, comparing ISO strings and breaking ties by device string (greater wins), then by id. All of the winning side's changes in the cluster are kept, the loser's none. A cluster containing a rich-text pointer is a conflict instead (including `/details` vs `/details/foo`). The result is order-independent, so both peers converge. Applied changes are ordered by `(at, device, id)`.
- **Rich text.** Fields in `RICH_TEXT_FIELDS` (top-level pointers `/body`, `/notes`, `/details`; nested pointers below them match too) are never auto-merged: concurrent edits become a conflict and neither is applied, for a person to resolve.
- **Whole-entity rules.** Delete beats update; the dropped updates are reported as conflicts with `field: '*'`. A create on both sides is a conflict (`*`): neither create is applied and every other change to that entity is dropped and listed in the conflict's `dropped`. Conflicts are sorted deterministically. A delete on both sides applies once.

## Consequences

- Wall-clock `at` decides winners, so a device with a skewed clock can win unfairly; a hybrid logical clock can replace it later without changing the format.
- Field-level LWW can combine fields into a state no single user saw; acceptable for metadata, and why prose is excluded.
- Merge assumes the inputs only contain changes since the ancestor; computing that is the sync layer's job.
