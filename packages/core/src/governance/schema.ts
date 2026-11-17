import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ACQUIRE_METHODS, Provenance, type AcquireMethod } from "../model/source.js";

export { ACQUIRE_METHODS };
export type { AcquireMethod };

export const PROFILES = ["irb", "gdpr", "hipaa", "dmp"] as const;
export type Profile = (typeof PROFILES)[number];

export const RESIDENCY_KINDS = [
  "device",
  "removable",
  "network",
  "cloud_folder",
  "own_server",
  "cloud",
] as const;
export type ResidencyKind = (typeof RESIDENCY_KINDS)[number];

export const PROCESSING_OPS = [
  "ocr",
  "image_proxy",
  "video_proxy",
  "metadata_lookup",
  "transcription",
  "translation",
  "agent",
] as const;
export type ProcessingOp = (typeof PROCESSING_OPS)[number];

/**
 * Derived from Provenance.captureMethod so the two can never drift: every provenance method except
 * the three ways of acquiring, which `acquireMethods` governs (a separate list, so a project whose
 * file names its own `captureMethods` is not made to refuse them).
 */
export const CAPTURE_METHODS = Provenance.shape.captureMethod.options.filter(
  (m): m is Exclude<(typeof Provenance.shape.captureMethod.options)[number], AcquireMethod> => !(ACQUIRE_METHODS as readonly string[]).includes(m),
);

/** Public bibliographic services: exempt from the vendors list for metadata_lookup only. */
export const PUBLIC_METADATA_SERVICES = ["crossref", "openalex", "openlibrary", "loc"] as const;

/** Control paths that hold dates. Only DATE_PATHS take part in "earliest wins". */
export const ALL_DATE_FIELDS = [
  "retention.rawDataDestroyAfter",
  "protocol.approvedFrom",
  "protocol.expires",
  "dmp.embargoUntil",
] as const;
export const DATE_PATHS: ReadonlySet<string> = new Set(["retention.rawDataDestroyAfter", "protocol.expires"]);

export const ENCRYPTION_LEVELS = ["required", "optional", "off"] as const;
export const LOCATION_LEVELS = ["strip", "coarsen", "keep"] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "must be an ISO date (YYYY-MM-DD)")
  .refine((s) => !Number.isNaN(Date.parse(s)), "not a real date");

/** A list of method names from one family; a name of the other family gets a sentence saying where it belongs. */
const methodList = (own: readonly string[], other: readonly string[], ownKey: string, otherKey: string, ownWhat: string, otherWhat: string) =>
  z.array(z.string()).superRefine((list, ctx) => {
    list.forEach((m, i) => {
      if (own.includes(m)) return;
      ctx.addIssue({
        code: "custom",
        path: [i],
        message: other.includes(m)
          ? `${m} is ${otherWhat}, not ${ownWhat}; list it under ${otherKey}`
          : `${m} is not ${ownWhat} (${ownKey} accepts: ${own.join(", ")})`,
      });
    });
  });

const processingList = z.array(z.string().min(1));

const isoUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/, "must be an ISO 8601 UTC timestamp, e.g. 2026-01-01T09:30:00Z")
  .refine((x) => !Number.isNaN(Date.parse(x)), "not a real timestamp");

/**
 * `value` is the exact looser value being approved; it must be present (it may be null). `reason` and
 * `by` must be there; a blank one (`blank()`) is read like any other text, and the exception then
 * waives nothing (`effectivePolicy`): one outcome for a blank reason and a blank approver (R391 c, R415 d).
 */
const ExceptionSchema = z
  .object({
    control: z.string().min(1),
    value: z.unknown(),
    reason: z.string(),
    by: z.string(),
    at: isoUtc,
  })
  .strict()
  .superRefine((e, ctx) => {
    if (!("value" in e)) ctx.addIssue({ code: "custom", path: ["value"], message: "required: the looser value being approved" });
  });

const VendorSchema = z
  .object({
    id: z.string().min(1),
    baa: z.boolean().default(false),
    dpa: z.boolean().default(false),
    region: z.string().optional(),
  })
  .strict();

const section = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict().partial().optional();

