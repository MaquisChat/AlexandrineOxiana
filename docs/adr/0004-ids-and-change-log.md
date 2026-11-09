# 0004. Ids and change log

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

Sync is switched on in Phase 5, but every repository write from now on must append to a change log, so the format and merge rules are fixed now (spec 2.3). Devices work offline and merge later without a central server.

## Decision

- **Ids.** UUIDv7 (`newId`): globally unique without coordination and sortable by creation time, so ids double as a stable tiebreak and make logs and indexes append-friendly.
- **Change.** `{ id, at, author, device, projectId, entity, op, field?, value?, prev? , removed? }`. `create` and `delete` carry the whole object and no `field`. `update` is per leaf field, addressed by an RFC 6901 JSON pointer (`~` as `~0`, `/` as `~1`). Arrays are leaf values (one change replaces the array); nested plain objects are recursed into. `prev` supports conflict display and auditing.
- **Removed keys.** `undefined` does not survive JSON, so removing a key is `{ op: 'update', prev, removed: true }`; an added key is an update with no `prev`.
- **Merge (`mergeConcurrent`).** Input is the two change lists since the common ancestor. Per entity and field, last writer wins by `(at, device)`, comparing ISO strings and breaking ties by device string (greater wins), then by id. All same-side changes of the winning side are kept. The result is order-independent, so both peers converge. Applied changes are ordered by `(at, device, id)`.
- **Rich text.** Fields in `RICH_TEXT_FIELDS` (`/body`, `/notes`, `/details`, also as pointer prefixes) are never auto-merged: concurrent edits become a conflict and neither is applied, for a person to resolve.
- **Whole-entity rules.** Delete beats update; the dropped updates are reported as conflicts with `field: '*'`. A create on both sides is a conflict (`*`) and neither is applied. A delete on both sides applies once.

## Consequences

- Wall-clock `at` decides winners, so a device with a skewed clock can win unfairly; a hybrid logical clock can replace it later without changing the format.
- Field-level LWW can combine fields into a state no single user saw; acceptable for metadata, and why prose is excluded.
- Parent/child pointers (e.g. `/details` vs `/details/foo`) on opposite sides are not treated as overlapping.
- Merge assumes the inputs only contain changes since the ancestor; computing that is the sync layer's job.
