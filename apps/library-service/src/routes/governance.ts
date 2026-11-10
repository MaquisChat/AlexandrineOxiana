/**
 * Governance (spec 6; R96): the project's governance.yaml as text. PUT validates it with the core
 * schema after a safe YAML pre-parse (no custom tags, at most 64 KB, alias expansion capped), and
 * returns the effective policy's violations; a change that loosens the rules needs a `reason`,
 * which is recorded on the audit event (Repo.setGovernance).
 */
import type { FastifyInstance } from "fastify";
import { isAlias, isNode, parseDocument, visit } from "yaml";
import { effectivePolicy, parseGovernance } from "@ao/core";
import { GOVERNANCE_MAX_BYTES } from "@ao/library";
import { badRequest } from "../errors.js";
import { bodyOf, optStr, projectParam, str, type Ctx } from "./util.js";

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

export function registerGovernance(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  app.get("/projects/:id/governance", async (req) => {
    const s = state.requireSession();
    const projectId = projectParam(ctx, req);
    const yaml = await s.repo.getGovernanceText(projectId);
    let violations: unknown[] = [];
    try {
      violations = effectivePolicy(parseGovernance(yaml)).violations;
    } catch {
      // unreadable rules: every request is denied; the text is still shown for fixing
    }
    return { yaml, violations };
  });

  app.put("/projects/:id/governance", async (req) => {
    const s = state.requireWritable();
    const projectId = projectParam(ctx, req);
    const b = bodyOf(req);
    const yaml = str(b, "yaml", 2 * GOVERNANCE_MAX_BYTES);
    const reason = optStr(b, "reason", 2000);
    safeYamlCheck(yaml);
    const r = await s.repo.setGovernance(projectId, yaml, reason ? { reason } : {});
    state.publishState();
    return { violations: r.violations, loosened: r.loosened };
  });
}
