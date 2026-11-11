// The entry point of the built library service folder (copied there as service.mjs by build.mjs;
// Task 37a, R153, ADR 0013). It runs before any other code of the service is loaded, and:
//
//  1. refuses to start if NODE_OPTIONS, NODE_PATH or NAPI_RS_NATIVE_LIBRARY_PATH is set: each can
//     make Node load code from outside this folder, and none can be undone from inside the program
//     (NODE_OPTIONS has already been applied by the time this runs; refusing still stops an
//     accidental or careless launcher). Whoever starts the folder gives it an allow-listed
//     environment (START.txt);
//  2. refuses to start if the folder was built for another platform, architecture, C library or
//     Node ABI than the running Node (build-info.json): its native modules would not load;
//  3. empties Node's global module folders (~/.node_modules, ~/.node_libraries, $PREFIX/lib/node)
//     as a second line of defence: the build already guarantees that no require misses in the
//     folder (R153), so they are never needed;
//  4. loads the bundled service, main.mjs.
//
// Messages are plain and name no path (R96). Plain JavaScript with Node built-ins only.
import { readFileSync } from "node:fs";
import Module from "node:module";

const REDIRECTING = ["NODE_OPTIONS", "NODE_PATH", "NAPI_RS_NATIVE_LIBRARY_PATH"];

function refuse(why) {
  process.stderr.write(`The library service will not start: ${why}\n`);
  process.exit(1);
}

for (const name of REDIRECTING) {
  if (process.env[name] !== undefined) {
    refuse(`${name} is set in its environment. It can make Node load code from outside the app; start the service with an environment that does not set ${REDIRECTING.join(", ")} (see START.txt).`);
  }
}

let info;
try {
  info = JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8"));
} catch {
  refuse("its build information (build-info.json) is missing or damaged. Reinstall the app.");
}
const libc = process.platform === "linux" ? (process.report?.getReport?.().header?.glibcVersionRuntime ? "glibc" : "musl") : undefined;
const here = `${process.platform}-${process.arch}${libc ? `-${libc}` : ""} with Node ABI ${process.versions.modules} (Node ${process.version})`;
const built = `${info?.platform}-${info?.arch}${info?.libc ? `-${info.libc}` : ""} with Node ABI ${info?.nodeAbi} (Node ${info?.node})`;
if (info?.platform !== process.platform || info?.arch !== process.arch || String(info?.nodeAbi) !== process.versions.modules || (info?.libc ?? undefined) !== libc) {
  refuse(`it was built for ${built}, but this is ${here}. Start it with the Node release it was built for.`);
}

Module.globalPaths.splice(0, Module.globalPaths.length);

await import("./main.mjs");
