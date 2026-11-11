/**
 * The import review queue (spec 5.4): items an import could not identify with confidence. The
 * selected item is shown next to its candidate matches; per item: Accept, Edit, Merge, Skip, Keep
 * both (and accept one of the candidates); for a selection: Set type, Add tag, Move to collection.
 * Every review request names the project in its body (R97).
 *
 * The preview is plain text (the record's details and its files' names): the service has no route
 * that serves an imported file's content for preview yet.
 *
 * In projects that pseudonymise names, titles taken from file names, and collections and tags the
 * batch made from folder names, are flagged (R64): they can carry participants' names. What the
 * batch made is what the service reports it created (BatchSummary.created, R118).
 *
 * The list shows the titles the service sends with the items (R118); a record is fetched for the
 * item shown, and — as a fallback for items sent without a title — for those items, a pool of
 * SOURCE_POOL requests at a time, the shown item first (R115 I4). The records loaded are kept in a
 * small store outside React state that each row reads for itself, so an answer re-renders only the
 * rows it changes, not the whole queue (a queue of thousands would otherwise be rebuilt per answer).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ApiClient } from "../../api/client";
import {
  importApi,
  type BatchSummary,
  type Candidate,
  type Collection,
  type Creator,
  type ImportPolicy,
  type ReviewDecision,
  type ReviewItem,
  type ReviewPatch,
  type SourceFile,
  type SourceListItem,
  type Tag,
} from "../../api/import";
import { CodeSwatch } from "../../components/CodeSwatch";
import { UserText } from "../../components/UserText";
import { inAppLink } from "../../navigation";
import { count, ErrorNote, errorText, fmt, reportHref, Section, SOURCE_TYPES, typeLabel } from "./shared";
import "./import.css";

/** Batch kinds whose collections are made from folder names. */
const FOLDER_KINDS = new Set(["folder", "zip", "device"]);

const titleOf = (sf: SourceFile | undefined): string => {
  const v = sf?.source.title.variants;
  return (v?.find((x) => x.kind === "original") ?? v?.[0])?.value ?? "";
};

const creatorName = (c: Creator): string => c.literal ?? [c.given, c.family].filter(Boolean).join(" ");

const creatorsText = (cs: Creator[]): string => cs.map(creatorName).filter(Boolean).join("; ");

/** The title came from the file name (field evidence, or the identification method). */
export function titleFromFileName(item: ReviewItem, sf: SourceFile | undefined): boolean {
  if (item.method?.startsWith("filename")) return true;
  return !!sf?.fieldEvidence.some((e) => e.field === "/title" && e.source.kind === "filename");
}

/** The source records loaded so far, by source id; a change tells only its readers (useRecord). */
interface RecordStore {
  get(sid: string | undefined): SourceFile | undefined;
  set(entries: Iterable<[string, SourceFile]>): void;
  subscribe(listener: () => void): () => void;
}

