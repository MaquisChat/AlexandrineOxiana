/**
 * "Transcribe everything without a transcript" (whole channels, Task 9; spec point 5): a button above the project's
 * sources list. A press first asks how many sources have audio or video and no transcript, and how long they are
 * (GET /projects/:id/untranscribed), and says so (`transcribeAllText.confirm`) with "Transcribe them" and "Cancel"; or
 * says that there is nothing to do, and offers nothing. The sentence takes focus.
 *
 * "Transcribe them" puts them on the project's transcription list once (POST /projects/:id/transcription-list), says how
 * many were put on it as a status and returns focus to the button. The work line of the list comes by itself: the service
 * publishes the change on the screen's own event stream (R679), so nothing here touches the work lines.
 *
 * A refusal shows the service's sentence; a missing speech model is said once, as SpeechModelNotice says it, with the
 * link to the Optional tools screen (another missing tool as MissingToolNotice says it). One request per press (a
 * synchronous guard, then the button is disabled). Answers that arrive after the project changed or after unmount are
 * dropped.
 *
 * `readOnly`: the library is read-only. The button is then off, as the Library screen's other edit buttons are; the
 * screen's read-only banner says why (R684).
 */
import { transcribeAllText, type UntranscribedResponse } from "@ao/shared";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { backgroundApi } from "../api/background";
import { ApiClientError, type ApiClient } from "../api/client";
import { errorText } from "../api/library";
import { speechSize } from "../api/tools";
import { MissingToolNotice, missingToolOf, SpeechModelNotice } from "./MissingToolNotice";
import { UserText } from "./UserText";

export interface TranscribeAllProps {
  client: ApiClient;
  projectId: string;
  /** The library is read-only: the button is off and nothing is asked. */
  readOnly?: boolean;
}

/** The app's usual words when the service gives none. */
const FAILED = "That could not be done. Try again.";

type Step = { kind: "idle" } | { kind: "asking" } | { kind: "confirm"; r: UntranscribedResponse } | { kind: "sending"; r: UntranscribedResponse };

export function TranscribeAll({ client, projectId, readOnly = false }: TranscribeAllProps) {
  const api = useMemo(() => backgroundApi(client), [client]);
  const id = useId();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [added, setAdded] = useState<string>("");
  const [failure, setFailure] = useState<unknown>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const said = useRef<HTMLParagraphElement>(null);
  /** A request in flight (a ref: a double click fires before the button re-renders, R113). */
  const busy = useRef(false);
  /** Moves on when the project changes and at unmount: an older answer is dropped. */
  const generation = useRef(0);
  /** Where focus goes after the next render: the sentence (it was just said) or the button. */
  const focusTo = useRef<"said" | "button" | null>(null);

  useEffect(() => {
    generation.current++;
    busy.current = false;
    setStep({ kind: "idle" });
    setAdded("");
    setFailure(undefined);
    return () => {
      generation.current++;
    };
  }, [projectId]);

  useEffect(() => {
    const to = focusTo.current;
    if (!to) return;
    focusTo.current = null;
    (to === "said" ? said.current : button.current)?.focus();
  });

  const ask = async () => {
    if (busy.current || readOnly) return;
    busy.current = true;
    const my = generation.current;
    setStep({ kind: "asking" });
    setAdded("");
    setFailure(undefined);
    try {
      const r = await api.untranscribed(projectId);
      if (generation.current !== my) return;
      focusTo.current = "said";
      setStep({ kind: "confirm", r });
    } catch (err) {
      if (generation.current !== my) return;
      // The button was disabled while it asked: focus goes back to it, the refusal said below it.
      focusTo.current = "button";
      setStep({ kind: "idle" });
      setFailure(err ?? new Error(FAILED));
    } finally {
      if (generation.current === my) busy.current = false;
    }
  };

  const send = async () => {
    if (busy.current || step.kind !== "confirm") return;
    busy.current = true;
    const my = generation.current;
    setStep({ kind: "sending", r: step.r });
    try {
      const res = await api.transcribeAll(projectId);
      if (generation.current !== my) return;
      setAdded(transcribeAllText.added(res.added));
      setStep({ kind: "idle" });
    } catch (err) {
      if (generation.current !== my) return;
      setStep({ kind: "idle" });
      setFailure(err ?? new Error(FAILED));
    } finally {
      if (generation.current === my) {
        busy.current = false;
        focusTo.current = "button";
      }
    }
  };

  const cancel = () => {
    if (busy.current) return;
    setStep({ kind: "idle" });
    focusTo.current = "button";
  };

  const shown = step.kind === "confirm" || step.kind === "sending" ? step.r : undefined;
  return (
    <div className="ao-transcribe-all">
      <button
        ref={button}
        type="button"
        disabled={readOnly || step.kind === "asking" || step.kind === "sending"}
        onClick={() => void ask()}
      >
        {transcribeAllText.button}
      </button>
      {shown ? (
        <div role="group" aria-labelledby={`${id}-said`}>
          <p id={`${id}-said`} ref={said} tabIndex={-1}>
            {transcribeAllText.confirm(shown)}
          </p>
          {shown.count > 0 ? (
            <div className="ao-actions">
              <button type="button" disabled={step.kind === "sending"} onClick={() => void send()}>
                {transcribeAllText.confirmButton}
              </button>
              <button type="button" disabled={step.kind === "sending"} onClick={cancel}>
                {transcribeAllText.cancel}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <p role="status">{added}</p>
      {failure !== undefined ? (
        <div role="alert" className="ao-warning">
          <Refusal err={failure} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The service's sentence; a missing tool is said once (R684): a speech model as SpeechModelNotice says it, another tool
 * as MissingToolNotice does, each with its link, and not the service's general sentence as well.
 */
function Refusal({ err }: { err: unknown }) {
  const missing = missingToolOf(err);
  const model = missing?.tool ? speechSize(missing.tool) : undefined;
  if (missing && err instanceof ApiClientError) {
    return model ? <SpeechModelNotice model={model} installed={{ [model]: false }} /> : <MissingToolNotice from={err} as="p" />;
  }
  return <UserText as="p">{errorText(err, FAILED)}</UserText>;
}
