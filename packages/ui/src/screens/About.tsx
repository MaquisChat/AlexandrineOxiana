/**
 * About and third-party notices (Task 37c; R103, R124, R129: the notice CPAL-1.0 section 3.6 calls
 * for). Nothing here is retyped: every notice is a file a build produces or ships, read into the
 * interface when it is built (Vite raw imports), shown as text through UserText.
 *
 *  - citeproc-js and the citation styles: packages/core/csl/NOTICE.md (the notice, the source's
 *    availability, the repository address, the pinned version, no modifications) and the CPAL-1.0
 *    and CC BY-SA 3.0 texts next to it, the same files the service build copies into its folder.
 *  - Typefaces: the OFL texts in packages/ui/public/fonts, shipped with the fonts.
 *  - The library service's npm packages: the THIRD-PARTY-NOTICES.md its build generates, and the
 *    media worker's licence manifest (sidecar-manifest.json, made by
 *    services/media-worker/packaging/manifest.py). The desktop build (apps/desktop/scripts/build-linux.mjs)
 *    copies both to apps/desktop/generated/notices/ before it builds the interface; any other build
 *    of the interface says where they come from instead.
 */
import { UserText } from "../components/UserText";
import "../components/library.css";
import "./About.css";

const raw = (files: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).filter((e): e is [string, string] => typeof e[1] === "string"));

const CSL = raw(import.meta.glob("../../../core/csl/{NOTICE.md,LICENSE-CPAL-1.0.txt,LICENSE-CC-BY-SA-3.0.txt}", { query: "?raw", import: "default", eager: true }));
const FONTS = raw(import.meta.glob("../../public/fonts/OFL-*.txt", { query: "?raw", import: "default", eager: true }));
const GENERATED = raw(import.meta.glob("../../../../apps/desktop/generated/notices/*", { query: "?raw", import: "default", eager: true }));

const fileNamed = (files: Record<string, string>, name: string): string | undefined => Object.entries(files).find(([k]) => k.endsWith(`/${name}`))?.[1];

export interface BuiltNotices {
  /** The library service build's THIRD-PARTY-NOTICES.md. */
  npm?: string;
  /** The packaged worker's sidecar-manifest.json. */
  worker?: string;
}

/** The notices the desktop build supplied to this build of the interface (none in other builds). */
export const BUILT_NOTICES: BuiltNotices = {
  ...(fileNamed(GENERATED, "library-service-THIRD-PARTY-NOTICES.md") !== undefined ? { npm: fileNamed(GENERATED, "library-service-THIRD-PARTY-NOTICES.md")! } : {}),
  ...(fileNamed(GENERATED, "worker-sidecar-manifest.json") !== undefined ? { worker: fileNamed(GENERATED, "worker-sidecar-manifest.json")! } : {}),
};

export interface NpmNotice {
  name: string;
  version: string;
  licence: string;
  how: string;
}

/** The package table of the service build's THIRD-PARTY-NOTICES.md. */
export function parseNpmNotices(md: string): NpmNotice[] {
  const out: NpmNotice[] = [];
  for (const line of md.split(/\r?\n/)) {
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (!line.trim().startsWith("|") || cells.length < 4) continue;
    const [name = "", version = "", licence = "", how = ""] = cells;
    if (name === "Package" || /^-+$/.test(name)) continue;
    out.push({ name, version, licence, how });
  }
  return out;
}

interface WorkerManifest {
  workerVersion?: string;
  python?: string;
  packages: Array<{ name: string; version: string; licence: string }>;
  nativeLibraries: Array<{ path: string; carriedBy: string; licence: string }>;
  notBundled: string[];
}

function parseWorker(json: string): WorkerManifest | undefined {
  try {
    const m = JSON.parse(json) as Partial<WorkerManifest>;
    const text = (v: unknown) => (typeof v === "string" ? v : String(v ?? ""));
    if (!Array.isArray(m.packages)) return undefined;
    return {
      ...(typeof m.workerVersion === "string" ? { workerVersion: m.workerVersion } : {}),
      ...(typeof m.python === "string" ? { python: m.python } : {}),
      packages: m.packages.map((p) => ({ name: text(p?.name), version: text(p?.version), licence: text(p?.licence) })),
      nativeLibraries: (Array.isArray(m.nativeLibraries) ? m.nativeLibraries : []).map((x) => ({ path: text(x?.path), carriedBy: text(x?.carriedBy), licence: text(x?.licence) })),
      notBundled: (Array.isArray(m.notBundled) ? m.notBundled : []).map(text),
    };
  } catch {
    return undefined;
  }
}

const FONT_NAMES: Record<string, string> = { AtkinsonHyperlegible: "Atkinson Hyperlegible", OpenDyslexic: "OpenDyslexic", SortsMillGoudy: "Sorts Mill Goudy" };

function LicenceText({ title, text }: { title: string; text: string | undefined }) {
  if (text === undefined) return null;
  return (
    <details className="ao-notice__details">
      <summary>{title}</summary>
      <UserText as="div" className="ao-notice">
        {text}
      </UserText>
    </details>
  );
}

