/**
 * The library's projects, each with its compliance profile badges (IRB, GDPR, HIPAA, DMP) and, for
 * an encrypted project that is not unlocked, "Locked". Badges are text, never colour alone.
 */
import type { ProfileId, ProjectSummary } from "../api/library";
import { UserText } from "./UserText";
import "./library.css";

const PROFILE_LABELS: Record<ProfileId, { short: string; long: string }> = {
  irb: { short: "IRB", long: "Institutional Review Board rules" },
  gdpr: { short: "GDPR", long: "GDPR rules" },
  hipaa: { short: "HIPAA", long: "HIPAA rules" },
  dmp: { short: "DMP", long: "Data management plan rules" },
};

export interface ProjectNavProps {
  projects: ProjectSummary[];
  profiles: Record<string, ProfileId[]>;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

export function ProjectNav({ projects, profiles, selectedId, onSelect }: ProjectNavProps) {
  return (
    <nav aria-label="Projects" className="ao-projects">
      <h2 className="ao-pane-title">Projects</h2>
      {projects.length === 0 ? (
        <p className="ao-muted">No projects yet.</p>
      ) : (
        <ul className="ao-plain-list">
          {projects.map((p) => (
            <li key={p.id}>
              <button type="button" className="ao-project" aria-current={p.id === selectedId ? "true" : undefined} onClick={() => onSelect(p.id)}>
                <UserText className="ao-project__name">{p.name}</UserText>
                <span className="ao-badges">
                  {(profiles[p.id] ?? []).map((id) => (
                    <abbr key={id} className="ao-badge" title={PROFILE_LABELS[id].long}>
                      {PROFILE_LABELS[id].short}
                    </abbr>
                  ))}
                  {p.encrypted && !p.unlocked && <span className="ao-badge ao-badge--locked">Locked</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
