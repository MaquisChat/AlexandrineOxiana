/**
 * Task 36's routes (R113): governance, audit log, fieldwork, move library and missing files. App.tsx's
 * route table (R118) shows them on their paths; the project is in the query (`?project=<id>`), so
 * a link names it. Links and the project picker use the shared pushState navigation (navigation.tsx).
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { STREAM_OPEN_TIMEOUT_MS, type ApiClient } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isNoAnswerInTime, isUnreachable, readWithin } from "../api/firstRead";
import { governanceApi, type GovernanceApi, type ProjectSummary } from "../api/governance";
import { errorText, type LibraryState } from "../api/library";
import { PageReads, usePageHost } from "../components/PageReads";
import { TryAgain } from "../components/TryAgain";
import { isolated } from "../components/UserText";
import { inAppLink, libraryHref, navigate, normalisePath, PATHS, type AppLocation } from "../navigation";
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
  render(api: GovernanceApi, projectId: string, ctx: { readOnlyReason?: string | undefined; encrypted?: boolean | undefined; readOnlyLibrary?: boolean; firstReadMs?: number }): ReactNode;
}

export const governanceRoutes: GovernanceRoute[] = [
  { path: PATHS.governance, label: "Governance", needsProject: true, render: (api, pid, ctx) => <GovernanceSettings key={pid} api={api} projectId={pid} readOnlyReason={ctx.readOnlyReason} encrypted={ctx.encrypted} {...(ctx.firstReadMs !== undefined ? { firstReadMs: ctx.firstReadMs } : {})} /> },
  { path: PATHS.audit, label: "Audit log", needsProject: true, render: (api, pid, ctx) => <AuditLog key={pid} api={api} projectId={pid} {...(ctx.firstReadMs !== undefined ? { firstReadMs: ctx.firstReadMs } : {})} /> },
  { path: PATHS.fieldwork, label: "Fieldwork", needsProject: true, render: (api, pid, ctx) => <Fieldwork key={pid} api={api} projectId={pid} encrypted={ctx.encrypted} readOnly={ctx.readOnlyLibrary === true} {...(ctx.firstReadMs !== undefined ? { firstReadMs: ctx.firstReadMs } : {})} /> },
  { path: PATHS.moveLibrary, label: "Move library", needsProject: false, render: (api) => <MoveLibrary api={api} /> },
  { path: PATHS.missingFiles, label: "Missing files", needsProject: false, render: (api) => <MissingFiles api={api} /> },
];

export const isGovernancePath = (path: string): boolean => governanceRoutes.some((r) => r.path === normalisePath(path));

/** A link to one of these screens, for a project (when it needs one). */
export const governanceHref = (path: string, projectId?: string): string => (projectId ? `${path}?project=${encodeURIComponent(projectId)}` : path);

/** R641 D1: the pause before the event stream, lost or not opened in time, is opened again. */
const LISTEN_AGAIN_MS = 2_000;

/**
 * `firstReadMs` (FR-756, R579): how long the list of projects, and each screen's own first reads, are waited for before
 * the read is given up (smaller in tests). `streamOpenMs` (R641 D1, R597): how long the event stream is waited for to
 * open before it is given up and, after a pause, opened afresh.
 */
