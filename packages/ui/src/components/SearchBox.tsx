/**
 * A search field that reports what was typed once typing pauses (250 ms by default), so the service
 * is asked once per pause rather than once per key. Escape clears it at once.
 */
import { useEffect, useId, useRef, useState } from "react";
import "./library.css";

export const SEARCH_DEBOUNCE_MS = 250;

export interface SearchBoxProps {
  label: string;
  onSearch: (text: string) => void;
  delayMs?: number;
  placeholder?: string;
}

export function SearchBox({ label, onSearch, delayMs = SEARCH_DEBOUNCE_MS, placeholder }: SearchBoxProps) {
  const [value, setValue] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(onSearch);
  latest.current = onSearch;
  const id = useId();

  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (v: string) => {
    setValue(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => latest.current(v.trim()), delayMs);
  };

  return (
    <div className="ao-search" role="search">
      <label htmlFor={id} className="ao-visually-hidden">
        {label}
      </label>
      <input
        id={id}
        type="search"
        dir="auto"
        value={value}
        placeholder={placeholder ?? label}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            clearTimeout(timer.current);
            setValue("");
            latest.current("");
          }
        }}
      />
    </div>
  );
}
