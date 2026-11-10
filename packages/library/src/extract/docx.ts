/** DOCX: `docProps/core.xml` (dc:title, dc:creator, dcterms:created, dc:language) and the body text. */
import { cleanText, decodeEntities, normalizeDate, parseNameList } from "./names.js";
import { dcValues } from "./epub.js";
import { tokens, tagIs } from "./scan.js";
import { MAX_TEXT_CHARS, type RawExtract } from "./types.js";
import { openZip } from "./zip.js";

/** core.xml is metadata: only its first 512 KB is read (R52). */
const MAX_CORE_BYTES = 512 * 1024;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

/**
 * Paragraph text of WordprocessingML in one linear pass (`<w:t>` runs, `<w:tab/>`, `<w:br/>`),
 * stopping once MAX_TEXT_CHARS characters have been collected. Unclosed elements simply end the scan.
 */
export function docxText(xml: string): string {
  const paragraphs: string[] = [];
  let current = "";
  let inText = false;
  let total = 0;
  const flush = () => {
    if (current.trim()) paragraphs.push(current);
    current = "";
  };
  for (const t of tokens(xml)) {
    if (total >= MAX_TEXT_CHARS) break;
    if (t.kind === "text") {
      if (inText) {
        const s = decodeEntities(t.text);
        current += s;
        total += s.length;
      }
      continue;
    }
    if (tagIs(t, "w:t")) inText = !t.end && !t.self;
    else if (tagIs(t, "w:tab") && !t.end) current += " ";
    else if (tagIs(t, "w:br") && !t.end) current += "\n";
    else if (tagIs(t, "w:p") && (t.end || t.self)) flush();
  }
  flush();
  const text = cleanText(paragraphs.join("\n"));
  const cut = text.slice(0, MAX_TEXT_CHARS);
  // Never end on half a surrogate pair.
  return text.length > MAX_TEXT_CHARS && /[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut;
}

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
      const text = docxText(doc);
      if (text) out.text = text;
    }
    return out;
  } finally {
    zip.close();
  }
}
