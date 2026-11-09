import { parse as parseYaml } from "yaml";
import { z } from "zod";

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

/** Same values as Provenance.captureMethod. */
export const CAPTURE_METHODS = [
  "official_api",
  "browser_capture",
  "downloader",
  "manual_upload",
  "zotero_import",
  "device_import",
  "refman_import",
  "calibre_import",
] as const;

/** Public bibliographic services: exempt from the vendors list for metadata_lookup only. */
export const PUBLIC_METADATA_SERVICES = ["crossref", "openalex", "openlibrary", "loc"] as const;

export const ENCRYPTION_LEVELS = ["required", "optional", "off"] as const;
export const LOCATION_LEVELS = ["strip", "coarsen", "keep"] as const;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, "must be an ISO date (YYYY-MM-DD)")
  .refine((s) => !Number.isNaN(Date.parse(s)), "not a real date");

const processingList = z.array(z.string().min(1));

const ExceptionSchema = z
  .object({
    control: z.string().min(1),
    value: z.unknown().optional(),
    reason: z.string(),
    by: z.string().optional(),
    at: z.string().optional(),
  })
  .strict();

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
    consent: section({ requireStatus: z.boolean(), requireLegalBasis: z.boolean() }),
    retention: section({ rawDataDestroyAfter: isoDate.nullable() }),
    audit: section({ enabled: z.boolean() }),
    encryption: section({ atRest: z.enum(ENCRYPTION_LEVELS) }),
    sharing: section({ locationMetadata: z.enum(LOCATION_LEVELS) }),
    captureMethods: z.array(z.enum(CAPTURE_METHODS)),
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
export type GovernanceException = z.infer<typeof ExceptionSchema>;

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
  consent: { requireStatus: boolean; requireLegalBasis: boolean };
  retention: { rawDataDestroyAfter: string | null };
  audit: { enabled: boolean };
  encryption: { atRest: (typeof ENCRYPTION_LEVELS)[number] };
  sharing: { locationMetadata: (typeof LOCATION_LEVELS)[number] };
  captureMethods: (typeof CAPTURE_METHODS)[number][];
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
  consent: { requireStatus: true, requireLegalBasis: true },
  retention: { rawDataDestroyAfter: null },
  audit: { enabled: true },
  encryption: { atRest: "required" },
  sharing: { locationMetadata: "coarsen" },
  captureMethods: ["manual_upload", "zotero_import", "refman_import", "calibre_import", "device_import"],
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
  return cfg;
}