/** Every key optional: used for profiles and for the raw (pre-defaults) project file. */
export const PartialGovernanceSchema = z
  .object({
    profiles: z.array(z.enum(PROFILES)),
    residency: section({
      allowed: z.array(z.enum(RESIDENCY_KINDS)),
      approvedCloudFolders: z.array(z.string()),
    }),
    processing: section(Object.fromEntries(PROCESSING_OPS.map((o) => [o, processingList])) as Record<ProcessingOp, typeof processingList>),
    vendors: z.array(VendorSchema),
    identifiability: section({
      containsIdentifiable: z.boolean(),
      pseudonymizeFileNames: z.boolean(),
      deidentifiedExportsOnly: z.boolean(),
    }),
    consent: section({
      requireStatus: z.boolean(),
      requireLegalBasis: z.boolean(),
      /** Legal basis recorded by default per data category, e.g. `social-media: public task (Art. 6(1)(e))`. */
      defaultLegalBasis: z.record(z.string().min(1), z.string().trim().min(1)),
    }),
    retention: section({ rawDataDestroyAfter: isoDate.nullable() }),
    audit: section({ enabled: z.boolean() }),
    encryption: section({ atRest: z.enum(ENCRYPTION_LEVELS) }),
    sharing: section({ locationMetadata: z.enum(LOCATION_LEVELS) }),
    captureMethods: methodList(CAPTURE_METHODS, ACQUIRE_METHODS, "captureMethods", "acquireMethods", "a capture method", "a way of acquiring"),
    acquireMethods: methodList(ACQUIRE_METHODS, CAPTURE_METHODS, "acquireMethods", "captureMethods", "a way of acquiring", "a capture method"),
    protocol: section({
      number: z.string().nullable(),
      approvedFrom: isoDate.nullable(),
      expires: isoDate.nullable(),
      platforms: z.array(z.string()),
      populations: z.array(z.string()),
      languages: z.array(z.string()),
      requireBeforeCapture: z.boolean(),
    }),
    dmp: section({
      repository: z.string().nullable(),
      formats: z.array(z.string()),
      metadataStandard: z.string().nullable(),
      embargoUntil: isoDate.nullable(),
    }),
    exceptions: z.array(ExceptionSchema),
  })
  .strict()
  .partial();

export type Vendor = z.infer<typeof VendorSchema>;
export interface GovernanceException {
  control: string;
  value: unknown;
  reason: string;
  by: string;
  at: string;
}

export interface GovernanceConfig {
  profiles: Profile[];
  residency: { allowed: ResidencyKind[]; approvedCloudFolders: string[] };
  processing: Record<ProcessingOp, string[]>;
  vendors: Vendor[];
  identifiability: {
    containsIdentifiable: boolean;
    pseudonymizeFileNames: boolean;
    deidentifiedExportsOnly: boolean;
  };
  consent: { requireStatus: boolean; requireLegalBasis: boolean; defaultLegalBasis: Record<string, string> };
  retention: { rawDataDestroyAfter: string | null };
  audit: { enabled: boolean };
  encryption: { atRest: (typeof ENCRYPTION_LEVELS)[number] };
  sharing: { locationMetadata: (typeof LOCATION_LEVELS)[number] };
  captureMethods: (typeof CAPTURE_METHODS)[number][];
  /** Find and acquire: which ways of acquiring are allowed. Default all three, whatever `captureMethods` says. */
  acquireMethods: AcquireMethod[];
  protocol: {
    number: string | null;
    approvedFrom: string | null;
    expires: string | null;
    platforms: string[];
    populations: string[];
    languages: string[];
    requireBeforeCapture: boolean;
  };
  dmp: {
    repository: string | null;
    formats: string[];
    metadataStandard: string | null;
    embargoUntil: string | null;
  };
  exceptions: GovernanceException[];
}

type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
export type PartialGovernance = DeepPartial<GovernanceConfig>;

export const DEFAULT_GOVERNANCE: GovernanceConfig = {
  profiles: [],
  residency: { allowed: ["device", "removable"], approvedCloudFolders: [] },
  processing: {
    ocr: ["local"],
    image_proxy: ["local"],
    video_proxy: ["local"],
    metadata_lookup: ["crossref", "openalex", "openlibrary", "loc"],
    transcription: ["local"],
    translation: ["local"],
    agent: ["local"],
  },
  vendors: [],
  identifiability: { containsIdentifiable: true, pseudonymizeFileNames: true, deidentifiedExportsOnly: true },
  consent: { requireStatus: true, requireLegalBasis: true, defaultLegalBasis: {} },
  retention: { rawDataDestroyAfter: null },
  audit: { enabled: true },
  encryption: { atRest: "required" },
  sharing: { locationMetadata: "coarsen" },
  captureMethods: ["manual_upload", "zotero_import", "refman_import", "calibre_import", "device_import"],
  acquireMethods: [...ACQUIRE_METHODS],
  protocol: {
    number: null,
    approvedFrom: null,
    expires: null,
    platforms: [],
    populations: [],
    languages: [],
    requireBeforeCapture: false,
  },
  dmp: { repository: null, formats: [], metadataStandard: null, embargoUntil: null },
  exceptions: [],
};

