/**
 * The background (service worker in Chrome/Edge, event page in Firefox). It does the work a capture
 * needs after the user clicked a button in the popup, so closing the popup does not stop it:
 *  - injects the content script into that tab (activeTab; never on its own),
 *  - collects the page's fields and HTML, takes the stitched screenshot, and posts them to
 *    POST /capture/browser with the paired token;
 *  - runs "profile as I scroll" (start / status / finish / cancel) and sends the noted links.
 * It listens only to the extension's own popup and to its own content script.
 */
import browser, { type Runtime } from "webextension-polyfill";
import { ApiError, createApi } from "./api.js";
import { fitCaptureBody } from "./body-size.js";
import type { ContentApi } from "./content/index.js";
import { bytesToBase64, captureFullPage, createCaptureLimiter } from "./content/screenshot.js";
import { validateSelectors, type SelectorsConfig } from "./content/selectors-schema.js";
import { addPending, chunks, parsePending, removePending } from "./pending.js";
import type { BackgroundRequest, CaptureReply, ProfileStatus } from "./types.js";

const api = createApi({ fetch: (input, init) => fetch(input, init), storage: browser.storage.local });

/** captureVisibleTab allows two calls a second for the whole extension: one limiter for all captures. */
const captureSlot = createCaptureLimiter();
/** The service takes at most 500 links per request. */
const MAX_LINKS = 500;

// ---- selectors.json: loaded from the package and checked against its schema ----
let selectors: Promise<SelectorsConfig> | undefined;
function loadSelectors(): Promise<SelectorsConfig> {
  selectors ??= fetch(browser.runtime.getURL("selectors.json"))
    .then((r) => r.json())
    .then(validateSelectors)
    .catch((e: unknown) => {
      selectors = undefined;
      throw new Error(`The extension's selectors.json could not be used (${e instanceof Error ? e.message : String(e)}).`);
    });
  return selectors;
}

// ---- running steps in the tab ----
type Step = { ok: true; value: unknown } | { ok: false; error: string };
type StepName = keyof ContentApi;

