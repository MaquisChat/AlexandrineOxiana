/**
 * Withdrawn consent reaches new links too (R117 I1): a source that gets linked to a participant
 * whose consent was withdrawn — directly (participantIds) or through a session that includes them —
 * is queued for review in the same change, whether it was created by a capture, a running or
 * resumed import, or linked later. Nothing is refused or deleted: the researcher decides.
 */
import type { ProjectJson } from "./state.js";
import { appendReviewEntry } from "./review.js";
import type { Tx } from "./mutate.js";
import type { RepoCore } from "./state.js";

/** Participants (ids) a source is linked to: directly, and through its session. */
export function linkedParticipants(data: ProjectJson, s: { participantIds: string[]; sessionId?: string | undefined }): Set<string> {
  const out = new Set(s.participantIds);
  if (s.sessionId) for (const p of data.sessions.find((x) => x.id === s.sessionId)?.participantIds ?? []) out.add(p);
  return out;
}

/** Codes of the withdrawn participants among `ids`. */
export function withdrawnAmong(data: ProjectJson, ids: Iterable<string>): string[] {
  const withdrawn = new Set(data.consents.filter((c) => c.withdrawn).map((c) => c.participantId));
  const out: string[] = [];
  for (const id of ids) if (withdrawn.has(id)) out.push(data.participants.find((p) => p.id === id)?.code ?? "(unknown)");
  return out.sort();
}

export function withdrawnReason(codes: string[]): string {
  return `This source is linked to ${codes.length === 1 ? "participant" : "participants"} ${codes.join(", ")}, whose consent was withdrawn. Decide whether it may be kept or used; nothing has been deleted.`;
}

/**
 * Queues `sourceId` for review when its links (`after`) reach a withdrawn participant that its
 * earlier links (`before`, none for a new source) did not.
 */
export async function flagIfWithdrawn(
  core: RepoCore,
  tx: Tx,
  data: ProjectJson,
  sourceId: string,
  after: { participantIds: string[]; sessionId?: string | undefined },
  before?: { participantIds: string[]; sessionId?: string | undefined },
): Promise<boolean> {
  const prev = before ? linkedParticipants(data, before) : new Set<string>();
  const added = [...linkedParticipants(data, after)].filter((id) => !prev.has(id));
  const codes = withdrawnAmong(data, added);
  if (!codes.length) return false;
  await appendReviewEntry(core, tx, { sourceId, kind: "verification", fields: {}, reasons: [withdrawnReason(codes)] });
  return true;
}
