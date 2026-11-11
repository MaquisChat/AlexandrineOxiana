/** Fieldwork entities (spec 3.6): participants, sessions, consent records, source links. */
import { ConsentRecord, Participant, Session, newId, type SourceFile } from "@ao/core";
import { FieldworkInUseError, InvalidInputError, NotFoundError } from "./errors.js";
import { runMutation, type MutateRequest } from "./mutate.js";
import { appendReviewEntry } from "./review.js";
import { isUnlocked, readFullData, writeProjectData } from "./projects.js";
import { decryptBytes, readMaybe } from "./io.js";
import { loadPseudonyms, nextParticipantCode } from "./pseudonyms.js";
import { flagIfWithdrawn, linkedParticipants } from "./withdrawn.js";
import * as fsp from "node:fs/promises";
import { encName } from "@ao/core";
import type { ProjectJson } from "./state.js";
import { editSource, readSourceFile, storeRequest } from "./sources.js";
import type { ProjectState, RepoCore } from "./state.js";

export interface ParticipantInput {
  /** Defaults to the next `P-NNN` code. */
  code?: string;
  /** Identifying details (governed). Stored encrypted in encrypted projects. */
  details?: Record<string, string>;
  /** Legal basis for holding the details (required by most profiles when details are given). */
  legalBasis?: string;
}

export async function createParticipant(core: RepoCore, projectId: string, input: ParticipantInput): Promise<Participant> {
  core.assertWritable();
  const identifiable = !!input.details && Object.keys(input.details).length > 0;
  return runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable, hasLocation: false, ...(input.legalBasis ? { legalBasis: input.legalBasis } : {}) } },
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const taken = await takenCodes(core, tx.state, data);
      const code = input.code ?? nextParticipantCode(data.participants, taken.all);
      assertCodeFree(taken, code);
      const p = Participant.parse({ id: newId(), projectId, code, consentIds: [], ...(identifiable ? { details: input.details } : {}) });
      tx.entity("participant", p.id);
      data.participants.push(p);
      await writeProjectData(core, tx, data);
      tx.record("participant", p.id, null, p);
      return p;
    },
    { op: "participant.create" },
  );
}

export interface SessionInput {
  date: string;
  /** A place name (not coordinates); stored encrypted in encrypted projects. */
  place?: string;
  participantIds?: string[];
  notes?: string;
  /** Legal basis for holding place/notes (required by most profiles when they are given). */
  legalBasis?: string;
}

export async function createSession(core: RepoCore, projectId: string, input: SessionInput): Promise<Session> {
  core.assertWritable();
  // Where fieldwork happened and what was noted there can identify people.
  const identifiable = !!input.place?.trim() || !!input.notes?.trim();
  return runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable, hasLocation: false, ...(input.legalBasis ? { legalBasis: input.legalBasis } : {}) } },
    async (tx) => {
      const data = await readFullData(core, tx.state);
      for (const id of input.participantIds ?? []) {
        if (!data.participants.some((p) => p.id === id)) throw new NotFoundError("Participant", id);
      }
      const s = Session.parse({
        id: newId(),
        projectId,
        date: input.date,
        participantIds: input.participantIds ?? [],
        ...(input.place !== undefined ? { place: input.place } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
      tx.entity("session", s.id);
      data.sessions.push(s);
      await writeProjectData(core, tx, data);
      tx.record("session", s.id, null, s);
      return s;
    },
    { op: "session.create" },
  );
}

export interface ConsentInput {
  participantId: string;
  scope: string;
  date: string;
  expires?: string;
  documentAssetId?: string;
}

export async function createConsent(core: RepoCore, projectId: string, input: ConsentInput): Promise<ConsentRecord> {
  core.assertWritable();
  return runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable: false, hasLocation: false } },
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const p = data.participants.find((x) => x.id === input.participantId);
      if (!p) throw new NotFoundError("Participant", input.participantId);
      const c = ConsentRecord.parse({ id: newId(), projectId, ...input });
      tx.entity("consent", c.id);
      data.consents.push(c);
      const before = structuredClone(p);
      p.consentIds = [...p.consentIds, c.id];
      await writeProjectData(core, tx, data);
      tx.record("consent", c.id, null, c);
      tx.record("participant", p.id, before, p);
      return c;
    },
    { op: "consent.create" },
  );
}

