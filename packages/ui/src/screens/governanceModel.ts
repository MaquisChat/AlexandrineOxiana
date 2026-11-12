/**
 * What the governance screen knows about the rules file (spec 6.3): the defaults, what each
 * profile requires (mirrors packages/core/src/governance/profiles/*.yaml — the service is the
 * authority and reports violations on save), which direction is "looser" for each control, and
 * edits to the YAML text that keep its comments.
 */
import { isMap, parseDocument, type Document } from "yaml";
import { CAPTURE_METHODS } from "@ao/core/src/governance/schema";
import type { Profile } from "../api/governance";

export const PROFILES: Array<{ id: Profile; label: string }> = [
  { id: "irb", label: "University IRB" },
  { id: "gdpr", label: "GDPR" },
  { id: "hipaa", label: "HIPAA" },
  { id: "dmp", label: "Funder DMP" },
];
export const PROFILE_LABEL: Record<Profile, string> = { irb: "IRB", gdpr: "GDPR", hipaa: "HIPAA", dmp: "Funder DMP" };

export const RESIDENCY_KINDS = ["device", "removable", "network", "cloud_folder", "own_server", "cloud"] as const;
export const RESIDENCY_LABEL: Record<(typeof RESIDENCY_KINDS)[number], string> = {
  device: "This computer",
  removable: "Removable drives",
  network: "Network storage",
  cloud_folder: "Approved cloud-synced folders",
  own_server: "The project's own server",
  cloud: "Public cloud",
};
export const PROCESSING_OPS = ["ocr", "image_proxy", "video_proxy", "metadata_lookup", "transcription", "translation", "agent"] as const;
export const PROCESSING_LABEL: Record<(typeof PROCESSING_OPS)[number], string> = {
  ocr: "Text recognition (OCR)",
  image_proxy: "Image viewing copies",
  video_proxy: "Video viewing copies",
  metadata_lookup: "Metadata lookups",
  transcription: "Transcription",
  translation: "Translation",
  agent: "Research agents",
};
/** Every capture method the rules know (the core schema's own list, so the form cannot miss one). */
export { CAPTURE_METHODS };
export type CaptureMethod = (typeof CAPTURE_METHODS)[number];
/** Each capture method in plain words (D11). */
export const CAPTURE_LABEL: Record<CaptureMethod, string> = {
  browser_capture: "Browser capture: pages and posts saved with the browser extension",
  downloader: "Downloader: videos and posts saved from their links on the Capture screen",
  official_api: "A platform's official interface (API)",
  manual_upload: "Files you add yourself: dropped, added by path, or imported from a folder or ZIP archive",
  zotero_import: "Import from Zotero",
  refman_import: "Import from a reference file (BibTeX, RIS, CSL-JSON, Zotero RDF)",
  calibre_import: "Import from a Calibre library",
  device_import: "Import from a camera or phone folder",
};
/** The methods that capture from the web: what a capture also needs (R41) is said next to them. */
export const WEB_CAPTURE_METHODS: readonly CaptureMethod[] = ["browser_capture", "downloader", "official_api"];
/** The data category whose default legal basis captures from the web use (the library's LEGAL_CATEGORY). */
export const WEB_LEGAL_CATEGORY = "social-media";

export const ENCRYPTION_LEVELS = ["required", "optional", "off"] as const;
export const LOCATION_LEVELS = ["strip", "coarsen", "keep"] as const;

export interface Config {
  profiles: Profile[];
  residency: { allowed: string[] };
  processing: Record<string, string[]>;
  identifiability: { containsIdentifiable: boolean; pseudonymizeFileNames: boolean; deidentifiedExportsOnly: boolean };
  consent: { requireStatus: boolean; requireLegalBasis: boolean; defaultLegalBasis?: Record<string, string> };
  captureMethods: string[];
  retention: { rawDataDestroyAfter: string | null };
  audit: { enabled: boolean };
  encryption: { atRest: string };
  sharing: { locationMetadata: string };
  protocol: {
    number: string | null;
    approvedFrom: string | null;
    expires: string | null;
    platforms: string[];
    populations: string[];
    languages: string[];
    requireBeforeCapture: boolean;
  };
  dmp: { repository: string | null; formats: string[]; metadataStandard: string | null; embargoUntil: string | null };
  exceptions: Array<{ control: string; value: unknown; reason: string; by: string; at: string }>;
}

