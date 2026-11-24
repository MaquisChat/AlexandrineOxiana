/**
 * An interrupted change whose undo cannot complete, end to end (FR-736, R503 d, R528): the library opens with a change
 * a crash left behind, in which a file the change wrote was changed outside the app afterwards. The undo leaves that
 * file as it is (R519), so the banner says a file is in the way, "Resolve…" lists the file's place in the library, the
 * researcher moves the file out of the library, "Roll it back" completes, the banner goes and the project takes changes
 * again.
 *
 * The marker is laid down in the library's folder while the library is closed, in the shape this build writes, and the
 * library is then opened through the chooser. Elements are found by role and accessible name; each wait is on a state
 * the page or the service reaches.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ORIGIN, expect, libraryWithProject, test } from "./fixtures.js";

const LIBRARY = "Harbour library";
const PROJECT = "Dock interviews";
const TXN = "019a7000-0000-7000-8000-0000000000e7";
const OWN = "written by the change\n";
const HAND = "the researcher's own notes, typed in after the crash\n";

test("an interrupted change with a file changed outside the app: the banner, the list with the file's place, the file moved away, rolled back, and the project takes changes again", async ({ page, app }) => {
  let libraryPath = "";
  let projectId = "";
  let rel = "";

  await test.step("set-up: a library with a project; closed; a change a crash left behind, its file changed by hand", async () => {
    let projectFolder = "";
    ({ libraryPath, projectId, projectFolder } = await libraryWithProject(app, page, { library: LIBRARY, project: PROJECT }));
    expect((await app.api("POST", "/libraries/close")).status).toBe(200);
    rel = `${projectFolder}/notes.txt`;
    const auditLines = readFileSync(join(libraryPath, projectFolder, "audit", "0001.jsonl"), "utf8").trim().split("\n").length;
    mkdirSync(join(libraryPath, ".tmp"), { recursive: true });
    // The change created notes.txt with these bytes and stopped before its audit entry (no event of it in the log).
    const sha256 = createHash("sha256").update(OWN).digest("hex");
    writeFileSync(
      join(libraryPath, ".tmp", `txn-${TXN}.json`),
      JSON.stringify({ formatVersion: 1, txn: TXN, projectId, projectFolder, auditEvents: 1, auditSeqBefore: auditLines, entries: [{ kind: "created", path: rel, sha256 }] }),
    );
    // Changed outside the app after the crash: no longer the change's own bytes.
    writeFileSync(join(libraryPath, ...rel.split("/")), HAND);
  });

  const banners = page.getByRole("region", { name: "Library status" });
  const SAYS = `An interrupted change in ${PROJECT} could not be undone completely, because a file changed or put there outside the app is in the way. Nothing was lost. Changes to ${PROJECT} are off until it is undone. Choose “Resolve…” to see which file to move.`;

  await test.step("opened through the chooser: the banner says a file is in the way", async () => {
    await page.goto(`${APP_ORIGIN}/`);
    await page.getByRole("button", { name: `Open ${LIBRARY}` }).click();
    await expect(page.getByRole("heading", { level: 1, name: LIBRARY })).toBeVisible();
    await expect(banners.getByRole("status").filter({ hasText: "An interrupted change in" })).toHaveText(`${SAYS} Resolve…`);
    // A standing state, not an event: nothing to dismiss.
    await expect(banners.getByRole("button", { name: /Dismiss/u })).toHaveCount(0);
  });

  const dialog = page.getByRole("dialog", { name: "Interrupted changes" });

  await test.step("“Resolve…”: the list names the file with its place in the library", async () => {
    await banners.getByRole("button", { name: `Resolve the interrupted change in ${PROJECT}…` }).click();
    const item = dialog.getByRole("group", { name: `Interrupted change in ${PROJECT}` });
    await expect(item.getByText(`${rel} was changed or put there outside the app`)).toHaveText(
      `${rel} was changed or put there outside the app, so the app left it as it is. Move it somewhere outside the library (it is kept there as it is), then choose “Roll it back”.`,
    );
    await expect(item.getByRole("button", { name: "Close this change as it is" })).toHaveCount(0);
  });

  await test.step("the researcher moves the file out of the library; “Roll it back” completes", async () => {
    const outside = join(app.root, "moved-out-notes.txt");
    renameSync(join(libraryPath, ...rel.split("/")), outside);
    await dialog.getByRole("button", { name: "Roll it back" }).click();
    await dialog.getByRole("button", { name: "Yes, roll it back" }).click();
    await expect(dialog.getByText("Nothing is waiting: every interrupted change is resolved.")).toBeVisible();
    expect(readFileSync(outside, "utf8")).toBe(HAND);
    expect(existsSync(join(libraryPath, ".tmp", `txn-${TXN}.json`))).toBe(false);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });

  await test.step("the banner is gone, and the project takes a change", async () => {
    await expect(page.getByText("An interrupted change in", { exact: false })).toHaveCount(0);
    const made = await app.api("POST", `/projects/${projectId}/collections`, { name: "Chapter one" });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
  });
});
