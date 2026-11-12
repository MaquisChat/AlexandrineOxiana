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
 *  - Full licence texts (Task 37j, ADR 0015): the *-LICENCES.txt files the desktop build writes there
 *    (the shell's crates, the interface's packages, Node.js, the service's packages, the worker's
 *    packages). Each is its own chunk, loaded only when the person asks to see it.
 */
import { useEffect, useId, useRef, useState } from "react";
import { UserText } from "../components/UserText";
import "../components/library.css";
import "./About.css";

const raw = (files: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).filter((e): e is [string, string] => typeof e[1] === "string"));

const CSL = raw(import.meta.glob("../../../core/csl/{NOTICE.md,LICENSE-CPAL-1.0.txt,LICENSE-CC-BY-SA-3.0.txt}", { query: "?raw", import: "default", eager: true }));
const FONTS = raw(import.meta.glob("../../public/fonts/OFL-*.txt", { query: "?raw", import: "default", eager: true }));
// The lists only: the licence texts (*-LICENCES.txt) are large and loaded on demand, below.
const GENERATED = raw(import.meta.glob("../../../../apps/desktop/generated/notices/*.{json,md}", { query: "?raw", import: "default", eager: true }));
// The full licence texts the desktop build collected (Task 37j): each its own chunk, fetched only
// when the person asks for it, never part of the main bundle or of start-up.
const LAZY_TEXTS = import.meta.glob("../../../../apps/desktop/generated/notices/*-LICENCES.txt", { query: "?raw", import: "default" });

/** The parts of the app whose licence texts the desktop build collects, in the order shown. */
const LICENCE_PARTS = [
  ["shell-crates", "the app's Rust crates"],
  ["interface-npm", "the interface's npm packages"],
  ["node", "Node.js"],
  ["library-service", "the library service's npm packages"],
  ["worker", "the media helper's Python packages"],
] as const;
export type LicencePart = (typeof LICENCE_PARTS)[number][0];
export type LicenceTextLoaders = Partial<Record<LicencePart, () => Promise<string>>>;

/** One loader per licence-texts file the desktop build supplied (none in other builds). */
export const BUILT_LICENCE_TEXTS: LicenceTextLoaders = Object.fromEntries(
  Object.entries(LAZY_TEXTS).flatMap(([path, load]) => {
    const part = /\/([^/]+)-LICENCES\.txt$/.exec(path)?.[1];
    if (!part || !LICENCE_PARTS.some(([p]) => p === part)) return [];
    return [
      [
        part,
        async () => {
          const text: unknown = await load();
          if (typeof text !== "string") throw new Error("not a text");
          return text;
        },
      ],
    ];
  }),
);

const fileNamed = (files: Record<string, string>, name: string): string | undefined => Object.entries(files).find(([k]) => k.endsWith(`/${name}`))?.[1];

export interface BuiltNotices {
  /** The library service build's THIRD-PARTY-NOTICES.md. */
  npm?: string;
  /** The packaged worker's sidecar-manifest.json. */
  worker?: string;
  /** The shell's own Rust crates (apps/desktop/scripts/notices.mjs, from `cargo metadata`). */
  crates?: string;
  /** The interface's production npm packages (notices.mjs, from `pnpm list`). */
  interfaceNpm?: string;
}

const built = (key: keyof BuiltNotices, file: string): BuiltNotices => {
  const text = fileNamed(GENERATED, file);
  return text === undefined ? {} : { [key]: text };
};

/** The notices the desktop build supplied to this build of the interface (none in other builds). */
export const BUILT_NOTICES: BuiltNotices = {
  ...built("npm", "library-service-THIRD-PARTY-NOTICES.md"),
  ...built("worker", "worker-sidecar-manifest.json"),
  ...built("crates", "shell-crates.json"),
  ...built("interfaceNpm", "interface-npm.json"),
};

interface ListedNotice {
  name: string;
  version: string;
  licence: string;
  source?: string;
}

/** A list notices.mjs wrote, or undefined if it cannot be read. */
function parseList(json: string): ListedNotice[] | undefined {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return undefined;
    const text = (x: unknown) => (typeof x === "string" ? x : "");
    return v.map((e: Record<string, unknown>) => ({ name: text(e?.name), version: text(e?.version), licence: text(e?.licence), ...(typeof e?.source === "string" ? { source: e.source } : {}) }));
  } catch {
    return undefined;
  }
}

