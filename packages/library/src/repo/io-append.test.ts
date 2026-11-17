/**
 * R393 c (found reproducing D31): an append that the disk cuts short (a full disk writes part of the line and reports
 * how much) must not be taken for a whole line. appendDurable writes the rest or fails and truncates the file back,
 * so it never leaves a torn line behind (which would refuse every later append to that file, TornFileError).
 *
 * The short write is made real with a file-size limit (`prlimit --fsize`) on a child process: skipped where prlimit
 * does not exist (it is part of util-linux; not on macOS).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendDurable } from "./io.js";

/** R436 f: an injected writer that reports no bytes written (at most `left` times, then it gives up loudly). */
const writer = vi.hoisted(() => ({ zero: false, calls: 0, left: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const m = await importOriginal<typeof import("node:fs")>();
  return {
    ...m,
    writeSync: ((...a: Parameters<typeof m.writeSync>) => {
      if (!writer.zero) return (m.writeSync as (...x: unknown[]) => number)(...a);
      writer.calls++;
      if (writer.left-- <= 0) throw new Error("the write loop kept spinning");
      return 0;
    }) as typeof m.writeSync,
  };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const TSX = resolve(HERE, "../../../../node_modules/.bin/tsx");
const hasPrlimit = (() => {
  try {
    execFileSync("prlimit", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "ao-append-"));
});
afterEach(async () => {
  writer.zero = false;
  await rm(tmp, { recursive: true, force: true });
});

describe("appendDurable when a write reports nothing written (R436 f)", () => {
  it("gives up with an error at the first such write instead of spinning, and leaves the file as it was", async () => {
    const file = join(tmp, "log.jsonl");
    await writeFile(file, "first line\n");
    Object.assign(writer, { zero: true, calls: 0, left: 1000 });
    const err = await appendDurable(file, "second line\n").then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    writer.zero = false;
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toBe("the write loop kept spinning");
    expect(writer.calls).toBe(1);
    expect(await readFile(file, "utf8")).toBe("first line\n");
  });
});

/** Runs appendDurable(file, line) in a child whose files may grow to `limit` bytes; what it threw and the file's size. */
async function appendUnderLimit(file: string, line: string, limit: number): Promise<{ threw?: string; size: number }> {
  const script = join(tmp, "probe.mts");
  await writeFile(
    script,
    `import { statSync } from "node:fs";
import { appendDurable } from ${JSON.stringify(join(HERE, "io.ts"))};
process.on("SIGXFSZ", () => {}); // the limit is then a plain EFBIG error
let threw;
try { await appendDurable(process.argv[2], process.argv[3]); } catch (e) { threw = e.code ?? e.name; }
let size = -1;
try { size = statSync(process.argv[2]).size; } catch {}
console.log(JSON.stringify({ threw, size }));
`,
  );
  const r = spawnSync("prlimit", [`--fsize=${limit}`, TSX, script, file, line], { encoding: "utf8", timeout: 60_000 });
  const out = r.stdout.trim().split("\n").pop() ?? "";
  if (!out.startsWith("{")) throw new Error(`the probe did not answer: ${r.stderr}`);
  return JSON.parse(out) as { threw?: string; size: number };
}

describe.skipIf(!hasPrlimit)("appendDurable on a disk that cuts the write short (R393 c)", () => {
  it("a line the disk cuts short fails and leaves the file as it was, never torn", async () => {
    const file = join(tmp, "log.jsonl");
    await writeFile(file, "first line\n");
    const r = await appendUnderLimit(file, `${"a".repeat(4000)}\n`, 1024);
    expect(r.threw).toBe("EFBIG");
    expect(r.size).toBe("first line\n".length);
  }, 90_000);

  it("a new file the disk cuts short is removed", async () => {
    const file = join(tmp, "new.jsonl");
    const r = await appendUnderLimit(file, `${"b".repeat(4000)}\n`, 1024);
    expect(r.threw).toBe("EFBIG");
    expect(r.size).toBe(-1);
  }, 90_000);

  it("a line that fits is written whole", async () => {
    const file = join(tmp, "ok.jsonl");
    const r = await appendUnderLimit(file, "short\n", 1024);
    expect(r.threw).toBeUndefined();
    expect(r.size).toBe(6);
  }, 90_000);
});
