/**
 * Governance (spec 6; R96): the project's governance.yaml as text. PUT validates it with the core
 * schema after a safe YAML pre-parse (no custom tags, at most 64 KB, alias expansion capped), and
 * returns the effective policy's violations; a change that loosens the rules needs a `reason`,
 * which is recorded on the audit event (Repo.setGovernance). An edit names the version it was made
 * from (If-Match / `baseSha256`, the sha256 GET returns); a file changed since → 409 CONFLICT.
 *
 * Also the two governance controls that keep files (Task 36): protocol approval documents dropped
 * onto the protocol record (stored under `<Project>/protocol/`, sealed in encrypted projects), and
 * retention — the raw originals due under `retention.rawDataDestroyAfter`, and their destruction
 * (only those due, only with `confirm: true`), answered with the destruction certificate. A
 * certificate is always shown as written at the destruction together with its amendments and the
 * resulting status of its backups step (R147): in the answer to a destruction, and in the list of
 * the project's certificates.
 */
import { userInfo } from "node:os";
import type { FastifyInstance } from "fastify";
import { isAlias, isNode, parseDocument, visit } from "yaml";
import { GovernanceParseError, effectivePolicy, parseGovernance, parseGovernanceWithWarnings } from "@ao/core";
import type { GovernanceReadability } from "@ao/shared";
import {
  GOVERNANCE_MAX_BYTES,
  addProtocolDocuments,
  destroyRaw,
  listDestructions,
  listProtocolDocuments,
  researcherName,
  retentionDue,
  scrubPaths,
  setProjectTimeZone,
} from "@ao/library";
import { badRequest } from "../errors.js";
import { bodyOf, optBool, optStr, projectParam, str, strArray, type Ctx } from "./util.js";

const isAbsolute = (p: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);

const whoAmI = (): string => {
  try {
    return userInfo().username;
  } catch {
    return "researcher";
  }
};

/** Aliases allowed in a governance file (each one may expand a whole subtree). */
const MAX_ALIASES = 20;

