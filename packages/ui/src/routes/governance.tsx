/**
 * Task 36's routes (R113): governance, audit log, fieldwork, move library and missing files. App.tsx's
 * route table (R118) shows them on their paths; the project is in the query (`?project=<id>`), so
 * a link names it. Links and the project picker use the shared pushState navigation (navigation.tsx).
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { ApiClient } from "../api/client";
import { governanceApi, type GovernanceApi, type ProjectSummary } from "../api/governance";
import { errorText } from "../api/library";
import { inAppLink, navigate, normalisePath, PATHS, type AppLocation } from "../navigation";
import { AuditLog } from "../screens/AuditLog";
import { Fieldwork } from "../screens/Fieldwork";
import { GovernanceSettings } from "../screens/GovernanceSettings";
import { MissingFiles } from "../screens/MissingFiles";
import { MoveLibrary } from "../screens/MoveLibrary";
import "../screens/GovernanceScreens.css";

export interface GovernanceRoute {
  path: string;
  label: string;
  needsProject: boolean;
  render(api: GovernanceApi, projectId: string, ctx: { readOnlyReason?: string | undefined; encrypted?: boolean | undefined }): ReactNode;
}

export const governanceRoutes: GovernanceRoute[] = [
  { path: PATHS.governance, label: "Governance", needsProject: true, render: (api, pid, ctx) => <GovernanceSettings key={pid} api={api} projectId={pid} readOnlyReason={ctx.readOnlyReason} /> },
  { path: PATHS.audit, label: "Audit log", needsProject: true, render: (api, pid) => <AuditLog key={pid} api={api} projectId={pid} /> },
  { path: PATHS.fieldwork, label: "Fieldwork", needsProject: true, render: (api, pid, ctx) => <Fieldwork key={pid} api={api} projectId={pid} encrypted={ctx.encrypted} /> },
  { path: PATHS.moveLibrary, label: "Move library", needsProject: false, render: (api) => <MoveLibrary api={api} /> },
  { path: PATHS.missingFiles, label: "Missing files", needsProject: false, render: (api) => <MissingFiles api={api} /> },
];

export const isGovernancePath = (path: string): boolean => governanceRoutes.some((r) => r.path === normalisePath(path));

/** A link to one of these screens, for a project (when it needs one). */
export const governanceHref = (path: string, projectId?: string): string => (projectId ? `${path}?project=${encodeURIComponent(projectId)}` : path);

export function GovernanceRoutes({ client, loc }: { client: ApiClient; loc: AppLocation }) {
  const api = useMemo(() => governanceApi(client), [client]);
  const path = normalisePath(loc.pathname);
  const asked = new URLSearchParams(loc.search).get("project") ?? "";
  const id = useId();
  const [projects, setProjects] = useState<ProjectSummary[] | undefined>();
  const [listError, setListError] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    api.projects().then(
      (r) => live && setProjects(r.projects),
      (err: unknown) => {
        if (!live) return;
        setProjects([]);
        setListError(errorText(err, "The projects could not be read."));
      },
    );
    return () => {
      live = false;
    };
  }, [api]);
  // Whether the library may be changed here, read for the Governance form only: it then says why its
  // rules cannot be changed instead of letting a change be refused on save. Unknown: not said (the
  // service refuses a change it may not make either way).
  const onGovernance = path === PATHS.governance;
  const [libraryMode, setLibraryMode] = useState<string | undefined>();
  useEffect(() => {
    if (!onGovernance) return;
    let live = true;
    api.libraryMode().then(
      (m) => live && setLibraryMode(m),
      () => live && setLibraryMode(undefined),
    );
    return () => {
      live = false;
    };
  }, [api, onGovernance]);

  const list = projects ?? [];
  // The project named in the address when it is one of the library's. A name that is not selects
  // none (never another project's screen, 41b2 M1); no name selects the first.
  const unknown = !!asked && !!projects && !list.some((p) => p.id === asked);
  const projectId = asked ? (unknown ? "" : asked) : (list[0]?.id ?? "");
  const route = governanceRoutes.find((r) => r.path === path);
  const project = list.find((p) => p.id === projectId);
  const readOnlyReason =
    libraryMode === "read-only"
      ? "This library is open read-only here, so its rules cannot be changed."
      : project?.encrypted && project.unlocked === false
        ? "This project is locked. Unlock it in the library to change its rules."
        : undefined;
  return (
    <div>
      <nav className="ao-nav" aria-label="Governance and library">
        {governanceRoutes.map((r) => {
          const href = governanceHref(r.path, projectId || undefined);
          return (
            <a key={r.path} href={href} onClick={inAppLink} aria-current={r.path === path ? "page" : undefined}>
              {r.label}
            </a>
          );
        })}
        <label htmlFor={`${id}-project`}>Project</label>
        <select id={`${id}-project`} value={projectId} onChange={(e) => e.target.value && navigate(governanceHref(path, e.target.value))}>
          {!projectId && <option value="">Choose a project</option>}
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </nav>
      {listError && (
        <p role="alert" className="ao-screen ao-error">
          {listError}
        </p>
      )}
      {unknown && (
        <p role="alert" className="ao-screen ao-error">
          The project named in the address is not in this library. Choose a project from the list.
        </p>
      )}
      {route ? route.needsProject && !projectId ? <p className="ao-screen">Choose a project first.</p> : route.render(api, projectId, { readOnlyReason, encrypted: project?.encrypted === true }) : null}
    </div>
  );
}
