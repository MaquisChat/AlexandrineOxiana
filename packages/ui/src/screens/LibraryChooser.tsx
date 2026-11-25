/**
 * Choose a library (spec 4.5 "Multiple libraries"): the registered libraries with where each was
 * last seen, opened at its last known place; one that is not there goes to "Library not found".
 * A library can also be opened, or created, at a typed folder; inside the desktop shell a native
 * folder picker fills that field too (PathField). A chosen folder is only put in the field:
 * it reaches the service when Open or Create is used, and the service decides.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { ApiClientError } from "../api/client";
import { FIRST_READ_TIMEOUT_MS, isUnreachable, readWithin } from "../api/firstRead";
import { errorText, type CurrentLibrary, type LibraryApi, type LibraryEntry, type LibraryState } from "../api/library";
import { PathField } from "../components/PathField";
import { DeviceNoticeBanners, useNoticeDismiss } from "../components/StatusBanner";
import { UserText } from "../components/UserText";
import { navigate, PATHS } from "../navigation";
import { dismissLostCreate, useLostCreates, type LostCreate } from "./lostCreates";
import "../components/library.css";

export interface LibraryChooserProps {
  api: Pick<LibraryApi, "libraries">;
  onOpened: (current: CurrentLibrary) => void;
  onNotFound: (library: LibraryEntry) => void;
  /**
   * FR-756 I3 (R602): how long the read of the list of libraries is waited for before it is given up as a read that got
   * no answer (FIRST_READ_TIMEOUT_MS; smaller in tests).
   */
  firstReadMs?: number;
}

