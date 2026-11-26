/**
 * The free space and the name of the disk a library is on (whole channels, Task 4): read for the
 * estimate and the 10 GB floor. No test waits on a real timer: diskutil's 2 s limit is execFile's
 * own `timeout`, answered here by the injected execFile.
 */
import type { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { diskName, freeBytes } from "./disk.js";

type Answer = { err?: NodeJS.ErrnoException & { killed?: boolean; signal?: string }; stdout?: string };
/** An execFile stand-in: records each call and answers it as told. */
function fakeExecFile(answer: Answer) {
  const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = [];
  const fn = ((file: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    calls.push({ file, args, opts });
    queueMicrotask(() => cb(answer.err ?? null, answer.stdout ?? "", ""));
    return {};
  }) as unknown as typeof execFile;
  return { fn, calls };
}

const PLIST = (name: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>DeviceIdentifier</key>
	<string>disk3s1</string>
	<key>VolumeName</key>
	<string>${name}</string>
</dict>
</plist>
`;

describe("the disk a library is on", () => {
  it("freeBytes reads the free space and is null when it cannot tell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ao-disk-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const free = await freeBytes(dir);
    expect(typeof free).toBe("number");
    expect(free).toBeGreaterThan(0);
    expect(Number.isFinite(free)).toBe(true);
    expect(await freeBytes(join(dir, "not", "there"))).toBeNull();
  });

  it("diskName reads /Volumes/<name>", async () => {
    const x = fakeExecFile({ stdout: PLIST("Other") });
    expect(await diskName("/Volumes/Research Drive/Libraries/Lib", { platform: "darwin", execFile: x.fn })).toBe("Research Drive");
    expect(await diskName("/Volumes/Field", { platform: "linux", execFile: x.fn })).toBe("Field");
    expect(x.calls).toHaveLength(0); // the name is in the path: diskutil is not asked
  });

  it("diskName reads diskutil's VolumeName on macOS", async () => {
    const x = fakeExecFile({ stdout: PLIST("Macintosh HD &amp; more") });
    expect(await diskName("/Users/someone/Library Folder", { platform: "darwin", execFile: x.fn })).toBe("Macintosh HD & more");
    expect(x.calls).toHaveLength(1);
    expect(x.calls[0]).toMatchObject({ file: "/usr/sbin/diskutil", args: ["info", "-plist", "/Users/someone/Library Folder"] });
    expect(x.calls[0]!.opts.timeout).toBe(2000);
  });

  it("diskName is null off a Mac and when diskutil fails or takes more than 2 s", async () => {
    const off = fakeExecFile({ stdout: PLIST("Should not be read") });
    expect(await diskName("/home/someone/Lib", { platform: "linux", execFile: off.fn })).toBeNull();
    expect(await diskName("C:\\Users\\someone\\Lib", { platform: "win32", execFile: off.fn })).toBeNull();
    expect(off.calls).toHaveLength(0);

    const failed = fakeExecFile({ err: Object.assign(new Error("Could not find disk"), { code: "1" }) as NodeJS.ErrnoException });
    expect(await diskName("/Users/someone/Lib", { platform: "darwin", execFile: failed.fn })).toBeNull();

    // execFile's own timeout (2 s) kills diskutil and answers with this error
    const slow = fakeExecFile({ err: Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }) as Answer["err"] });
    expect(await diskName("/Users/someone/Lib", { platform: "darwin", execFile: slow.fn })).toBeNull();
    expect(slow.calls[0]!.opts.timeout).toBe(2000);

    const noName = fakeExecFile({ stdout: "<plist><dict></dict></plist>" });
    expect(await diskName("/Users/someone/Lib", { platform: "darwin", execFile: noName.fn })).toBeNull();
  });
});
