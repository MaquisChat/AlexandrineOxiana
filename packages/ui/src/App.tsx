/**
 * The app shell and its one router (R118). Navigation is pushState-based (navigation.tsx; never
 * hash routing) and this file owns the single route table: the library screens (Task 33), the bulk
 * import wizard and its review queue (Task 35), governance, audit log, fieldwork, move library and
 * missing files (Task 36) and the settings (appearance, and the researcher's name on this device). Every screen other than
 * the library shows a "Back to library" link. Without a service connection only the appearance
 * settings can be shown.
 */
import { useMemo, type ReactElement } from "react";
import { createClient, type ApiClient } from "./api/client";
import { BackToLibrary, normalisePath, PATHS, projectInQuery, useDropGuard, useLocation, type AppLocation } from "./navigation";
import { GovernanceRoutes, isGovernancePath } from "./routes/governance";
import { importRoute, isImportPath } from "./routes/import";
import { isLibraryPath, LibraryRoutes } from "./routes/library";
import { isReaderPath, ReaderRoute } from "./routes/reader";
import { isTranscriptPath, TranscriptRoute } from "./routes/transcript";
import { About } from "./screens/About";
import { AppearanceSettingsScreen } from "./screens/AppearanceSettings";
import { CaptureRoute } from "./screens/Capture";
import { ExtensionPairingRoute } from "./screens/ExtensionPairing";
import { FindAcquire } from "./screens/FindAcquire";
import { ToolsSetupRoute } from "./screens/ToolsSetup";
import { WatchedFoldersRoute } from "./screens/WatchedFolders";
import { ZoteroSync } from "./screens/ZoteroSync";
import { ResearcherNameSetting } from "./screens/ResearcherName";
import { SearchSources } from "./screens/SearchSources";
import type { ServiceConnection } from "./serviceConnection";
import { AppearanceProvider } from "./theme/AppearanceProvider";

export type { ServiceConnection } from "./serviceConnection";

export interface AppRoute {
  /** Which paths (normalised, without query) this route shows. */
  matches(path: string): boolean;
  render(loc: AppLocation, client: ApiClient, port?: number): ReactElement | null;
  /** Shows the "Back to library" link above the screen. */
  back: boolean;
}

/** The route table: first match wins. */
export const ROUTES: readonly AppRoute[] = [
  { matches: isLibraryPath, render: (loc, client) => <LibraryRoutes client={client} loc={loc} />, back: false },
  { matches: isImportPath, render: (loc, client) => importRoute(loc, client), back: true },
  { matches: isGovernancePath, render: (loc, client) => <GovernanceRoutes client={client} loc={loc} />, back: true },
  { matches: isTranscriptPath, render: (loc, client) => <TranscriptRoute client={client} loc={loc} />, back: true },
  { matches: isReaderPath, render: (loc, client) => <ReaderRoute client={client} loc={loc} />, back: true },
  { matches: (p) => p === PATHS.capture, render: (loc, client) => <CaptureRoute client={client} loc={loc} />, back: true },
  { matches: (p) => p === PATHS.find, render: (loc, client) => <FindAcquire client={client} loc={loc} />, back: true },
  { matches: (p) => p === PATHS.extension, render: (_loc, client, port) => <ExtensionPairingRoute client={client} port={port} />, back: true },
  { matches: (p) => p === PATHS.tools, render: (loc, client) => <ToolsSetupRoute client={client} loc={loc} />, back: true },
  { matches: (p) => p === PATHS.watchedFolders, render: (loc, client) => <WatchedFoldersRoute client={client} loc={loc} />, back: true },
  { matches: (p) => p === PATHS.zotero, render: (_loc, client) => <ZoteroSync client={client} />, back: true },
  { matches: (p) => p === PATHS.searchSources, render: (loc, client) => <SearchSources client={client} loc={loc} />, back: true },
  { matches: (p) => p === PATHS.about, render: () => <About />, back: true },
  {
    matches: (p) => p === PATHS.appearance,
    render: (_loc, client) => (
      <>
        <AppearanceSettingsScreen />
        <ResearcherNameSetting client={client} />
      </>
    ),
    back: true,
  },
];

function NotFound() {
  return (
    <main className="ao-page" aria-labelledby="ao-not-found">
      <h1 id="ao-not-found">Page not found</h1>
      <p>There is no screen at this address.</p>
    </main>
  );
}

export function routeFor(loc: AppLocation, client: ApiClient, port?: number): ReactElement {
  const route = ROUTES.find((r) => r.matches(normalisePath(loc.pathname)));
  const screen = route?.render(loc, client, port) ?? <NotFound />;
  return (
    <>
      {route?.back !== false && <BackToLibrary projectId={projectInQuery(loc.search)} />}
      {screen}
    </>
  );
}

/** The service's port, for the one screen that shows it (the token and address stay in the client). */
const servicePort = (s?: ServiceConnection): number | undefined => {
  const n = s ? Number(new URL(s.baseUrl).port) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export function App({ service }: { service?: ServiceConnection }) {
  const client: ApiClient | undefined = useMemo(() => (service ? createClient(service.baseUrl, service.token) : undefined), [service]);
  const loc = useLocation();
  useDropGuard();
  return (
    <AppearanceProvider {...(client ? { client } : {})}>
      {client ? routeFor(loc, client, servicePort(service)) : <AppearanceSettingsScreen />}
    </AppearanceProvider>
  );
}
