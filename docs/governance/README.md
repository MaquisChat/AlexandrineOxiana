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

A project may record an **exception** for one specific control (for example `encryption.atRest`). An exception must state the **exact looser value** being approved, a written reason, who approved it (`by`), and when (`at`, an ISO 8601 UTC time such as `2026-01-01T09:30:00Z`). A missing value, approver, or time is an error when the file is loaded.

An exception covers only the approved value, for that one control:

- For an ordered setting, the project may go down to the approved value and no further. An exception approving `optional` encryption lets `optional` stand; `off` is still a violation.
- For a list, only the items named in the approved value may stay beyond what the profile allows; everything else is removed and reported. For outside services, the vendor-agreement check still applies to any service not named in the exception.
- For a yes/no requirement, the approved value must equal the value the project chose.

An exception with a blank reason has no effect. An exception naming a control that does not exist is reported as a warning and waives nothing.

### Presence checks

Some profile requirements cannot be made stricter automatically because the software cannot invent the information. Examples are naming a data repository or setting a destruction date. If the information is missing, it is reported as a violation until someone fills it in (or an exception with a reason is recorded).

### Outside services (vendors)

Processing steps (OCR, translation, transcription, and so on) are either `local` (on the researcher's own device) or an outside vendor listed under `vendors`, with flags for whether a Business Associate Agreement (`baa`) or Data Processing Agreement (`dpa`) is in place. A vendor name that is not declared is an error when the file is loaded. Public bibliographic lookup services (Crossref, OpenAlex, Open Library, Library of Congress) used for metadata lookup receive only bibliographic identifiers and are exempt from the vendor-agreement requirement.

### Default legal basis

When `consent.requireLegalBasis` is on (the GDPR profile turns it on), identifiable data can only be stored with a stated legal basis. For data captured in bulk, a project can record the basis once per category under `consent.defaultLegalBasis`:

```yaml
consent:
  defaultLegalBasis:
    social-media: "public task (GDPR Art. 6(1)(e)); approved by the ethics board on 2026-10-01"
    manual-upload: "legitimate interest (GDPR Art. 6(1)(f)); see the data management plan, section 3"
```

Link capture from YouTube, Instagram and TikTok uses the `social-media` entry, unless the researcher gives a basis for that one capture. The basis is stored in each source's provenance. If no basis is recorded, the capture stops before anything is downloaded and says so in plain language. The software records the basis you state; it does not judge whether it is valid.

Files you drag and drop onto the library (drag-and-drop attach) use the `manual-upload` entry for each new source. A file dropped onto an existing source is stored under that source's own recorded basis instead. Without a basis, an identifiable project refuses the drop and says why.

Bulk Import uses one entry per kind of source: folders and ZIP archives use `manual-upload`; reference-manager exports (BibTeX, RIS and CSL-JSON files) use `refman-import`; Zotero RDF exports use `zotero-import` (their provenance says the data came from Zotero); Calibre libraries use `calibre-import`; photos, videos and recordings imported from a phone or camera folder (iPhone and camera media import) use `device-import`. The capture methods behind them (`refman_import`, `zotero_import`, `calibre_import`, `device_import`) must be listed under `captureMethods`. They are by default.

```yaml
consent:
  defaultLegalBasis:
    refman-import: "legitimate interest (GDPR Art. 6(1)(f)); bibliographic records only"
    zotero-import: "legitimate interest (GDPR Art. 6(1)(f)); the researcher's Zotero library"
    calibre-import: "legitimate interest (GDPR Art. 6(1)(f)); the researcher's own e-book library"
    device-import: "consent (GDPR Art. 6(1)(a)); fieldwork consent forms, see the data management plan"
```

### Location data in photos, videos and recordings

Phones and many cameras record where a photo, video or voice memo was made (GPS). `sharing.locationMetadata` says what happens to that location: `keep`, `coarsen` (latitude and longitude rounded to one decimal place, about 11 km, roughly a city) or `strip` (every location tag removed: EXIF GPS, XMP, and the QuickTime location atoms).

- A file counts as having a location when it has GPS coordinates (also a GPS track recorded with a video), when it names a place without coordinates (IPTC/XMP City, Sub-location, State, Country, "location created/shown"), or when its metadata cannot be read at all (it might have one).
- The original file is never changed. With `coarsen` or `strip`, an original that has a location is stored only encrypted: in a project whose encryption at rest is `off` it is refused with "Location data requires encryption or locationMetadata: keep", and in a project that is not encrypted (encryption `optional` but not turned on) with "This project hides locations, so photos with a location can only be stored in an encrypted project." Turn on encryption for the project, or choose `keep`.
- The viewing copies (a JPEG for photos, an MP4 for videos) follow the rule as it is when the copy is made: if the rule was made stricter after the file was imported (say from `coarsen` to `strip`), the stricter rule applies. Each viewing copy is checked after it is made: its location is read back from the file (embedded and timed metadata included). A `strip` copy may hold no location or place name at all; a `coarsen` copy only latitude and longitude rounded to one decimal (no altitude, time, speed, direction or place names). A copy that does not match, or whose rule changed while it was being made, is thrown away and never stored (in the second case it is made again under the new rule).
- If the media helper is not running, the original is still stored as above, and the source shows that its viewing copy is pending ("proxy pending"). The copy is made, with the rule applied, as soon as the media helper is available.
- Voice memos and other recordings have no viewing copy; their location stays only in the original, stored under the same rule.

## Enforcement status

At present the workbench computes the effective policy and the list of violations. Actually blocking actions (for example refusing a capture until a protocol is recorded) lands with the policy engine, the next task. Where the profile pages say the app "blocks" something, that describes the behavior the policy engine will enforce.

## The profiles

- [IRB](irb.md): human-subjects research under an approved protocol.
- [GDPR](gdpr.md): personal data of people in the EU/EEA.
- [HIPAA](hipaa.md): protected health information.
- [DMP](dmp.md): funder data-management-plan requirements.

## What the verification report will show

In a later phase (Phase 5) the workbench will produce a verification report. For every control it will list: the value the project set, the value actually in force after the strictest-wins merge, which profile required it, and any exception (reason, approver, date). Each profile page says what its controls will look like there. Until that report exists, these descriptions state the intended behavior.
