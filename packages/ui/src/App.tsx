/**
 * The app shell: the library screens at / and /library (Task 33), the Appearance settings elsewhere.
 */
import { useMemo } from "react";
import { createClient, type ApiClient } from "./api/client";
import { AppearanceSettingsScreen } from "./screens/AppearanceSettings";
import type { ServiceConnection } from "./serviceConnection";
import { AppearanceProvider } from "./theme/AppearanceProvider";
import { LibraryRoutes, isLibraryPath, usePathname } from "./routes/library";

export type { ServiceConnection } from "./serviceConnection";

export function App({ service }: { service?: ServiceConnection }) {
  const client: ApiClient | undefined = useMemo(() => (service ? createClient(service.baseUrl, service.token) : undefined), [service]);
  const path = usePathname();
  return (
    <AppearanceProvider {...(client ? { client } : {})}>
      {client && isLibraryPath(path) ? <LibraryRoutes client={client} /> : <AppearanceSettingsScreen />}
    </AppearanceProvider>
  );
}
