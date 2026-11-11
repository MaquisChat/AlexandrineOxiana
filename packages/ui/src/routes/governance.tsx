/**
 * Task 36's routes (R113): governance, audit log, fieldwork, move library and missing files. App.tsx's
 * route table (R118) shows them on their paths; the project is in the query (`?project=<id>`), so
 * a link names it. Links and the project picker use the shared pushState navigation (navigation.tsx).
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { ApiClient } from "../api/client";
import { governanceApi, type GovernanceApi, type ProjectSummary } from "../api/governance";
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
  render(api: GovernanceApi, projectId: string): ReactNode;
}

export const governanceRoutes: GovernanceRoute[] = [
  { path: PATHS.governance, label: "Governance", needsProject: true, render: (api, pid) => <GovernanceSettings key={pid} api={api} projectId={pid} /> },
  { path: PATHS.audit, label: "Audit log", needsProject: true, render: (api, pid) => <AuditLog key={pid} api={api} projectId={pid} /> },
  { path: PATHS.fieldwork, label: "Fieldwork", needsProject: true, render: (api, pid) => <Fieldwork key={pid} api={api} projectId={pid} /> },
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
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    api.projects().then(
      (r) => setProjects(r.projects),
      () => setProjects([]),
    );
  }, [api]);
  // The project named in the address, if it is one of the library's; else the first.
  const projectId = projects.some((p) => p.id === asked) ? asked : (projects[0]?.id ?? "");
  const route = governanceRoutes.find((r) => r.path === path);
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
        <select id={`${id}-project`} value={projectId} onChange={(e) => navigate(governanceHref(path, e.target.value))}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </nav>
      {route ? route.needsProject && !projectId ? <p className="ao-screen">Choose a project first.</p> : route.render(api, projectId) : null}
    </div>
  );
}
