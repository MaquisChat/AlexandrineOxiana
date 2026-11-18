## WB5 — the service and the command line: `apps/library-service`, `apps/cli` (about 14,000 lines)
You are reviewer number 5. Your part: `apps/library-service/src/**` and `apps/cli/src/**`.
Where a mistake costs most: who may call (the bearer token, the Host and Origin checks, the routes the browser extension may call and nothing more, the routes only the screens may call; tickets for media and files — lifetime, scope, in an address only where a ruling allows); the content-security policy and every header on every kind of answer (JSON, a file, a snapshot, an error); what an error says (no path, no secret, no stack); request bodies (size bounds, a schema on every route, a path in a body — is each such path checked?); streaming uploads and downloads (a client that stops half-way; a slow client); start-up and shut-down (resume of batches, jobs and finds; the lock; a second service on the same library); the log (what it writes of names, paths, tokens). The command line: what it prints of secrets and paths; its exit codes; that it changes the library only through the same governed calls.
Specific checks:
1. For EVERY route: is it behind the token and the Host/Origin checks, or deliberately not (list the deliberate ones and say whether each is right)?
2. Three routes whose handler trusts a field it should not (an id used in a path, a project id that is not the opened one, a ticket for another project) — or show there are none.
3. R58 on the service's side: are governance-load warnings sent to the screens on every route that loads the rules?
4. Ledger line 272 (Task 36: moving a library when the request reached the service but no line came back; the streaming byte cap in the copy): fixed or open?