export function GovernanceRoutes({ client, loc, firstReadMs = FIRST_READ_TIMEOUT_MS, streamOpenMs = STREAM_OPEN_TIMEOUT_MS }: { client: ApiClient; loc: AppLocation; firstReadMs?: number; streamOpenMs?: number }) {
  const api = useMemo(() => governanceApi(client), [client]);
  const path = normalisePath(loc.pathname);
  const asked = new URLSearchParams(loc.search).get("project") ?? "";
  const id = useId();
  const [projects, setProjects] = useState<ProjectSummary[] | undefined>();
  const [listError, setListError] = useState<string | undefined>();
  /** FR-756: the list's last read got no answer (or none in time): "Try again" is offered; `listTry` moves on with it. */
  const [listUnreachable, setListUnreachable] = useState(false);
  const [listTry, setListTry] = useState(0);
  /** The list's read is in the air (it may never settle). */
  const listOut = useRef(false);
  const pickerRef = useRef<HTMLSelectElement>(null);
  // R463 M4: Fieldwork asks too, so that it does not offer a detach the library would refuse.
  const onGovernance = path === PATHS.governance || path === PATHS.fieldwork;
  // On the Governance form, each change of the library's state (a project locked or unlocked in
  // another window, the library turning read-only) is followed while the form is open, so the reason
  // the rules cannot be changed follows it (FR-389). The stream opens with the state as it is, which
  // the opening reads already hold: it reads nothing more. Each later one reads the projects once
  // and takes the library's mode from the event itself (R468).
  const [stateSeq, setStateSeq] = useState(0);
  const [libraryMode, setLibraryMode] = useState<string | undefined>();
  /** Set once an event has said the mode: the opening read's answer, if later, is then older. */
  const modeFromEvent = useRef(false);
  // R641 D1: a stream that is lost, or not opened within `streamOpenMs`, is opened again after a pause. On a reopened
  // stream the state it opens with counts as a change (one may have been missed meanwhile): the projects are read again.
  useEffect(() => {
    if (!onGovernance) return;
    const ac = new AbortController();
    void (async () => {
      let opened = false;
      while (!ac.signal.aborted) {
        let first = !opened;
        try {
          for await (const e of client.events({ signal: ac.signal, openWithinMs: streamOpenMs })) {
            if (e.type !== "library.state") continue;
            opened = true;
            const mode = e.data && typeof e.data === "object" ? (e.data as LibraryState).mode : undefined;
            if (typeof mode === "string") {
              modeFromEvent.current = true;
              setLibraryMode(mode);
            }
            if (first) first = false;
            else setStateSeq((n) => n + 1);
          }
        } catch {
          // Lost, or not opened in time: opened again below. Meanwhile the reason stays as last known; the service still
          // refuses a change it may not make.
        }
        if (ac.signal.aborted) return;
        await new Promise<void>((r) => {
          const t = setTimeout(r, LISTEN_AGAIN_MS);
          ac.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
        });
      }
    })();
    return () => ac.abort();
  }, [client, onGovernance, streamOpenMs]);
  useEffect(() => {
    let live = true;
    const ac = new AbortController();
    listOut.current = true;
    // FR-756: a read that never settles is given up after `firstReadMs` (its request cancelled).
    readWithin((signal) => api.projects({ signal }), firstReadMs, ac.signal).then(
      (r) => {
        if (!live) return;
        listOut.current = false;
        setProjects(r.projects);
        setListError(undefined);
        setListUnreachable(false);
      },
      (err: unknown) => {
        if (!live) return;
        listOut.current = false;
        setListUnreachable(isUnreachable(err));
        // Given up at the limit or failed: nothing is known of the projects, so the one named in the address is still
        // shown, never "not in this library" (R605 M1, R601 b): the list stays as it was (unread, or as last read).
        // Given up: its sentence alone, not run together with "could not be reached" (R586 M5).
        setListError(isNoAnswerInTime(err) ? (err as Error).message : errorText(err, "The projects could not be read."));
      },
    );
    return () => {
      live = false;
      listOut.current = false;
      ac.abort();
    };
  }, [api, stateSeq, firstReadMs, listTry]);
  // R605 I2: the list and the screen's own first reads are one page: one sentence and one "Try again" for them all.
  const { page, sentence: pageSentence, screenSays, retryAll } = usePageHost({
    sentence: listError && listUnreachable ? listError : undefined,
    out: () => listOut.current,
    retry: () => {
      setListError(undefined);
      setListUnreachable(false);
      setListTry((n) => n + 1);
    },
  });
  // Whether the library may be changed here, read for the Governance form only: it then says why its
  // rules cannot be changed instead of letting a change be refused on save. Unknown: not said (the
  // service refuses a change it may not make either way).
  useEffect(() => {
    if (!onGovernance) return;
    let live = true;
    modeFromEvent.current = false;
    api.libraryMode().then(
      (m) => live && !modeFromEvent.current && setLibraryMode(m),
      () => live && !modeFromEvent.current && setLibraryMode(undefined),
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
  /** FR-163: an encrypted project not unlocked: marked in the picker, and each screen of it offers to unlock it in the library. */
  const isLocked = (p: ProjectSummary | undefined) => !!p?.encrypted && p.unlocked === false;
  const readOnlyReason =
    libraryMode === "read-only"
      ? "This library is open read-only here, so its rules cannot be changed."
      : isLocked(project)
        ? "This project is locked, so its rules cannot be changed until it is unlocked."
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
        <select ref={pickerRef} id={`${id}-project`} value={projectId} onChange={(e) => e.target.value && navigate(governanceHref(path, e.target.value))}>
          {!projectId && <option value="">Choose a project</option>}
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {isLocked(p) ? `${isolated(p.name)} (locked)` : isolated(p.name)}
            </option>
          ))}
        </select>
      </nav>
      {/* R617 N2: where the screen's alert already says the page's sentence, the list's no-answer is said by it. */}
      {(pageSentence ?? (screenSays ? undefined : listError)) && (
        <p role="alert" className="ao-screen ao-error">
          {pageSentence ?? listError}
        </p>
      )}
      {pageSentence !== undefined && (
        <div className="ao-screen">
          <TryAgain focusTo={pickerRef} onPress={retryAll} />
        </div>
      )}
      {unknown && (
        <p role="alert" className="ao-screen ao-error">
          The project named in the address is not in this library. Choose a project from the list.
        </p>
      )}
      {route?.needsProject && isLocked(project) && (
        <p className="ao-screen ao-warning">
          This project is locked.{" "}
          <a href={libraryHref(projectId)} onClick={inAppLink}>
            Unlock it in the library
          </a>{" "}
          to see and change everything in it here.
        </p>
      )}
      <PageReads value={page}>
        {route ? route.needsProject && !projectId ? <p className="ao-screen">Choose a project first.</p> : route.render(api, projectId, { readOnlyReason, encrypted: project?.encrypted === true, readOnlyLibrary: libraryMode === "read-only", firstReadMs }) : null}
      </PageReads>
    </div>
  );
}