export const DEFAULTS: Config = {
  profiles: [],
  residency: { allowed: ["device", "removable"] },
  processing: {
    ocr: ["local"],
    image_proxy: ["local"],
    video_proxy: ["local"],
    metadata_lookup: ["crossref", "openalex", "openlibrary", "loc"],
    transcription: ["local"],
    translation: ["local"],
    agent: ["local"],
  },
  identifiability: { containsIdentifiable: true, pseudonymizeFileNames: true, deidentifiedExportsOnly: true },
  consent: { requireStatus: true, requireLegalBasis: true },
  captureMethods: ["manual_upload", "zotero_import", "refman_import", "calibre_import", "device_import"],
  retention: { rawDataDestroyAfter: null },
  audit: { enabled: true },
  encryption: { atRest: "required" },
  sharing: { locationMetadata: "coarsen" },
  protocol: { number: null, approvedFrom: null, expires: null, platforms: [], populations: [], languages: [], requireBeforeCapture: false },
  dmp: { repository: null, formats: [], metadataStandard: null, embargoUntil: null },
  exceptions: [],
};

/** Largest governance.yaml the service accepts (GOVERNANCE_MAX_BYTES); refused before parsing (R117 I7). */
export const GOVERNANCE_MAX_BYTES = 64 * 1024;
/** Aliases a governance file may expand (each can expand a whole subtree). */
const MAX_ALIASES = 10;

/** Profile rules that are not control values (mirrors vendorRequires / cloudFolderNeedsApproval in the profile YAMLs). */
export const PROFILE_VENDOR_RULES: Partial<Record<Profile, string>> = {
  hipaa: "every outside vendor needs a signed business associate agreement (BAA)",
  gdpr: "every outside vendor needs a data processing agreement (DPA)",
};
export const PROFILE_RESIDENCY_RULES: Partial<Record<Profile, string>> = {
  hipaa: "approved cloud-synced folders count only when at least one is listed under residency.approvedCloudFolders; public cloud is never allowed",
};

/** A control path and what a profile requires there. */
export interface Requirement {
  control: string;
  value: unknown;
  /** "present": the profile only needs a value filled in (Funder DMP). */
  kind: "minimum" | "present" | "not-public-cloud";
}

export const PROFILE_REQUIREMENTS: Record<Profile, Requirement[]> = {
  irb: [
    { control: "protocol.requireBeforeCapture", value: true, kind: "minimum" },
    { control: "identifiability.pseudonymizeFileNames", value: true, kind: "minimum" },
    { control: "audit.enabled", value: true, kind: "minimum" },
  ],
  gdpr: [
    { control: "consent.requireLegalBasis", value: true, kind: "minimum" },
    { control: "audit.enabled", value: true, kind: "minimum" },
  ],
  hipaa: [
    { control: "encryption.atRest", value: "required", kind: "minimum" },
    { control: "residency.allowed", value: ["device", "removable", "network", "own_server", "cloud_folder"], kind: "not-public-cloud" },
    { control: "audit.enabled", value: true, kind: "minimum" },
    { control: "sharing.locationMetadata", value: "strip", kind: "minimum" },
  ],
  dmp: [
    { control: "dmp.repository", value: null, kind: "present" },
    { control: "dmp.formats", value: null, kind: "present" },
    { control: "retention.rawDataDestroyAfter", value: null, kind: "present" },
  ],
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function merge(base: unknown, over: unknown): unknown {
  if (isObj(base) && isObj(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = v === undefined ? base[k] : merge(base[k], v);
    return out;
  }
  return over === undefined ? base : over;
}

export function getPath(o: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((c, k) => (isObj(c) ? c[k] : undefined), o);
}

/** The rules as written, with defaults filled in. Throws on YAML that cannot be read. */
export function readConfig(text: string): Config {
  if (new TextEncoder().encode(text).length > GOVERNANCE_MAX_BYTES) throw new Error("governance.yaml is larger than 64 KB");
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0]!.message.split("\n")[0]);
  const raw = doc.toJS({ maxAliasCount: MAX_ALIASES }) as unknown;
  if (raw !== null && raw !== undefined && !isObj(raw)) throw new Error("The top level of governance.yaml must be a mapping");
  return merge(DEFAULTS, raw ?? {}) as Config;
}

