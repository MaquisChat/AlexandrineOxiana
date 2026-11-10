#!/usr/bin/env node
// Downloads pinned third-party test fixtures into tests/fixtures/downloaded/ (gitignored).
// Each file is pinned by URL and sha256; a file that is already present with the right hash is
// kept. Offline (or any download failure) skips that file with a reason and exits 0, so tests
// that need it skip too (with CI=true it exits 1 instead). Licenses and sources: tests/fixtures/ATTRIBUTION.md.
// Later tasks add entries to FIXTURES.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "tests", "fixtures", "downloaded");

export const FIXTURES = [
  {
    // LibriSpeech utterance (speaker 307) as distributed in the VOiCES corpus "source" set; CC BY 4.0.
    name: "librispeech-voices-sp0307-sg0042.wav",
    url: "https://download.pytorch.org/torchaudio/tutorial-assets/Lab41-SRI-VOiCES-src-sp0307-ch127535-sg0042.wav",
    sha256: "c65fcd726d6b08c82c1e5dc7558f863cd8d483e3ed2f4a7bcf271dc1865ada14",
  },
  {
    // raw.pixls.us sample, Canon EOS 5D Mark III, 14-bit DNG; CC0 1.0.
    name: "canon-eos-5d-mark-iii-14bit.dng",
    url: "https://raw.pixls.us/getfile.php/2204/nice/Canon%20-%20EOS%205D%20Mark%20III%20-%2014bit%2014bit%20(2.3471882640587).dng",
    sha256: "1d77dcc6cdb839b10c1948f0b4471984ab48cf15e973fb77520584cee72b603e",
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function fetchOne(f) {
  const dest = join(outDir, f.name);
  if (existsSync(dest) && sha256(readFileSync(dest)) === f.sha256) return `ok (cached) ${f.name}`;
  let res;
  try {
    res = await fetch(f.url, { signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    return `SKIP ${f.name}: download failed (offline?): ${err?.cause?.code ?? err?.message ?? err}`;
  }
  if (!res.ok) return `SKIP ${f.name}: HTTP ${res.status}`;
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== f.sha256) return `SKIP ${f.name}: sha256 mismatch (got ${got}); file not saved`;
  const tmp = `${dest}.part`;
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
  return `ok ${f.name} (${buf.length} bytes)`;
}

mkdirSync(outDir, { recursive: true });
let skipped = 0;
for (const f of FIXTURES) {
  const line = await fetchOne(f);
  if (line.startsWith("SKIP")) skipped++;
  console.log(line);
}
// Locally a missing fixture only skips the tests that need it; CI must have them all.
if (skipped && process.env.CI === "true") process.exit(1);