const message = (err: unknown, fallback: string) => errorText(err, fallback);
const isAbsolute = (p: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
/** R449 e: the room is asked for this long after the box last changed. */
const ROOM_PAUSE_MS = 600;
/** R450 a: the line is emptied when a newer answer has not come this long after it was asked. */
const ROOM_ANSWER_LIMIT_MS = 4000;
/** R450 b: a path that got no figure is asked again after each of these waits, then no more. */
const ROOM_RETRY_MS = [2000, 4000, 8000];
/** R447 b: under this many free bytes the line adds that it is little room. */
const LITTLE_ROOM = 10e9;
/** `n` rounded DOWN to one decimal, without a trailing ".0". */
const downToTenth = (n: number) => String(Math.floor(n * 10) / 10);
/**
 * A disk's free room in words, never larger than it is (R449 d): rounded down — from 1,000 GB in TB with one decimal,
 * from 10 GB in whole GB, from 1 GB in GB with one decimal, from 1 MB in whole MB, below that "less than 1 MB" — so the
 * figure and the little-room sentence (under 10 GB) can never contradict each other. Only this line; `formatSize`
 * keeps its own rounding for the rest of the app.
 */
const roomFigure = (bytes: number): string => {
  if (bytes >= 1e12) return `${downToTenth(bytes / 1e12)} TB`;
  if (bytes >= 10e9) return `${Math.floor(bytes / 1e9)} GB`;
  if (bytes >= 1e9) return `${downToTenth(bytes / 1e9)} GB`;
  if (bytes >= 1e6) return `${Math.floor(bytes / 1e6)} MB`;
  return "less than 1 MB";
};
export const roomSentence = (bytes: number) =>
  `Free space on that disk: ${roomFigure(bytes)}.${bytes < LITTLE_ROOM ? " That is little room: an import copies its files into the library." : ""}`;

/**
 * FR-194 (R461 b): one notice per project whose creation could not be told made or not when its library closed. Only
 * the names are isolated (UserText, dir=auto), so a right-to-left name does not turn the sentence (as FR-158). Each is a
 * polite status, read once; focus is not moved to it. "Got it" removes it and moves focus to the next notice's
 * "Got it", or to the page's heading when none is left.
 */
function LostCreateNotices({ heading }: { heading: RefObject<HTMLHeadingElement | null> }) {
  const lost = useLostCreates();
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  if (!lost.length) return null;
  const gotIt = (x: LostCreate, i: number) => {
    const next = lost[i + 1] ?? lost[i - 1];
    dismissLostCreate(x.key);
    setTimeout(() => {
      const button = next ? box.current?.querySelector<HTMLButtonElement>(`[data-lost="${CSS.escape(next.key)}"]`) : null;
      (button ?? heading.current)?.focus();
    });
  };
  return (
    <div className="ao-library__banners" ref={box}>
      {lost.map((x, i) => (
        <div key={x.key} role="status" className="ao-banner ao-banner--warn">
          <span id={`${id}-${i}`}>
            When “<UserText>{x.project}</UserText>” was being created in “<UserText>{x.library}</UserText>”, the app could not tell whether it was made. When you open that library again, look for “
            <UserText>{x.project}</UserText>” in its list of projects before creating it again.
          </span>{" "}
          <button type="button" className="ao-small" data-lost={x.key} aria-describedby={`${id}-${i}`} onClick={() => gotIt(x, i)}>
            Got it
          </button>
        </div>
      ))}
    </div>
  );
}

export function LibraryChooser({ api, onOpened, onNotFound, firstReadMs = FIRST_READ_TIMEOUT_MS }: LibraryChooserProps) {
  const [libraries, setLibraries] = useState<LibraryEntry[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  // This computer's own notices (Task 68 fix round 1, M1): seen here too, with the same "Got it".
  const [notices, setNotices] = useState<LibraryState["notices"]>([]);
  const heading = useRef<HTMLHeadingElement>(null);
  const [noticeGone, setNoticeGone] = useState(0);
  useEffect(() => {
    if (noticeGone > 0) heading.current?.focus();
  }, [noticeGone]);
  const notice = useNoticeDismiss(
    (kind) => api.libraries.dismissNotice(kind),
    (kind) => {
      setNotices((list) => (list ?? []).filter((n) => n.kind !== kind));
      setNoticeGone((n) => n + 1);
    },
  );
  const id = useId();
  // R447: a folder the service offers for a new library (never put in the box by itself), and the free room on the
  // disk under the folder in the box, for the path it was asked for.
  const [suggested, setSuggested] = useState<string | undefined>();
  // The room's line, as words (R449 e): kept while a newer answer is awaited, so it changes only when they change.
  const [roomWords, setRoomWords] = useState("");
  const roomAsk = useRef(0);

  useEffect(() => {
    let live = true;
    api.libraries
      .suggestedFolder()
      .then((r) => {
        if (live && typeof r.folder === "string" && r.folder) setSuggested(r.folder);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    const p = path.trim();
    const ask = ++roomAsk.current;
    // Emptied at once only when the box no longer holds a full path; otherwise the last words stay until the answer.
    if (!isAbsolute(p)) {
      setRoomWords("");
      return;
    }
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
      return t;
    };
    const askRoom = (attempt: number) => {
      // Not answered in time: the old figure is no longer vouched for. A late answer is still shown below.
      const limit = later(() => {
        if (roomAsk.current === ask) setRoomWords("");
      }, ROOM_ANSWER_LIMIT_MS);
      const noFigure = () => {
        const wait = ROOM_RETRY_MS[attempt];
        if (wait !== undefined) later(() => askRoom(attempt + 1), wait);
      };
      api.libraries
        .folderRoom(p)
        .then((r) => {
          clearTimeout(limit);
          timers.delete(limit);
          // An answer for a path the box no longer holds is dropped; no number, nothing said (never a guess).
          if (roomAsk.current !== ask) return;
          if (typeof r.freeBytes === "number" && Number.isFinite(r.freeBytes) && r.freeBytes >= 0) {
            setRoomWords(roomSentence(r.freeBytes));
          } else {
            setRoomWords("");
            noFigure();
          }
        })
        .catch(() => {
          clearTimeout(limit);
          timers.delete(limit);
          if (roomAsk.current !== ask) return;
          setRoomWords("");
          noFigure();
        });
    };
    later(() => askRoom(0), ROOM_PAUSE_MS);
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      roomAsk.current++;
    };
  }, [api, path]);

  // FR-756 I3 (R602): the list has the time limit. A read that got no answer (none at all, or none in time) says its own
  // sentence with "Try again" (`listTry` moves it on); one refused with an answer says so as before.
  const [listNoAnswer, setListNoAnswer] = useState<string | undefined>();
  /** FR-756's remainder (R609 N2): the list's last read was refused with an answer (it says so; the list is not known). */
  const [listRefused, setListRefused] = useState(false);
  const [listTry, setListTry] = useState(0);
  const triedList = useRef(false);
  useEffect(() => {
    const ac = new AbortController();
    readWithin((signal) => api.libraries.list({ signal }), firstReadMs, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        setListNoAnswer(undefined);
        setListRefused(false);
        setLibraries(r.libraries);
        setNotices(r.notices ?? []);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        // R609 N2: a list not read (given up, failed or refused) is never shown as an empty one ("No libraries yet"): the
        // list stays as it was (unread, or as last read).
        if (isUnreachable(err)) {
          setListNoAnswer((err as ApiClientError).message);
          return;
        }
        setListNoAnswer(undefined);
        setListRefused(true);
        setError(message(err, "The list of libraries could not be read."));
      });
    return () => ac.abort();
  }, [api, firstReadMs, listTry]);
  // The "Try again" pressed has gone (the list was read): focus goes to the heading, never the page.
  useEffect(() => {
    if (listNoAnswer || !triedList.current) return;
    triedList.current = false;
    const now = document.activeElement;
    if (!now || now === document.body || !now.isConnected) heading.current?.focus();
  }, [listNoAnswer]);

  const open = async (entry: LibraryEntry) => {
    const at = entry.lastKnownPaths[0];
    if (!at) return onNotFound(entry);
    setBusy(true);
    setError(undefined);
    try {
      onOpened(await api.libraries.open(at));
    } catch (err) {
      if (err instanceof ApiClientError && (err.code === "NOT_FOUND" || err.code === "LIBRARY_OFFLINE" || err.code === "VALIDATION")) onNotFound(entry);
      else setError(message(err, "The library could not be opened."));
    } finally {
      setBusy(false);
    }
  };

  const openTyped = async (e: FormEvent, create: boolean) => {
    e.preventDefault();
    const p = path.trim();
    if (!isAbsolute(p)) return setError("Give the library folder's full path, for example /Users/you/Research library or D:\\Research library.");
    if (create && !name.trim()) return setError("Give the new library a name.");
    setBusy(true);
    setError(undefined);
    try {
      onOpened(create ? await api.libraries.create(p, name.trim()) : await api.libraries.open(p));
    } catch (err) {
      setError(message(err, create ? "The library could not be created." : "The library could not be opened."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="ao-page">
      <h1 ref={heading} tabIndex={-1}>
        Choose a library
      </h1>
      <DeviceNoticeBanners notices={notices} onDismiss={notice.onDismiss} error={notice.error} />
      <LostCreateNotices heading={heading} />
      {libraries === undefined ? (
        !listNoAnswer && !listRefused && <p aria-live="polite">Loading libraries…</p>
      ) : libraries.length === 0 ? (
        <p>No libraries yet. Open a library folder, or create a new library below.</p>
      ) : (
        <ul aria-label="Libraries" className="ao-plain-list">
          {libraries.map((l) => (
            <li key={l.libraryId} className="ao-card">
              <UserText as="h2" className="ao-pane-title">
                {l.name}
              </UserText>
              {l.lastKnownPaths[0] && (
                <p className="ao-path">
                  <UserText>{l.lastKnownPaths[0]}</UserText>
                </p>
              )}
              <button type="button" disabled={busy} aria-label={`Open ${l.name}`} onClick={() => void open(l)}>
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
      {listNoAnswer && (
        <>
          <p role="alert" className="ao-error">
            {listNoAnswer}
          </p>
          <p>
            <button
              type="button"
              onClick={() => {
                triedList.current = true;
                setListTry((n) => n + 1);
              }}
            >
              Try again
            </button>
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="ao-error">
          {error}
        </p>
      )}
      <h2 className="ao-pane-title">Another library</h2>
      <form className="ao-inline-form" onSubmit={(e) => void openTyped(e, false)}>
        <PathField
          id={`${id}-path`}
          label="Library folder"
          pick="folder"
          pickerTitle="Choose the library folder"
          value={path}
          disabled={busy}
          onChange={(p) => {
            setPath(p);
            setError(undefined);
          }}
          inputProps={{ dir: "auto" }}
        />
        <button type="submit" disabled={busy}>
          Open library
        </button>
      </form>
      <div className="ao-library-place">
        {suggested && (
          <p>
            {/* R448: the button is named by its own words; this line is its description. */}
            <span id={`${id}-suggested`}>
              Suggested: <UserText className="ao-path">{suggested}</UserText>
            </span>{" "}
            <button
              type="button"
              aria-describedby={`${id}-suggested`}
              disabled={busy}
              onClick={() => {
                setPath(suggested);
                setError(undefined);
              }}
            >
              Use this folder
            </button>
          </p>
        )}
        <p role="status" className="ao-library-room">{roomWords}</p>
      </div>
      <form className="ao-inline-form" onSubmit={(e) => void openTyped(e, true)}>
        <label htmlFor={`${id}-name`}>New library name</label>
        <input id={`${id}-name`} dir="auto" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={busy}>
          Create a new library in that folder
        </button>
      </form>
      <p>
        <a
          href={PATHS.about}
          onClick={(e) => {
            e.preventDefault();
            navigate(PATHS.about);
          }}
        >
          About and third-party notices
        </a>
      </p>
    </main>
  );
}
