/** DOCX: `docProps/core.xml` (dc:title, dc:creator, dcterms:created, dc:language) and the body text. */
import { decodeEntities, clean, normalizeDate, parseNameList } from "./names.js";
import { dcValues } from "./epub.js";
import { MAX_TEXT_CHARS, type RawExtract } from "./types.js";
import { openZip } from "./zip.js";

const MAX_CORE_BYTES = 1024 * 1024;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export async function extractDocx(path: string): Promise<RawExtract> {
  const zip = await openZip(path);
  try {
    const out: RawExtract = {};
    const core = (await zip.read("docProps/core.xml", MAX_CORE_BYTES))?.toString("utf8");
    if (core) {
      const title = dcValues(core, "title")[0]?.value;
      if (title) out.title = title;
      const creator = dcValues(core, "creator")[0]?.value;
      const creators = creator ? parseNameList(creator) : [];
      if (creators.length) out.creators = creators;
      const issued = normalizeDate(dcValues(core, "created")[0]?.value);
      if (issued) out.issued = issued;
      const language = dcValues(core, "language")[0]?.value;
      if (language) out.language = language;
    }
    const doc = (await zip.read("word/document.xml", MAX_DOCUMENT_BYTES))?.toString("utf8");
    if (doc) {
      const paragraphs: string[] = [];
      let length = 0;
      for (const p of doc.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gu)) {
        const runs = [...p[1]!.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/gu)].map((r) => (r[1] !== undefined ? decodeEntities(r[1]) : " "));
        const t = clean(runs.join(""));
        if (!t) continue;
        paragraphs.push(t);
        length += t.length + 1;
        if (length >= MAX_TEXT_CHARS) break;
      }
      if (paragraphs.length) out.text = paragraphs.join("\n");
    }
    return out;
  } finally {
    zip.close();
  }
}
