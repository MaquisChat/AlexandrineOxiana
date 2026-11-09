/** Fieldwork entities (spec 3.6): participants, sessions, consent records, source links. */
import { ConsentRecord, Participant, Session, newId, type SourceFile } from "@ao/core";
import { NotFoundError } from "./errors.js";
import { runMutation } from "./mutate.js";
import { isUnlocked, readFullData, writeProjectData } from "./projects.js";
import { nextParticipantCode } from "./pseudonyms.js";
import { editSource, readSourceFile, storeRequest } from "./sources.js";
import type { RepoCore } from "./state.js";

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
      if (data.participants.some((p) => p.code.toLowerCase() === code.toLowerCase())) {
        throw new Error(`Participant code ${code} is already in use`);
      }
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
}

export async function createSession(core: RepoCore, projectId: string, input: SessionInput): Promise<Session> {
  core.assertWritable();
  return runMutation(
    core,
    projectId,
    { action: "store", store: { identifiable: false, hasLocation: false } },
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
