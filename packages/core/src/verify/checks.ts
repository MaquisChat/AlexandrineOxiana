import type { FieldEvidence, FieldVerification, SourceType } from "../model/index.js";
import {
  clip, datesEqual, getByPointer, datePrecision, groundedIn, handleKey, longEnough, hasTokens, isRecord, NO_SPACE_SCRIPT, normalizeTitle,
  parseEdtf, snapshotDates, sourceKey, textOf, textVariants, titleSimilarity, TRUSTED_KINDS,
} from "./evidence.js";
import type { LookupEvidence } from "./evidence.js";

/** Everything one field check needs; built once per verifyDraft call. */
export interface CheckCtx {
  type: string;
  draft: Record<string, unknown>;
  /** Stored evidence plus synthetic evidence from lookups, for ALL fields. */
  evidence: FieldEvidence[];
  documentText?: string;
  /** Normalized, capped document text ("" when absent). */
  docNorm: string;
  snapshot?: Record<string, unknown>;
  lookups: LookupEvidence[];
}

export const FIELD_LABELS: Record<string, string> = {
  "/title": "Title",
  "/creators": "Creators",
  "/issued": "Publication date",
  "/container": "Container (journal or site name)",
  "/publisher": "Publisher",
  "/identifiers/platformPostId": "Post ID",
  "/identifiers/url": "Link",
  "/identifiers/doi": "DOI",
  "/identifiers/isbn": "ISBN",
};
export const labelOf = (field: string): string => FIELD_LABELS[field] ?? `Field ${field}`;

const SOCIAL: ReadonlySet<string> = new Set<SourceType>(["social-post", "video"]);
const PLATFORM_TEXT_KEYS = ["title", "fulltitle", "caption", "description", "text"];
const PLATFORM_NAME_KEYS = ["uploader", "uploader_id", "channel", "owner_username"];

function snapStrings(snap: Record<string, unknown> | undefined, keys: string[]): string[] {
  if (!snap) return [];
  return keys.flatMap((k) => (typeof snap[k] === "string" || typeof snap[k] === "number" ? [String(snap[k])] : []));
}
const snapNorm = (snap: Record<string, unknown> | undefined, keys: string[]) =>
  snapStrings(snap, keys).map(normalizeTitle).filter(Boolean);

function evidenceFor(c: CheckCtx, field: string): FieldEvidence[] {
  return c.evidence.filter((e) => e.field === field);
}

/** Creator records of a value; a bare string counts as one literal creator. */
export function creatorList(v: unknown): Record<string, unknown>[] {
  if (typeof v === "string") return v.trim() ? [{ literal: v }] : [];
  return Array.isArray(v) ? v.filter(isRecord) : [];
}
type Person = { family?: string; given?: string; whole?: string; handle?: string };
const nz = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const n = normalizeTitle(v);
  return n || undefined;
};
/**
 * Normalized parts of a creator. A literal with a comma is "Family, Given"; a literal without a comma
 * is kept whole (it may be an organisation) and never split into words.
 */
