// The sandbox worker for imported citation styles (R88 I3): renders one citation or bibliography
// with citeproc-js and exits. It runs in a worker_threads Worker with a heap cap, and the parent
// terminates it after a timeout, so a style that loops or allocates without end cannot block or
// exhaust the library process. Plain JavaScript (no build step): it needs only citeproc. Inputs
// are already cleaned by @ao/core (citationLang, citeprocCitationItems); the output is joined the
// way @ao/core's joinBibliography does.
import { createRequire } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

const CSL = createRequire(workerData.citeprocFrom)("citeproc");

parentPort.once("message", (req) => {
  try {
    const items = new Map(req.items.map((i) => [i.id, i]));
    const locale = (l) => req.locales[l] ?? req.locales[req.lang] ?? req.locales["en-US"] ?? false;
    const engine = new CSL.Engine({ retrieveLocale: locale, retrieveItem: (id) => items.get(id) }, req.styleXml, req.lang, true);
    engine.setOutputFormat(req.format);
    engine.updateItems([...items.keys()]);
    const bibliography = () => {
      const bib = engine.makeBibliography();
      if (!bib) return "";
      if (req.format === "html") return `${bib[0].bibstart}${bib[1].join("")}${bib[0].bibend}`;
      return bib[1].map((x) => x.trim()).join("\n");
    };
    let out;
    if (req.kind === "citation") out = engine.makeCitationCluster(req.cites);
    else if (req.kind === "probe") out = `${engine.makeCitationCluster(req.cites)}\n${bibliography()}`;
    else out = bibliography();
    parentPort.postMessage({ ok: true, out: String(out) });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e?.message ?? e).slice(0, 300) });
  }
});
