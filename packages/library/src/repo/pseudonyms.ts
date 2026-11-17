/**
 * Pseudonym map (spec 4.4): handle or name → participant code, kept only in
 * `<Project>/keys/pseudonyms.json.enc` (encrypted with the project key).
 */
import type { Creator, Participant } from "@ao/core";
import { creatorNameTexts, identityKey, newId } from "@ao/core";
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

/**
 * The identifying string for a creator, under which it is looked up and recorded: its handle, else
 * its literal, else "given family". A handle is one identity with or without its "@" (R438): the
 * key is the handle with exactly one "@" in front ("fake.dancer", "@fake.dancer", "@@fake.dancer "
 * are one account). A name is never a handle: the literal "Maria" stays "Maria", another person
 * than "@maria" (R403 b). No fallback to an entry recorded earlier from a handle without its "@".
 */
export function creatorKey(c: Creator): string | undefined {
  const handle = c.handle?.trim().replace(/^[@\uFF20]+/u, "").trim();
  if (handle) return `@${handle}`.normalize("NFC");
  const k = c.literal?.trim() || [c.given, c.family].filter(Boolean).join(" ").trim();
  return k ? k.normalize("NFC") : undefined;
}

/** Detail keys of a participant that name the person (mapped to their code like the pseudonym map). */
export const NAME_KEY = /name|handle|user|alias|account/iu;

/**
 * The names of this project's participants, name → code (R387 d): ONE list for a source's folder
 * name (repo/sources.ts) and its citation (export/bibliography.ts), so the two cannot drift. The
 * pseudonym map; each participant's identifying details whose key names the person (`NAME_KEY`;
 * "fullName", "handle" …); and `creators` with their codes (the folder name of a new source: each
 * of core's `creatorNameTexts` — handle, literal, "given family", family, each word of a family name
 * of several words that could be a name by itself (R403 c), given; a folder replaces each of these
 * of any length, R387 c). The first
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
    for (const t of creatorNameTexts(c)) add(t.text, code);
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

// Identity is decided by core's `identityKey` (R403 b): compatibility forms and case folded,
// invisible characters removed, white space collapsed, no-space and Hangul words joined; accents,
// voicing marks, "@" and punctuation KEPT. Deliberately NOT core's `fold`/`normName`, by which names
// are found in text: over-matching is the safe side for REPLACING a name, the unsafe side for
// deciding WHO a person is (Hương and Hường, Peña and Pena, ハナコ and バナコ are different people).

/**
 * The code of the existing participant `key` names (R403 b, R427 a), the ONE identity look-up for
 * `assignCodes` and the profile capture (`pseudonymCodeFor`): the map entry equal to `key` AS
 * WRITTEN (NFC, ends trimmed) first; else the first equal by the strict key (`identityKey`). An older
 * library may hold two entries the strict key makes equal ("김 민수" P-001, "김민수" P-002: it compared
 * by lower case only): each spelling keeps its own record. Never the folded key: that is for
 * replacing names, not for deciding who a person is.
 */
export function participantCodeOf(map: ReadonlyMap<string, string>, key: string): string | undefined {
  const w = key.normalize("NFC").trim();
  for (const [k, code] of map) if (k.normalize("NFC").trim() === w) return code;
  const n = identityKey(key);
  // A key that is nothing but invisible characters and spaces is compared as written (lowercased).
  for (const [k, code] of map) if (n ? identityKey(k) === n : k.toLowerCase() === key.toLowerCase()) return code;
  return undefined;
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
  // An existing participant is found as written, else by the strict identity key (R403 b, R427 a):
  // "LUCIA FERNANDEZ" is the "Lucia Fernandez" already coded; "Lucia Fernandez" is not "Lucía Fernández".
  const lookup = (key: string) => participantCodeOf(map, key);
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
