/**
 * The Library screen's Zotero lines (Task Z12): under the shown project's header, one line per Zotero library linked to
 * THAT project, in the service's own words. Nothing is composed here about how a sync went: the line of a link is the
 * state's `status` exactly; a run going now reads as the Zotero screen says it; a paused link or a locked project adds
 * the same sentence the Zotero screen shows. No tick, no colour that carries the news: only words, so a failure never
 * reads as success. With no link, nothing at all is drawn (no heading, no empty region). It is ordinary text in the
 * page's reading order, not an announcement.
 *
 * Reads: the state is read when a project is shown and again after a `zotero.sync` event that says "finished" (the
 * screen counts them; a burst is one render, and a read asked for while one is out makes exactly one more after it).
 * Each read draws a number when it STARTS and an answer older than one already shown is dropped, as is an answer for a
 * project (or a closed library) left meanwhile. No polling, no timer. A state that cannot be read leaves the lines as
 * they were, except right after a finished sync (R299 e): then the lines are taken away, since a line from before the
 * run could read as if the run that just ended had succeeded (nothing is better than an older success). This part of
 * the screen never fails and never shows an error. The key is never involved: nothing here
 * checks it or starts a sync.
 */
import { ZOTERO_SYNC_REASON_TEXT, type ZoteroSyncStateResponse } from "@ao/shared";
import { useEffect, useRef, useState } from "react";
import type { LibraryApi } from "../api/library";
import { UserText } from "../components/UserText";
import "./LibraryZotero.css";
import { LOCKED_TEXT, PAUSED_UNKNOWN_TEXT, ZoteroProgressText, hasUnknownPause, labelOfRef } from "./zoteroWords";

type Link = ZoteroSyncStateResponse["links"][number];
/** What the `zotero.sync` events said, accumulated by the Library screen: how many "finished", and the run going now. */
export interface ZoteroEvents {
  n: number;
  finished: number;
  run?: { ref: string; done: number; total: number };
}

/** The sentences for a link that waits, in the Zotero screen's order and words. */
function waitingNotes(link: Link): string[] {
  const notes: string[] = [];
  if (link.paused === "undone") notes.push(ZOTERO_SYNC_REASON_TEXT["sync-undone"]);
  if (link.paused === "key-refused") notes.push(ZOTERO_SYNC_REASON_TEXT["key-refused"]);
  if (link.paused === "library-gone") notes.push(ZOTERO_SYNC_REASON_TEXT["library-gone"]);
  if (hasUnknownPause(link)) notes.push(PAUSED_UNKNOWN_TEXT);
  if (link.waitingFor === "project-locked") notes.push(LOCKED_TEXT);
  return notes;
}

interface Props {
  api: LibraryApi;
  /** The shown project; with none (or no library open) nothing is requested. */
  projectId: string | undefined;
  /** False once the library has closed: nothing more is requested. */
  open: boolean;
  events: ZoteroEvents;
}

export function LibraryZotero({ api, projectId, open, events }: Props) {
  const [shown, setShown] = useState<{ projectId: string; links: Link[]; running?: ZoteroSyncStateResponse["running"] } | undefined>();
  const [run, setRun] = useState<ZoteroEvents["run"]>();
  const alive = useRef(true);
  /** Which project (and whether open) the reads belong to; moved on by a change of either and by unmount. */
  const gen = useRef(0);
  const out = useRef(false);
  const pending = useRef(false);
  const started = useRef(0);
  const applied = useRef(0);
  const eventCount = useRef(0);
  const latest = useRef({ api, projectId, open });
  latest.current = { api, projectId, open };
  /** `afterFinished`: this read follows a finished sync (R299 e: if it fails, the lines go). */
  const startRead = useRef<(afterFinished?: boolean) => void>(() => undefined);

  startRead.current = (afterFinished = false) => {
    const { api: a, projectId: pid, open: isOpen } = latest.current;
    if (!pid || !isOpen || !alive.current) return;
    const mine = gen.current;
    const seq = ++started.current;
    const eventsThen = eventCount.current;
    out.current = true;
    const done = () => {
      if (mine !== gen.current) return;
      out.current = false;
      if (pending.current) {
        pending.current = false;
        startRead.current(true); // asked for by a finished event
      }
    };
    /** A read that failed: right after a finished sync the lines are taken away; at any other time they stay as they were. */
    const failed = () => {
      if (!afterFinished || !alive.current || mine !== gen.current || seq < applied.current) return;
      applied.current = seq;
      setShown(undefined);
    };
    a.zotero
      .state()
      .then((s) => {
        if (!alive.current || mine !== gen.current || seq < applied.current) return;
        if (!s || !Array.isArray(s.links)) return failed();
        applied.current = seq;
        setShown({ projectId: pid, links: s.links.filter((l) => l.projectId === pid), ...(s.running ? { running: s.running } : {}) });
        // The run in progress comes from the events once one has arrived after this request started.
        if (eventCount.current === eventsThen) setRun(s.running ? { ref: s.running.ref, done: s.running.done, total: s.running.total } : undefined);
      })
      .catch(failed)
      .finally(done);
  };

  useEffect(
    () => () => {
      alive.current = false;
      gen.current++;
    },
    [],
  );

  // A project shown (or left, or the library closed): the reads of the one before are dropped, and one is made for this.
  useEffect(() => {
    gen.current++;
    out.current = false;
    pending.current = false;
    setShown((s) => (s && s.projectId === projectId && open ? s : undefined));
    startRead.current();
  }, [projectId, open]);

  // The events: the run going, and a read after each finished one (one at a time, one more if asked meanwhile).
  const seenFinished = useRef(events.finished);
  const seenEvents = useRef(events.n);
  useEffect(() => {
    if (events.n === seenEvents.current) return;
    seenEvents.current = events.n;
    eventCount.current++;
    setRun(events.run);
    if (events.finished !== seenFinished.current) {
      seenFinished.current = events.finished;
      if (out.current) pending.current = true;
      else startRead.current(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.n]);

  if (!open || !projectId || shown?.projectId !== projectId || shown.links.length === 0) return null;
  return (
    <div className="ao-library__zotero" data-testid="zotero-lines" role="group" aria-label="Zotero sync of this project">
      {shown.links.map((link) => {
        const label = labelOfRef(link.ref, undefined);
        const going = run?.ref === link.ref ? run : undefined;
        return (
          <p key={link.ref}>
            {going ? (
              <ZoteroProgressText label={label} done={going.done} total={going.total} unknown="the number of items is not known yet." />
            ) : (
              <>
                <UserText>{label}</UserText>: <UserText>{link.status}</UserText>
              </>
            )}
            {waitingNotes(link).map((n) => (
              <span key={n}>
                {" "}
                <UserText>{n}</UserText>
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}