function person(x: Record<string, unknown>): Person {
  const p: Person = { family: nz(x.family), given: nz(x.given), handle: nz(x.handle) };
  if (typeof x.literal === "string" && x.literal.trim()) {
    const lit = x.literal.trim();
    if (lit.includes(",")) {
      p.family ??= nz(lit.split(",")[0]);
      p.given ??= nz(lit.split(",").slice(1).join(" "));
    } else p.whole = nz(lit);
  }
  return p;
}
export function creatorName(x: Record<string, unknown>, handleFirst = false): string | undefined {
  const p = person(x);
  const lit = p.whole ?? undefined;
  const raw = (k: "family" | "handle") => (typeof x[k] === "string" && (x[k] as string).trim() ? (x[k] as string).trim() : undefined);
  const fam = raw("family") ?? (p.family && typeof x.literal === "string" ? x.literal.split(",")[0]!.trim() : undefined);
  const whole = lit && typeof x.literal === "string" ? x.literal.trim() : undefined;
  const order = handleFirst ? [raw("handle"), fam, whole] : [fam, whole, raw("handle")];
  return order.find((v) => v !== undefined);
}
const joinNames = (a: string, b: string) => [`${a} ${b}`, ...(NO_SPACE_SCRIPT.test(a + b) ? [`${a}${b}`] : [])];
function personAgree(x: Person, y: Person): boolean {
  const wholeVsStructured = (w: string, o: Person) =>
    !!o.family && !!o.given && [...joinNames(o.given, o.family), ...joinNames(o.family, o.given)].some((n) => n === w || n.replace(/ /g, "") === w.replace(/ /g, ""));
  if (x.whole || y.whole) {
    if (x.whole && y.whole) return x.whole === y.whole;
    return x.whole ? wholeVsStructured(x.whole, y) : wholeVsStructured(y.whole!, x);
  }
  if (x.family && y.family) return x.family === y.family && (!x.given || !y.given || x.given === y.given);
  if (x.handle && y.handle && !x.family && !y.family) return x.handle === y.handle;
  if (x.handle && y.handle && (!x.family || !y.family)) return x.handle === y.handle;
  return false;
}
/** The full ordered creator lists match: same length, and each position the same person. */
export function creatorsAgree(a: unknown, b: unknown): boolean {
  const la = creatorList(a), lb = creatorList(b);
  if (la.length === 0 || la.length !== lb.length) return false;
  return la.every((x, i) => personAgree(person(x), person(lb[i]!)));
}
/** Exact creator list equality on family, given, whole literal and handle. */
export function creatorsEqualStrict(a: unknown, b: unknown): boolean {
  const la = creatorList(a), lb = creatorList(b);
  if (la.length === 0 || la.length !== lb.length) return false;
  return la.every((x, i) => {
    const y = lb[i]!;
    return (["family", "given", "literal", "handle"] as const).every((k) => nz(x[k]) === nz(y[k]));
  });
}
const creatorsText = (v: unknown): string =>
  creatorList(v).map((x) => (typeof x.literal === "string" && x.literal.trim() ? x.literal.trim() : creatorName(x) ?? "?")).join("; ");

const canonList = (field: string, v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).map((x) => canon(field, x));

