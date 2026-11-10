import type { FieldEvidence, FieldVerification, SourceType } from "../model/index.js";
import {
  clip, datesEqual, getByPointer, datePrecision, groundedIn, handleKey, longEnough, hasTokens, isRecord, NO_SPACE_SCRIPT, normalizeTitle,
  parseEdtf, quoteStatesDate, snapshotDates, sourceKey, textOf, textVariants, titleSimilarity, TRUSTED_KINDS,
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
  "/volume": "Volume",
  "/issue": "Issue",
  "/page": "Pages",
  "/edition": "Edition",
  "/numberOfPages": "Number of pages",
  "/publisherPlace": "Place of publication",
  "/collectionTitle": "Series",
  "/collectionNumber": "Number in series",
  "/genre": "Genre",
  "/medium": "Medium",
  "/number": "Number",
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
/**
 * `handleRescue`: a record with a family name may match a handle-only record by handle alone. Only
 * social posts and videos allow that; elsewhere a matching handle must not carry an unsupported name.
 */
function personAgree(x: Person, y: Person, handleRescue: boolean): boolean {
  const wholeVsStructured = (w: string, o: Person) =>
    !!o.family && !!o.given && [...joinNames(o.given, o.family), ...joinNames(o.family, o.given)].some((n) => n === w || n.replace(/ /g, "") === w.replace(/ /g, ""));
  if (x.whole || y.whole) {
    if (x.whole && y.whole) return x.whole === y.whole;
    return x.whole ? wholeVsStructured(x.whole, y) : wholeVsStructured(y.whole!, x);
  }
  const sameHandle = !!x.handle && x.handle === y.handle;
  const handlesCompatible = !x.handle || !y.handle || x.handle === y.handle;
  if (x.family && y.family) return x.family === y.family && (!x.given || !y.given || x.given === y.given) && handlesCompatible;
  // One side carries a name (family or given) the other does not have: only a handle could link them.
  if (x.family || y.family || !x.given !== !y.given) return handleRescue && sameHandle;
  if (x.given && y.given) return x.given === y.given && handlesCompatible;
  return sameHandle;
}
/** The full ordered creator lists match: same length, and each position the same person. */
export function creatorsAgree(a: unknown, b: unknown, type?: string): boolean {
  const la = creatorList(a), lb = creatorList(b);
  if (la.length === 0 || la.length !== lb.length) return false;
  const handleRescue = type !== undefined && SOCIAL.has(type);
  return la.every((x, i) => personAgree(person(x), person(lb[i]!), handleRescue));
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
/** Creators as shown in reason sentences: the whole literal or "Family, Given", plus the handle ("@name") if any. */
function creatorsText(v: unknown): string {
  const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
  return creatorList(v).map((x) => {
    const family = str(x.family), given = str(x.given);
    const name = str(x.literal) ?? (family && given ? `${family}, ${given}` : family ?? given);
    const handle = str(x.handle) ? `@${str(x.handle)!.replace(/^@/, "")}` : undefined;
    return name && handle ? `${name} (${handle})` : name ?? handle ?? "?";
  }).join("; ");
}

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

/**
 * Do two evidence values for this field say the same thing (at the precision we care about)?
 * `type` is the source type; it only matters for creators (see personAgree).
 * Lists (ISBNs etc.) agree when they are equal as sets or one contains the other; that is only safe
 * between sources that each already list every current value (see matchDraft).
 */
export function agree(field: string, a: unknown, b: unknown, type?: string): boolean {
  if (field === "/title" || field === "/container") {
    return textVariants(a).some((x) => textVariants(b).some((y) => titleSimilarity(x, y) >= 0.9));
  }
  if (field === "/issued") {
    const x = parseEdtf(a), y = parseEdtf(b);
    return !!x && !!y && datesEqual(x, y);
  }
  if (field === "/creators") {
    return creatorsAgree(a, b, type);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = canonList(field, a), y = canonList(field, b);
    if (x.length === 0 || y.length === 0) return false;
    return x.every((k) => y.includes(k)) || y.every((k) => x.includes(k));
  }
  return canon(field, a) === canon(field, b);
}

export type Match = "exact" | "near" | "differ";
const sameText = (x: string, among: string[]) => normalizeTitle(x) !== "" && among.some((y) => normalizeTitle(x) === normalizeTitle(y));

/**
 * The title/container texts that must each be supported: every variant that is not a translation
 * (original, romanized). Translations are labelled as such and need no source, but they cannot stand
 * in for an unsupported original. Empty when the value has only translations.
 */
function requiredTexts(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (!isRecord(v) || !Array.isArray(v.variants)) return [];
  return v.variants.flatMap((x) => (isRecord(x) && typeof x.value === "string" && x.kind !== "translated" ? [x.value] : []));
}
/** Every required text passes; a value with only translations passes if any of them does. */
function everyRequired(v: unknown, ok: (text: string) => boolean): boolean {
  const req = requiredTexts(v);
  return req.length > 0 ? req.every(ok) : textVariants(v).some(ok);
}

/**
 * How well does an evidence value support the CURRENT value? "near" = close but not enough.
 * A list of identifiers is supported only by a source that lists every current value.
 */
export function matchDraft(field: string, evValue: unknown, draftValue: unknown, type?: string): Match {
  if (field === "/title" || field === "/container") {
    const ev = textVariants(evValue);
    if (everyRequired(draftValue, (x) => sameText(x, ev))) return "exact";
    const dv = requiredTexts(draftValue).length > 0 ? requiredTexts(draftValue) : textVariants(draftValue);
    return dv.some((x) => ev.some((y) => titleSimilarity(x, y) >= 0.9)) ? "near" : "differ";
  }
  if (field === "/issued") {
    const d = parseEdtf(draftValue), e = parseEdtf(evValue);
    if (!d || !e || !datesEqual(d, e)) return "differ";
    return datePrecision(d) > datePrecision(e) ? "near" : "exact";
  }
  if (field !== "/creators" && (Array.isArray(evValue) || Array.isArray(draftValue))) {
    const dv = canonList(field, draftValue), ev = canonList(field, evValue);
    const found = dv.filter((k) => ev.includes(k)).length;
    return dv.length > 0 && found === dv.length ? "exact" : found > 0 ? "near" : "differ";
  }
  return agree(field, evValue, draftValue, type) ? "exact" : "differ";
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

const DAY_MS = 86_400_000;

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
    // The platform's own dates (timestamp vs upload_date) more than a day apart: the platform data
    // contradicts itself, so neither can confirm the date (a one-day gap is a time-zone difference).
    const full = dates.filter((d) => d.m !== undefined && d.d !== undefined).map((d) => Date.UTC(d.y, d.m! - 1, d.d!));
    if (full.length > 1 && Math.max(...full) - Math.min(...full) > DAY_MS) {
      return result("conflict", ["platform-date"], "The platform data gives two different dates for this post (its timestamp and its upload date), so the date needs checking.");
    }
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
    // The handle says nothing about a family name; only social posts and videos are identified by handle alone.
    const byHandleAlone = SOCIAL.has(c.type) || list.every((x) => !person(x).family && !person(x).given && !person(x).whole);
    if (byHandleAlone && withHandle.length > 0 && withHandle.length === list.length) return result("verified", ["platform-handle"]);
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

function conflicts(field: string, a: unknown, b: unknown, type: string): boolean {
  if (field === "/title") {
    const x = textOf(a), y = textOf(b);
    return x !== undefined && y !== undefined && titleSimilarity(x, y) < 0.6;
  }
  if (field === "/issued") {
    const x = parseEdtf(a), y = parseEdtf(b);
    return !!x && !!y && Math.abs(x.y - y.y) > 1;
  }
  if (field === "/creators") {
    return creatorList(a).length > 0 && creatorList(b).length > 0 && !creatorsAgree(a, b, type);
  }
  return false;
}

export function checkCrossSource(field: string, c: CheckCtx): FieldVerification | undefined {
  const evs = evidenceFor(c, field).filter((e) => e.source.kind !== "user");
  for (let i = 0; i < evs.length; i++) {
    for (let j = i + 1; j < evs.length; j++) {
      const a = evs[i]!, b = evs[j]!;
      if (conflicts(field, a.value, b.value, c.type)) {
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

/** The quote is long enough and exists in the document/snapshot. */
function quoteFound(e: FieldEvidence, c: CheckCtx): boolean {
  if (typeof e.quote !== "string") return false;
  const q = normalizeTitle(e.quote);
  if (!q || !quoteTokensOk(q)) return false;
  return hasTokens(c.docNorm, q) || snapNorm(c.snapshot, [...PLATFORM_TEXT_KEYS, ...PLATFORM_NAME_KEYS]).some((x) => hasTokens(x, q));
}

/**
 * A given name must be in the quote too. A full given name anywhere (token-bounded); initials only
 * directly next to the family name ("A. Okafor", "Okafor, A.", "A.B. Okafor").
 */
function givenInQuote(p: Person, q: string): boolean {
  if (!p.given) return true;
  const parts = p.given.split(" ");
  if (parts.some((w) => Array.from(w).length > 1 || NO_SPACE_SCRIPT.test(w))) return hasTokens(q, p.given);
  if (!p.family) return false;
  return [p.given, parts.join("")].some((g) => hasTokens(q, `${g} ${p.family}`) || hasTokens(q, `${p.family} ${g}`));
}

/** The quote exists in the document/snapshot, is long enough, and actually contains the whole value it supports. */
function quoteSupports(field: string, e: FieldEvidence, c: CheckCtx): boolean {
  if (typeof e.quote !== "string" || !quoteFound(e, c)) return false;
  const q = normalizeTitle(e.quote);
  if (field === "/issued") {
    // Every component the date gives (year, month, day) must be written in the quote.
    const d = parseEdtf(e.value);
    return !!d && quoteStatesDate(e.quote, d);
  }
  if (field === "/creators") {
    const list = creatorList(e.value);
    return list.length > 0 && list.every((x) => {
      const n = creatorName(x, SOCIAL.has(c.type));
      const nn = n ? normalizeTitle(n) : "";
      return !!nn && longEnough(nn, "name") && hasTokens(q, nn) && givenInQuote(person(x), q);
    });
  }
  const inQuote = (v: string) => !!v && longEnough(v, "title") && hasTokens(q, v);
  if (field === "/title" || field === "/container") {
    // The evidence matched the current value, so check the current value: every original/romanized variant must be quoted.
    return everyRequired(getByPointer(c.draft, field), (t) => inQuote(normalizeTitle(t)));
  }
  // A list (ISBNs etc.) is backed only when the quote contains every one of its values.
  if (Array.isArray(e.value)) return e.value.length > 0 && e.value.every((x) => textVariants(x).map(normalizeTitle).some(inQuote));
  return textVariants(e.value).map(normalizeTitle).some(inQuote);
}

// ---------------------------------------------------------------- grounding

function creatorNames(c: CheckCtx): (string | undefined)[] {
  const social = SOCIAL.has(c.type);
  return creatorList(c.draft.creators).map((x) => creatorName(x, social));
}

/** Is the field's current value found in the document text or the platform snapshot? */
export function checkGrounding(field: string, c: CheckCtx): FieldVerification | undefined {
  if (field === "/title") {
    // Every original/romanized variant must be found; a translation found in the text grounds nothing else.
    const inDoc = (t: string) => groundedIn(c.docNorm, normalizeTitle(t), "title");
    if (everyRequired(c.draft.title, inDoc)) return result("verified", ["found-in-document-text"]);
    const snaps = snapNorm(c.snapshot, PLATFORM_TEXT_KEYS);
    const inSnap = (t: string) => snaps.some((s) => groundedIn(s, normalizeTitle(t), "title"));
    if (everyRequired(c.draft.title, (t) => inDoc(t) || inSnap(t))) return result("verified", ["found-in-platform-data"]);
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

/** Call only with evidence that already supports the current value (matchDraft "exact"). */
export function independentAgreement(field: string, evs: FieldEvidence[], type?: string): boolean {
  const usable = evs.filter((e) => TRUSTED_KINDS.has(e.source.kind));
  for (let i = 0; i < usable.length; i++)
    for (let j = i + 1; j < usable.length; j++)
      if (sourceKey(usable[i]!) !== sourceKey(usable[j]!) && agree(field, usable[i]!.value, usable[j]!.value, type)) return true;
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

function aiUnverified(label: string, aiEvs: FieldEvidence[], c: CheckCtx): FieldVerification {
  const hasQuote = aiEvs.some((e) => typeof e.quote === "string" && e.quote.trim() !== "");
  if (aiEvs.some((e) => quoteFound(e, c))) {
    return result("unverified", ["ai-quote"], `${label} was suggested by AI, but the passage it quoted does not clearly state it.`);
  }
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

  const match = new Map(evs.map((e) => [e, matchDraft(field, e.value, value, c.type)] as const));
  const agreeing = evs.filter((e) => match.get(e) === "exact");
  const near = evs.filter((e) => match.get(e) === "near");
  const disagreeing = evs.filter((e) => match.get(e) === "differ");
  const mismatchSentence = (e: FieldEvidence) =>
    `${label} recorded here ("${showValue(field, value)}") does not match what ${sourceName(e)} says ("${showValue(field, e.value)}").`;
  const trustedDis = disagreeing.filter((e) => TRUSTED_KINDS.has(e.source.kind));
  if (trustedDis.length > 0) {
    return { ...result("conflict", ["draft-vs-evidence"], mismatchSentence(trustedDis[0]!), trustedDis.map((e) => ({ value: e.value, source: e.source }))), current: value };
  }
  if (agreeing.length === 0 && near.length > 0 && Array.isArray(value) && field !== "/creators") {
    // A list of identifiers: say which values no source lists.
    const listed = new Set(evs.flatMap((e) => canonList(field, e.value)));
    const missing = value.filter((x) => !listed.has(canon(field, x)));
    const names = missing.slice(0, 3).map((x) => `"${clip(x)}"`).join(", ") + (missing.length > 3 ? ` and ${missing.length - 3} more` : "");
    return result("unverified", ["draft-vs-evidence"], missing.length > 0
      ? `${label}: ${names} ${missing.length === 1 ? "is" : "are"} not listed by any source, so ${missing.length === 1 ? "it" : "they"} may be mistyped or invented.`
      : `${label}: no single source lists all of the values recorded here, so the list could not be confirmed as a whole.`);
  }
  if (agreeing.length === 0 && near.length > 0 && (field === "/title" || field === "/container") && requiredTexts(value).length > 1) {
    // Several original/romanized variants: say which ones no source gives.
    const given = evs.flatMap((e) => textVariants(e.value));
    const missing = requiredTexts(value).filter((t) => !sameText(t, given));
    const names = missing.slice(0, 3).map((x) => `"${clip(x)}"`).join(", ");
    return result("unverified", ["draft-vs-evidence"], missing.length > 0
      ? `${label}: the version${missing.length === 1 ? "" : "s"} ${names} ${missing.length === 1 ? "is" : "are"} not given by any source.`
      : `${label}: no single source gives every version recorded here, so it could not be confirmed as a whole.`);
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
  if (aiEvs.length > 0 && agreeing.every((e) => e.source.kind === "ai")) return aiUnverified(label, aiEvs, c);

  const grounded = checkGrounding(field, c);
  if (grounded) return grounded;

  if (independentAgreement(field, solid, c.type)) return result("verified", ["independent-sources-agree"]);
  if (solid.some((e) => TRUSTED_KINDS.has(e.source.kind))) return result("single-source", ["single-trusted-source"]);

  if (agreeing.length === 0) {
    // Only user evidence for a different (older) value is left: say so instead of leaving the field unmarked.
    if (allEvs.some((e) => e.source.kind === "user")) {
      return result("unverified", ["user-stale"], `${label} no longer matches the value the researcher confirmed, and nothing else confirms it.`);
    }
    return required ? result("unverified", ["evidence"], `${label} has no recorded source, so it could not be checked.`) : undefined;
  }
  if (aiEvs.length > 0) return aiUnverified(label, aiEvs, c);
  return result("unverified", ["filename-only"], c.docNorm
    ? `${label} from the file name could not be found in the document text.`
    : `${label} comes only from the file name and nothing else confirms it.`);
}