/** Adds participants and/or sets the session of a source. */
export async function linkSourceToFieldwork(
  core: RepoCore,
  projectId: string,
  sourceId: string,
  link: { participantIds?: string[]; sessionId?: string },
): Promise<SourceFile> {
  core.assertWritable();
  const st = core.state(projectId);
  core.assertUnlocked(st);
  const current = await readSourceFile(core, st, sourceId);
  return runMutation(
    core,
    projectId,
    storeRequest(current.source.provenance),
    async (tx) => {
      const data = await readFullData(core, tx.state);
      for (const id of link.participantIds ?? []) {
        if (!data.participants.some((p) => p.id === id)) throw new NotFoundError("Participant", id);
      }
      if (link.sessionId !== undefined && !data.sessions.some((s) => s.id === link.sessionId)) {
        throw new NotFoundError("Session", link.sessionId);
      }
      const before = (await readSourceFile(core, tx.state, sourceId)).source;
      const sf = await editSource(core, tx, sourceId, (s) => ({
        ...s,
        participantIds: [...new Set([...s.participantIds, ...(link.participantIds ?? [])])],
        ...(link.sessionId !== undefined ? { sessionId: link.sessionId } : {}),
      }));
      await flagIfWithdrawn(core, tx, data, sourceId, sf.source, before);
      return sf;
    },
    { op: "source.fieldwork", entity: { type: "source", id: sourceId } },
  );
}

/** Fieldwork records. Identifying fields of a locked encrypted project are left out. */
export async function getFieldwork(
  core: RepoCore,
  projectId: string,
): Promise<{ participants: Participant[]; sessions: Session[]; consents: ConsentRecord[]; complete: boolean }> {
  const st = core.state(projectId);
  const data = await readFullData(core, st, true);
  return { participants: data.participants, sessions: data.sessions, consents: data.consents, complete: isUnlocked(core, projectId) };
}

/** Every code given in this project: participants', retired ones, and the pseudonym map's (R117 C1). */
async function takenCodes(core: RepoCore, st: ProjectState, data: ProjectJson): Promise<{ all: string[]; retired: Set<string>; mapped: Set<string> }> {
  const mapped = new Set<string>();
  if (core.encrypted(st)) for (const code of (await loadPseudonyms(core, st)).values()) mapped.add(code.toLowerCase());
  const retired = new Set((data.retiredParticipantCodes ?? []).map((c) => c.toLowerCase()));
  return { all: [...data.participants.map((p) => p.code), ...(data.retiredParticipantCodes ?? []), ...mapped], retired, mapped: new Set([...mapped, ...data.participants.map((p) => p.code.toLowerCase())]) };
}

function assertCodeFree(taken: { retired: Set<string>; mapped: Set<string> }, code: string): void {
  if (!code.trim()) throw new InvalidInputError("A participant code cannot be empty");
  const k = code.toLowerCase();
  if (taken.retired.has(k)) throw new InvalidInputError(`Participant code ${code} was retired when its participant was deleted, and is never given again`);
  if (taken.mapped.has(k)) throw new InvalidInputError(`Participant code ${code} is already in use`);
}

const NOT_IDENTIFYING: MutateRequest = { action: "store", store: { identifiable: false, hasLocation: false } };

function storeOf(identifiable: boolean, legalBasis: string | undefined): MutateRequest {
  return { action: "store", store: { identifiable, hasLocation: false, ...(legalBasis ? { legalBasis } : {}) } };
}

/** The data changed between the policy check and the change itself: nothing was written. */
const CHANGED_MEANWHILE = "This record changed while it was being saved; nothing was changed. Try again";

/** Changes to a participant: `null` clears the identifying details. The code never changes (R117 C1). */
export interface ParticipantPatch {
  /** Accepted only when it is the participant's current code: codes are immutable. */
  code?: string;
  details?: Record<string, string> | null;
  legalBasis?: string;
}

/** Governed update of a participant's details (R97). Its code is immutable (R117 C1). */
export async function updateParticipant(core: RepoCore, projectId: string, id: string, patch: ParticipantPatch): Promise<Participant> {
  core.assertWritable();
  // The policy request is decided from what the change will hold; re-checked inside the change.
  const willHold = (current: Participant | undefined) => {
    const details = patch.details === undefined ? current?.details : patch.details;
    return !!details && Object.keys(details).length > 0;
  };
  const identifiable = willHold((await readFullData(core, core.state(projectId), true)).participants.find((p) => p.id === id));
  return runMutation(
    core,
    projectId,
    storeOf(identifiable, patch.legalBasis),
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const p = data.participants.find((x) => x.id === id);
      if (!p) throw new NotFoundError("Participant", id);
      if (willHold(p) && !identifiable) throw new InvalidInputError(CHANGED_MEANWHILE);
      const before = structuredClone(p);
      if (patch.code !== undefined && patch.code !== p.code) {
        throw new InvalidInputError(`Participant codes cannot be changed once given (${p.code}): sources, citations and the pseudonym map refer to it`);
      }
      if (patch.details !== undefined) {
        if (patch.details && Object.keys(patch.details).length > 0) p.details = patch.details;
        else delete p.details;
      }
      Participant.parse(p);
      await writeProjectData(core, tx, data);
      tx.record("participant", id, before, p);
      return p;
    },
    { op: "participant.update", entity: { type: "participant", id } },
  );
}

