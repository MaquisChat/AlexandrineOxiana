## WB1 — `packages/core` and `packages/shared` (about 8,600 lines of code)
You are reviewer number 1. Your part: `packages/core/src` and `packages/shared/src`.
Where a mistake costs most: the policy engine (every decision path: does anything fail OPEN — an unknown action, an unknown control, a missing or half-parsed rules file, a profile requirement, an exception that has expired or lacks a reason?); the audit chain (hashing, sequence, verification: can an entry be dropped, reordered or re-written and still verify? what does a truncated last line do?); pseudonymisation (participant codes for names: every function that turns a participant or a source into text for a citation, an export or a report); citations (CSL, citation keys, BibTeX keys); the duplicate finder; date and name parsing where they decide identity.
Specific checks (answer each yes/no with evidence):
1. R88: are participant codes wired through citations — is there ANY path where a citation, a bibliography entry or a citation key built by core carries a participant's real name when the project pseudonymises?
2. R58: does core hand back governance-load warnings in a form the callers cannot drop silently (follow one warning from the parser to the type the service returns)?
3. The texts in `packages/shared` that the screens show verbatim: any that states something the code does not do (pick the twenty most consequential — encryption, consent, destruction, export, "nothing was changed").
4. Types crossing the boundary: any field the service sends that `shared` types as required but the library can omit (or the reverse).

