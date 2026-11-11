/**
 * The app shell. For now it shows the Appearance settings; the library screens arrive in Task 33.
 */
import { useMemo } from "react";
import { createClient, type ApiClient } from "./api/client";
import { AppearanceSettingsScreen } from "./screens/AppearanceSettings";
import type { ServiceConnection } from "./serviceConnection";
import { AppearanceProvider } from "./theme/AppearanceProvider";
import { LibraryRoutes } from "./routes/library";

export type { ServiceConnection } from "./serviceConnection";

export function App({ service }: { service?: ServiceConnection }) {
  const client: ApiClient | undefined = useMemo(() => (service ? createClient(service.baseUrl, service.token) : undefined), [service]);
  return (
    <AppearanceProvider {...(client ? { client } : {})}>
      <AppearanceSettingsScreen />
      {client ? <LibraryRoutes client={client} /> : null}
    </AppearanceProvider>
  );
}
