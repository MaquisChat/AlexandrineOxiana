/**
 * A qualitative code as shown everywhere in the UI (Tasks 34/35): its colour, its shape and its
 * name, so a code is never identified by colour alone (R103). Code n (1-based) uses --code-n and
 * CODE_GLYPHS[n - 1]; from 13 on the colours and shapes repeat and a number badge tells the codes
 * apart. A colour the user assigned to the code (#rrggbb) replaces the token.
 *
 * Never throws (R105): an index that is not a whole number from 1 shows a neutral swatch with the
 * name. Takes no style: colours come from tokens (or the user's own colour, validated).
 */
import type { CSSProperties } from "react";
import { CODE_PALETTE_SIZE } from "../theme/themes";
import { CODE_GLYPHS } from "./codeGlyphs";
import { UserText } from "./UserText";
import "./CodeSwatch.css";

export interface CodeSwatchProps {
  /** 1-based position of the code in its codebook. */
  index: number;
  /** The code's name (user text, shown with dir="auto"). */
  name: string;
  /** A custom colour the user assigned to this code, `#rrggbb`; anything else is ignored. */
  color?: string;
}

const NEUTRAL_GLYPH = "M3 3H13V13H3ZM5 5V11H11V5Z";

export function CodeSwatch({ index, name, color }: CodeSwatchProps) {
  const valid = Number.isSafeInteger(index) && index >= 1;
  const slot = valid ? ((index - 1) % CODE_PALETTE_SIZE) + 1 : 0;
  const glyph = valid ? CODE_GLYPHS[slot - 1]! : { name: "unassigned", d: NEUTRAL_GLYPH };
  const custom = typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined;
  const fill = valid ? (custom ?? `var(--code-${slot})`) : "var(--muted)";
  return (
    <span className="ao-code-swatch" data-testid="code-swatch">
      {/* The colour reaches the glyph through a custom property (CodeSwatch.css), never a paint attribute. */}
      <svg className="ao-code-swatch__glyph" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false" style={{ "--ao-swatch-fill": fill } as CSSProperties}>
        <path d={glyph.d} fillRule="evenodd" />
      </svg>
      {valid && index > CODE_PALETTE_SIZE && (
        <span className="ao-code-swatch__badge" data-testid="code-badge" aria-hidden="true">
          {index}
        </span>
      )}
      <span className="ao-visually-hidden">
        {glyph.name}
        {valid && index > CODE_PALETTE_SIZE ? ` ${index}` : ""}:{" "}
      </span>
      <UserText>{name}</UserText>
    </span>
  );
}
