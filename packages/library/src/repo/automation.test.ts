/**
 * Whole channels (Task 7): the project's switch "Transcribe captured audio and video automatically"
 * (`project.automation.transcribeNewMedia`), written through a governed, audited change of the project.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { KeyRing } from "../crypto/keys.js";
import { FAST, auditEvents, makeKit, makeProject, type Kit } from "../export/test-kit.js";
import { openLibrary } from "../library.js";
import { ReadOnlyLibraryError } from "./errors.js";
import { setProjectAutomation } from "./repo.js";
import { openTestRepo } from "./testing.js";

let kit: Kit;
beforeEach(async () => {
  kit = await makeKit("ao-automation-");
});
afterEach(async () => {
  await kit.close();
});

describe("the project's automatic transcription switch", () => {
  it("setProjectAutomation is governed and audited", async () => {
    const p = await makeProject(kit);
    expect(kit.repo.getProject(p.id).automation?.transcribeNewMedia).toBeUndefined();
    const before = (await auditEvents(kit, p)).length;
    const on = await setProjectAutomation(kit.repo, p.id, { transcribeNewMedia: true });
    expect(on.automation).toEqual({ transcribeNewMedia: true });
    expect(kit.repo.getProject(p.id).automation).toEqual({ transcribeNewMedia: true });
    const events = (await auditEvents(kit, p)).slice(before);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: { result: "allow" }, details: { op: "project.automation" } });
    // Kept in project.json: read again after the repository is opened again.
    await kit.reopen();
    expect(kit.repo.getProject(p.id).automation).toEqual({ transcribeNewMedia: true });
    await setProjectAutomation(kit.repo, p.id, { transcribeNewMedia: false });
    expect(kit.repo.getProject(p.id).automation).toEqual({ transcribeNewMedia: false });
    // Not a boolean: refused, nothing written.
    await expect(setProjectAutomation(kit.repo, p.id, { transcribeNewMedia: "yes" as unknown as boolean })).rejects.toBeInstanceOf(TypeError);
    expect(kit.repo.getProject(p.id).automation).toEqual({ transcribeNewMedia: false });

    // A read-only library refuses it as every change.
    const projectFile = join(kit.lib.root, kit.repo.getProject(p.id).folder, "project.json");
    const was = await readFile(projectFile);
    const ro = await openLibrary(kit.lib.root, {
      clock: () => kit.clock.now, deviceId: "dev-B", hostname: "host-B", pid: process.pid, isPidAlive: () => true,
      appConfigDir: join(kit.tmp, "config-B"), settleMs: 0, setInterval: () => ({}), clearInterval: () => {},
    });
    onTestFinished(() => ro.close());
    expect(ro.mode).toBe("read-only");
    const roRepo = await openTestRepo(ro, new KeyRing(), { clock: () => kit.clock.now, tz: "UTC", actor: "tester", scryptN: FAST });
    await expect(setProjectAutomation(roRepo, p.id, { transcribeNewMedia: true })).rejects.toBeInstanceOf(ReadOnlyLibraryError);
    expect(await readFile(projectFile)).toEqual(was);
  });
});
