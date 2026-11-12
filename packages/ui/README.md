# User interface (`@ao/ui`)

The React interface of Alexandrine Oxiana. It is one single-page app that the desktop shell shows in the system web view; it holds no library logic and talks only to the local library service. The route table is `src/App.tsx`, in-app navigation is `src/navigation.tsx` (history `pushState`, never hash routing), the screens are in `src/screens/`, shared parts in `src/components/`, and the theme tokens in `src/theme/`.

## Run the tests and checks

```sh
pnpm --filter @ao/ui test            # vitest run
pnpm --filter @ao/ui typecheck
pnpm --filter @ao/ui run lint:css    # the style rules
pnpm --filter @ao/ui run lint:colours  # no colour outside the theme tokens
pnpm --filter @ao/ui run build       # the built app that the shell loads
```

## Run it in development

The interface gets its service address and access token from the desktop shell, which sets `window.__AO_SERVICE__` before the app loads (`src/serviceConnection.ts`). So `pnpm --filter @ao/ui run dev` (a Vite server on 127.0.0.1) alone has no service to talk to. To drive the real interface against a real service, use the end-to-end harness (`pnpm e2e -- --app-only`; see `e2e/fixtures.ts`), or run the desktop app (`apps/desktop/README.md`). The only module that talks to the shell is `src/desktopShell.ts`.

## Rules that matter here

- **Colours from theme tokens only.** No colour values in a screen or a style file; `lint:colours` and `lint:css` enforce it.
- **Show outside text with `UserText`.** Anything that comes from a user or a source (titles, names, paths, messages from a service or a page) is shown through `src/components/UserText.tsx`, which sets the text direction for it.
- **Never `innerHTML`.** Nothing is inserted as HTML.
- **Archived HTML only through `SnapshotFrame`.** A captured web page is shown only inside `src/components/SnapshotFrame.tsx`, never directly in the app.
- The content-security policy in `index.html` is kept identical to the desktop shell's (`apps/desktop/src-tauri/tauri.conf.json`).
