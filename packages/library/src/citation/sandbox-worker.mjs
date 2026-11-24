// The sandbox worker for one imported citation style (R88 I3, R89): kept warm by the parent's pool
// and reused for that style's renders. It runs in a worker_threads Worker with a heap cap (256 MB, or
// the process-wide memory setting where one is given: 512 MB per worker in the desktop app; sandbox.ts); the
// parent terminates it on a timeout, an error or after it has been idle, so a style that loops or
// allocates without end cannot block or exhaust the library process. Plain JavaScript (no build
// step): it needs only citeproc.
//
// Messages, one at a time:
//   { type: "prepare", lang, locales }  builds the engine for `lang` (kept, one per language)
//   { type: "render", kind, lang, format, items, cites }
// Each render starts from fresh engine state (item registry and citation state emptied), like
// @ao/core's render.ts. Inputs are already cleaned by @ao/core (citationLang,
// citeprocCitationItems); output is joined the way @ao/core's joinBibliography does.
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const CSL = createRequire(workerData.citeprocFrom)("citeproc");
const styleXml = workerData.styleXml;
const engines = new Map(); // lang -> { engine, items }

function prepare(lang, locales) {
  if (engines.has(lang)) return;
  const items = new Map();
  const locale = (l) => locales[l] ?? locales[lang] ?? locales["en-US"] ?? false;
  const engine = new CSL.Engine({ retrieveLocale: locale, retrieveItem: (id) => items.get(id) }, styleXml, lang, true);
  engines.set(lang, { engine, items });
}

function render(req) {
  const e = engines.get(req.lang);
  if (!e) throw new Error("engine not prepared");
  const { engine, items } = e;
  items.clear();
  engine.updateItems([]);
  engine.restoreProcessorState([]);
  for (const it of req.items) items.set(it.id, it);
  engine.setOutputFormat(req.format);
  engine.updateItems([...items.keys()]);
  const bibliography = () => {
    const bib = engine.makeBibliography();
    if (!bib) return "";
    if (req.format === "html") return `${bib[0].bibstart}${bib[1].join("")}${bib[0].bibend}`;
    return bib[1].map((x) => x.trim()).join("\n");
  };
  if (req.kind === "citation") return engine.makeCitationCluster(req.cites);
  if (req.kind === "probe") return `${engine.makeCitationCluster(req.cites)}\n${bibliography()}`;
  return bibliography();
}

parentPort.on("message", (msg) => {
  try {
    if (msg.type === "prepare") {
      prepare(msg.lang, msg.locales);
      parentPort.postMessage({ ok: true });
    } else {
      parentPort.postMessage({ ok: true, out: String(render(msg)) });
    }
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e?.message ?? e).slice(0, 300) });
  }
});
