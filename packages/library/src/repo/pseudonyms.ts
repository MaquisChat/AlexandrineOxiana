/**
 * Pseudonym map (spec 4.4): handle or name → participant code, kept only in
 * `<Project>/keys/pseudonyms.json.enc` (encrypted with the project key).
 */
import type { Creator, Participant } from "@ao/core";
import { newId } from "@ao/core";
import { decryptBytes, readMaybe } from "./io.js";
import type { Tx } from "./mutate.js";
import type { ProjectJson, ProjectState, RepoCore } from "./state.js";

interface PseudonymFile {
  formatVersion: 1;
  map: Record<string, string>;
}

const relOf = (st: ProjectState) => `${st.rel}/keys/pseudonyms.json.enc`;

export async function loadPseudonyms(core: RepoCore, st: ProjectState): Promise<Map<string, string>> {
  const raw = await readMaybe(core.abs(relOf(st)));
  if (!raw) return new Map();
  const { key, keyId } = core.key(st);
  const plain = await decryptBytes((id) => (id === keyId ? key : undefined), raw);
  return new Map(Object.entries((JSON.parse(plain.toString("utf8")) as PseudonymFile).map));
}

export async function savePseudonyms(tx: Tx, map: Map<string, string>): Promise<void> {
  const body: PseudonymFile = { formatVersion: 1, map: Object.fromEntries(map) };
  await tx.writeFile(relOf(tx.state), JSON.stringify(body), { encrypt: true, mode: 0o600 });
}

/** The identifying string for a creator: handle, else literal, else "given family". */
export function creatorKey(c: Creator): string | undefined {
  const k = c.handle?.trim() || c.literal?.trim() || [c.given, c.family].filter(Boolean).join(" ").trim();
  return k ? k.normalize("NFC") : undefined;
}

/** Detail keys of a participant that name the person (mapped to their code like the pseudonym map). */
export const NAME_KEY = /name|handle|user|alias|account/iu;

/**
 * The names of this project's participants, name → code (R387 d): ONE list for a source's folder
 * name (repo/sources.ts) and its citation (export/bibliography.ts), so the two cannot drift. The
 * pseudonym map; each participant's identifying details whose key names the person (`NAME_KEY`;
 * "fullName", "handle" …); and `creators` with their codes (the folder name of a new source:
 * each name form — handle with and without "@", literal, family, given, "given family"). The first
 * entry of a name wins. The citation codes its creators itself (toCslItem), so it passes none.
 */
export function participantNames(
  map: ReadonlyMap<string, string>,
  participants: readonly Participant[],
  creators: ReadonlyArray<{ creator: Creator; code: string | undefined }> = [],
): Map<string, string> {
  const out = new Map(map);
  const add = (n: string | undefined, code: string) => {
    const t = n?.trim();
    if (t && !out.has(t)) out.set(t, code);
  };
  for (const p of participants) {
    for (const [k, v] of Object.entries(p.details ?? {})) if (NAME_KEY.test(k) && v.trim().length >= 2) add(v, p.code);
  }
  for (const { creator: c, code } of creators) {
    if (!code) continue;
    for (const n of [c.handle, c.handle?.replace(/^@+/, ""), c.literal, c.family, c.given, [c.given, c.family].filter(Boolean).join(" ")]) add(n, code);
  }
  return out;
}

/**
 * Next free `P-NNN` code: one past the highest numeric code ever given — of the participants, the
 * retired codes of deleted ones and the pseudonym map's codes (`taken`), so none is reissued (R117 C1).
 */
export function nextParticipantCode(participants: Participant[], taken: Iterable<string> = []): string {
  let max = 0;
  for (const code of [...participants.map((p) => p.code), ...taken]) {
    const m = /^P-(\d+)$/i.exec(code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `P-${String(max + 1).padStart(3, "0")}`;
}

/**
 * Ensures every creator has a code, creating a (detail-less) participant for
 * each new person. Returns the codes of `creators` in order and whether the
 * map or the project data changed.
 */
export function assignCodes(
  creators: Creator[],
  map: Map<string, string>,
  data: ProjectJson,
  tx: Tx,
): { codes: Array<string | undefined>; participantIds: string[]; changed: boolean } {
  let changed = false;
  const codes: Array<string | undefined> = [];
  const participantIds: string[] = [];
  const lookup = (key: string) => [...map.entries()].find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
  for (const c of creators) {
    // The interviewer is the researcher, not a research participant.
    const key = c.role === "interviewer" ? undefined : creatorKey(c);
    if (!key) {
      codes.push(undefined);
      continue;
    }
    let code = lookup(key);
    if (!code) {
      code = nextParticipantCode(data.participants, [...map.values(), ...(data.retiredParticipantCodes ?? [])]);
      const p: Participant = { id: newId(), projectId: tx.projectId, code, consentIds: [] };
      data.participants.push(p);
      tx.record("participant", p.id, null, p);
      map.set(key, code);
      changed = true;
    }
    codes.push(code);
    const pid = data.participants.find((p) => p.code === code)?.id;
    if (pid && !participantIds.includes(pid)) participantIds.push(pid);
  }
  return { codes, participantIds, changed };
}
