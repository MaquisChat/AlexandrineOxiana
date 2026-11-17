## WB6 — the screens: `packages/ui` (about 38,000 lines)
You are reviewer number 6. Your part: `packages/ui/src/**` (and `e2e/` only to see what is covered).
Where a mistake costs most: outside text as markup (grep every `dangerouslySetInnerHTML`, `innerHTML`, `srcDoc`, `href={` and `src={` built from data — each must be `UserText`, `SnapshotFrame` or a checked address); a screen that says something happened when the service refused or never answered ("Saved", "Destroyed", "Nothing was changed", "Sent"); destructive actions (destroy, withdraw consent, detach, sign out, delete a project: is each confirmed, can a repeated key or a double click fire it twice, does focus land somewhere sensible after); the review queue's decisions (a decision applied to an entry the researcher has not seen; a stale list); forms that hold a secret (passphrase, token: kept in state longer than needed? shown? logged?); locked and read-only states (every control off, with the reason); accessibility (names, keyboard, focus, live regions) on the ten screens a researcher uses most.
Specific checks:
1. R58: do governance-load warnings reach the screen — on which screens, and is there a screen that loads the rules and drops them?
2. Colours: any colour not from a theme token (the lint covers `.ts(x)` and CSS — look for what it cannot see: inline SVG, canvas, `style=` strings).
3. Contract: pick the fifteen requests whose answers matter most and compare the screen's reading of each field and each error code with the handler in `apps/library-service`.
4. Ledger line 272's screen points (Move library: no false "nothing changed"; Fieldwork's re-attach button).
Known and being fixed (do not report): dialogs whose first focus is the confirming button, confirmed by a held or doubled Enter on their opener (FR-630, Task FR-A9: `ChoiceDialog`, the capture acknowledgement, the watched folders' two). If you find ANOTHER control that a held or repeated key can fire twice, that is new.

