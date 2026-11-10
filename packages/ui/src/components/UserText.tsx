/**
 * Text the user typed or that came from a source (titles, captions, transcripts, notes). Always
 * rendered with `dir="auto"` so right-to-left text (Arabic, Hebrew, ...) is laid out correctly
 * whatever the interface direction (spec 8A.2). Use this for every such string.
 */
import type { CSSProperties, ReactNode } from "react";

export interface UserTextProps {
  children: ReactNode;
  as?: "span" | "p" | "div" | "blockquote" | "h1" | "h2" | "h3" | "td" | "li";
  /** BCP 47 language of the text, when known. */
  lang?: string;
  className?: string;
  style?: CSSProperties;
  "data-testid"?: string;
}

export function UserText({ children, as: Tag = "span", lang, className, style, "data-testid": testId }: UserTextProps) {
  return (
    <Tag dir="auto" lang={lang} className={className} style={style} data-testid={testId}>
      {children}
    </Tag>
  );
}
