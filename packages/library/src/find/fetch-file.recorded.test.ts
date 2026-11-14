/**
 * Task F14 (Ruling R317): with the lookup-fixtures switch on (`AO_LOOKUP_FIXTURES`, honoured only under
 * NODE_ENV=test), a free copy's download is answered from the recorded FILE answers and never reaches the network —
 * through the SAME code as a real download from the first byte on (the host rule on every address and redirect, at
 * most three redirects, the size limit by the bytes that pass, `content-encoding`, the type by the complete file's
 * bytes, the checksum, the part file, the abort signal). The switch is read once, where the lookup client reads it
 * (`HttpClient`), and handed down (`HttpClient.recordedFiles` → `fetchFile`'s `recorded`).
 *
 * The network guard: the process's global dispatcher is an undici MockAgent (disableNetConnect) that records every
 * request it is asked. With the switch on, nothing may reach it. With the switch off, the product's path asks it as
 * before (the download is the global dispatcher's, untouched).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpClient } from "../lookup/http.js";
import { LOOKUP_FIXTURES_ENV, RecordedFiles } from "../lookup/recorded.js";
import { FetchFileError, fetchFile } from "./fetch-file.js";
import { FREE_COPY_MAX_BYTES } from "./free-copy.js";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const HTML = Buffer.from("<!doctype html><html><head><title>Sign in</title></head><body>%PDF-1.4 not really</body></html>");

let tmp: string;
let fixtures: string;
let root: string;
let dir: string;
let into: string;
let guard: MockAgent;
let saved: Dispatcher;
/** Every request that reached the process's dispatcher (the "network"). */
let reached: string[];

const recordingInterceptor: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (opts, handler) => {
  reached.push(`${new URL(String(opts.origin)).origin}${opts.path}`);
  return dispatch(opts, handler);
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-fetch-recorded-"));
  fixtures = join(tmp, "fixtures");
  await mkdir(fixtures);
  root = join(tmp, "Lib");
  dir = join(root, ".tmp", "find-e1");
  into = join(dir, "1");
  await mkdir(join(root, ".tmp"), { recursive: true });
  reached = [];
  guard = new MockAgent();
  guard.disableNetConnect();
  // The "network" answers a PDF for anything on arXiv, so a leak would SUCCEED here — and is seen in `reached`.
  guard.get("https://arxiv.org").intercept({ path: () => true, method: "GET" }).reply(200, PDF).persist();
  saved = getGlobalDispatcher();
  setGlobalDispatcher(guard.compose(recordingInterceptor));
});

afterEach(async () => {
  setGlobalDispatcher(saved);
  await guard.close();
  await rm(tmp, { recursive: true, force: true });
});

type FileAnswer = { status: 200; file: string; headers?: Record<string, string> } | { status: number; location: string };

/** Writes the fixtures folder (one lookup answer kept, so the file stays a valid v1 answers file) and its files. */
async function record(files: Record<string, FileAnswer>, bodies: Record<string, Buffer> = {}): Promise<void> {
  for (const [name, b] of Object.entries(bodies)) await writeFile(join(fixtures, name), b);
  await writeFile(join(fixtures, "answers.json"), JSON.stringify({ v: 1, answers: { "https://api.crossref.org/works/10.5555/x": { status: 404 } }, files }));
}

/** The switch as the app reads it: once, by the lookup client, from its environment. */
const recordedFrom = (env: NodeJS.ProcessEnv): RecordedFiles | undefined => new HttpClient({ libraryRoot: root, env, sleep: async () => {} }).recordedFiles;
const ON: NodeJS.ProcessEnv = { NODE_ENV: "test" };
const on = () => recordedFrom({ ...ON, [LOOKUP_FIXTURES_ENV]: fixtures });

const get = (url: string, recorded: RecordedFiles | undefined, extra: Partial<Parameters<typeof fetchFile>[1]> = {}) =>
  fetchFile(url, { maxBytes: FREE_COPY_MAX_BYTES, deadlineMs: 180_000, into, recorded, ...extra });

async function refusal(p: Promise<unknown>): Promise<FetchFileError> {
  const e = await p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(FetchFileError);
  return e as FetchFileError;
}
const leftEmpty = async () => expect(existsSync(dir) ? await readdir(dir) : []).toEqual([]);

