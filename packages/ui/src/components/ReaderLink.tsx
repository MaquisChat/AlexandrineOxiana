/**
 * The way into the PDF reader from a source (Task R7): "Read the PDF", shown when the source has a
 * live original PDF. Placed in the source's details (SourceDetail), one line beside TranscriptLink:
 * `<ReaderLink projectId={projectId} sourceId={sourceId} assets={file.assets} />`. The address
 * carries ids only (readerHref); with several PDFs the reader opens the first whose file can be reached (R480 e:
 * the service marks a linked file it cannot find) and offers the others.
 */
import { isReadablePdfAsset } from "@ao/shared";
import { inAppLink } from "../navigation";
import { readerHref } from "../routes/reader";
import type { LinkAsset } from "./TranscriptLink";

/**
 * A PDF the reader can open: an original file (not something derived from it), not destroyed,
 * whose recorded type is a PDF (the service's document route serves only those).
 */
export const isReadablePdf = (a: LinkAsset): boolean => isReadablePdfAsset(a);

export function ReaderLink({ projectId, sourceId, assets }: { projectId: string; sourceId: string; assets: readonly LinkAsset[] }) {
  if (!assets.some(isReadablePdf)) return null;
  return (
    <p>
      <a href={readerHref(projectId, sourceId)} onClick={inAppLink}>
        Read the PDF
      </a>
    </p>
  );
}