/** Refuses YAML that is too large, uses tags, or relies on alias expansion; then the schema decides. */
export function safeYamlCheck(text: string): void {
  if (Buffer.byteLength(text, "utf8") > GOVERNANCE_MAX_BYTES) throw badRequest(`governance.yaml must be at most ${GOVERNANCE_MAX_BYTES / 1024} KB.`);
  const doc = parseDocument(text, { schema: "core", customTags: [], uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length) throw badRequest(`governance.yaml is not valid YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  let aliases = 0;
  let tagged = false;
  visit(doc, (_key, node) => {
    if (isAlias(node)) aliases++;
    else if (isNode(node) && node.tag && !/^tag:yaml\.org,2002:(str|int|float|bool|null|map|seq)$/.test(node.tag)) tagged = true;
  });
  if (tagged) throw badRequest("governance.yaml may not use YAML tags (such as !!binary or custom tags).");
  if (aliases > MAX_ALIASES) throw badRequest("governance.yaml uses too many aliases.");
  // Expansion itself is bounded by the parser's maxAliasCount when converting.
  try {
    doc.toJS({ maxAliasCount: MAX_ALIASES });
  } catch (err) {
    throw badRequest(`governance.yaml cannot be read safely: ${err instanceof Error ? err.message.split("\n")[0] : "alias expansion too large"}`);
  }
}

/**
 * Whether the policy engine can read these rules (R379 FR-A18, R58): when it cannot, every request
 * in the project is refused, so the answer says so with the engine's own messages, one line per
 * problem (the key and what is wrong; no path, no stack); readable rules carry their non-fatal
 * warnings (a key in an old spelling, an exception that waives nothing).
 */
export function governanceReadability(yaml: string, roots: Iterable<string>): GovernanceReadability {
  // One line; no path; at most MAX_LINE_CHARS (R397 b).
  const clean = (t: string) => {
    const line = scrubPaths(t.replace(/\s+/g, " "), roots).trim();
    return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
  };
  try {
    const { config, warnings } = parseGovernanceWithWarnings(yaml);
    effectivePolicy(config);
    return { readable: true, issues: [], warnings: capped(warnings.map(clean).filter(Boolean)) };
  } catch (err) {
    let issues: string[] = [];
    if (err instanceof GovernanceParseError && err.issues.length) issues = err.issues;
    else if (err instanceof Error) issues = [err.message.split("\n")[0]!.replace(/^governance\.yaml:\s*/, "").replace(/:\s*$/, "")];
    issues = issues.map(clean).filter(Boolean);
    return { readable: false, issues: issues.length ? capped(issues) : ["the rules file could not be read"], warnings: [] };
  }
}

/** At most this many issues (or warnings) are sent, then "and N more." (R397 b). */
const MAX_LINES = 20;
/** Each issue or warning is at most this many characters, cut with "…" (R397 b). */
const MAX_LINE_CHARS = 300;
const capped = (lines: string[]): string[] => (lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES), `and ${lines.length - MAX_LINES} more.`] : lines);

/** The single issue when the project's rules file is missing, or is a link that leads nowhere (R397 a). */
export const GOVERNANCE_MISSING_ISSUE = "The rules file (governance.yaml) is missing from this project's folder.";

export function registerGovernance(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  app.get("/projects/:id/governance", async (req, reply) => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    const { yaml, sha256, file } = await s.repo.getGovernance(projectId);
    // The version an edit is made from: send it back as If-Match (or `baseSha256`).
    void reply.header("ETag", `"${sha256}"`);
    let violations: unknown[] = [];
    try {
      violations = effectivePolicy(parseGovernance(yaml)).violations;
    } catch {
      // unreadable rules: every request is denied; the text is still shown for fixing
    }
    // R397 a: no file is not an empty file: the engine refuses everything until rules are put back.
    const readability: GovernanceReadability = file === "missing" ? { readable: false, issues: [GOVERNANCE_MISSING_ISSUE], warnings: [] } : governanceReadability(yaml, state.roots);
    return { yaml, sha256, violations, ...readability };
  });

  app.put("/projects/:id/governance", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const yaml = str(b, "yaml", 2 * GOVERNANCE_MAX_BYTES);
    const reason = optStr(b, "reason", 2000);
    // If-Match: one or more ETags (weak or strong); hex compared case-insensitively (R101 N3). Any
    // listed tag that is the current version counts; otherwise the first one is used (→ 409).
    const tags = typeof req.headers["if-match"] === "string" ? req.headers["if-match"].split(",").map((t) => t.trim().replace(/^W\//i, "").replace(/"/g, "").trim().toLowerCase()).filter(Boolean) : [];
    let baseSha256 = tags[0] ?? optStr(b, "baseSha256", 64)?.toLowerCase();
    if (tags.length > 1) {
      const { sha256 } = await s.repo.getGovernance(projectId);
      if (tags.includes(sha256)) baseSha256 = sha256;
    }
    if (!baseSha256 || !/^[0-9a-f]{64}$/.test(baseSha256)) {
      throw badRequest("Say which version of the rules this change was made from: the sha256 from GET, as If-Match or baseSha256.");
    }
    safeYamlCheck(yaml);
    const r = await s.repo.setGovernance(projectId, yaml, { baseSha256, ...(reason ? { reason } : {}) });
    state.publishState();
    // R282 f: the project's Find and acquire entries the rules had stopped are looked at again under the new rules.
    state.resumeFind(s, projectId);
    return { violations: r.violations, loosened: r.loosened, sha256: r.sha256, ...governanceReadability(yaml, state.roots) };
  });

  app.get("/projects/:id/protocol/documents", async (req) => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    return { documents: await listProtocolDocuments(s.repo, projectId) };
  });

  // Approval documents dropped onto the protocol record (absolute paths the researcher chose).
  app.post("/projects/:id/protocol/documents", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const paths = strArray(bodyOf(req), "paths", { max: 50 });
    if (paths.some((p) => !isAbsolute(p) || p.includes("\0"))) throw badRequest('"paths" must be absolute paths.');
    // One result per file (R117 I6): a refused file does not stop the others.
    const results = (await addProtocolDocuments(s.repo, projectId, paths)).map((r) => (r.reason ? { ...r, reason: scrubPaths(r.reason, state.roots) } : r));
    return { results, documents: await listProtocolDocuments(s.repo, projectId) };
  });

  app.get("/projects/:id/retention", async (req) => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    const { yaml } = await s.repo.getGovernance(projectId);
    let destroyAfter: string | null = null;
    try {
      destroyAfter = effectivePolicy(parseGovernance(yaml)).policy.retention.rawDataDestroyAfter;
    } catch {
      // unreadable rules: nothing is listed as due (retentionDue fails closed the same way)
    }
    const due = await retentionDue(s.repo, projectId, state.deps.clock());
    const out = [];
    for (const d of due) {
      const sf = await s.repo.getSource(projectId, d.sourceId);
      out.push({ sourceId: d.sourceId, title: sf.source.title.variants[0]?.value ?? "", assetIds: d.assetIds });
    }
    // The time zone the retention date is read in (R92, R93); null: UTC.
    return { destroyAfter, timeZone: s.repo.getProject(projectId).timeZone ?? null, due: out };
  });

  // The project's time zone (R93): a real IANA zone name, or null to read its dates in UTC again.
  app.put("/projects/:id/time-zone", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    if (!("timeZone" in b)) throw badRequest('"timeZone" is required (a time zone name such as Europe/Berlin, or null for UTC).');
    const tz = b.timeZone;
    if (tz !== null && (typeof tz !== "string" || tz.length > 64)) throw badRequest('"timeZone" must be a time zone name such as Europe/Berlin, or null for UTC.');
    const p = await setProjectTimeZone(s.repo, projectId, tz);
    return { timeZone: p.timeZone ?? null };
  });

  app.post("/projects/:id/retention/destroy", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const assetIds = strArray(b, "assetIds", { max: 10_000, itemMax: 64 });
    if (optBool(b, "confirm") !== true) throw badRequest("Destroying raw data cannot be undone: confirm it (confirm: true).");
    const includeDerived = optBool(b, "includeDerived") ?? false;
    // Who destroys the data is the researcher named in this device's settings, else the OS user this
    // service runs as; never text from the request (R117).
    const by = (await researcherName(state.deps.appConfigDir)) ?? whoAmI();
    // Only originals that are due now can be destroyed through here; checked again inside the change.
    const now = state.deps.clock();
    const due = new Set((await retentionDue(s.repo, projectId, now)).flatMap((d) => d.assetIds));
    if (!assetIds.length || assetIds.some((id) => !due.has(id))) throw badRequest("Only raw originals that are due for destruction can be destroyed.");
    const r = await destroyRaw(s.repo, projectId, assetIds, by, { includeDerived, onlyDue: now });
    state.publishState();
    const root = s.lib.root.replace(/[\\/]+$/, "");
    const rel = r.certificatePath.startsWith(root) ? r.certificatePath.slice(root.length + 1).split(/[\\/]/).join("/") : "";
    // `certificate`: as presented (its backups as they stand now). `original`: the file as written,
    // never rewritten. `amendments`: what was recorded beside it since (library-relative files).
    return { certificate: r.certificate, certificateFile: rel, original: r.original, amendments: r.amendments, status: r.status };
  });

  // The project's destruction certificates, oldest first: each as written, with its amendments, the
  // resulting status, the backups still to be removed, and why the app does not remove them by
  // itself when its files and the audit log disagree (R147). Library-relative paths only.
  app.get("/projects/:id/retention/certificates", async (req) => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    const certificates = (await listDestructions(s.repo, projectId)).map((d) => (d.problem ? { ...d, problem: scrubPaths(d.problem, state.roots) } : d));
    return { certificates };
  });
}
