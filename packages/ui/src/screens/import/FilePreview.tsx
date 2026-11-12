/**
 * The file under review (Task 57): a picture of the source — its own file when the browser can show
 * that type, else a viewing copy the import made (a HEIC photo's proxy) — read from the service's
 * picture route with the token in the Authorization header and shown through a `blob:` address
 * (R135 1), released as soon as it is no longer shown. Other files (PDFs, recordings, documents)
 * have no preview route yet, and the panel says so plainly instead.
 *
 * An answer for an item no longer shown is dropped (and never becomes an address); leaving the
 * screen aborts the request and releases the address.
 */
import { useEffect, useState } from "react";
import { PICTURE_MAX_BYTES } from "@ao/shared";
import type { ImportApi, SourceFile } from "../../api/import";
import { UserText } from "../../components/UserText";
import { errorText, Section } from "./shared";

type AssetRef = SourceFile["assets"][number];

/** Picture types a browser shows as they are (the service serves these and HEIC/HEIF, never SVG). */
const SHOWN = /^image\/(png|jpeg|gif|webp|avif|bmp|apng)$/;

const mimeOf = (a: AssetRef): string => (a.mime ?? a.mediaType ?? "").toLowerCase();

/** The name a file is shown under: the last part of its path, else its recorded file name, else its id. */
export function assetName(a: AssetRef): string {
  const fromPath = a.path?.split(/[\\/]/).pop();
  return fromPath || a.fileName || a.id;
}

/** The picture to show for a source: its own file first, then a viewing copy; none for other files. */
export function pictureFor(assets: AssetRef[]): AssetRef | undefined {
  const shown = assets.filter((a) => a.status !== "destroyed" && SHOWN.test(mimeOf(a)) && (a.bytes === undefined || a.bytes <= PICTURE_MAX_BYTES));
  return shown.find((a) => a.role !== "derived") ?? shown[0];
}

type View = { state: "none" } | { state: "loading"; name: string } | { state: "shown"; name: string; url: string } | { state: "failed"; message: string };

export function FilePreview({ api, projectId, source }: { api: ImportApi; projectId: string; source: SourceFile }) {
  const sourceId = source.source.id;
  const picture = pictureFor(source.assets);
  const assetId = picture?.id;
  const name = picture ? assetName(picture) : "";
  // The first paint of an item with a picture already says it is loading (M9); the effect then
  // fetches it. ItemPanel is keyed by the item, so this initial state is per item.
  const [view, setView] = useState<View>(() => (assetId ? { state: "loading", name } : { state: "none" }));

  useEffect(() => {
    if (!assetId) {
      setView({ state: "none" });
      return;
    }
    let live = true;
    let url: string | null = null;
    const ctl = new AbortController();
    setView({ state: "loading", name });
    api.picture(projectId, sourceId, assetId, ctl.signal).then(
      (blob) => {
        if (!live) return;
        url = URL.createObjectURL(blob);
        setView({ state: "shown", name, url });
      },
      (err: unknown) => {
        if (live) setView({ state: "failed", message: errorText(err) });
      },
    );
    return () => {
      live = false;
      ctl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, projectId, sourceId, assetId, name]);

  return (
    <Section title="File preview" level={3} className="ao-review__preview">
      {view.state === "none" && <p className="ao-import__hint">No preview of this file can be shown here. Its details are above; open the source after review to read it.</p>}
      {view.state === "loading" && <p className="ao-import__hint">Loading the picture…</p>}
      {view.state === "shown" && (
        <figure className="ao-review__figure">
          <img src={view.url} alt={`Preview of ${view.name}`} className="ao-review__picture" />
          <figcaption>
            <UserText>{view.name}</UserText>
          </figcaption>
        </figure>
      )}
      {view.state === "failed" && <p className="ao-import__error">The picture could not be shown. {view.message}</p>}
    </Section>
  );
}
