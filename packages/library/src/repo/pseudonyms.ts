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

/** Next free `P-NNN` code (one past the highest numeric code in use). */
export function nextParticipantCode(participants: Participant[]): string {
  let max = 0;
  for (const p of participants) {
    const m = /^P-(\d+)$/.exec(p.code);
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
      code = nextParticipantCode(data.participants);
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