/** Changes to a session: `null` clears place or notes. */
export interface SessionPatch {
  date?: string;
  place?: string | null;
  participantIds?: string[];
  notes?: string | null;
  legalBasis?: string;
}

/** Governed update of a session (R97); the participants named must exist. */
export async function updateSession(core: RepoCore, projectId: string, id: string, patch: SessionPatch): Promise<Session> {
  core.assertWritable();
  const willHold = (current: Session | undefined) => {
    const place = patch.place === undefined ? current?.place : patch.place;
    const notes = patch.notes === undefined ? current?.notes : patch.notes;
    return !!place?.trim() || !!notes?.trim();
  };
  const identifiable = willHold((await readFullData(core, core.state(projectId), true)).sessions.find((s) => s.id === id));
  return runMutation(
    core,
    projectId,
    storeOf(identifiable, patch.legalBasis),
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const s = data.sessions.find((x) => x.id === id);
      if (!s) throw new NotFoundError("Session", id);
      if (willHold(s) && !identifiable) throw new InvalidInputError(CHANGED_MEANWHILE);
      const before = structuredClone(s);
      for (const pid of patch.participantIds ?? []) {
        if (!data.participants.some((p) => p.id === pid)) throw new NotFoundError("Participant", pid);
      }
      if (patch.date !== undefined) s.date = patch.date;
      if (patch.participantIds !== undefined) s.participantIds = [...new Set(patch.participantIds)];
      for (const key of ["place", "notes"] as const) {
        const v = patch[key];
        if (v === undefined) continue;
        if (v === null || v === "") delete s[key];
        else s[key] = v;
      }
      Session.parse(s);
      await writeProjectData(core, tx, data);
      tx.record("session", id, before, s);
      // A participant added to the session reaches the session's sources (R117 I1).
      if (patch.participantIds !== undefined) {
        const beforeData = { ...data, sessions: data.sessions.map((x) => (x.id === id ? before : x)) };
        for (const sid of tx.state.sources.keys()) {
          const src = (await readSourceFile(core, tx.state, sid)).source;
          if (src.sessionId !== id) continue;
          const had = linkedParticipants(beforeData, src);
          await flagIfWithdrawn(core, tx, data, sid, src, { participantIds: [...had] });
        }
      }
      return s;
    },
    { op: "session.update", entity: { type: "session", id } },
  );
}

/**
 * Changes to a consent record: `null` clears the expiry. The document is set only by attaching a
 * form (attachConsentDocument); it can be detached (`documentAssetId: null`) with a reason (R117 I3).
 */
export interface ConsentPatch {
  scope?: string;
  date?: string;
  expires?: string | null;
  documentAssetId?: null;
  /** Required when detaching the document; recorded on the audit event. */
  detachReason?: string;
}

/** Governed update of a consent record (R97); a withdrawn record cannot be changed. */
export async function updateConsent(core: RepoCore, projectId: string, id: string, patch: ConsentPatch): Promise<ConsentRecord> {
  core.assertWritable();
  const docPatch = (patch as { documentAssetId?: unknown }).documentAssetId;
  if (docPatch !== undefined && docPatch !== null) {
    throw new InvalidInputError("A consent record's document is set by attaching the signed form, not by editing the record");
  }
  const detaching = docPatch === null;
  if (detaching && !patch.detachReason?.trim()) throw new InvalidInputError("Detaching the signed form from a consent record needs a reason");
  return runMutation(
    core,
    projectId,
    NOT_IDENTIFYING,
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const c = data.consents.find((x) => x.id === id);
      if (!c) throw new NotFoundError("Consent record", id);
      if (c.withdrawn) throw new InvalidInputError("This consent was withdrawn; the record is kept as it was and cannot be changed");
      const before = structuredClone(c);
      if (patch.scope !== undefined) c.scope = patch.scope;
      if (patch.date !== undefined) c.date = patch.date;
      if (patch.expires !== undefined) {
        if (patch.expires === null || patch.expires === "") delete c.expires;
        else c.expires = patch.expires;
      }
      if (detaching) delete c.documentAssetId;
      const parsed = ConsentRecord.safeParse(c);
      if (!parsed.success) throw new InvalidInputError("The consent record is not valid (check the dates)");
      await writeProjectData(core, tx, data);
      tx.record("consent", id, before, c);
      return c;
    },
    {
      op: detaching ? "consent.document-detach" : "consent.update",
      entity: { type: "consent", id },
      ...(detaching ? { auditDetails: { reason: patch.detachReason!.trim() } } : {}),
    },
  );
}

