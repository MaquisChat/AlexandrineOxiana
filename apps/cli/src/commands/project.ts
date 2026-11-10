import type { Command } from "commander";
import { CAPTURE_METHODS, DEFAULT_GOVERNANCE, PROFILES, parseGovernance } from "@ao/core";
import { GovernanceViolationError } from "@ao/library";
import { EXIT, ExitError } from "../errors.js";
import { readPassphrase } from "../prompt.js";
import { withSession } from "./common.js";

const collect = (value: string, prev: string[] = []): string[] => [...prev, ...value.split(",").map((v) => v.trim()).filter(Boolean)];

/** The project's governance.yaml (JSON-style quoting is valid YAML). */
export interface GovernanceChoices {
  profiles: string[];
  capture: string[];
  defaultLegalBasis?: string | undefined;
  protocolNumber?: string | undefined;
  protocolFrom?: string | undefined;
  protocolUntil?: string | undefined;
  notIdentifiable?: boolean | undefined;
}

export function governanceYaml(c: GovernanceChoices): string {
  const { profiles, capture, defaultLegalBasis } = c;
  const lines: string[] = [];
  if (profiles.length) lines.push(`profiles: [${profiles.join(", ")}]`);
  if (capture.length) {
    const methods = [...new Set<string>([...DEFAULT_GOVERNANCE.captureMethods, ...capture])];
    lines.push(`captureMethods: [${methods.join(", ")}]`);
  }
  if (c.notIdentifiable) lines.push("identifiability:", "  containsIdentifiable: false", "encryption:", "  atRest: optional");
  if (c.protocolNumber || c.protocolFrom || c.protocolUntil) {
    lines.push("protocol:");
    if (c.protocolNumber) lines.push(`  number: ${JSON.stringify(c.protocolNumber)}`);
    if (c.protocolFrom) lines.push(`  approvedFrom: ${JSON.stringify(c.protocolFrom)}`);
    if (c.protocolUntil) lines.push(`  expires: ${JSON.stringify(c.protocolUntil)}`);
  }
  if (defaultLegalBasis) lines.push("consent:", "  defaultLegalBasis:", `    social-media: ${JSON.stringify(defaultLegalBasis)}`);
  return `${lines.join("\n")}\n`;
}

export function registerProject(program: Command): void {
  const project = program.command("project").description("Create a project (one study, with its own rules)");
  project
    .command("create")
    .description("Create a governed project in the library")
    .argument("<name>", "the project's name")
    .option("--profile <name>", `rules to follow: ${PROFILES.join(", ")} (repeat or comma separate)`, collect, [])
    .option("--encrypt", "encrypt the project's files with a passphrase")
    .option("--capture <methods>", "capture methods to allow, e.g. downloader,browser_capture", collect, [])
    .option("--default-legal-basis <text>", "legal basis recorded by default for social-media captures")
    .option("--protocol-number <text>", "the approved protocol number (the irb profile needs one before anything is captured)")
    .option("--protocol-from <date>", "the day the protocol's approval starts (YYYY-MM-DD)")
    .option("--protocol-until <date>", "the day the protocol's approval ends (YYYY-MM-DD)")
    .option("--not-identifiable", "the project holds no identifiable data, so it may be unencrypted")
    .action(async (name: string, o: { profile: string[]; encrypt?: boolean; capture: string[]; defaultLegalBasis?: string; protocolNumber?: string; protocolFrom?: string; protocolUntil?: string; notIdentifiable?: boolean }, cmd: Command) => {
      const badProfile = o.profile.find((p) => !(PROFILES as readonly string[]).includes(p));
      if (badProfile) throw new ExitError(`"${badProfile}" is not a rules profile.`, EXIT.failure, `Choose from: ${PROFILES.join(", ")}`);
      const badMethod = o.capture.find((m) => !(CAPTURE_METHODS as readonly string[]).includes(m));
      if (badMethod) throw new ExitError(`"${badMethod}" is not a capture method.`, EXIT.failure, `Choose from: ${CAPTURE_METHODS.join(", ")}`);
      const yaml = governanceYaml({
        profiles: o.profile,
        capture: o.capture,
        defaultLegalBasis: o.defaultLegalBasis?.trim() || undefined,
        protocolNumber: o.protocolNumber?.trim() || undefined,
        protocolFrom: o.protocolFrom,
        protocolUntil: o.protocolUntil,
        notIdentifiable: o.notIdentifiable,
      });
      try {
        parseGovernance(yaml);
      } catch (err) {
        throw new ExitError(`These project settings are not valid: ${err instanceof Error ? err.message : String(err)}`, EXIT.failure);
      }

      let passphrase: string | undefined;
      if (o.encrypt) {
        const p = await readPassphrase("Choose a passphrase for this project: ", true);
        if (p === null) throw new ExitError("An encrypted project needs a passphrase.", EXIT.failure, "Run in a terminal to be asked, or set the AO_PASSPHRASE environment variable.");
        passphrase = p;
      }
      await withSession(cmd, true, async (s, out) => {
        let created;
        try {
          created = await s.repo.createProject({
            name,
            governanceYaml: yaml,
            encryption: passphrase ? { enabled: true, passphrase } : { enabled: false },
          });
        } catch (err) {
          if (err instanceof GovernanceViolationError && !o.encrypt) {
            throw new ExitError(err.message, EXIT.denied, "Add --encrypt to create the project with encryption.");
          }
          throw err;
        }
        const { project: p, recoveryCode } = created;
        out.data({ id: p.id, name: p.name, folder: p.folder, encrypted: p.encryption.enabled, ...(recoveryCode ? { recoveryCode } : {}) });
        out.line(`Created the project "${p.name}"  →  ${p.folder}`);
        if (recoveryCode) {
          out.line("");
          out.line("RECOVERY CODE (shown only this once):");
          out.line(`  ${recoveryCode}`);
          out.line("Write it down and keep it somewhere safe, apart from your computer.");
          out.line("If you forget the passphrase, this code is the only way to open the project.");
        }
      });
    });
}
