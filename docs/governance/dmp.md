# DMP profile

For projects that must follow a funder's data-management plan. This page is plain-language documentation, not legal advice; the software attests to configured controls and is not certification (see the [overview](README.md)).

This profile does not make any setting stricter. It checks that the plan's key facts have been **filled in**. The software cannot invent them, so a missing item is reported as a violation until someone supplies it (or records an exception with a reason).

## Controls this profile checks

| Control | What it checks | Why the profile checks it | What the verification report will show |
| --- | --- | --- | --- |
| `dmp.repository` | A repository where the data will be deposited is named. | Funders ask where data will be preserved and shared. | The repository named, or a violation if empty. |
| `dmp.formats` | At least one preservation file format is listed. | Funders ask which formats the data will be kept in. | The formats listed, or a violation if the list is empty. |
| `retention.rawDataDestroyAfter` | A date for destroying raw data is set. | A plan must state how long raw data is kept. | The date, or a violation if unset. When combined with other profiles, the earliest date is used. |

`dmp.metadataStandard` and `dmp.embargoUntil` are recorded for the report but are not required by this profile.
