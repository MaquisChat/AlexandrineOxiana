import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
/** The built UI the test browser loads (`pnpm --filter @ao/ui run build`). */
export const UI_DIST = fileURLToPath(new URL("../packages/ui/dist/", import.meta.url));
/** @ao/library: its sources (run with tsx) and dependencies serve test set-up and checks. */
export const LIBRARY_DIR = fileURLToPath(new URL("../packages/library/", import.meta.url));
export const SERVICE_DIR = fileURLToPath(new URL("../apps/library-service/", import.meta.url));
/** Fake yt-dlp and gallery-dl: put first on the worker's PATH so no capture reaches the network. */
export const FAKE_TOOLS = fileURLToPath(new URL("../packages/library/tests/fixtures/fake-tools", import.meta.url));
/** Recorded metadata answers (answers.json) replayed by the service under NODE_ENV=test. */
export const LOOKUP_FIXTURES = fileURLToPath(new URL("../packages/library/tests/fixtures/lookup", import.meta.url));
/** A fake faster-whisper and the worker wrapper that puts it first on the worker's PYTHONPATH (fixtures.ts `fakeControl`). */
export const FAKE_SPEECH = fileURLToPath(new URL("../packages/library/tests/fixtures/fake-speech", import.meta.url));