/**
 * Package-internal (attachConsentDocument): records the signed form's asset on the consent. The
 * asset must belong to a source of this project that was made for this consent (I5).
 */
export async function setConsentDocument(core: RepoCore, projectId: string, id: string, assetId: string): Promise<ConsentRecord> {
  core.assertWritable();
  return runMutation(
    core,
    projectId,
    NOT_IDENTIFYING,
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const c = data.consents.find((x) => x.id === id);
      if (!c) throw new NotFoundError("Consent record", id);
      if (c.withdrawn) throw new InvalidInputError("This consent was withdrawn; the record is kept as it was and cannot be changed");
      if (c.documentAssetId === assetId) return c;
      const before = structuredClone(c);
      c.documentAssetId = assetId;
      ConsentRecord.parse(c);
      await writeProjectData(core, tx, data);
      tx.record("consent", id, before, c);
      return c;
    },
    { op: "consent.document", entity: { type: "consent", id } },
  );
}

/** Sources linked to `participantId`: directly, or through a session that includes them (R117 I1). */
async function sourcesOfParticipant(core: RepoCore, st: ProjectState, data: ProjectJson, participantId: string): Promise<string[]> {
  const out: string[] = [];
  for (const sid of st.sources.keys()) {
    const sf = await readSourceFile(core, st, sid);
    if (linkedParticipants(data, sf.source).has(participantId)) out.push(sid);
  }
  return out;
}

/**
 * Withdraws a consent (R97): the record is marked withdrawn (kept as evidence, with the reason —
 * sealed in encrypted projects), and every source linked to the participant (directly or through a
 * session) is queued for review. Nothing is deleted; the researcher decides what happens to each
 * source. Sources linked to the participant later are queued when they are linked (R117 I1).
 * Audited as `consent.withdraw` with the number of sources flagged (no names).
 */
export async function withdrawConsent(
  core: RepoCore,
  projectId: string,
  id: string,
  opts: { reason?: string } = {},
): Promise<{ consent: ConsentRecord; flaggedSourceIds: string[] }> {
  core.assertWritable();
  let flagged = 0;
  return runMutation(
    core,
    projectId,
    NOT_IDENTIFYING,
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const c = data.consents.find((x) => x.id === id);
      if (!c) throw new NotFoundError("Consent record", id);
      if (c.withdrawn) throw new InvalidInputError("This consent was already withdrawn");
      const p = data.participants.find((x) => x.id === c.participantId);
      const before = structuredClone(c);
      const reason = opts.reason?.trim();
      c.withdrawn = { at: tx.at, ...(reason ? { reason } : {}) };
      await writeProjectData(core, tx, data);
      tx.record("consent", id, before, c);
      const sourceIds = await sourcesOfParticipant(core, tx.state, data, c.participantId);
      const why = reason ? ` (${reason})` : "";
      for (const sourceId of sourceIds) {
        await appendReviewEntry(core, tx, {
          sourceId,
          kind: "verification",
          fields: {},
          reasons: [
            `Consent from participant ${p?.code ?? "(unknown)"} (scope: ${c.scope}) was withdrawn on ${tx.at.slice(0, 10)}${why}. ` +
              "Decide whether this source may still be kept or used; nothing has been deleted.",
          ],
        });
      }
      flagged = sourceIds.length;
      return { consent: c, flaggedSourceIds: sourceIds };
    },
    { op: "consent.withdraw", entity: { type: "consent", id }, auditDetails: () => ({ flaggedSources: flagged }) },
  );
}

/**
 * Sessions and participants that an unfinished import (running, paused, cancelled, failed: all
 * resumable) will link new sources to (R117 I2). A batch record that cannot be read counts as
 * referencing everything (fail closed).
 */
