/**
 * Task 36's routes (R113: this task's own module; App.tsx imports it once): governance, audit log,
 * fieldwork, move library and missing files. Hash-based until the app shell's router arrives; each
 * entry says whether it needs a project and how to render it, so a shell router can mount them.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { ApiClient } from "../api/client";
import { governanceApi, type GovernanceApi, type ProjectSummary } from "../api/governance";
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
  { path: "#/governance", label: "Governance", needsProject: true, render: (api, pid) => <GovernanceSettings key={pid} api={api} projectId={pid} /> },
  { path: "#/audit", label: "Audit log", needsProject: true, render: (api, pid) => <AuditLog key={pid} api={api} projectId={pid} /> },
  { path: "#/fieldwork", label: "Fieldwork", needsProject: true, render: (api, pid) => <Fieldwork key={pid} api={api} projectId={pid} /> },
  { path: "#/move-library", label: "Move library", needsProject: false, render: (api) => <MoveLibrary api={api} /> },
  { path: "#/missing-files", label: "Missing files", needsProject: false, render: (api) => <MissingFiles api={api} /> },
];

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function GovernanceRoutes({ client }: { client: ApiClient }) {
  const api = useMemo(() => governanceApi(client), [client]);
  const hash = useHash();
  const id = useId();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState("");
  useEffect(() => {
    api.projects().then(
      (r) => {
        setProjects(r.projects);
        setProjectId((cur) => cur || r.projects[0]?.id || "");
      },
      () => setProjects([]),
    );
  }, [api]);
  const route = governanceRoutes.find((r) => r.path === hash);
  return (
    <div>
      <nav className="ao-nav" aria-label="Governance and library">
        {governanceRoutes.map((r) => (
          <a key={r.path} href={r.path} aria-current={r.path === hash ? "page" : undefined}>
            {r.label}
          </a>
        ))}
        <label htmlFor={`${id}-project`}>Project</label>
        <select id={`${id}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </nav>
      {route ? (
        route.needsProject && !projectId ? (
          <p className="ao-screen">Choose a project first.</p>
        ) : (
          route.render(api, projectId)
        )
      ) : null}
    </div>
  );
}
