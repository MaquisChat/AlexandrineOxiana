/**
 * Copy a citation (spec 8.1): pick a style (searching GET /styles), a format, and copy. The
 * citation is always the string the service renders (participant codes, withheld sources and
 * custom-style sandboxing are applied there, R88/R90); it is copied with navigator.clipboard and
 * shown as text — HTML and RTF output are never rendered as markup.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ApiClientError } from "../api/client";
import type { CitationFormat, LibraryApi, StyleEntry } from "../api/library";
import { SEARCH_DEBOUNCE_MS } from "./SearchBox";
import { UserText } from "./UserText";
import "./library.css";

export const DEFAULT_STYLE: StyleEntry = { id: "apa", title: "American Psychological Association 7th edition" };

export interface CitePanelProps {
  api: Pick<LibraryApi, "citations">;
  projectId: string;
  sourceIds: string[];
  initialStyle?: StyleEntry;
}

const message = (err: unknown) => (err instanceof ApiClientError ? err.message : "The citation could not be made.");

export function CitePanel({ api, projectId, sourceIds, initialStyle = DEFAULT_STYLE }: CitePanelProps) {
  const [style, setStyle] = useState<StyleEntry>(initialStyle);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<StyleEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [format, setFormat] = useState<CitationFormat>("text");
  const [result, setResult] = useState<{ text: string; copied: boolean } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchSeq = useRef(0);
  const id = useId();
  const listId = `${id}-styles`;

  useEffect(() => () => clearTimeout(timer.current), []);

  const search = (q: string) => {
    setQuery(q);
    setOpen(true);
    setActive(-1);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const seq = ++searchSeq.current;
      api.citations
        .styles(q.trim())
        .then((list) => {
          if (seq === searchSeq.current) setOptions(list.slice(0, 50));
        })
        .catch((err: unknown) => {
          if (seq === searchSeq.current) setError(message(err));
        });
    }, SEARCH_DEBOUNCE_MS);
  };

  const choose = (s: StyleEntry) => {
    setStyle(s);
    setQuery("");
    setOpen(false);
    setActive(-1);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(options.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" && open && options[active]) {
      e.preventDefault();
      choose(options[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      setQuery("");
    }
  };

  const copy = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const text = await api.citations.cite({ projectId, sourceIds, style: style.id, format });
      let copied = false;
      try {
        if (!navigator.clipboard) throw new Error("no clipboard");
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        setError("Copying is not available here. Select the citation below and copy it.");
      }
      setResult({ text, copied });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Cite" className="ao-cite">
      <h3 className="ao-pane-subtitle">Cite</h3>
      <div className="ao-cite__field">
        <label htmlFor={`${id}-style`}>Citation style</label>
        <input
          id={`${id}-style`}
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
          value={query}
          onChange={(e) => search(e.target.value)}
          onKeyDown={onKey}
          placeholder="Search styles"
          aria-describedby={`${id}-current`}
        />
        <p id={`${id}-current`} className="ao-muted ao-small-text">
          Using: <UserText>{style.title}</UserText>
        </p>
        {open && options.length > 0 && (
          <ul id={listId} role="listbox" aria-label="Citation styles" className="ao-listbox">
            {options.map((s, i) => (
              <li
                key={s.id}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "ao-listbox__option ao-listbox__option--active" : "ao-listbox__option"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(s)}
              >
                <UserText>{s.title}</UserText>
                {s.custom && <span className="ao-badge">Custom</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="ao-cite__field">
        <label htmlFor={`${id}-format`}>Format</label>
        <select id={`${id}-format`} value={format} onChange={(e) => setFormat(e.target.value as CitationFormat)}>
          <option value="text">Plain text</option>
          <option value="html">HTML</option>
          <option value="rtf">RTF</option>
        </select>
      </div>
      <button type="button" onClick={() => void copy()} disabled={busy || sourceIds.length === 0}>
        Copy citation
      </button>
      {error && (
        <p role="alert" className="ao-error">
          {error}
        </p>
      )}
      <div aria-live="polite">
        {result?.copied && <p className="ao-ok">Copied.</p>}
        {result && (
          <UserText as="p" className="ao-citation">
            {result.text}
          </UserText>
        )}
      </div>
    </section>
  );
}
