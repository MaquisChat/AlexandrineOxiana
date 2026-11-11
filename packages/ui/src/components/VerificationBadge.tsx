/**
 * One metadata field's verification (Task 34d; statuses from packages/core/src/verify, R37–R40):
 * the badge says the status in words with its own glyph and outline, never by colour alone, and
 * its accessible name gives the field and the status ("Date: Conflict"). Pressing it (mouse or
 * keyboard) opens FieldEvidencePopover with the evidence and Confirm.
 *
 * What each status means (packages/core/src/verify/checks.ts):
 * - verified: independent sources agree, or the value was found in the document or platform data;
 * - single source: one trusted source gives it and nothing contradicts it;
 * - unverified: missing, only from the file name or an unsupported AI suggestion, or it differs
 *   slightly from what a source says;
 * - conflict: a trusted source or an integrity check (ISBN checksum, DOI) disagrees with it;
 * - confirmed by you: the researcher's own confirmation of exactly this value (a later change, or
 *   a failed integrity check, takes it away). Accepting a review item does not set it (R137).
 */
import type { FieldReview } from "@ao/shared";
import { useRef, useState } from "react";
import { FieldEvidencePopover } from "./FieldEvidencePopover";
import "./verification.css";

export type BadgeStatus = FieldReview["status"];

export const STATUS_WORDS: Record<BadgeStatus, string> = {
  verified: "Verified",
  "single-source": "Single source",
  unverified: "Unverified",
  conflict: "Conflict",
  "user-confirmed": "Confirmed by you",
  none: "Not checked",
};

/** A distinct glyph per status (hidden from screen readers: the words carry the meaning). */
const GLYPH: Record<BadgeStatus, string> = {
  verified: "✓",
  "single-source": "1",
  unverified: "?",
  conflict: "!",
  "user-confirmed": "★",
  none: "–",
};

export const statusWords = (s: string): string => STATUS_WORDS[s as BadgeStatus] ?? STATUS_WORDS.none;

export interface VerificationBadgeProps {
  review: FieldReview;
  /** The field in words ("Publication date"). */
  label: string;
  expanded: boolean;
  onOpen: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
}

export function VerificationBadge({ review, label, expanded, onOpen, buttonRef }: VerificationBadgeProps) {
  const status: BadgeStatus = review.status in STATUS_WORDS ? review.status : "none";
  const words = STATUS_WORDS[status];
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`ao-verify ao-verify--${status}`}
      aria-label={`${label}: ${words}`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      onClick={onOpen}
    >
      <span aria-hidden="true" className="ao-verify__glyph">
        {GLYPH[status]}
      </span>
      {words}
    </button>
  );
}

export interface FieldCheckProps {
  review: FieldReview;
  label: string;
  /** The record's value of the field now (what Confirm confirms when nothing else is chosen). */
  value: unknown;
  readOnly: boolean;
  /**
   * Records the researcher's value through the service's field route (`field` is the record's
   * key, e.g. "issued"). Throws with a plain-language message when it was not saved.
   */
  onConfirm: (field: string, value: unknown) => Promise<void>;
}

/** The badge and, while open, its evidence popover. */
export function FieldCheck({ review, label, value, readOnly, onConfirm }: FieldCheckProps) {
  const [open, setOpen] = useState(false);
  const badge = useRef<HTMLButtonElement>(null);
  return (
    <span className="ao-verify-wrap">
      <VerificationBadge review={review} label={label} expanded={open} onOpen={() => setOpen((o) => !o)} buttonRef={badge} />
      {open && (
        <FieldEvidencePopover
          review={review}
          label={label}
          value={value}
          readOnly={readOnly}
          onConfirm={onConfirm}
          onClose={() => {
            setOpen(false);
            // After the popover is gone (its own focus restore runs first).
            setTimeout(() => badge.current?.focus());
          }}
        />
      )}
    </span>
  );
}