/** Profiles (selected) that require something of `control`. */
export function requiredBy(cfg: Config, control: string): Array<{ profile: Profile; req: Requirement }> {
  return cfg.profiles.flatMap((profile) => (PROFILE_REQUIREMENTS[profile] ?? []).filter((r) => r.control === control).map((req) => ({ profile, req })));
}

const rank = (order: readonly string[], v: unknown) => order.indexOf(v as string); // lower index = stricter

/** Whether `next` is looser than `prev` for this control (direction per control, R98). */
export function isLooser(control: string, prev: unknown, next: unknown): boolean {
  if (control === "encryption.atRest") return rank(ENCRYPTION_LEVELS, next) > rank(ENCRYPTION_LEVELS, prev);
  if (control === "sharing.locationMetadata") return rank(LOCATION_LEVELS, next) > rank(LOCATION_LEVELS, prev);
  if (control === "retention.rawDataDestroyAfter" || control === "protocol.expires") {
    if (next === null || next === "") return prev !== null && prev !== "";
    return prev !== null && prev !== "" && String(next) > String(prev);
  }
  if (control === "protocol.approvedFrom") {
    if (next === null || next === "") return prev !== null && prev !== "";
    return prev !== null && prev !== "" && String(next) < String(prev);
  }
  if (control === "protocol.platforms") {
    const a = (prev as string[]) ?? [];
    const b = (next as string[]) ?? [];
    return (a.length > 0 && b.length === 0) || b.some((x) => !a.includes(x));
  }
  // A new or changed default legal basis lets captures through without one being stated (core merge.ts).
  if (control.startsWith("consent.defaultLegalBasis.")) return typeof next === "string" && next.trim() !== "" && next !== prev;
  if (Array.isArray(prev) || Array.isArray(next)) {
    // residency.allowed, processing.*: allowing more is looser.
    const a = (prev as string[]) ?? [];
    return ((next as string[]) ?? []).some((x) => !a.includes(x));
  }
  if (typeof prev === "boolean" || typeof next === "boolean") return prev === true && next !== true;
  return false;
}

/** Whether `value` asks for less than a profile requires (the profile's label), else null. */
export function belowProfile(cfg: Config, control: string, value: unknown): Profile | null {
  for (const { profile, req } of requiredBy(cfg, control)) {
    if (req.kind === "present" && (value === null || value === "" || (Array.isArray(value) && !value.length))) return profile;
    if (req.kind === "not-public-cloud" && Array.isArray(value) && value.includes("cloud")) return profile;
    if (req.kind === "minimum" && isLooser(control, req.value, value)) return profile;
  }
  return null;
}

/** The value a profile requirement forces when a profile is turned on (null: leave as is). */
export function tightened(control: string, current: unknown, req: Requirement): unknown {
  if (req.kind === "not-public-cloud") return Array.isArray(current) ? current.filter((x) => x !== "cloud") : current;
  if (req.kind === "present") return current;
  return isLooser(control, req.value, current) ? req.value : current;
}

/**
 * The edits that turn `profile` on (R119: one edit): the profile listed, and each control it
 * requires raised to the requirement where the rules ask for less. The governance screen and the
 * new-project dialog both write a profile this way.
 */
