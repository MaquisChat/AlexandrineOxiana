# GDPR profile

For research involving personal data of people in the EU/EEA. This page is plain-language documentation, not legal advice; the software attests to configured controls and is not certification (see the [overview](README.md)).

## Controls this profile sets

| Control | What it does | Why the profile sets it | What the verification report will show |
| --- | --- | --- | --- |
| `consent.requireLegalBasis` = true | Each person or record must have a stated legal basis for processing (for example consent or public task) before it can be used. | GDPR requires a lawful basis for processing personal data. | Whether the requirement is on, and which records lack a basis. |
| `audit.enabled` = true | Every action on project data is recorded in a tamper-evident log. | Supports accountability: showing what was done with personal data. | Audit on, plus the log-integrity result. |
| Vendor rule: data processing agreement | An outside vendor can process data only if it is declared with `dpa: true`. Others are removed from the effective list. | Processors need a Data Processing Agreement under GDPR Article 28. | Each external vendor, its `dpa` status, its region, and a violation for any vendor removed. |

Public bibliographic lookup services (Crossref, OpenAlex, Open Library, Library of Congress) see only bibliographic identifiers and are exempt from the vendor rule for metadata lookup.

## Not covered

The software does not assess data transfers outside the EU/EEA beyond recording each vendor's region.
