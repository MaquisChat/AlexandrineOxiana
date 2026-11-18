/**
 * An add whose index write fails never deletes a kept copy it did not write (Task 68 fix round 1,
 * M3): after a reset, the copies of the fonts added before stay unlisted in the fonts folder; adding
 * the same file again reuses its copy, and a failure then must not remove it.
 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fail = vi.hoisted(() => ({ fontsIndex: false }));
vi.mock("@ao/library", async (orig) => {
  const real = await orig<typeof import("@ao/library")>();
  return {
    ...real,
    updateAppSettingStrict: ((dir: string, name: string, ...rest: unknown[]) => {
      if (fail.fontsIndex && name === "fonts.json") return Promise.reject(Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }));
      return (real.updateAppSettingStrict as (...a: unknown[]) => unknown)(dir, name, ...rest);
    }) as typeof real.updateAppSettingStrict,
  };
});

import { deviceDeps, type Deps } from "@ao/library";
import { createService, type LibraryService } from "./server.js";

const TOKEN = "ui-token-0123456789abcdefghijklmnopqrstuvwxyz";
const ui = { authorization: `Bearer ${TOKEN}`, origin: "http://tauri.localhost" };
let tmp: string;
let deps: Deps;
let svc: LibraryService | undefined;

beforeEach(async () => {
  fail.fontsIndex = false;
  tmp = await mkdtemp(join(tmpdir(), "ao-fonts-cleanup-"));
  deps = { ...deviceDeps(join(tmp, "config")), settleMs: 0 };
  svc = await createService({ token: TOKEN, deps, worker: null, logStream: new Writable({ write: (_c, _e, cb) => cb() }) });
});
afterEach(async () => {
  await svc?.close();
  await rm(tmp, { recursive: true, force: true });
});

const post = (url: string, body: unknown) => svc!.app.inject({ method: "POST", url, headers: { ...ui, "content-type": "application/json" }, payload: JSON.stringify(body) });

describe("fonts: the clean-up of a failed add", () => {
  it("does not delete a kept copy that was there before the add (an unlisted copy after a reset)", async () => {
    const font = join(tmp, "Junicode.woff2");
    await writeFile(font, Buffer.concat([Buffer.from("wOF2", "latin1"), Buffer.alloc(700, 3)]));
    expect((await post("/settings/fonts", { path: font, name: "Junicode" })).statusCode).toBe(200);
    await writeFile(join(deps.appConfigDir, "fonts.json"), "garbage{");
    expect((await post("/settings/reset", { file: "fonts", confirm: true })).statusCode).toBe(200);
    const kept = await readdir(join(deps.appConfigDir, "fonts"));
    expect(kept).toHaveLength(1);
    fail.fontsIndex = true;
    expect((await post("/settings/fonts", { path: font, name: "Junicode" })).statusCode).toBeGreaterThanOrEqual(500);
    expect(await readdir(join(deps.appConfigDir, "fonts"))).toEqual(kept);
  });

  it("does delete a copy it wrote itself when the index write fails (no copy left without its entry)", async () => {
    const font = join(tmp, "Other.woff2");
    await writeFile(font, Buffer.concat([Buffer.from("wOF2", "latin1"), Buffer.alloc(800, 5)]));
    fail.fontsIndex = true;
    expect((await post("/settings/fonts", { path: font, name: "Other" })).statusCode).toBeGreaterThanOrEqual(500);
    expect(await readdir(join(deps.appConfigDir, "fonts")).catch(() => [])).toEqual([]);
  });
});