export function profileOnEntries(cfg: Config, profile: Profile): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [["profiles", [...new Set([...cfg.profiles, profile])]]];
  for (const req of PROFILE_REQUIREMENTS[profile]) {
    const before = getPath(cfg, req.control);
    const after = tightened(req.control, before, req);
    if (JSON.stringify(after) !== JSON.stringify(before)) entries.push([req.control, after]);
  }
  return entries;
}

/** An exception already approving exactly this value. */
export function hasException(cfg: Config, control: string, value: unknown): boolean {
  return cfg.exceptions.some((e) => e.control === control && JSON.stringify(e.value) === JSON.stringify(value));
}

/**
 * Sets each path to its value in the YAML text with one parse (R119), keeping comments and layout
 * elsewhere. The size limit is checked before parsing; the alias limit when the document is read.
 */
export function setManyIn(text: string, entries: Array<[string, unknown]>): string {
  if (new TextEncoder().encode(text).length > GOVERNANCE_MAX_BYTES) throw new Error("governance.yaml is larger than 64 KB");
  const doc = parseDocument(text, { uniqueKeys: true }) as Document;
  if (doc.errors.length) throw new Error(doc.errors[0]!.message.split("\n")[0]);
  doc.toJS({ maxAliasCount: MAX_ALIASES }); // throws on alias expansion beyond the limit
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  for (const [path, value] of entries) doc.setIn(path.split("."), doc.createNode(value));
  return String(doc);
}

/**
 * What else a capture from the web needs before it will run under these rules (R41, and the
 * engine's capture rule), in plain sentences; empty when nothing else is needed. `today` is YYYY-MM-DD.
 */
export function captureNeeds(cfg: Config, today: string): string[] {
  const out: string[] = [];
  const fallback = cfg.consent.defaultLegalBasis?.[WEB_LEGAL_CATEGORY]?.trim();
  if (cfg.identifiability.containsIdentifiable && cfg.consent.requireLegalBasis && !fallback) {
    out.push(
      "A legal basis, because this project holds identifiable data and its rules require one. The Capture screen asks for it with each capture; the browser extension cannot, so its captures are refused until a default legal basis is set below.",
    );
  }
  if (cfg.protocol.requireBeforeCapture && !cfg.protocol.number) out.push("A protocol number in the protocol record below: these rules refuse every capture until there is one.");
  const day = (d: string | null) => (d ? d.slice(0, 10) : null);
  const from = day(cfg.protocol.approvedFrom);
  const until = day(cfg.protocol.expires);
  if (from && today < from) out.push(`The protocol's approval to start, on ${from}: captures are refused until then.`);
  if (until && today > until) out.push(`A renewed protocol approval: it expired on ${until}, and captures are refused until it is renewed.`);
  return out;
}

/** Removes `path` from the YAML text (nothing when it is not there), keeping comments and layout elsewhere. */
export function removeIn(text: string, path: string): string {
  const doc = parseDocument(text, { uniqueKeys: true }) as Document;
  if (doc.errors.length) throw new Error(doc.errors[0]!.message.split("\n")[0]);
  if (doc.hasIn(path.split("."))) doc.deleteIn(path.split("."));
  return String(doc);
}

/** Sets `path` to `value` in the YAML text, keeping comments and layout elsewhere. */
export function setIn(text: string, path: string, value: unknown): string {
  return setManyIn(text, [[path, value]]);
}

/** Appends an exception (spec 6.2: a recorded justification for loosening a profile requirement). */
export function addException(text: string, e: Config["exceptions"][number]): string {
  const list = readConfig(text).exceptions;
  const doc = parseDocument(text, { uniqueKeys: true }) as Document;
  if (!isMap(doc.contents)) doc.contents = doc.createNode({}) as never;
  doc.setIn(["exceptions"], doc.createNode([...list, e]));
  return String(doc);
}

/** Now, in the form governance.yaml wants for exceptions (UTC, seconds). */
export const nowUtc = (d = new Date()) => `${d.toISOString().slice(0, 19)}Z`;