async function unfinishedBatchLinks(core: RepoCore, st: ProjectState): Promise<{ sessionIds: Set<string>; participantIds: Set<string>; unreadable: boolean }> {
  const out = { sessionIds: new Set<string>(), participantIds: new Set<string>(), unreadable: false };
  let names: string[];
  try {
    names = await fsp.readdir(core.abs(`${st.rel}/imports`));
  } catch {
    return out;
  }
  const encrypted = core.encrypted(st);
  for (const n of names) {
    if (!/^batch-\d+$/.test(n)) continue;
    const rel = `${st.rel}/imports/${n}/batch.json`;
    try {
      const raw = await readMaybe(core.abs(encrypted ? encName(rel) : rel));
      if (!raw) continue;
      let text: string;
      if (encrypted) {
        const { key, keyId } = core.key(st);
        text = (await decryptBytes((k) => (k === keyId ? key : undefined), raw)).toString("utf8");
      } else text = raw.toString("utf8");
      const rec = JSON.parse(text) as { state?: string; fieldwork?: { sessionId?: string; participantIds?: string[] } };
      const state = rec.state ?? "finished";
      if (state === "finished" || state === "undone" || !rec.fieldwork) continue;
      if (rec.fieldwork.sessionId) out.sessionIds.add(rec.fieldwork.sessionId);
      for (const p of rec.fieldwork.participantIds ?? []) out.participantIds.add(p);
    } catch {
      out.unreadable = true;
    }
  }
  return out;
}

/**
 * Deletes a participant only when nothing links to it (R97, R117): no consent record, session,
 * source or unfinished import, and the pseudonym map does not name it (such a participant is a
 * real person sources were attributed to: withdraw the consent instead). The code is retired.
 */
export async function deleteParticipant(core: RepoCore, projectId: string, id: string): Promise<void> {
  core.assertWritable();
  await runMutation(
    core,
    projectId,
    { action: "delete" },
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const p = data.participants.find((x) => x.id === id);
      if (!p) throw new NotFoundError("Participant", id);
      const links: string[] = [];
      const consents = data.consents.filter((c) => c.participantId === id).length;
      const sessions = data.sessions.filter((s) => s.participantIds.includes(id)).length;
      const sources = (await sourcesOfParticipant(core, tx.state, data, id)).length;
      const batches = await unfinishedBatchLinks(core, tx.state);
      if (consents) links.push(plural(consents, "consent record"));
      if (sessions) links.push(plural(sessions, "session"));
      if (sources) links.push(plural(sources, "source"));
      if (batches.participantIds.has(id)) links.push("an unfinished import");
      else if (batches.unreadable) links.push("possibly an import whose record cannot be read");
      if (core.encrypted(tx.state) && [...(await loadPseudonyms(core, tx.state)).values()].some((c) => c.toLowerCase() === p.code.toLowerCase())) {
        links.push("the pseudonym map (a person named in sources; withdraw their consent instead)");
      }
      if (links.length) throw new FieldworkInUseError(`Participant ${p.code}`, links);
      data.participants = data.participants.filter((x) => x.id !== id);
      data.retiredParticipantCodes = [...new Set([...(data.retiredParticipantCodes ?? []), p.code])];
      await writeProjectData(core, tx, data);
      tx.record("participant", id, p, null);
    },
    { op: "participant.delete", entity: { type: "participant", id } },
  );
}

/** Deletes a session only when no source or unfinished import links to it (R97, R117 I2). */
export async function deleteSession(core: RepoCore, projectId: string, id: string): Promise<void> {
  core.assertWritable();
  await runMutation(
    core,
    projectId,
    { action: "delete" },
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const s = data.sessions.find((x) => x.id === id);
      if (!s) throw new NotFoundError("Session", id);
      let sources = 0;
      for (const sid of tx.state.sources.keys()) {
        if ((await readSourceFile(core, tx.state, sid)).source.sessionId === id) sources++;
      }
      const links = sources ? [plural(sources, "source")] : [];
      const batches = await unfinishedBatchLinks(core, tx.state);
      if (batches.sessionIds.has(id)) links.push("an unfinished import");
      else if (batches.unreadable) links.push("possibly an import whose record cannot be read");
      if (links.length) throw new FieldworkInUseError(`The session of ${s.date}`, links);
      data.sessions = data.sessions.filter((x) => x.id !== id);
      await writeProjectData(core, tx, data);
      tx.record("session", id, s, null);
    },
    { op: "session.delete", entity: { type: "session", id } },
  );
}

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