describe("fetchFile with the fixtures switch on: a recorded file is downloaded through every check", () => {
  it("a recorded PDF is saved under the caller's name with its SHA-256, and nothing reaches the network", async () => {
    await record({ "https://arxiv.org/pdf/5555.00001": { status: 200, file: "made-up-handbuilt.pdf" } }, { "made-up-handbuilt.pdf": PDF });
    const got = await get("https://arxiv.org/pdf/5555.00001", on());
    expect(got).toEqual({ path: into, sha256: createHash("sha256").update(PDF).digest("hex"), bytes: PDF.length, mime: "application/pdf" });
    expect(await readdir(dir)).toEqual(["1"]);
    expect(reached).toEqual([]);
  });

  it("a redirect to another recorded address is followed under the host rule", async () => {
    await record(
      {
        "https://europepmc.org/articles/PMC5555001?pdf=render": { status: 302, location: "https://www.ncbi.nlm.nih.gov/pmc/5555001.pdf" },
        "https://www.ncbi.nlm.nih.gov/pmc/5555001.pdf": { status: 200, file: "made-up-handbuilt.pdf" },
      },
      { "made-up-handbuilt.pdf": PDF },
    );
    expect((await get("https://europepmc.org/articles/PMC5555001?pdf=render", on())).mime).toBe("application/pdf");
    expect(reached).toEqual([]);
  });

  it("a file larger than the limit is refused as the bytes pass, and its part file removed", async () => {
    await record({ "https://arxiv.org/pdf/5555.00002": { status: 200, file: "big-handbuilt.pdf" } }, { "big-handbuilt.pdf": Buffer.concat([PDF, Buffer.alloc(4096, 32)]) });
    const e = await refusal(get("https://arxiv.org/pdf/5555.00002", on(), { maxBytes: 1024 }));
    expect(e.code).toBe("too-large");
    await leftEmpty();
    expect(reached).toEqual([]);
  });

  it("a recorded file of the wrong type is refused by its bytes", async () => {
    await record({ "https://arxiv.org/pdf/5555.00003": { status: 200, file: "page-handbuilt.pdf", headers: { "content-type": "application/pdf" } } }, { "page-handbuilt.pdf": HTML });
    const e = await refusal(get("https://arxiv.org/pdf/5555.00003", on()));
    expect(e.code).toBe("not-pdf-or-epub");
    expect(e.message).toBe("The service sent something that is not a PDF or EPUB.");
    await leftEmpty();
    expect(reached).toEqual([]);
  });

  it("a recorded compressed answer is refused as a real one is", async () => {
    await record({ "https://arxiv.org/pdf/5555.00004": { status: 200, file: "gz-handbuilt.bin", headers: { "content-encoding": "gzip" } } }, { "gz-handbuilt.bin": gzipSync(PDF) });
    expect((await refusal(get("https://arxiv.org/pdf/5555.00004", on()))).code).toBe("encoded");
    await leftEmpty();
    expect(reached).toEqual([]);
  });

  it("a redirect to a host the rule refuses is not followed, though an answer is recorded there", async () => {
    await record(
      {
        "https://arxiv.org/pdf/5555.00005": { status: 302, location: "https://evil.example/x.pdf" },
        "https://evil.example/x.pdf": { status: 200, file: "made-up-handbuilt.pdf" },
      },
      { "made-up-handbuilt.pdf": PDF },
    );
    expect((await refusal(get("https://arxiv.org/pdf/5555.00005", on()))).code).toBe("redirect-refused");
    await leftEmpty();
    expect(reached).toEqual([]);
  });

  it("an address off the list is refused before anything, though an answer is recorded for it", async () => {
    await record({ "https://evil.example/x.pdf": { status: 200, file: "made-up-handbuilt.pdf" } }, { "made-up-handbuilt.pdf": PDF });
    expect((await refusal(get("https://evil.example/x.pdf", on()))).code).toBe("address");
    expect(existsSync(dir)).toBe(false);
    expect(reached).toEqual([]);
  });

  it("four redirects are one too many, as in a real download", async () => {
    await record(
      {
        "https://arxiv.org/r/1": { status: 301, location: "/r/2" },
        "https://arxiv.org/r/2": { status: 302, location: "/r/3" },
        "https://arxiv.org/r/3": { status: 307, location: "/r/4" },
        "https://arxiv.org/r/4": { status: 308, location: "/r/5" },
        "https://arxiv.org/r/5": { status: 200, file: "made-up-handbuilt.pdf" },
      },
      { "made-up-handbuilt.pdf": PDF },
    );
    expect((await refusal(get("https://arxiv.org/r/1", on()))).code).toBe("too-many-redirects");
    // Three are followed: from /r/2 the file comes.
    expect((await get("https://arxiv.org/r/2", on())).mime).toBe("application/pdf");
    expect(reached).toEqual([]);
  });

  it("an abort through the signal ends it with the reason and leaves no part file", async () => {
    await record({ "https://arxiv.org/pdf/5555.00006": { status: 200, file: "made-up-handbuilt.pdf" } }, { "made-up-handbuilt.pdf": PDF });
    const ac = new AbortController();
    const reason = new Error("stopped");
    ac.abort(reason);
    await expect(get("https://arxiv.org/pdf/5555.00006", on(), { signal: ac.signal })).rejects.toBe(reason);
    await leftEmpty();
    expect(reached).toEqual([]);
  });
});

