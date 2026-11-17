/**
 * Choose a library (spec 4.5 "Multiple libraries"): the registered libraries with where each was
 * last seen, opened at its last known place; one that is not there goes to "Library not found".
 * A library can also be opened, or created, at a typed folder; inside the desktop shell a native
 * folder picker fills that field too (PathField). A chosen folder is only put in the field:
 * it reaches the service when Open or Create is used, and the service decides.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiClientError } from "../api/client";
import { errorText, type CurrentLibrary, type LibraryApi, type LibraryEntry, type LibraryState } from "../api/library";
import { formatSize } from "../api/tools";
import { PathField } from "../components/PathField";
import { DeviceNoticeBanners, useNoticeDismiss } from "../components/StatusBanner";
import { UserText } from "../components/UserText";
import { navigate, PATHS } from "../navigation";
import "../components/library.css";

export interface LibraryChooserProps {
  api: Pick<LibraryApi, "libraries">;
  onOpened: (current: CurrentLibrary) => void;
  onNotFound: (library: LibraryEntry) => void;
}

const message = (err: unknown, fallback: string) => errorText(err, fallback);
const isAbsolute = (p: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
/** R447 b: the room is asked for this long after the box last changed. */
const ROOM_PAUSE_MS = 300;
/** R447 b: under this many free bytes the line adds that it is little room. */
const LITTLE_ROOM = 10e9;
const roomText = (bytes: number) =>
  `Free space on that disk: ${formatSize(bytes)}.${bytes < LITTLE_ROOM ? " That is little room: an import copies its files into the library." : ""}`;

export function LibraryChooser({ api, onOpened, onNotFound }: LibraryChooserProps) {
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
  const [room, setRoom] = useState<{ path: string; bytes: number } | undefined>();
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
    setRoom(undefined);
    if (!isAbsolute(p)) return;
    const timer = setTimeout(() => {
      api.libraries
        .folderRoom(p)
        .then((r) => {
          // An answer for a path the box no longer holds is dropped; no number, nothing said (never a guess).
          if (roomAsk.current === ask && typeof r.freeBytes === "number" && Number.isFinite(r.freeBytes) && r.freeBytes >= 0) setRoom({ path: p, bytes: r.freeBytes });
        })
        .catch(() => {});
    }, ROOM_PAUSE_MS);
    return () => {
      clearTimeout(timer);
      roomAsk.current++;
    };
  }, [api, path]);

  useEffect(() => {
    let live = true;
    api.libraries
      .list()
      .then((r) => {
        if (!live) return;
        setLibraries(r.libraries);
        setNotices(r.notices ?? []);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setLibraries([]);
        setError(message(err, "The list of libraries could not be read."));
      });
    return () => {
      live = false;
    };
  }, [api]);

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
      {libraries === undefined ? (
        <p aria-live="polite">Loading libraries…</p>
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
        <p role="status">{room && room.path === path.trim() ? roomText(room.bytes) : ""}</p>
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