export class GovernanceParseError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "GovernanceParseError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function deepMerge(base: unknown, over: unknown): unknown {
  if (isObj(base) && isObj(over)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = v === undefined ? base[k] : deepMerge(base[k], v);
    return out;
  }
  return over === undefined ? base : over;
}

export function formatZodIssues(err: z.ZodError, label: string): string[] {
  const out: string[] = [];
  for (const i of err.issues) {
    if (i.code === "unrecognized_keys") {
      for (const k of i.keys) out.push(`${[...i.path, k].join(".")}: unknown key (check spelling) in ${label}`);
    } else {
      out.push(`${i.path.join(".") || "(root)"}: ${i.message}`);
    }
  }
  return out;
}

/** Parse a YAML document that may be partial; used for profiles too. */
export function parsePartial(yamlText: string, label: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    throw new GovernanceParseError(`${label}: invalid YAML: ${(e as Error).message}`, []);
  }
  if (raw === null || raw === undefined) return {};
  if (!isObj(raw)) throw new GovernanceParseError(`${label}: top level must be a mapping`, []);
  return raw;
}

export function parseGovernance(yamlText: string): GovernanceConfig {
  return parseGovernanceWithWarnings(yamlText).config;
}

function leafPaths(o: unknown, prefix = ""): string[] {
  if (!isObj(o)) return [];
  return Object.entries(o).flatMap(([k, v]) => (isObj(v) ? leafPaths(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}

/** Same as parseGovernance, plus non-fatal warnings (e.g. exceptions naming unknown controls). */
export function parseGovernanceWithWarnings(yamlText: string): { config: GovernanceConfig; warnings: string[] } {
  const raw = parsePartial(yamlText, "governance.yaml");
  const r = PartialGovernanceSchema.safeParse(raw);
  if (!r.success) {
    const issues = formatZodIssues(r.error, "governance.yaml");
    throw new GovernanceParseError(`governance.yaml is invalid:\n${issues.join("\n")}`, issues);
  }
  const cfg = deepMerge(DEFAULT_GOVERNANCE, r.data) as GovernanceConfig;

  const issues: string[] = [];
  const ids = new Set<string>();
  cfg.vendors.forEach((v, i) => {
    if (v.id === "local") issues.push(`vendors.${i}.id: "local" is reserved for on-device processing`);
    if (ids.has(v.id)) issues.push(`vendors.${i}.id: duplicate vendor "${v.id}"`);
    ids.add(v.id);
  });
  for (const op of PROCESSING_OPS) {
    cfg.processing[op].forEach((id, i) => {
      const builtin = op === "metadata_lookup" && (PUBLIC_METADATA_SERVICES as readonly string[]).includes(id);
      if (id !== "local" && !builtin && !ids.has(id))
        issues.push(`processing.${op}.${i}: unknown vendor "${id}" (declare it under vendors)`);
    });
  }
  if (issues.length) throw new GovernanceParseError(`governance.yaml is invalid:\n${issues.join("\n")}`, issues);
  const known = new Set(leafPaths(DEFAULT_GOVERNANCE));
  const legacy: string[] = [];
  // The drag-and-drop category was first spelled `manual_upload`; it is `manual-upload` now (R57).
  const bases = cfg.consent.defaultLegalBasis;
  if (Object.prototype.hasOwnProperty.call(bases, "manual_upload")) {
    if (!Object.prototype.hasOwnProperty.call(bases, "manual-upload")) {
      cfg.consent.defaultLegalBasis = { ...bases, "manual-upload": bases["manual_upload"]! };
      legacy.push('consent.defaultLegalBasis.manual_upload: the category is now spelled "manual-upload"; the old key is read as it, please rename it');
    } else {
      legacy.push('consent.defaultLegalBasis.manual_upload: ignored, "manual-upload" is set (the old spelling of the same category)');
    }
  }
  const warnings = [...legacy, ...cfg.exceptions
    .map((e, i) => (known.has(e.control) ? null : `exceptions.${i}.control: "${e.control}" is not a known control path; it waives nothing`))
    .filter((w): w is string => w !== null)];
  return { config: cfg, warnings };
}
