# HIPAA profile

For research that handles protected health information (PHI). This page is plain-language documentation, not legal advice; the software attests to configured controls and is not certification (see the [overview](README.md)).

## Controls this profile sets

| Control | What it does | Why the profile sets it | What the verification report will show |
| --- | --- | --- | --- |
| `encryption.atRest` = required | Stored project data must be encrypted. | Protects PHI if a device or drive is lost or stolen. | Encryption level in force; a violation if the project chose `optional` or `off` without an exception. |
| `residency.allowed` limited to device, removable, network, own_server | Data may live only on the researcher's device, removable media, an institutional network location, or the institution's own server. Public cloud (`cloud`) and cloud-synced folders (`cloud_folder`) are removed. | Keeps PHI where the institution controls it. | The allowed locations in force and any removed. |
| `audit.enabled` = true | Every action on project data is recorded in a tamper-evident log. | PHI access must be traceable. | Audit on, plus the log-integrity result. |
| `sharing.locationMetadata` = strip | GPS and location details are removed from files when they are shared or exported. | Location is an identifier that can point to a person or place. | The setting in force; a violation if the project kept or only coarsened location without an exception. Note the project default is `coarsen`, so HIPAA projects must set `strip` or record an exception. |
| Vendor rule: business associate agreement | An outside vendor can process data only if declared with `baa: true`. Others are removed from the effective list. | A vendor handling PHI needs a Business Associate Agreement. | Each external vendor, its `baa` status, and a violation for any vendor removed. |

Public bibliographic lookup services (Crossref, OpenAlex, Open Library, Library of Congress) see only bibliographic identifiers and are exempt from the vendor rule for metadata lookup. Cloud-synced folders approved by your institution may be covered by an exception with a written reason.
