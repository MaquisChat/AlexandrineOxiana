# IRB profile

For research on human subjects that is governed by an approved IRB protocol. This page is plain-language documentation, not legal advice; the software attests to configured controls and is not certification (see the [overview](README.md)).

## Controls this profile sets

| Control | What it does | Why the profile sets it | What the verification report will show |
| --- | --- | --- | --- |
| `protocol.requireBeforeCapture` = true | Capturing material (downloading, importing) is blocked (by the policy engine) until a protocol number, approval date, and expiry are recorded. | An IRB approval must exist before data about participants is collected. | Whether the requirement is on, and the protocol number and dates on file. A violation if the project turned it off without an exception. |
| `identifiability.pseudonymizeFileNames` = true | File names are replaced with codes so a participant's name or identifier does not appear in a file name. | File names travel with files into backups, email, and exports and are easy to overlook. | The setting in force, and a violation if the project asked for readable names without an exception. |
| `audit.enabled` = true | Every action on project data is recorded in a tamper-evident log. | The IRB must be able to see what was done with study data and when. | Audit on, plus the result of the log-integrity check. |

## Fields the project must fill in

The protocol number, approval and expiry dates, platforms, populations, and languages are the project's own values. The profile does not invent them. If the protocol has expired, captures are blocked while the requirement is on.
