# Governance settings and compliance profiles

This folder explains, in plain language, the governance controls in the research workbench. It is written for an IRB, privacy, or research-compliance office.

**Important.** The software attests to which controls are *configured and enforced* in a project. It is not legal certification, and it does not decide whether a study is compliant with any law, policy, or protocol. That judgment stays with your institution.

## How it works

Each project has a `governance.yaml` file. It names one or more **profiles** (`irb`, `gdpr`, `hipaa`, `dmp`) and sets the project's own choices (where data may live, which outside services may process it, how long raw data is kept, and so on).

A profile is a set of **minimums**. When several profiles apply, or when the project's own settings are looser than a profile, **the strictest value wins**:

| Kind of setting | Rule |
| --- | --- |
| Lists (allowed storage locations, allowed services, capture methods) | Only items allowed by both the project and the profile remain. |
| Yes/no requirements (audit on, legal basis required) | If any profile requires it, it is required. |
| Encryption at rest | `required` is stricter than `optional`, which is stricter than `off`. |
| Location metadata in shared files | `strip` is stricter than `coarsen`, which is stricter than `keep`. |
| Dates (for example, destroy raw data after) | The earliest date is used. |
| Empty protocol or data-plan fields | Filled from a profile only where a profile sets a value. Profiles mostly set *requirements*, not values. |

If a project asks for something looser than a profile allows, the stricter value is used and the difference is recorded as a **violation** in the report.

### Exceptions

A project may record an **exception** for one specific control (for example `encryption.atRest`). An exception needs a written reason, who approved it, and when. With a non-empty reason, the looser value is allowed and no violation is raised for that control. An exception applies to that one control only. An exception with a blank reason has no effect.

### Presence checks

Some profile requirements cannot be made stricter automatically because the software cannot invent the information. Examples are naming a data repository or setting a destruction date. If the information is missing, it is reported as a violation until someone fills it in (or an exception with a reason is recorded).

### Outside services (vendors)

Processing steps (OCR, translation, transcription, and so on) are either `local` (on the researcher's own device) or an outside vendor listed under `vendors`, with flags for whether a Business Associate Agreement (`baa`) or Data Processing Agreement (`dpa`) is in place. A vendor name that is not declared is an error when the file is loaded. Public bibliographic lookup services (Crossref, OpenAlex, Open Library, Library of Congress) used for metadata lookup receive only bibliographic identifiers and are exempt from the vendor-agreement requirement.

## The profiles

- [IRB](irb.md): human-subjects research under an approved protocol.
- [GDPR](gdpr.md): personal data of people in the EU/EEA.
- [HIPAA](hipaa.md): protected health information.
- [DMP](dmp.md): funder data-management-plan requirements.

## What the verification report will show

In a later phase (Phase 5) the workbench will produce a verification report. For every control it will list: the value the project set, the value actually in force after the strictest-wins merge, which profile required it, and any exception (reason, approver, date). Each profile page says what its controls will look like there. Until that report exists, these descriptions state the intended behavior.
