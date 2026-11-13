// The development and test way of starting the library service (`pnpm start`, the end-to-end harness): the service's
// TypeScript through tsx, in ONE process (standard input, the token line and signals are the service's own).
//
// Its first statement gives the process sixteen file threads (UV_THREADPOOL_SIZE; cloud-drive watched folders, A3 d,
// A5, R227, R233 M10), as the built folder's launcher does: libuv reads the variable once, when the first call needs a
// thread, so it is set before anything is loaded (the module has no static import). A larger whole number already in
// the environment is kept; anything else (unset, smaller, or not a whole number, e.g. "16abc") becomes 16. The product never comes here: the shell starts the built folder's
// service.mjs with an allow-listed environment, so there the value is always the launcher's 16.
const given = process.env.UV_THREADPOOL_SIZE ?? "";
if (!(/^\d{1,4}$/u.test(given) && Number(given) >= 16 && Number(given) <= 1024)) process.env.UV_THREADPOOL_SIZE = "16";

const { register } = await import("tsx/esm/api");
register();
await import(new URL("../src/main.ts", import.meta.url).href);
