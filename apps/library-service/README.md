# Library service (`@ao/library-service`)

The local HTTP/JSON service that sits between the interface (and the browser extension) and the library engine (`packages/library`). It opens a library, applies the project's rules to every change, and starts the media worker. The desktop shell starts it as a helper process; the command-line tool uses the library engine directly. The entry point is `src/main.ts` (its header comment is the reference for start-up); the server is `src/server.ts`, the routes are in `src/routes/`.

## Run the tests

```sh
pnpm --filter @ao/library-service test        # vitest run
pnpm --filter @ao/library-service typecheck
```

## Start it in development

The service never takes its access token from the environment or the command line. The token is written on standard input as one line, and standard input must stay open: when it closes, the service shuts down cleanly (the shell relies on that to leave no stray process). From `apps/library-service`:

```sh
{ printf '%s\n' "$TOKEN"; cat; } | node --max-old-space-size=512 --import tsx src/main.ts
```

`TOKEN` is any 32 to 512 characters from `A-Z a-z 0-9 . _ ~ + / = -`. When it is listening it prints `AO_SERVICE_READY port=<n>` on standard output. Settings by environment: `AO_SERVICE_PORT` (default any free port), `AO_LIBRARY` (a library folder to open), `AO_CONFIG_DIR` (the app settings folder), `AO_NO_WORKER=1` (run without the media worker).

`pnpm --filter @ao/library-service run build` makes the shippable folder `dist/library-service/` that the desktop app carries (see `docs/adr/0013-desktop-shell.md`); `run smoke` checks it.

## Rules that matter here

- **Loopback only.** It listens on 127.0.0.1 and nowhere else.
- **Token on standard input.** Never in the environment, an argument or a URL. It refuses to start if `AO_SERVICE_TOKEN` is set, if it is given an argument, or if standard input is a terminal. Requests carry it as a bearer token; the token is never printed or logged.
- **Host and Origin checks.** A request's `Host` must be `127.0.0.1` or `localhost` (with this service's port). If it has an `Origin`, that must be the desktop shell's (`tauri://localhost`, `http://tauri.localhost`) or a paired browser extension's. The extension's token reaches only its own few routes.
- **Everything governed.** Every library mutation is governed by the project's rules, audited, and crash-safe through the transaction marker (project rule R26; see `docs/handoff/LEDGER.md`).