const canon = (field: string, v: unknown): string => {
  if (Array.isArray(v)) return v.map((x) => canon(field, x)).sort().join("|");
  const t = textOf(v);
  if (t === undefined) return JSON.stringify(v) ?? "";
  if (field === "/identifiers/doi" || field === "/identifiers/isbn" || field === "/identifiers/arxiv") {
    return t.trim().toLowerCase().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/, "").replace(/[\s-]/g, "");
  }
  if (field === "/identifiers/issn") return t.toUpperCase().replace(/[\s-]/g, "");
  if (field === "/identifiers/url") {
    try {
      const u = new URL(t.trim());
      return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}${u.search}${u.hash}`;
    } catch {
      return t.trim();
    }
  }
  if (field.startsWith("/identifiers/")) return t.trim();
  return normalizeTitle(t);
};

/** Do two evidence values for this field say the same thing (at the precision we care about)? */
export function agree(field: string, a: unknown, b: unknown): boolean {
  if (field === "/title" || field === "/container") {
    return textVariants(a).some((x) => textVariants(b).some((y) => titleSimilarity(x, y) >= 0.9));
  }
  if (field === "/issued") {
    const x = parseEdtf(a), y = parseEdtf(b);
    return !!x && !!y && datesEqual(x, y);
  }
  if (field === "/creators") {
    return creatorsAgree(a, b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const y = canonList(field, b);
    return canonList(field, a).some((x) => y.includes(x));
  }
  return canon(field, a) === canon(field, b);
}

export type Match = "exact" | "near" | "differ";

/** How well does an evidence value support the CURRENT value? "near" = close but not enough. */
export function matchDraft(field: string, evValue: unknown, draftValue: unknown): Match {
  if (field === "/title" || field === "/container") {
    const dv = textVariants(draftValue), ev = textVariants(evValue);
    if (dv.some((x) => ev.some((y) => normalizeTitle(x) !== "" && normalizeTitle(x) === normalizeTitle(y)))) return "exact";
    return dv.some((x) => ev.some((y) => titleSimilarity(x, y) >= 0.9)) ? "near" : "differ";
  }
  if (field === "/issued") {
    const d = parseEdtf(draftValue), e = parseEdtf(evValue);
    if (!d || !e || !datesEqual(d, e)) return "differ";
    return datePrecision(d) > datePrecision(e) ? "near" : "exact";
  }
  return agree(field, evValue, draftValue) ? "exact" : "differ";
}

const setEqual = (field: string, a: unknown, b: unknown) => {
  const x = new Set(canonList(field, a)), y = new Set(canonList(field, b));
  return x.size === y.size && [...x].every((k) => y.has(k));
};

function variantKeys(v: unknown): string[] | undefined {
  if (!isRecord(v) || !Array.isArray(v.variants)) return undefined;
  return v.variants.filter(isRecord).map((x) => `${String(x.lang)}|${String(x.kind)}|${normalizeTitle(String(x.value))}`).sort();
}

/** Strict agreement used before stamping `user-confirmed`: no similarity thresholds, no coarser dates. */
export function agreeStrict(field: string, a: unknown, b: unknown): boolean {
  if (field === "/title" || field === "/container") {
    const ka = variantKeys(a), kb = variantKeys(b);
    if (ka && kb) return ka.length > 0 && ka.join("\n") === kb.join("\n");
    const one = (v: unknown, k: string[] | undefined) => (k ? (k.length === 1 ? k[0]!.split("|").slice(2).join("|") : undefined) : typeof v === "string" ? normalizeTitle(v) : undefined);
    const x = one(a, ka), y = one(b, kb);
    return x !== undefined && x !== "" && x === y;
  }
  if (field === "/issued") return typeof a === "string" && a === b;
  if (field === "/creators") return creatorsEqualStrict(a, b);
  if (Array.isArray(a) || Array.isArray(b)) return setEqual(field, a, b);
  return canon(field, a) === canon(field, b);
}

const result = (status: FieldVerification["status"], checks: string[], reason?: string, values?: FieldVerification["values"]): FieldVerification => ({
  status, checks, ...(reason ? { reason } : {}), ...(values ? { values } : {}),
});

// ---------------------------------------------------------------- platform identity

export function checkPlatformIdentity(field: string, c: CheckCtx): FieldVerification | undefined {
  const snap = c.snapshot;
  if (!snap) return undefined;
  const id = typeof snap.id === "string" || typeof snap.id === "number" ? String(snap.id) : undefined;

  if (field === "/identifiers/platformPostId" || field === "/identifiers/url") {
    if (id === undefined) return undefined;
    const postId = getByPointer(c.draft, "/identifiers/platformPostId");
    const url = getByPointer(c.draft, "/identifiers/url");
    if (field === "/identifiers/platformPostId") {
      if (typeof postId !== "string") return undefined;
      if (postId !== id) return result("conflict", ["platform-id"], `The post ID "${clip(postId)}" does not match the ID recorded when the post was captured ("${clip(id)}").`);
      if (typeof url === "string" && !url.includes(postId)) return result("conflict", ["platform-id"], `The post ID "${clip(postId)}" does not appear in the link.`);
      return result("verified", ["platform-id"]);
    }
    if (typeof url !== "string") return undefined;
    if (!url.includes(id)) return result("conflict", ["platform-id"], `The link does not contain the post ID recorded when the post was captured ("${clip(id)}").`);
    return result("verified", ["platform-id"]);
  }

  if (field === "/issued") {
    const dates = snapshotDates(snap);
    const issued = parseEdtf(c.draft.issued);
    if (dates.length === 0 || !issued) return undefined;
    const ok = dates.some((d) => datesEqual(issued, d));
    return ok
      ? result("verified", ["platform-date"])
      : result("conflict", ["platform-date"], `The date "${clip(c.draft.issued)}" does not match the date recorded by the platform.`);
  }

  if (field === "/creators") {
    const handles = snapStrings(snap, ["uploader_id", "owner_username"]).map(handleKey);
    if (handles.length === 0) return undefined;
    const list = creatorList(c.draft.creators);
    const withHandle = list.filter((x) => typeof x.handle === "string" && x.handle);
    const bad = withHandle.find((x) => !handles.includes(handleKey(x.handle as string)));
    if (bad) return result("conflict", ["platform-handle"], `The handle "${clip(bad.handle)}" does not match the account recorded by the platform.`);
    if (withHandle.length > 0 && withHandle.length === list.length) return result("verified", ["platform-handle"]);
  }
  return undefined;
}

// ---------------------------------------------------------------- identifier integrity

export function isbnValid(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (10 - i) * (s[i] === "X" ? 10 : Number(s[i]));
    return sum % 11 === 0;
  }
  if (/^\d{13}$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
    return sum % 10 === 0;
  }
  return false;
}

const normDoi = (d: string) => d.trim().toLowerCase().replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:)/, "");

export function checkIdentifier(field: string, c: CheckCtx): FieldVerification | undefined {
  if (field === "/identifiers/isbn") {
    const raw = c.draft.identifiers && isRecord(c.draft.identifiers) ? c.draft.identifiers.isbn : undefined;
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
    const bad = list.find((x) => typeof x !== "string" || !isbnValid(x));
    if (bad !== undefined) return result("conflict", ["isbn-checksum"], `The ISBN "${clip(bad)}" is not valid (its check digit does not add up), so it may be mistyped or invented.`);
    return undefined;
  }
  if (field === "/identifiers/doi") {
    const doi = getByPointer(c.draft, "/identifiers/doi");
    if (typeof doi !== "string") return undefined;
    const hit = c.lookups.find((l) => typeof l.matchedIdentifier === "string" && normDoi(l.matchedIdentifier) === normDoi(doi) && typeof l.title === "string");
    if (!hit) return undefined;
    const titles = textVariants(c.draft.title);
    let sim = Math.max(0, ...titles.map((t) => titleSimilarity(t, hit.title!)));
    const lt = normalizeTitle(hit.title!);
    if (lt && groundedIn(c.docNorm, lt, "title")) sim = Math.max(sim, 1);
    if (sim >= 0.9) return result("verified", ["doi-lookup"]);
    if (sim < 0.6) return result("conflict", ["doi-lookup"], `The DOI resolves to a different work ("${clip(hit.title)}") than the title recorded here.`);
    return result("unverified", ["doi-lookup"], `The DOI resolves to a work whose title only partly matches ("${clip(hit.title)}").`);
  }
  return undefined;
}

// ---------------------------------------------------------------- cross-source conflict

function conflicts(field: string, a: unknown, b: unknown): boolean {
  if (field === "/title") {
    const x = textOf(a), y = textOf(b);
    return x !== undefined && y !== undefined && titleSimilarity(x, y) < 0.6;
  }
  if (field === "/issued") {
    const x = parseEdtf(a), y = parseEdtf(b);
    return !!x && !!y && Math.abs(x.y - y.y) > 1;
  }
  if (field === "/creators") {
    return creatorList(a).length > 0 && creatorList(b).length > 0 && !creatorsAgree(a, b);
  }
  return false;
}

export function checkCrossSource(field: string, c: CheckCtx): FieldVerification | undefined {
  const evs = evidenceFor(c, field).filter((e) => e.source.kind !== "user");
  for (let i = 0; i < evs.length; i++) {
    for (let j = i + 1; j < evs.length; j++) {
      const a = evs[i]!, b = evs[j]!;
      if (conflicts(field, a.value, b.value)) {
        const show = (e: FieldEvidence) => `"${clip(field === "/creators" ? creatorsText(e.value) : e.value)}" (from ${sourceName(e)})`;
        return result("conflict", ["cross-source"], `Two sources disagree about the ${labelOf(field).toLowerCase()}: ${show(a)} versus ${show(b)}.`, [
          { value: a.value, source: a.source },
          { value: b.value, source: b.source },
        ]);
      }
    }
  }
  return undefined;
}

export function sourceName(e: Pick<FieldEvidence, "source">): string {
  const k = e.source.kind;
  const base: Record<string, string> = {
    embedded: "the file's embedded data", lookup: "an online lookup", "platform-json": "the platform data",
    "page-dom": "the web page", filename: "the file name", ai: "AI", zotero: "Zotero", refman: "Reference Manager", ocr: "text recognition", user: "the researcher",
  };
  return k === "lookup" && e.source.provider ? `an online lookup (${e.source.provider})` : base[k] ?? k;
}

// ---------------------------------------------------------------- AI quotes

function quoteTokensOk(q: string): boolean {
  return NO_SPACE_SCRIPT.test(q) ? Array.from(q.replace(/ /g, "")).length >= 4 : q.split(" ").length >= 3;
}

/** The quote exists in the document/snapshot, is long enough, and actually contains the value it supports. */
function quoteSupports(field: string, e: FieldEvidence, c: CheckCtx): boolean {
  if (typeof e.quote !== "string") return false;
  const q = normalizeTitle(e.quote);
  if (!q || !quoteTokensOk(q)) return false;
  const inText = hasTokens(c.docNorm, q) || snapNorm(c.snapshot, [...PLATFORM_TEXT_KEYS, ...PLATFORM_NAME_KEYS]).some((x) => hasTokens(x, q));
  if (!inText) return false;
  if (field === "/issued") {
    const d = parseEdtf(e.value);
    return !!d && hasTokens(q, String(d.y));
  }
  if (field === "/creators") {
    const list = creatorList(e.value);
    return list.length > 0 && list.every((x) => {
      const n = creatorName(x, SOCIAL.has(c.type));
      const nn = n ? normalizeTitle(n) : "";
      return !!nn && longEnough(nn, "name") && hasTokens(q, nn);
    });
  }
  const vals = Array.isArray(e.value) ? e.value.flatMap(textVariants) : textVariants(e.value);
  return vals.map(normalizeTitle).some((v) => !!v && longEnough(v, "title") && hasTokens(q, v));
}

// ---------------------------------------------------------------- grounding

function creatorNames(c: CheckCtx): (string | undefined)[] {
  const social = SOCIAL.has(c.type);
  return creatorList(c.draft.creators).map((x) => creatorName(x, social));
}

/** Is the field's current value found in the document text or the platform snapshot? */
export function checkGrounding(field: string, c: CheckCtx): FieldVerification | undefined {
  if (field === "/title") {
    const titles = textVariants(c.draft.title).map(normalizeTitle).filter(Boolean);
    if (titles.some((t) => groundedIn(c.docNorm, t, "title"))) return result("verified", ["found-in-document-text"]);
    const snaps = snapNorm(c.snapshot, PLATFORM_TEXT_KEYS);
    if (titles.some((t) => snaps.some((s) => groundedIn(s, t, "title")))) return result("verified", ["found-in-platform-data"]);
    return undefined;
  }
  if (field === "/creators") {
    const names = creatorNames(c);
    if (names.length === 0 || names.some((n) => n === undefined)) return undefined;
    const snaps = snapNorm(c.snapshot, PLATFORM_NAME_KEYS);
    const ok = names.every((n) => {
      const nn = normalizeTitle(n!);
      return !!nn && (groundedIn(c.docNorm, nn, "name") || snaps.some((s) => groundedIn(s, nn, "name")));
    });
    return ok ? result("verified", ["found-in-document-or-platform-data"]) : undefined;
  }
  return undefined;
}

export function independentAgreement(field: string, evs: FieldEvidence[]): boolean {
  const usable = evs.filter((e) => TRUSTED_KINDS.has(e.source.kind));
  for (let i = 0; i < usable.length; i++)
    for (let j = i + 1; j < usable.length; j++)
      if (sourceKey(usable[i]!) !== sourceKey(usable[j]!) && agree(field, usable[i]!.value, usable[j]!.value)) return true;
  return false;
}

// ---------------------------------------------------------------- one field

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  const t = textOf(v);
  return t !== undefined && t.trim() === "";
}

function aiUnverified(label: string, aiEvs: FieldEvidence[]): FieldVerification {
  const hasQuote = aiEvs.some((e) => typeof e.quote === "string" && e.quote.trim() !== "");
  return result("unverified", ["ai-quote"], hasQuote
    ? `${label} was suggested by AI, but the passage it quoted could not be found in the document.`
    : `${label} was suggested by AI without a quoted passage from the document to back it up.`);
}

const showValue = (field: string, v: unknown) => clip(field === "/creators" ? creatorsText(v) : v);

export function verifyField(field: string, c: CheckCtx, required: boolean): FieldVerification | undefined {
  const label = labelOf(field);
  const allEvs = evidenceFor(c, field);
  const value = getByPointer(c.draft, field);
  const empty = isEmpty(value);

  if (empty) {
    return required || allEvs.length > 0 ? result("unverified", ["present"], `${label} is missing.`) : undefined;
  }
  // Integrity failures (bad ISBN checksum, DOI resolving to another work) override even user confirmation.
  const integrity = checkIdentifier(field, c);
  if (integrity?.status === "conflict") return integrity;
  // User evidence confirms only the value the user actually saw; a later change makes it stale.
  if (allEvs.some((e) => e.source.kind === "user" && agreeStrict(field, e.value, value))) return result("user-confirmed", ["user"]);
  const evs = allEvs.filter((e) => e.source.kind !== "user");

  if (field === "/issued" && !parseEdtf(value)) {
    return result("unverified", ["date-format"], `The publication date "${clip(value)}" is not in a form we can read (expected YYYY, YYYY-MM or YYYY-MM-DD).`);
  }
  const hit = checkPlatformIdentity(field, c) ?? checkIdentifier(field, c) ?? checkCrossSource(field, c);
  if (hit) return hit;

  const match = new Map(evs.map((e) => [e, matchDraft(field, e.value, value)] as const));
  const agreeing = evs.filter((e) => match.get(e) === "exact");
  const near = evs.filter((e) => match.get(e) === "near");
  const disagreeing = evs.filter((e) => match.get(e) === "differ");
  const mismatchSentence = (e: FieldEvidence) =>
    `${label} recorded here ("${showValue(field, value)}") does not match what ${sourceName(e)} says ("${showValue(field, e.value)}").`;
  const trustedDis = disagreeing.filter((e) => TRUSTED_KINDS.has(e.source.kind));
  if (trustedDis.length > 0) {
    return { ...result("conflict", ["draft-vs-evidence"], mismatchSentence(trustedDis[0]!), trustedDis.map((e) => ({ value: e.value, source: e.source }))), current: value };
  }
  if (agreeing.length === 0 && near.length > 0) {
    const n = near[0]!;
    return result("unverified", ["draft-vs-evidence"], field === "/issued"
      ? `${label} "${showValue(field, value)}" is more precise than any source supports (${sourceName(n)} says "${showValue(field, n.value)}").`
      : `${label} recorded here ("${showValue(field, value)}") differs slightly from the source (${sourceName(n)} says "${showValue(field, n.value)}").`);
  }
  if (agreeing.length === 0 && disagreeing.length > 0) {
    return result("unverified", ["draft-vs-evidence"], mismatchSentence(disagreeing[0]!));
  }

  const aiEvs = agreeing.filter((e) => e.source.kind === "ai");
  if (aiEvs.some((e) => quoteSupports(field, e, c))) return result("verified", ["ai-quote-found"]);
  const solid = agreeing.filter((e) => e.source.kind !== "filename" && e.source.kind !== "ai");
  // AI-only values are judged by their quote alone, never by the value merely appearing in the text.
  if (aiEvs.length > 0 && agreeing.every((e) => e.source.kind === "ai")) return aiUnverified(label, aiEvs);

  const grounded = checkGrounding(field, c);
  if (grounded) return grounded;

  if (independentAgreement(field, solid)) return result("verified", ["independent-sources-agree"]);
  if (solid.some((e) => TRUSTED_KINDS.has(e.source.kind))) return result("single-source", ["single-trusted-source"]);

  if (agreeing.length === 0) {
    return required ? result("unverified", ["evidence"], `${label} has no recorded source, so it could not be checked.`) : undefined;
  }
  if (aiEvs.length > 0) return aiUnverified(label, aiEvs);
  return result("unverified", ["filename-only"], c.docNorm
    ? `${label} from the file name could not be found in the document text.`
    : `${label} comes only from the file name and nothing else confirms it.`);
}
