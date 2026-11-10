/**
 * Test-only (not exported from the package): a media worker stub for image.proxy / video.proxy
 * that plays the location part of the real worker (Task 15): it copies the input and rewrites its
 * GPS with exiftool per the requested mode (`lie` leaves the exact GPS in, to test that a proxy
 * whose location does not match is rejected). Plus readers for the coordinates of a file.
 */
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { ExifTool } from "exiftool-vendored";
import type { StubJob } from "../worker-testing.js";

/** Signed coordinates of a file as exiftool reads them now (undefined: none). */
export async function gpsOf(et: ExifTool, path: string): Promise<{ lat: number; lon: number } | undefined> {
  const t = (await et.readRaw(path, { readArgs: ["-G1", "-a", "-n"] })) as unknown as Record<string, unknown>;
  const lat = t["Composite:GPSLatitude"];
  const lon = t["Composite:GPSLongitude"];
  return typeof lat === "number" && typeof lon === "number" ? { lat, lon } : undefined;
}

/** Every tag exiftool reports whose name says it is a location (GPS, ISO 6709, QuickTime location). */
export async function locationTags(et: ExifTool, path: string): Promise<string[]> {
  const t = (await et.readRaw(path, { readArgs: ["-G1", "-a", "-n"] })) as unknown as Record<string, unknown>;
  return Object.keys(t).filter((k) => /GPS|Location|ISO6709|xyz/iu.test(k));
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** onSubmit for stubWorker: image.proxy / video.proxy made by copying and rewriting the location. */
export function proxyStub(et: ExifTool, opts: { lie?: boolean } = {}) {
  return async (job: StubJob): Promise<Record<string, unknown>> => {
    const { type, input, output, params } = job.body;
    if (type !== "image.proxy" && type !== "video.proxy") return { status: "failed", error: { code: "UNSUPPORTED", message: type } };
    const mode = String(params.location ?? "keep");
    // exiftool writes by the file's real type: work on a copy named like the input, then rename.
    await mkdir(dirname(output), { recursive: true });
    const work = join(dirname(output), `work${extname(input)}`);
    await copyFile(input, work);
    if (!opts.lie && mode !== "keep") {
      const gps = await gpsOf(et, work);
      const del = { "GPS:all": null, "XMP:GPSLatitude": null, "XMP:GPSLongitude": null, "Keys:GPSCoordinates": null, "UserData:GPSCoordinates": null };
      await et.write(work, del as never, { writeArgs: ["-overwrite_original"] });
      if (mode === "coarsen" && gps) {
        const coarse =
          type === "video.proxy"
            ? { "Keys:GPSCoordinates": `${round1(gps.lat)}, ${round1(gps.lon)}` }
            : // exiftool-vendored sets the hemisphere refs from the signs
              { GPSLatitude: round1(gps.lat), GPSLongitude: round1(gps.lon) };
        await et.write(work, coarse as never, { writeArgs: ["-overwrite_original"] });
      }
    }
    await copyFile(work, output);
    await rm(work, { force: true });
    return { status: "done", result: { output, meta: { location: mode } } };
  };
}
