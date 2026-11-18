/**
 * Step 5: options for this import (spec 5.4). Defaults: copy, collections, merge, OCR on,
 * transcription off — except that projects that pseudonymise names default to ignoring folder
 * structure (R64), and projects that keep files encrypted cannot link in place (R24). With "Copy into
 * the library", files the source links in place (Zotero linked attachments) are copied too; keeping
 * them as links is a separate, explicit choice, shown only when the scan found some and never where
 * the project's rules require encryption (R136).
 */
import type { ImportOptions, ImportPolicy } from "../../api/import";
import { DescribedRadio } from "./StepSource";
import { Section } from "./shared";

export type WizardOptions = Omit<ImportOptions, "approveOutside">;

export const LINK_WARNING = "Linked files are outside encryption and retention control and will be flagged in reports.";

export function defaultOptions(policy: ImportPolicy): WizardOptions {
  return { fileHandling: "copy", structure: policy.pseudonymizeNames ? "none" : "collections", duplicates: "merge", ocr: true, transcribe: false };
}

export interface StepOptionsProps {
  options: WizardOptions;
  onOptions(o: WizardOptions): void;
  policy: ImportPolicy;
  /** Files the scan found that the source links in place (Zotero linked attachments; R136). */
  linkedAttachments?: number;
}

export function StepOptions({ options, onOptions, policy, linkedAttachments = 0 }: StepOptionsProps) {
  const set = <K extends keyof WizardOptions>(k: K, v: WizardOptions[K]) => onOptions({ ...options, [k]: v });
  return (
    <Section title="Options">
      <fieldset className="ao-import__choices">
        <legend>Files</legend>
        <DescribedRadio name="ao-import-files" label="Copy into the library" hint="Recommended. Files are stored, protected and backed up with the project." checked={options.fileHandling === "copy"} onSelect={() => set("fileHandling", "copy")} />
        <DescribedRadio
          name="ao-import-files"
          label="Link in place"
          hint={policy.encryptionRequired ? "Not available: this project keeps its files encrypted, so they are always copied." : "Files stay where they are; the library only points to them."}
          checked={options.fileHandling === "link"}
          disabled={policy.encryptionRequired}
          onSelect={() => set("fileHandling", "link")}
        />
        {options.fileHandling === "link" && (
          <p className="ao-import__warning" role="note">
            {LINK_WARNING}
          </p>
        )}
        {options.fileHandling === "copy" && linkedAttachments > 0 && !policy.encryptionRequired && (
          <>
            <label className="ao-import__choice">
              <input type="checkbox" checked={options.linkedFiles === "link"} onChange={(e) => set("linkedFiles", e.target.checked ? "link" : "copy")} />
              <span>
                Keep the {linkedAttachments === 1 ? "file" : `${linkedAttachments.toLocaleString("en-US")} files`} Zotero links to where {linkedAttachments === 1 ? "it is, as a link" : "they are, as links"}
              </span>
            </label>
            {options.linkedFiles === "link" && (
              <p className="ao-import__warning" role="note">
                {LINK_WARNING}
              </p>
            )}
          </>
        )}
      </fieldset>

      <fieldset className="ao-import__choices">
        <legend>Folder structure</legend>
        <DescribedRadio name="ao-import-structure" label="Folders become collections" checked={options.structure === "collections"} onSelect={() => set("structure", "collections")} />
        <DescribedRadio name="ao-import-structure" label="Folders become tags" checked={options.structure === "tags"} onSelect={() => set("structure", "tags")} />
        <DescribedRadio name="ao-import-structure" label="Ignore folder structure" checked={options.structure === "none"} onSelect={() => set("structure", "none")} />
        {policy.pseudonymizeNames && (
          <p className="ao-import__note">
            This project pseudonymises names. Folder names can carry participants' names, so folder structure is ignored unless you choose otherwise; if you keep it, check the collection or tag
            names in the review queue.
          </p>
        )}
      </fieldset>

      <fieldset className="ao-import__choices">
        <legend>Duplicates</legend>
        <DescribedRadio name="ao-import-duplicates" label="Merge into the existing source" hint="Adds the new files and missing details to the source you already have." checked={options.duplicates === "merge"} onSelect={() => set("duplicates", "merge")} />
        <DescribedRadio name="ao-import-duplicates" label="Skip" checked={options.duplicates === "skip"} onSelect={() => set("duplicates", "skip")} />
        <DescribedRadio name="ao-import-duplicates" label="Keep both" checked={options.duplicates === "keep-both"} onSelect={() => set("duplicates", "keep-both")} />
        <p className="ao-import__hint">Duplicates are found by identical files, the same DOI or ISBN, or a close match on title, first author and year. Uncertain matches go to review.</p>
      </fieldset>

      <fieldset className="ao-import__choices">
        <legend>After import</legend>
        <label className="ao-import__choice">
          <input type="checkbox" checked={options.ocr} onChange={(e) => set("ocr", e.target.checked)} />
          <span>OCR scanned PDFs</span>
        </label>
        <label className="ao-import__choice">
          <input type="checkbox" checked={options.transcribe} onChange={(e) => set("transcribe", e.target.checked)} />
          <span>Transcribe audio and video</span>
        </label>
      </fieldset>
    </Section>
  );
}
