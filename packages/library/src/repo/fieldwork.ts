/** Fieldwork entities (spec 3.6): participants, sessions, consent records, source links. */
import { ConsentRecord, Participant, Session, newId, type SourceFile } from "@ao/core";
import { FieldworkInUseError, InvalidInputError, NotFoundError } from "./errors.js";
import { runMutation, type MutateRequest } from "./mutate.js";
import { appendReviewEntry } from "./review.js";
import { isUnlocked, readFullData, writeProjectData } from "./projects.js";
import { nextParticipantCode } from "./pseudonyms.js";
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
      const code = input.code ?? nextParticipantCode(data.participants);
      assertCodeFree(data.participants, code);
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
      return editSource(core, tx, sourceId, (s) => ({
        ...s,
        participantIds: [...new Set([...s.participantIds, ...(link.participantIds ?? [])])],
        ...(link.sessionId !== undefined ? { sessionId: link.sessionId } : {}),
      }));
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

function assertCodeFree(participants: Participant[], code: string, except?: string): void {
  if (!code.trim()) throw new InvalidInputError("A participant code cannot be empty");
  if (participants.some((p) => p.id !== except && p.code.toLowerCase() === code.toLowerCase())) {
    throw new InvalidInputError(`Participant code ${code} is already in use`);
  }
}

const NOT_IDENTIFYING: MutateRequest = { action: "store", store: { identifiable: false, hasLocation: false } };

function storeOf(identifiable: boolean, legalBasis: string | undefined): MutateRequest {
  return { action: "store", store: { identifiable, hasLocation: false, ...(legalBasis ? { legalBasis } : {}) } };
}

/** Changes to a participant: `null` clears the identifying details. */
export interface ParticipantPatch {
  code?: string;
  details?: Record<string, string> | null;
  legalBasis?: string;
}

/** Governed update of a participant (R97): the code stays unique; details are governed like on create. */
export async function updateParticipant(core: RepoCore, projectId: string, id: string, patch: ParticipantPatch): Promise<Participant> {
  core.assertWritable();
  const current = (await readFullData(core, core.state(projectId), true)).participants.find((p) => p.id === id);
  if (!current) throw new NotFoundError("Participant", id);
  const details = patch.details === undefined ? current.details : patch.details;
  const identifiable = !!details && Object.keys(details).length > 0;
  return runMutation(
    core,
    projectId,
    storeOf(identifiable, patch.legalBasis),
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const p = data.participants.find((x) => x.id === id);
      if (!p) throw new NotFoundError("Participant", id);
      const before = structuredClone(p);
      if (patch.code !== undefined) {
        assertCodeFree(data.participants, patch.code, id);
        p.code = patch.code;
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
  const current = (await readFullData(core, core.state(projectId), true)).sessions.find((s) => s.id === id);
  if (!current) throw new NotFoundError("Session", id);
  const place = patch.place === undefined ? current.place : patch.place;
  const notes = patch.notes === undefined ? current.notes : patch.notes;
  const identifiable = !!place?.trim() || !!notes?.trim();
  return runMutation(
    core,
    projectId,
    storeOf(identifiable, patch.legalBasis),
    async (tx) => {
      const data = await readFullData(core, tx.state);
      const s = data.sessions.find((x) => x.id === id);
      if (!s) throw new NotFoundError("Session", id);
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
      return s;
    },
    { op: "session.update", entity: { type: "session", id } },
  );
}

/** Changes to a consent record: `null` clears the expiry or the document. */
export interface ConsentPatch {
  scope?: string;
  date?: string;
  expires?: string | null;
  documentAssetId?: string | null;
}

/** Governed update of a consent record (R97); a withdrawn record cannot be changed. */
export async function updateConsent(core: RepoCore, projectId: string, id: string, patch: ConsentPatch): Promise<ConsentRecord> {
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
      const before = structuredClone(c);
      if (patch.scope !== undefined) c.scope = patch.scope;
      if (patch.date !== undefined) c.date = patch.date;
      for (const key of ["expires", "documentAssetId"] as const) {
        const v = patch[key];
        if (v === undefined) continue;
        if (v === null || v === "") delete c[key];
        else c[key] = v;
      }
      const parsed = ConsentRecord.safeParse(c);
      if (!parsed.success) throw new InvalidInputError("The consent record is not valid (check the dates and the document)");
      await writeProjectData(core, tx, data);
      tx.record("consent", id, before, c);
      return c;
    },
    { op: "consent.update", entity: { type: "consent", id } },
  );
}

/** Sources of the project that name `participantId` (read inside a running change). */
async function sourcesOfParticipant(core: RepoCore, st: ProjectState, participantId: string): Promise<string[]> {
  const out: string[] = [];
  for (const sid of st.sources.keys()) {
    const sf = await readSourceFile(core, st, sid);
    if (sf.source.participantIds.includes(participantId)) out.push(sid);
  }
  return out;
}

/**
 * Withdraws a consent (R97): the record is marked withdrawn (kept as evidence), and every source
 * linked to the participant is queued for review. Nothing is deleted; the researcher decides what
 * happens to each source. Audited as `consent.withdraw` with the number of sources flagged (no
 * names). `reason` goes into the review entries only (sealed in encrypted projects).
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
      c.withdrawn = { at: tx.at };
      await writeProjectData(core, tx, data);
      tx.record("consent", id, before, c);
      const sourceIds = await sourcesOfParticipant(core, tx.state, c.participantId);
      const why = opts.reason?.trim() ? ` (${opts.reason.trim()})` : "";
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

/** Deletes a participant only when no consent record, session or source links to it (R97). */
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
      const sources = (await sourcesOfParticipant(core, tx.state, id)).length;
      if (consents) links.push(plural(consents, "consent record"));
      if (sessions) links.push(plural(sessions, "session"));
      if (sources) links.push(plural(sources, "source"));
      if (links.length) throw new FieldworkInUseError(`Participant ${p.code}`, links);
      data.participants = data.participants.filter((x) => x.id !== id);
      await writeProjectData(core, tx, data);
      tx.record("participant", id, p, null);
    },
    { op: "participant.delete", entity: { type: "participant", id } },
  );
}

/** Deletes a session only when no source links to it (R97). */
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
      if (sources) throw new FieldworkInUseError(`The session of ${s.date}`, [plural(sources, "source")]);
      data.sessions = data.sessions.filter((x) => x.id !== id);
      await writeProjectData(core, tx, data);
      tx.record("session", id, s, null);
    },
    { op: "session.delete", entity: { type: "session", id } },
  );
}

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