/** Calls one step of the content script (globalThis.__aoCapture) in the tab and returns its result. */
async function inTab<K extends StepName>(tabId: number, step: K, ...args: Parameters<ContentApi[K]>): Promise<Awaited<ReturnType<ContentApi[K]>>> {
  const results = await browser.scripting.executeScript({
    target: { tabId },
    // Serialised into the page's isolated world: everything it needs is passed in as arguments.
    func: async (name: string, stepArgs: unknown[]): Promise<Step> => {
      try {
        const capture = globalThis.__aoCapture as unknown as Record<string, (...a: unknown[]) => unknown> | undefined;
        if (!capture) return { ok: false, error: "The capture script is not loaded in this page." };
        const fn = capture[name];
        if (typeof fn !== "function") return { ok: false, error: `Unknown step ${name}.` };
        return { ok: true, value: await fn(...stepArgs) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    args: [step, args],
  });
  const r = results[0]?.result as Step | undefined;
  if (!r) throw new Error("The page did not answer (it may have been closed or reloaded).");
  if (!r.ok) throw new Error(r.error);
  return r.value as Awaited<ReturnType<ContentApi[K]>>;
}

async function injectContent(tabId: number): Promise<void> {
  await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "The desktop app no longer knows this extension. Pair it again.";
    return e.message;
  }
  const m = e instanceof Error ? e.message : String(e);
  if (/activeTab|all_urls|Cannot access|cannot be scripted|Missing host permission/i.test(m)) return "This page cannot be captured from here. Open the extension on the page itself and try again.";
  return m;
}

// ---- capture this page ----
const busy = new Set<number>();

async function capturePage(tabId: number, projectId: string, alsoDownload: boolean): Promise<CaptureReply> {
  if (busy.has(tabId)) return { ok: false, message: "This tab is already being captured." };
  busy.add(tabId);
  await browser.action.setBadgeText({ tabId, text: "…" }).catch(() => {});
  try {
    const sel = await loadSelectors();
    await injectContent(tabId);
    const collected = await inTab(tabId, "collect", sel);
    const tab = await browser.tabs.get(tabId);
    const shot = await captureFullPage({
      page: {
        metrics: () => inTab(tabId, "screenshotStart"),
        scrollTo: (y) => inTab(tabId, "screenshotScroll", y),
        hideFixed: () => inTab(tabId, "screenshotHideFixed"),
        restore: () => inTab(tabId, "screenshotRestore").catch(() => {}),
      },
      captureVisible: async () => {
        const now = await browser.tabs.get(tabId);
        if (!now.active || now.windowId !== tab.windowId) throw new Error("The capture stopped because another tab was brought to the front. Try again and stay on the page until it finishes.");
        return browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      },
      slot: captureSlot,
      deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    });
    const notes: string[] = [];
    if (collected.htmlNote) notes.push(collected.htmlNote);
    // Within the service's 32 MB, in bytes: HTML, then media links are dropped, else refused here.
    const fitted = fitCaptureBody({
      projectId,
      url: collected.url,
      extracted: collected.extracted,
      screenshotPng: bytesToBase64(shot.png),
      ...(collected.html ? { html: collected.html } : {}),
      alsoDownload,
    });
    const body = fitted.body;
    notes.push(...fitted.notes);
    if (shot.truncated) notes.push("The page is very long: the screenshot stops after 30,000 pixels.");
    else if (shot.scaled) notes.push("The screenshot was made smaller to fit in memory.");
    const r = await api.captureBrowser(body);
    if (r.htmlNote) notes.push(r.htmlNote);
    return { ok: true, sourceId: r.sourceId, message: [`Captured: ${r.status === "merged" ? "added to the downloaded source" : "saved to your library"}.`, ...notes].join(" ") };
  } catch (e) {
    return { ok: false, message: errorText(e) };
  } finally {
    busy.delete(tabId);
    await browser.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  }
}

// ---- profile as I scroll ----
const profileKey = (tabId: number) => `profile:${tabId}`;
const PENDING = "pendingLinks";

async function profileRecord(tabId: number): Promise<{ projectId: string } | undefined> {
  const v = (await browser.storage.session.get(profileKey(tabId)))[profileKey(tabId)] as { projectId?: unknown } | undefined;
  return typeof v?.projectId === "string" ? { projectId: v.projectId } : undefined;
}

function cleanLinks(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const u of v) {
    if (out.size >= MAX_LINKS) break;
    if (typeof u !== "string" || u.length > 2048) continue;
    try {
      const p = new URL(u);
      if (p.protocol === "https:" || p.protocol === "http:") out.add(p.href);
    } catch {
      /* not a link */
    }
  }
  return [...out];
}

// Links not sent, per project, in storage.session; every change goes through one queue so two
// finishing runs cannot overwrite each other's lists.
let pendingQueue: Promise<unknown> = Promise.resolve();
function updatePending(change: (p: ReturnType<typeof parsePending>) => ReturnType<typeof parsePending>): Promise<void> {
  const run = pendingQueue.then(async () => {
    const next = change(parsePending((await browser.storage.session.get(PENDING))[PENDING]));
    if (Object.keys(next).length) await browser.storage.session.set({ [PENDING]: next });
    else await browser.storage.session.remove(PENDING);
  });
  pendingQueue = run.catch(() => {});
  return run;
}

/** Why the service did not take a list, in words for the user (R112: by error code). */
function refusalReason(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "FORBIDDEN") return "the desktop app needs updating (this version does not take link lists from the extension)";
    if (e.code === "POLICY_DENIED") return `the project's rules do not allow it: ${e.reason ?? e.message}`;
  }
  return errorText(e);
}

const links = (n: number) => `${n} link${n === 1 ? "" : "s"}`;

/** Sends `urls` (in pieces of 500) to POST /capture/browser/links; what is not taken is kept for the project. */
async function sendLinks(projectId: string, urls: string[]): Promise<CaptureReply> {
  if (!urls.length) return { ok: false, message: "No post links were noted. Scroll the profile, then press Finish." };
  let sent = 0;
  try {
    for (const part of chunks(urls, MAX_LINKS)) {
      await api.queueLinks(projectId, part);
      sent += part.length;
    }
  } catch (e) {
    const reason = refusalReason(e);
    const rest = urls.slice(sent);
    await updatePending((p) => addPending(p, projectId, rest, reason));
    return { ok: false, message: `${sent ? `Sent ${links(sent)}; ` : ""}${links(rest.length)} not sent: ${reason}. They are kept until the browser closes; open the extension to try again or copy them.` };
  }
  // Whatever of these was waiting for this project has now been taken.
  const done = new Set(urls);
  await updatePending((p) => {
    const left = (p[projectId]?.urls ?? []).filter((u) => !done.has(u));
    return left.length ? { ...p, [projectId]: { ...p[projectId]!, urls: left } } : removePending(p, projectId);
  });
  return { ok: true, message: `Sent ${links(sent)} to the desktop app's capture queue.` };
}