const NOT_IN_THIS_BUILD = "This list is added by the desktop build of the app, from the build of the helper itself; this build of the interface does not include it.";

export function About({ notices = BUILT_NOTICES }: { notices?: BuiltNotices }) {
  const notice = fileNamed(CSL, "NOTICE.md");
  const npm = notices.npm !== undefined ? parseNpmNotices(notices.npm) : undefined;
  const worker = notices.worker !== undefined ? parseWorker(notices.worker) : undefined;
  const fonts = Object.entries(FONTS).sort(([a], [b]) => a.localeCompare(b));

  return (
    <main className="ao-page" aria-labelledby="ao-about-title">
      <h1 id="ao-about-title">About and third-party notices</h1>
      <p>Alexandrine Oxiana is built with the work of others. Their notices and licences follow.</p>

      <section aria-labelledby="ao-about-csl" className="ao-card">
        <h2 id="ao-about-csl" className="ao-pane-title">
          Citation processor and styles
        </h2>
        {notice !== undefined ? (
          <UserText as="div" className="ao-notice">
            {notice}
          </UserText>
        ) : (
          <p>The citation notice is missing from this build.</p>
        )}
        <LicenceText title="The CPAL-1.0 licence text" text={fileNamed(CSL, "LICENSE-CPAL-1.0.txt")} />
        <LicenceText title="The CC BY-SA 3.0 licence text" text={fileNamed(CSL, "LICENSE-CC-BY-SA-3.0.txt")} />
      </section>

      <section aria-labelledby="ao-about-fonts" className="ao-card">
        <h2 id="ao-about-fonts" className="ao-pane-title">
          Typefaces
        </h2>
        {fonts.map(([file, text]) => {
          const stem = file.replace(/^.*\/OFL-/, "").replace(/\.txt$/, "");
          return <LicenceText key={file} title={`${FONT_NAMES[stem] ?? stem}: SIL Open Font License 1.1`} text={text} />;
        })}
      </section>

      <section aria-labelledby="ao-about-npm" className="ao-card">
        <h2 id="ao-about-npm" className="ao-pane-title">
          The library service&apos;s npm packages
        </h2>
        {npm === undefined ? (
          <p>{NOT_IN_THIS_BUILD}</p>
        ) : (
          <>
            <p>Bundled into the library service or copied unmodified beside it. Each package&apos;s own licence files travel with the service.</p>
            <table className="ao-table" aria-label="npm packages in the library service">
              <thead>
                <tr>
                  <th scope="col">Package</th>
                  <th scope="col">Version</th>
                  <th scope="col">Licence</th>
                  <th scope="col">How</th>
                </tr>
              </thead>
              <tbody>
                {npm.map((p) => (
                  <tr key={`${p.name}@${p.version}`}>
                    <UserText as="td">{p.name}</UserText>
                    <UserText as="td">{p.version}</UserText>
                    <UserText as="td">{p.licence}</UserText>
                    <UserText as="td">{p.how}</UserText>
                  </tr>
                ))}
              </tbody>
            </table>
            <LicenceText title="The whole notices file" text={notices.npm} />
          </>
        )}
      </section>

      <section aria-labelledby="ao-about-worker" className="ao-card">
        <h2 id="ao-about-worker" className="ao-pane-title">
          The media helper&apos;s packages
        </h2>
        {notices.worker === undefined ? (
          <p>{NOT_IN_THIS_BUILD}</p>
        ) : worker === undefined ? (
          <p>The media helper&apos;s licence manifest could not be read.</p>
        ) : (
          <>
            <p>
              <UserText>{`The media helper ${worker.workerVersion ?? ""} runs on Python ${worker.python ?? ""}. Its packages' licence files travel with it. Not bundled, and installed separately: ${worker.notBundled.join(", ")}.`}</UserText>
            </p>
            <table className="ao-table" aria-label="Python packages in the media helper">
              <thead>
                <tr>
                  <th scope="col">Package</th>
                  <th scope="col">Version</th>
                  <th scope="col">Licence</th>
                </tr>
              </thead>
              <tbody>
                {worker.packages.map((p) => (
                  <tr key={`${p.name}@${p.version}`}>
                    <UserText as="td">{p.name}</UserText>
                    <UserText as="td">{p.version}</UserText>
                    <UserText as="td">{p.licence}</UserText>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="ao-table" aria-label="Native libraries in the media helper">
              <thead>
                <tr>
                  <th scope="col">Library</th>
                  <th scope="col">Carried by</th>
                  <th scope="col">Licence</th>
                </tr>
              </thead>
              <tbody>
                {worker.nativeLibraries.map((x) => (
                  <tr key={x.path}>
                    <UserText as="td">{x.path}</UserText>
                    <UserText as="td">{x.carriedBy}</UserText>
                    <UserText as="td">{x.licence}</UserText>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </main>
  );
}
