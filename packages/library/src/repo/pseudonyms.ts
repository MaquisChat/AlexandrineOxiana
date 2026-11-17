/**
 * Pseudonym map (spec 4.4): handle or name → participant code, kept only in
 * `<Project>/keys/pseudonyms.json.enc` (encrypted with the project key).
 */
import type { Creator, Participant } from "@ao/core";
import { creatorNameTexts, newId } from "@ao/core";
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
 * "fullName", "handle" …); and `creators` with their codes (the folder name of a new source: each
 * of core's `creatorNameTexts` — handle, literal, "given family", family, each word of a family name
 * of several words, given; a folder replaces each of any length, R387 c). The first
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

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
/** Scripts written without spaces (core's NO_SPACE_SCRIPT, the set title verification uses). */
const NO_SPACE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const HANGUL = /\p{Script=Hangul}/u;

/**
 * The key by which `assignCodes` decides that a creator is a participant already coded (R403 b):
 * compatibility forms (NFKC) and case folded, invisible (default-ignorable) characters removed, white
 * space collapsed and trimmed, and a space between two characters of a script written without spaces,
 * or between two Hangul characters, removed ("김 민수" = "김민수", "山田 太郎" = "山田太郎": a family and
 * a given name written apart or together). Accents, voicing marks, "@" and punctuation are KEPT.
 * It is deliberately NOT core's `fold`/`normName`, by which names are found in text: over-matching
 * is the safe side for REPLACING a name, and the unsafe side for deciding WHO a person is — Hương
 * and Hường, Peña and Pena, ハナコ and バナコ, "@maria" and "María" are different people, and one
 * participant for both would hang the second person's source on the first person's consent.
 */
export function identityKey(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(IGNORABLE, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/(.) (?=(.))/gsu, (m, a: string, b: string) =>
      (NO_SPACE.test(a) && NO_SPACE.test(b)) || (HANGUL.test(a) && HANGUL.test(b)) ? a : m,
    );
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
  // An existing participant is found by the strict identity key (R403 b): "LUCIA FERNANDEZ" is the
  // "Lucia Fernandez" already coded; "Lucia Fernandez" is not "Lucía Fernández".
  const lookup = (key: string) => {
    const n = identityKey(key);
    // A key that is nothing but invisible characters and spaces is compared as written (lowercased).
    return [...map.entries()].find(([k]) => (n ? identityKey(k) === n : k.toLowerCase() === key.toLowerCase()))?.[1];
  };
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