function ListSection({ id, title, tableLabel, intro, json, withSource }: { id: string; title: string; tableLabel: string; intro: string; json: string | undefined; withSource?: boolean }) {
  const list = json === undefined ? undefined : parseList(json);
  return (
    <section aria-labelledby={id} className="ao-card">
      <h2 id={id} className="ao-pane-title">
        {title}
      </h2>
      {json === undefined ? (
        <p>{NOT_IN_THIS_BUILD}</p>
      ) : list === undefined ? (
        <p>This list could not be read.</p>
      ) : (
        <>
          <p>{intro}</p>
          <table className="ao-table" aria-label={tableLabel}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Version</th>
                <th scope="col">Licence</th>
                {withSource && <th scope="col">Source</th>}
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={`${e.name}@${e.version}`}>
                  <UserText as="td">{e.name}</UserText>
                  <UserText as="td">{e.version}</UserText>
                  <UserText as="td">{e.licence}</UserText>
                  {withSource && <UserText as="td">{e.source ?? ""}</UserText>}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

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

const NOT_IN_THIS_BUILD = "This list is added by the desktop build of the app, from the builds of what it ships; this build of the interface does not include it.";

type PartState = { status: "idle" } | { status: "loading" } | { status: "done"; text: string } | { status: "failed" };

/** One part's licence texts behind a show/hide button; loaded the first time it is shown. */
function LicenceTextsPart({ label, load }: { label: string; load: () => Promise<string> }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PartState>({ status: "idle" });
  const mounted = useRef(true);
  const loading = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const toggle = () => {
    if (loading.current) return; // a second click while loading sends nothing more
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (state.status === "done") return;
    loading.current = true;
    setState({ status: "loading" });
    load().then(
      (text) => {
        loading.current = false;
        if (mounted.current) setState({ status: "done", text });
      },
      () => {
        loading.current = false;
        if (mounted.current) setState({ status: "failed" });
      },
    );
  };

  return (
    <div>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={toggle}>
        {`Show the licence texts of ${label}`}
      </button>
      <div id={id} hidden={!open}>
        {state.status === "loading" ? <p role="status">Loading the licence texts…</p> : null}
        {state.status === "failed" ? <p role="alert">These licence texts could not be loaded. Try again.</p> : null}
        {state.status === "done" ? (
          <UserText as="div" className="ao-notice">
            {state.text}
          </UserText>
        ) : null}
      </div>
    </div>
  );
}

function FullLicenceTexts({ loaders }: { loaders: LicenceTextLoaders }) {
  const parts = LICENCE_PARTS.flatMap(([part, label]) => {
    const load = loaders[part];
    return load ? [{ part, label, load }] : [];
  });
  return (
    <section aria-labelledby="ao-about-texts" className="ao-card">
      <h2 id="ao-about-texts" className="ao-pane-title">
        Full licence texts
      </h2>
      {parts.length === 0 ? (
        <p>The full licence texts are added by the desktop build of the app, from the builds of what it ships; this build of the interface does not include them.</p>
      ) : (
        <>
          <p>
            The licence and notice files of every package the app ships, collected when the app was built. Each identical text appears once, with every copyright line from its copies. A package that ships no
            licence text of its own is named, with the standard text used for it.
          </p>
          {parts.map((p) => (
            <LicenceTextsPart key={p.part} label={p.label} load={p.load} />
          ))}
        </>
      )}
    </section>
  );
}

export function About({ notices = BUILT_NOTICES, licenceTexts = BUILT_LICENCE_TEXTS }: { notices?: BuiltNotices; licenceTexts?: LicenceTextLoaders }) {
  const notice = fileNamed(CSL, "NOTICE.md");
  // The notice NOTICE.md quotes for the About screen (its "> " lines), shown first.
  const quoted = notice
    ?.split(/\r?\n/)
    .filter((l) => l.startsWith("> "))
    .map((l) => l.slice(2))
    .join(" ");
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
        {quoted ? <UserText as="blockquote">{quoted}</UserText> : null}
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

      <ListSection
        id="ao-about-crates"
        title="The app's own Rust crates"
        tableLabel="Rust crates in the app"
        intro="Compiled into the app's program. Crates under the Mozilla Public License 2.0 are available in source form where their row says."
        json={notices.crates}
        withSource
      />
      <ListSection
        id="ao-about-ui-npm"
        title="The interface's npm packages"
        tableLabel="npm packages in the interface"
        intro="The packages the app's interface is built from."
        json={notices.interfaceNpm}
      />

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

      <FullLicenceTexts loaders={licenceTexts} />
    </main>
  );
}