async function profileStart(tabId: number, projectId: string): Promise<ProfileStatus> {
  // Profile capture queues the links for the downloader: the project must allow both (R112).
  const project = (await api.listProjects()).find((p) => p.id === projectId);
  if (!project?.captureMethods.includes("browser_capture") || !project.captureMethods.includes("downloader")) {
    throw new Error("Profile capture needs a project whose rules allow both browser capture and the downloader.");
  }
  const sel = await loadSelectors();
  await injectContent(tabId);
  const s = await inTab(tabId, "profileStart", sel);
  await browser.storage.session.set({ [profileKey(tabId)]: { projectId } });
  return { ...s, projectId };
}

async function profileStatus(tabId: number): Promise<ProfileStatus> {
  const rec = await profileRecord(tabId);
  if (!rec) return { active: false, count: 0 };
  try {
    const s = await inTab(tabId, "profileStatus");
    if (!s.active) await browser.storage.session.remove(profileKey(tabId));
    return { ...s, projectId: rec.projectId };
  } catch {
    // The page was left or reloaded: nothing is listening any more.
    await browser.storage.session.remove(profileKey(tabId));
    return { active: false, count: 0 };
  }
}

async function profileFinish(tabId: number, fromPage?: unknown): Promise<CaptureReply> {
  const rec = await profileRecord(tabId);
  if (!rec) return { ok: false, message: "Profile capture is not running on this tab." };
  await browser.storage.session.remove(profileKey(tabId));
  const urls = cleanLinks(fromPage !== undefined ? fromPage : await inTab(tabId, "profileStop").catch(() => []));
  return sendLinks(rec.projectId, urls);
}

async function profileCancel(tabId: number, inPage: boolean): Promise<ProfileStatus> {
  await browser.storage.session.remove(profileKey(tabId));
  if (inPage) await inTab(tabId, "profileStop").catch(() => []);
  return { active: false, count: 0 };
}

// ---- messages ----
// The popup (also when opened as a tab); a content script's sender.url is the web page, never this.
const isPopup = (sender: Runtime.MessageSender) => sender.id === browser.runtime.id && typeof sender.url === "string" && sender.url.startsWith(browser.runtime.getURL("popup.html"));
const isOwnContentScript = (sender: Runtime.MessageSender) => sender.id === browser.runtime.id && typeof sender.tab?.id === "number" && sender.frameId === 0;
const validTab = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;

async function handle(msg: BackgroundRequest, sender: Runtime.MessageSender): Promise<unknown> {
  if (typeof msg !== "object" || msg === null) return undefined;
  if (msg.type === "overlay-finish" || msg.type === "overlay-cancel") {
    if (!isOwnContentScript(sender)) return undefined;
    const tabId = sender.tab!.id!;
    return msg.type === "overlay-finish" ? profileFinish(tabId, msg.urls) : profileCancel(tabId, false);
  }
  if (!isPopup(sender)) return undefined;
  switch (msg.type) {
    case "capture-page":
      if (!validTab(msg.tabId) || !validId(msg.projectId)) return undefined;
      return capturePage(msg.tabId, msg.projectId, msg.alsoDownload === true);
    case "profile-start":
      if (!validTab(msg.tabId) || !validId(msg.projectId)) return undefined;
      return profileStart(msg.tabId, msg.projectId).catch((e: unknown) => ({ active: false, count: 0, error: errorText(e) }));
    case "profile-status":
      return validTab(msg.tabId) ? profileStatus(msg.tabId) : undefined;
    case "profile-finish":
      return validTab(msg.tabId) ? profileFinish(msg.tabId) : undefined;
    case "profile-cancel":
      return validTab(msg.tabId) ? profileCancel(msg.tabId, true) : undefined;
    case "pending-retry": {
      if (!validId(msg.projectId)) return undefined;
      const entry = parsePending((await browser.storage.session.get(PENDING))[PENDING])[msg.projectId];
      return entry ? sendLinks(msg.projectId, entry.urls) : { ok: false, message: "Nothing is waiting to be sent." };
    }
    case "pending-discard":
      if (!validId(msg.projectId)) return undefined;
      await updatePending((p) => removePending(p, msg.projectId));
      return { ok: true, message: "Discarded." };
    default:
      return undefined;
  }
}

browser.runtime.onMessage.addListener((msg: unknown, sender: Runtime.MessageSender) => handle(msg as BackgroundRequest, sender));

browser.tabs.onRemoved.addListener((tabId: number) => {
  void browser.storage.session.remove(profileKey(tabId));
});
