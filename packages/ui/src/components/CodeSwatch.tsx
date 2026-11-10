/**
 * A qualitative code as shown everywhere in the UI (Tasks 34/35): its colour, its shape and its
 * name, so a code is never identified by colour alone (R103). Code n (1-based) uses --code-n and
 * CODE_GLYPHS[n - 1], cycling after 12; a colour the user assigned to the code replaces the token.
 */
import { CODE_PALETTE_SIZE } from "../theme/themes";
import { CODE_GLYPHS } from "./codeGlyphs";
import { UserText } from "./UserText";
import "./CodeSwatch.css";

export interface CodeSwatchProps {
  /** 1-based position of the code in its codebook. */
  index: number;
  /** The code's name (user text, shown with dir="auto"). */
  name: string;
  /** A custom colour the user assigned to this code, if any. */
  color?: string;
}

export function CodeSwatch({ index, name, color }: CodeSwatchProps) {
  if (!Number.isInteger(index) || index < 1) throw new Error(`CodeSwatch index must be a whole number from 1 (got ${index})`);
  const slot = ((index - 1) % CODE_PALETTE_SIZE) + 1;
  const glyph = CODE_GLYPHS[slot - 1]!;
  return (
    <span className="ao-code-swatch" data-testid="code-swatch">
      <svg className="ao-code-swatch__glyph" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false">
        <path d={glyph.d} fill={color ?? `var(--code-${slot})`} fillRule="evenodd" />
      </svg>
      <span className="ao-visually-hidden">{glyph.name}: </span>
      <UserText>{name}</UserText>
    </span>
  );
}