function recordStore(): RecordStore {
  const map = new Map<string, SourceFile>();
  const listeners = new Set<() => void>();
  return {
    get: (sid) => (sid ? map.get(sid) : undefined),
    set(entries) {
      for (const [k, v] of entries) map.set(k, v);
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** One source's record; the component re-renders when that record changes, and only then. */
function useRecord(store: RecordStore, sid: string | undefined): SourceFile | undefined {
  return useSyncExternalStore(store.subscribe, () => store.get(sid));
}

export interface ReviewQueueProps {
  client: ApiClient;
  projectId: string;
  batchId: string;
}

/** Source requests in flight at once (R115 I4). */
export const SOURCE_POOL = 6;

/** What the batch made from folder names (R64): the collections and tags it reports it created (R118). */
function madeByBatch(id: string, batch: BatchSummary | undefined): boolean {
  if (!batch?.created || !FOLDER_KINDS.has(batch.kind)) return false;
  return batch.created.collectionIds.includes(id) || batch.created.tagIds.includes(id);
}

export function ReviewQueue({ client, projectId, batchId }: ReviewQueueProps) {
  const api = useMemo(() => importApi(client), [client]);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [store] = useState(recordStore);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  /** Read by each answer: clearing a failure that is not there would re-render the whole queue. */
  const failedRef = useRef(failed);
  failedRef.current = failed;
  const [policy, setPolicy] = useState<ImportPolicy | null>(null);
  const [batch, setBatch] = useState<BatchSummary | undefined>(undefined);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [focusId, setFocusId] = useState<{ id: string | null } | null>(null);
  const showButtons = useRef(new Map<string, HTMLButtonElement>());
  const title = useRef<HTMLHeadingElement>(null);

  // ---- source loading: a queue served by SOURCE_POOL workers, the current item first ----
  const pool = useRef({ queue: [] as string[], active: 0, live: true, asked: new Set<string>() });
  // Answers are applied as they arrive, gathered over a frame so a long queue does not re-render
  // once per answer; the shown item's answer is applied at once.
  const arrived = useRef(new Map<string, SourceFile>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownSid = useRef<string | undefined>(undefined);
  const flush = useCallback(() => {
    if (flushTimer.current) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    if (!arrived.current.size) return;
    const got = arrived.current;
    arrived.current = new Map();
    store.set(got);
  }, [store]);
  const pump = useCallback(() => {
    const p = pool.current;
    while (p.live && p.active < SOURCE_POOL && p.queue.length) {
      const sid = p.queue.shift()!;
      p.asked.add(sid);
      p.active++;
      api
        .source(projectId, sid)
        .then(
          (sf) => {
            if (!p.live) return;
            arrived.current.set(sid, sf);
            if (sid === shownSid.current) flush();
            else flushTimer.current ??= setTimeout(flush, 16);
            if (failedRef.current.has(sid)) setFailed((cur) => new Set([...cur].filter((x) => x !== sid)));
          },
          () => {
            p.asked.delete(sid); // a retry may ask again
            if (p.live) setFailed((cur) => new Set(cur).add(sid));
          },
        )
        .finally(() => {
          p.active--;
          pump();
        });
    }
  }, [api, projectId, flush]);
  /** Loads these sources next (ahead of what is already queued); one already asked for is not asked again. */
  const loadFirst = useCallback(
    (sids: string[]) => {
      const p = pool.current;
      const fresh = sids.filter((x) => !p.asked.has(x));
      p.queue = [...fresh, ...p.queue.filter((x) => !fresh.includes(x))];
      pump();
    },
    [pump],
  );

  useEffect(() => {
    const p = { queue: [] as string[], active: 0, live: true, asked: new Set<string>() };
    pool.current = p;
    let live = true;
    setError(null);
    api.review(batchId).then(
      (list) => {
        if (!live) return;
        setItems(list);
        setCurrent(list[0]?.id ?? null);
        // Titles come with the items; only items sent without one need their record for the list.
        p.queue = list.flatMap((i) => (i.sourceId && !i.title ? [i.sourceId] : []));
        pump();
      },
      (e: unknown) => live && setError(errorText(e)),
    );
    api.policy(projectId).then((x) => live && setPolicy(x), () => live && setPolicy({ pseudonymizeNames: true, encryptionRequired: true }));
    api.collections(projectId).then((c) => live && setCollections(c), () => {});
    api.tags(projectId).then((t) => live && setTags(t), () => {});
    api.batches(projectId).then((b) => live && setBatch(b.find((x) => x.batchId === batchId)), () => {});
    return () => {
      live = false;
      p.live = false;
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      arrived.current = new Map();
    };
  }, [api, projectId, batchId, pump]);

  // The item shown is loaded (its full record, for the preview) before the rest of the queue.
  const currentItem = items?.find((i) => i.id === current);
  shownSid.current = currentItem?.sourceId;
  const shownSource = useRecord(store, currentItem?.sourceId);
  useEffect(() => {
    const sid = currentItem?.sourceId;
    if (sid) loadFirst([sid]);
  }, [currentItem?.sourceId, loadFirst]);

  // After a decision, focus moves to the next item's row (or the heading when none is left).
  useEffect(() => {
    if (!focusId) return;
    const el = focusId.id ? showButtons.current.get(focusId.id) : undefined;
    (el ?? title.current)?.focus();
  }, [focusId]);

  /** The title the list shows for an item (read now, for the status line after a decision). */
  const titleFor = (i: ReviewItem, n: number) => titleOf(store.get(i.sourceId)) || i.title || `item ${fmt(n)}`;

  const retry = useCallback(
    (sid: string) => {
      setFailed((cur) => new Set([...cur].filter((x) => x !== sid)));
      loadFirst([sid]);
    },
    [loadFirst],
  );
  const toggle = useCallback((id: string, on: boolean) => setSelected((s) => (on ? [...s, id] : s.filter((x) => x !== id))), []);
  const showRef = useCallback((id: string, el: HTMLButtonElement | null) => {
    if (el) showButtons.current.set(id, el);
    else showButtons.current.delete(id);
  }, []);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const decide = async (item: ReviewItem, decision: ReviewDecision, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.decide(projectId, item.id, decision);
      const list = items ?? [];
      const at = list.findIndex((x) => x.id === item.id);
      const rest = list.filter((x) => x.id !== item.id);
      const next = rest[Math.min(at, rest.length - 1)]?.id ?? null;
      setItems(rest);
      setCurrent(next);
      setSelected((s) => s.filter((x) => x !== item.id));
      setStatus(`${done}: ${titleFor(item, at + 1)}`);
      setFocusId({ id: next });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const bulk = async (patch: ReviewPatch, done: string) => {
    if (!selected.length) return;
    setBusy(true);
    setError(null);
    const chosen = items?.filter((i) => selected.includes(i.id)) ?? [];
    try {
      const r = await api.bulkEdit(
        projectId,
        chosen.map((i) => i.id),
        patch,
      );
      setStatus(`${done} ${count(r.edited, "item")}.`);
      // The service applied the patch; the loaded records are updated in place (no refetch).
      const sids = new Set(chosen.flatMap((i) => (i.sourceId ? [i.sourceId] : [])));
      const edited: Array<[string, SourceFile]> = [];
      for (const sid of sids) {
        const sf = store.get(sid);
        if (!sf) continue;
        const s = { ...sf.source };
        if (patch.type) s.type = patch.type;
        if (patch.tagIds) s.tagIds = [...new Set([...s.tagIds, ...patch.tagIds])];
        if (patch.collectionId) s.collectionIds = [...new Set([...s.collectionIds, patch.collectionId])];
        edited.push([sid, { ...sf, source: s }]);
      }
      store.set(edited);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const item = currentItem;
  const flagging = policy?.pseudonymizeNames === true;

  return (
    <main className="ao-import ao-review" aria-labelledby="ao-review-title">
      <h1 id="ao-review-title" ref={title} tabIndex={-1}>
        Review queue
      </h1>
      <p>
        <a href={reportHref(projectId, batchId)} onClick={inAppLink}>
          Back to the import's report and undo
        </a>
      </p>
      <ErrorNote error={error} />
      <p className="ao-visually-hidden" role="status">
        {status}
      </p>
      {items === null && !error && <p role="status">Loading…</p>}
      {items !== null && items.length === 0 && <p>Nothing is waiting for review in this import.</p>}
      {items !== null && items.length > 0 && (
        <div className="ao-review__layout">
          <div className="ao-review__list-col">
            <BulkBar count={selected.length} collections={collections} tags={tags} busy={busy} onBulk={(p, d) => void bulk(p, d)} />
            <label className="ao-import__choice">
              <input
                type="checkbox"
                checked={selected.length === items.length}
                ref={(el) => {
                  if (el) el.indeterminate = selected.length > 0 && selected.length < items.length;
                }}
                onChange={(e) => setSelected(e.target.checked ? items.map((i) => i.id) : [])}
              />
              <span>Select all</span>
            </label>
            <ul className="ao-review__list" aria-label={`Items waiting for review (${fmt(items.length)})`}>
              {items.map((i, at) => (
                <Row
                  key={i.id}
                  id={i.id}
                  sourceId={i.sourceId}
                  n={at + 1}
                  store={store}
                  fallbackTitle={i.title || `item ${fmt(at + 1)}`}
                  reason={i.reasons[0] ?? ""}
                  current={i.id === current}
                  selected={selectedSet.has(i.id)}
                  broken={!!i.sourceId && failed.has(i.sourceId)}
                  onToggle={toggle}
                  onShow={setCurrent}
                  onRetry={retry}
                  showRef={showRef}
                />
              ))}
            </ul>
          </div>
          {item && (
            <ItemPanel
              key={item.id}
              api={api}
              projectId={projectId}
              item={item}
              source={shownSource}
              loadFailed={!!item.sourceId && failed.has(item.sourceId)}
              onRetry={() => item.sourceId && retry(item.sourceId)}
              collections={collections}
              tags={tags}
              flagTitle={flagging && titleFromFileName(item, shownSource)}
              flagFolderNames={flagging ? (id: string) => madeByBatch(id, batch) : () => false}
              busy={busy}
              onDecide={(d, done) => void decide(item, d, done)}
            />
          )}
        </div>
      )}
    </main>
  );
}

interface RowProps {
  id: string;
  sourceId: string | undefined;
  n: number;
  store: RecordStore;
  /** The title when the record has none (or is not loaded): the one sent with the item, else "item n". */
  fallbackTitle: string;
  reason: string;
  current: boolean;
  selected: boolean;
  broken: boolean;
  onToggle(id: string, on: boolean): void;
  onShow(id: string): void;
  onRetry(sourceId: string): void;
  showRef(id: string, el: HTMLButtonElement | null): void;
}

/** One queue row; re-renders only when its own props or its own record change (queues can hold thousands). */
const Row = memo(function Row({ id, sourceId, n, store, fallbackTitle, reason, current, selected, broken, onToggle, onShow, onRetry, showRef }: RowProps) {
  const t = titleOf(useRecord(store, sourceId)) || fallbackTitle;
  return (
    <li className={current ? "ao-review__row ao-review__row--current" : "ao-review__row"}>
      <input type="checkbox" aria-label={`Select ${t}`} checked={selected} onChange={(e) => onToggle(id, e.target.checked)} />
      <button type="button" className="ao-review__show" aria-label={`Show ${t}`} aria-pressed={current} ref={(el) => showRef(id, el)} onClick={() => onShow(id)}>
        <UserText className="ao-review__row-title">{t}</UserText>
        <span className="ao-import__hint">{broken ? "Could not be loaded." : reason}</span>
      </button>
      {broken && sourceId && (
        <button type="button" aria-label={`Retry loading item ${fmt(n)}`} onClick={() => onRetry(sourceId)}>
          Retry
        </button>
      )}
    </li>
  );
});

function BulkBar({ count: n, collections, tags, busy, onBulk }: { count: number; collections: Collection[]; tags: Tag[]; busy: boolean; onBulk(p: ReviewPatch, done: string): void }) {
  const [type, setType] = useState("");
  const [tag, setTag] = useState("");
  const [collection, setCollection] = useState("");
  const off = busy || n === 0;
  const items = count(n, "item");
  return (
    <fieldset className="ao-review__bulk">
      <legend>{n ? `For the ${items} selected` : "Select items to edit them together"}</legend>
      <div className="ao-review__bulk-row">
        <label className="ao-import__field">
          <span>Set type</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Choose a type</option>
            {SOURCE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={off || !type} onClick={() => onBulk({ type }, "Type set for")}>
          Apply type to {items}
        </button>
      </div>
      <div className="ao-review__bulk-row">
        <label className="ao-import__field">
          <span>Add tag</span>
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Choose a tag</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={off || !tag} onClick={() => onBulk({ tagIds: [tag] }, "Tag added to")}>
          Add tag to {items}
        </button>
      </div>
      <div className="ao-review__bulk-row">
        <label className="ao-import__field">
          <span>Move to collection</span>
          <select value={collection} onChange={(e) => setCollection(e.target.value)}>
            <option value="">Choose a collection</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={off || !collection} onClick={() => onBulk({ collectionId: collection }, "Moved")}>
          Move {items}
        </button>
      </div>
    </fieldset>
  );
}

interface ItemPanelProps {
  api: ReturnType<typeof importApi>;
  projectId: string;
  item: ReviewItem;
  source: SourceFile | undefined;
  loadFailed: boolean;
  onRetry(): void;
  collections: Collection[];
  tags: Tag[];
  flagTitle: boolean;
  /** True for a collection or tag id the batch made from a folder name (R64). */
  flagFolderNames(id: string): boolean;
  busy: boolean;
  onDecide(d: ReviewDecision, done: string): void;
}

function ItemPanel({ api, projectId, item, source, loadFailed, onRetry, collections, tags, flagTitle, flagFolderNames, busy, onDecide }: ItemPanelProps) {
  const [mode, setMode] = useState<"view" | "edit" | "merge">("view");
  const s = source?.source;
  const title = titleOf(source);
  const inCollections = (s?.collectionIds ?? []).map((id) => collections.find((c) => c.id === id)?.name ?? id);
  const itsTags = (s?.tagIds ?? []).map((id) => ({ id, index: tags.findIndex((t) => t.id === id) + 1, tag: tags.find((t) => t.id === id) }));
  const folderCollections = (s?.collectionIds ?? []).some(flagFolderNames);
  const folderTags = (s?.tagIds ?? []).some(flagFolderNames);

  return (
    <div className="ao-review__panel">
      <div className="ao-review__side-by-side">
        <Section title="Imported record" level={2} className="ao-review__record">
          {!source && !loadFailed && <p role="status">Loading…</p>}
          {!source && loadFailed && (
            <div className="ao-import__error" role="alert">
              <p>This item's record could not be loaded.</p>
              <button type="button" onClick={onRetry}>
                Retry
              </button>
            </div>
          )}
          {source && s && (
            <>
              <UserText as="p" className="ao-review__title">
                {title || "Untitled"}
              </UserText>
              {flagTitle && (
                <p className="ao-import__warning">
                  This title was taken from the file name. File names can carry participants' names: check it before accepting, and edit it if it names someone.
                </p>
              )}
              <dl className="ao-review__fields">
                <dt>Type</dt>
                <dd>{typeLabel(s.type)}</dd>
                {s.creators.length > 0 && (
                  <>
                    <dt>Creators</dt>
                    <dd>
                      <UserText>{creatorsText(s.creators)}</UserText>
                    </dd>
                  </>
                )}
                {s.issued && (
                  <>
                    <dt>Date</dt>
                    <dd>{s.issued}</dd>
                  </>
                )}
                {s.publisher && (
                  <>
                    <dt>Publisher</dt>
                    <dd>
                      <UserText>{s.publisher}</UserText>
                    </dd>
                  </>
                )}
                {source.assets.length > 0 && (
                  <>
                    <dt>Files</dt>
                    <dd>
                      <ul className="ao-review__plain-list">
                        {source.assets.map((a) => (
                          <li key={a.id}>
                            <UserText>{a.fileName ?? a.id}</UserText>
                            {a.mediaType ? <span className="ao-import__hint"> ({a.mediaType})</span> : null}
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
                {inCollections.length > 0 && (
                  <>
                    <dt>Collections</dt>
                    <dd>
                      <ul className="ao-review__plain-list">
                        {inCollections.map((n, i) => (
                          <li key={`${n}-${i}`}>
                            <UserText>{n}</UserText>
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
                {itsTags.length > 0 && (
                  <>
                    <dt>Tags</dt>
                    <dd>
                      <ul className="ao-review__plain-list ao-review__tags">
                        {itsTags.map((t) => (
                          <li key={t.id}>
                            <CodeSwatch index={t.index} name={t.tag?.name ?? t.id} {...(t.tag?.color ? { color: t.tag.color } : {})} />
                          </li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
              </dl>
              {folderCollections && (
                <p className="ao-import__warning">
                  These collection names come from folder names, which can carry participants' names. Check them, and rename the collection or move the item if one names someone.
                </p>
              )}
              {folderTags && (
                <p className="ao-import__warning">
                  These tag names come from folder names, which can carry participants' names. Check them, and rename or remove a tag that names someone.
                </p>
              )}
            </>
          )}
          <Section title="Why it needs review" level={3}>
            <ul>
              {item.reasons.map((r, i) => (
                <li key={`${i}:${r}`}>
                  <UserText>{r}</UserText>
                </li>
              ))}
            </ul>
            {item.confidence !== undefined && (
              <p className="ao-import__hint">
                Confidence {Math.round(item.confidence * 100)}%{item.method ? `, from ${item.method}` : ""}
              </p>
            )}
            {item.hints && item.hints.length > 0 && (
              <p className="ao-import__hint">
                Found in the file but not confirmed:{" "}
                {item.hints.map((h, i) => (
                  <span key={`${i}:${h}`}>
                    {i > 0 ? ", " : ""}
                    <UserText>{h}</UserText>
                  </span>
                ))}
              </p>
            )}
            {item.duplicateOf && (
              <>
                <p>
                  May duplicate a source you already have: <UserText>{item.duplicateOf.reason}</UserText>
                </p>
                <button type="button" disabled={busy} onClick={() => onDecide({ action: "merge", sourceId: item.duplicateOf!.sourceId }, "Merged")}>
                  Merge into the likely duplicate
                </button>
              </>
            )}
          </Section>
        </Section>

        <Section title="Candidate matches" level={2} className="ao-review__candidates">
          {!item.candidates?.length && <p className="ao-import__hint">No candidate matches were found.</p>}
          {item.candidates && item.candidates.length > 0 && (
            <ol className="ao-review__candidate-list">
              {item.candidates.map((c, i) => (
                <CandidateRow key={i} c={c} busy={busy} onUse={() => onDecide({ action: "accept-candidate", index: i }, "Accepted the match")} />
              ))}
            </ol>
          )}
        </Section>
      </div>

      <div className="ao-import__actions" role="group" aria-label="Decide this item">
        <button type="button" className="ao-import__primary" disabled={busy || !source} onClick={() => onDecide({ action: "accept" }, "Accepted")}>
          Accept
        </button>
        <button type="button" disabled={busy || !source} aria-expanded={mode === "edit"} onClick={() => setMode(mode === "edit" ? "view" : "edit")}>
          Edit
        </button>
        <button type="button" disabled={busy} aria-expanded={mode === "merge"} onClick={() => setMode(mode === "merge" ? "view" : "merge")}>
          Merge
        </button>
        <button type="button" disabled={busy} onClick={() => onDecide({ action: "skip" }, "Skipped")}>
          Skip
        </button>
        <button type="button" disabled={busy} onClick={() => onDecide({ action: "keep-both" }, "Kept both")}>
          Keep both
        </button>
      </div>

      {mode === "edit" && source && <EditForm source={source} busy={busy} onCancel={() => setMode("view")} onSave={(d) => onDecide(d, "Saved and accepted")} />}
      {mode === "merge" && <MergeForm api={api} projectId={projectId} item={item} busy={busy} onMerge={(sid) => onDecide({ action: "merge", sourceId: sid }, "Merged")} />}
    </div>
  );
}

function CandidateRow({ c, busy, onUse }: { c: Candidate; busy: boolean; onUse(): void }) {
  const ids = [c.identifiers?.doi ? `DOI ${c.identifiers.doi}` : "", ...(c.identifiers?.isbn ?? []).map((i) => `ISBN ${i}`), c.identifiers?.issn ? `ISSN ${c.identifiers.issn}` : ""].filter(Boolean);
  return (
    <li className="ao-review__candidate">
      <UserText as="p" className="ao-review__title">
        {c.title}
      </UserText>
      <p className="ao-import__hint">
        {[c.creators.length ? creatorsText(c.creators) : "", c.issued ?? "", c.container ?? c.publisher ?? "", typeLabel(c.type)].filter(Boolean).map((x, i) => (
          <span key={i}>
            {i > 0 ? " · " : ""}
            <UserText>{x}</UserText>
          </span>
        ))}
      </p>
      {ids.length > 0 && <p className="ao-import__hint">{ids.join(" · ")}</p>}
      <p className="ao-import__hint">From {c.provider}</p>
      <button type="button" disabled={busy} onClick={onUse}>
        Use this match<span className="ao-visually-hidden">: {c.title}</span>
      </button>
    </li>
  );
}

function EditForm({ source, busy, onCancel, onSave }: { source: SourceFile; busy: boolean; onCancel(): void; onSave(d: ReviewDecision): void }) {
  const s = source.source;
  const variants = s.title.variants;
  const at = Math.max(0, variants.findIndex((v) => v.kind === "original"));
  const [title, setTitle] = useState(variants[at]?.value ?? "");
  const [type, setType] = useState(s.type);
  const save = () => {
    const next = variants.length ? variants.map((v, i) => (i === at ? { ...v, value: title } : v)) : [{ lang: "und", kind: "original" as const, value: title }];
    onSave({ action: "accept", draft: { type, title: { variants: next } } });
  };
  return (
    <form
      className="ao-review__form"
      aria-label="Edit before accepting"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label className="ao-import__field ao-import__field--wide">
        <span>Title</span>
        <input type="text" dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="ao-import__field">
        <span>Type</span>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {SOURCE_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <div className="ao-import__actions">
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="ao-import__primary" disabled={busy || !title.trim()}>
          Save and accept
        </button>
      </div>
    </form>
  );
}

function MergeForm({ api, projectId, item, busy, onMerge }: { api: ReturnType<typeof importApi>; projectId: string; item: ReviewItem; busy: boolean; onMerge(sourceId: string): void }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<SourceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  /** Only the answer to the latest search is shown, whatever order the answers arrive in. */
  const search = async () => {
    const n = ++latest.current;
    setError(null);
    try {
      const found = (await api.searchSources(projectId, text.trim())).filter((r) => r.id !== item.sourceId);
      if (n === latest.current) setResults(found);
    } catch (e) {
      if (n === latest.current) setError(errorText(e));
    }
  };
  return (
    <div className="ao-review__form">
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label className="ao-import__field ao-import__field--wide">
          <span>Find the source to merge into</span>
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button type="submit" disabled={!text.trim()}>
          Search
        </button>
      </form>
      <ErrorNote error={error} />
      {results && results.length === 0 && <p>No sources match.</p>}
      {results && results.length > 0 && (
        <ul className="ao-review__plain-list">
          {results.map((r) => (
            <li key={r.id}>
              <button type="button" disabled={busy} onClick={() => onMerge(r.id)}>
                Merge into <UserText>{r.title}</UserText>
              </button>
              <span className="ao-import__hint"> ({typeLabel(r.type)})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
