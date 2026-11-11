/**
 * Step 4: how review works for this import (spec 5.4). Items identified with enough confidence are
 * accepted on their own; the rest wait in the review queue (ReviewQueue, /import/review), which
 * opens from the report once the import has run. In projects that pseudonymise names, the queue
 * also flags titles taken from file names and collections made from folder names (R64).
 */
import type { ImportPolicy } from "../../api/import";
import { Section } from "./shared";

/** AUTO_ACCEPT_THRESHOLD in @ao/core (R54): kept here as a number to show, not to decide with. */
const AUTO_ACCEPT_PERCENT = 90;

export function StepReview({ policy, likelyDuplicates }: { policy: ImportPolicy; likelyDuplicates: number }) {
  return (
    <Section title="Review">
      <p>
        Items identified with a confidence of {AUTO_ACCEPT_PERCENT}% or more are accepted on their own. The others wait in the review queue, where you see each item next to its candidate matches and can
        accept, correct, merge, skip or keep both, or set the type, a tag or a collection for many items at once.
      </p>
      {likelyDuplicates > 0 && <p>Uncertain duplicates also go to the review queue, whatever you choose for duplicates in the next step.</p>}
      {policy.pseudonymizeNames && (
        <p className="ao-import__note">
          This project pseudonymises names. File names and folder names can carry participants' names, so the review queue marks titles taken from file names and collections made from folder names
          for you to check.
        </p>
      )}
      <p className="ao-import__hint">The review queue opens from the report once the import has run.</p>
    </Section>
  );
}