describe("fetchFile with the fixtures switch on: an address with no recorded answer", () => {
  it("ends as 'The service did not send the file.' and no request leaves", async () => {
    await record({ "https://arxiv.org/pdf/5555.00007": { status: 200, file: "made-up-handbuilt.pdf" } }, { "made-up-handbuilt.pdf": PDF });
    // arXiv's "network" in this file WOULD answer a PDF: only the recorded answers may be used.
    const e = await refusal(get("https://arxiv.org/pdf/not-recorded", on()));
    expect(e.code).toBe("status");
    expect(e.message).toBe("The service did not send the file.");
    // Every allowed file host, and a redirect to an address with no answer.
    await record({ "https://archive.org/download/x/x.pdf": { status: 302, location: "https://ia801234.us.archive.org/1/items/x/x.pdf" } });
    for (const u of ["https://europepmc.org/articles/PMC1?pdf=render", "https://library.oapen.org/x.pdf", "https://archive.org/download/x/x.pdf"]) {
      expect((await refusal(get(u, on()))).message).toBe("The service did not send the file.");
    }
    await leftEmpty();
    expect(reached).toEqual([]);
  });

  it("a lookup's recorded answer is not a file answer (the two are apart)", async () => {
    await writeFile(join(fixtures, "a.json"), "{}");
    await writeFile(join(fixtures, "answers.json"), JSON.stringify({ v: 1, answers: { "https://arxiv.org/pdf/5555.00008": { status: 200, file: "a.json" } } }));
    expect((await refusal(get("https://arxiv.org/pdf/5555.00008", on()))).code).toBe("status");
    expect(reached).toEqual([]);
  });
});

describe("the switch is the lookup client's, and off it the product's path is untouched", () => {
  it("off in every mode but NODE_ENV exactly 'test': no recorded files, and the download goes to the process's dispatcher", async () => {
    await record({ "https://arxiv.org/pdf/5555.00009": { status: 200, file: "made-up-handbuilt.pdf" } }, { "made-up-handbuilt.pdf": PDF });
    for (const env of [{}, { NODE_ENV: "production" }, { NODE_ENV: "TEST" }, { NODE_ENV: "development", VITEST: "true" }] as NodeJS.ProcessEnv[]) {
      const recorded = recordedFrom({ ...env, [LOOKUP_FIXTURES_ENV]: fixtures });
      expect(recorded).toBeUndefined();
      await rm(dir, { recursive: true, force: true });
      expect((await get("https://arxiv.org/pdf/5555.00009", recorded)).mime).toBe("application/pdf");
    }
    expect(reached).toEqual(Array(4).fill("https://arxiv.org/pdf/5555.00009"));
  });

  it("on in test mode without the folder named: nothing recorded", () => {
    expect(recordedFrom({ NODE_ENV: "test" })).toBeUndefined();
  });

  it("only the loader's own object is taken as recorded answers", async () => {
    const fake = { dispatcher: guard } as unknown as RecordedFiles;
    await expect(get("https://arxiv.org/pdf/5555.00010", fake)).rejects.toThrow(TypeError);
    expect(reached).toEqual([]);
  });
});
