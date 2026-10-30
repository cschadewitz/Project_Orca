/** In-place opt-in choices inside AnswerCard. No registration, transport, storage or authority creation. */
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { Button, counted, KeyValueList, ObjectId, Text } from "../ui/index.js";
import { useTransientLayer } from "../layers-context.js";
import { useAnnounce } from "../a11y/announce-context.js";
import {
  copyScopedReviewScope,
  scopedPendingExecutionWindow,
  scopedReviewUnavailable,
  scopedSaveReviewUnavailable,
  type ScopedRuleReview,
  type ScopedRuleReviewPort,
} from "./scoped-rule-review.js";

export function ScopedRuleChoices({
  port,
  cannotWrite,
}: {
  port: ScopedRuleReviewPort;
  cannotWrite?: string | undefined;
}): JSX.Element {
  const [review, setReview] = useState<ScopedRuleReview>();
  const [phase, setPhase] = useState<"closed" | "loading" | "review" | "confirm" | "saved" | "settled">("closed");
  const [saved, setSaved] = useState(false);
  const [outcome, setOutcome] = useState("");
  const lock = useRef(false);
  const generation = useRef(0);
  const region = useRef<HTMLDivElement>(null);
  const start = useRef<HTMLSpanElement>(null);
  const back = useRef<HTMLSpanElement>(null);
  const announce = useAnnounce();
  useLayoutEffect(() => {
    const box = region.current;
    return () => {
      generation.current++;
      if (box?.contains(document.activeElement)) box.parentElement?.focus();
    };
  }, []);
  useEffect(
    () => () => {
      void review?.cancel?.();
    },
    [review],
  );
  const leave = () => {
    if (lock.current && phase !== "settled") return;
    generation.current++;
    const heldFocus = region.current?.contains(document.activeElement);
    setReview(undefined);
    setPhase("closed");
    setOutcome("");
    if (heldFocus) start.current?.querySelector("button")?.focus();
  };
  useTransientLayer(phase !== "closed", {
    name: "scoped permission review",
    close: leave,
    hasUnsentDraft: () => lock.current && phase !== "settled",
  });
  useEffect(() => {
    if (phase === "confirm") back.current?.querySelector("button")?.focus();
  }, [phase]);

  const load = async () => {
    if (lock.current || cannotWrite) return;
    const token = ++generation.current;
    setReview(undefined);
    setOutcome("");
    setPhase("loading");
    try {
      const result = await port.review();
      if (token !== generation.current) {
        void result?.cancel?.();
        return;
      }
      setReview(
        result
          ? { ...result, scope: copyScopedReviewScope(result.scope), decision: structuredClone(result.decision) }
          : undefined,
      );
      setPhase("review");
      if (!result) setOutcome("Review is unavailable. No choice was sent.");
    } catch {
      if (token !== generation.current) return;
      setPhase("review");
      setOutcome("Review failed. No choice was sent.");
    }
  };
  const commonReason =
    cannotWrite ??
    (lock.current
      ? phase === "settled"
        ? "Refresh authoritative state before reviewing this input again."
        : "A choice is awaiting confirmation."
      : !review
        ? "Review the exact scope first."
        : undefined);
  const reason = commonReason ?? (review ? scopedReviewUnavailable(review, Date.now()) : undefined);
  const saveReason = commonReason ?? (review ? scopedSaveReviewUnavailable(review, Date.now()) : undefined);
  const executionWindow = review ? scopedPendingExecutionWindow(review) : undefined;
  const choose = async (choice: "allowOnce" | "deny" | "createRule") => {
    if (lock.current || cannotWrite || !review || phase === "settled") return;
    // Denial does not require positive scope/coverage, but still requires the owner's current capability.
    const blocked =
      choice === "createRule"
        ? scopedSaveReviewUnavailable(review, Date.now())
        : scopedReviewUnavailable(review, Date.now());
    if (choice !== "deny" && blocked) {
      setOutcome(blocked);
      return;
    }
    try {
      if (!review.isCurrent()) {
        setOutcome("This review is stale. Review again.");
        return;
      }
    } catch {
      setOutcome("Current review authority is unavailable.");
      return;
    }
    const action = review[choice];
    if (!action || (choice === "createRule" && (saved || phase !== "confirm"))) return;
    lock.current = true; // Synchronous latch: repeated clicks before React renders cannot duplicate the intent.
    const token = generation.current;
    setOutcome("Waiting for confirmation.");
    try {
      const result = await action();
      if (token !== generation.current) return;
      if (choice === "createRule" && result === "confirmed") {
        setSaved(true);
        lock.current = false;
        setPhase("saved");
      } else {
        // Nothing was sent on a stale result, so the input can be reviewed again; everything else stays latched.
        if (result === "stale") lock.current = false;
        setPhase("settled");
      }
      const message =
        result === "confirmed"
          ? choice === "createRule"
            ? "Scoped rule saved. This invocation was not approved or dispatched."
            : choice === "allowOnce"
              ? "One-time answer recorded. No rule was created. Execution is not confirmed."
              : "Denial recorded. No rule was created."
          : result === "uncertain"
            ? "Acknowledgement is uncertain. Refresh authoritative state before taking another action. Do not repeat this choice."
            : result === "stale"
              ? "The reviewed scope or authority changed. Nothing is confirmed; review again."
              : "The choice was refused. No success is confirmed. Refresh authoritative state before taking another action.";
      setOutcome(message);
      announce(message);
    } catch {
      if (token !== generation.current) return;
      setPhase("settled");
      setOutcome(
        "Acknowledgement is uncertain. Refresh authoritative state before taking another action. Do not repeat this choice.",
      );
    } finally {
      // Only a confirmed save opens a fresh separate-answer review. Uncertain outcomes remain latched.
      if (token === generation.current && region.current?.contains(document.activeElement)) region.current.focus();
    }
  };

  return (
    <div ref={region} role="group" tabIndex={-1} aria-label="Scoped permission review">
      <span ref={start}>
        <Button
          disabled={lock.current || phase !== "closed" || cannotWrite !== undefined}
          disabledReason={
            cannotWrite ??
            (lock.current
              ? "Refresh authoritative state before reviewing this input again."
              : "Close the current review first.")
          }
          onClick={() => void load()}
        >
          Review permission
        </Button>
      </span>
      {phase !== "closed" && (
        <>
          {review && (
            <>
              <KeyValueList values={review.scope} />
              <KeyValueList
                values={{
                  coverage: review.decision.coverage.tier,
                  reviewDeadline: new Date(review.reviewUntil).toJSON() ?? "unknown",
                  requiredReview: review.requiredReview,
                  decisionAuthorizer: review.decision.authorizer,
                  support: review.decision.support,
                  decision: review.decision.decision,
                  authority: review.decision.authority,
                  authorityKind: review.decision.authorityKind,
                  expiry:
                    review.decision.expiry.state === "bounded"
                      ? review.decision.expiry.at
                      : review.decision.expiry.state,
                  review: review.decision.review,
                  execution: review.decision.execution,
                  recording: review.decision.observations.recording.status,
                  delivery: review.decision.observations.delivery.status,
                  dispatch: review.decision.observations.dispatch.status,
                  effect: review.decision.observations.effect.status,
                  revocation: review.decision.revocation,
                  revocationLatencyMs: review.decision.revocationLatencyMs ?? "unknown",
                }}
              />
              <Text style="caption">Reported coverage does not establish installed support or confirm execution.</Text>
              {executionWindow !== undefined && (
                <Text style="caption">
                  The execution window starts after approval and current checks. Execution then has up to{" "}
                  {counted(executionWindow / 1000, "second")}. Current checks may refuse this request.
                </Text>
              )}
              {review.decision.coverage.reference && (
                <Text style="caption">
                  Coverage reference <ObjectId id={review.decision.coverage.reference.id} variant="full" />
                </Text>
              )}
              {review.decision.reviewReference && (
                <Text style="caption">
                  Review reference <ObjectId id={review.decision.reviewReference.id} variant="full" />
                </Text>
              )}
              {review.decision.authorizerReference && (
                <Text style="caption">
                  Decision authorizer <ObjectId id={review.decision.authorizerReference.id} variant="full" />
                </Text>
              )}
              {review.decision.matchedRule && (
                <Text style="caption">
                  Matched rule <ObjectId id={review.decision.matchedRule.rule.id} variant="full" /> revision{" "}
                  <ObjectId id={review.decision.matchedRule.revision.id} variant="full" />
                </Text>
              )}
              {reason && <Text style="caption">Allow once: {reason}</Text>}
              {saveReason && saveReason !== reason && <Text style="caption">Save: {saveReason}</Text>}
            </>
          )}
          {phase !== "settled" && phase !== "saved" && (
            <div className="orca-card__options">
              {phase === "confirm" ? (
                <>
                  <span ref={back}>
                    <Button
                      disabled={lock.current}
                      disabledReason="A choice is awaiting confirmation."
                      onClick={() => {
                        setPhase("review");
                        region.current?.focus();
                      }}
                    >
                      Back
                    </Button>
                  </span>
                  <Button
                    disabled={saveReason !== undefined || !review?.createRule}
                    disabledReason={saveReason ?? "Scoped rule creation is unavailable."}
                    onClick={() => void choose("createRule")}
                  >
                    Save scoped rule
                  </Button>
                  <Text style="caption">
                    Saves exactly the displayed scope and limits. This invocation requires a separate one-time answer.
                  </Text>
                </>
              ) : (
                <>
                  <Button
                    disabled={reason !== undefined || !review?.allowOnce}
                    disabledReason={reason ?? "A verified one-time choice is unavailable."}
                    onClick={() => void choose("allowOnce")}
                  >
                    Allow once
                  </Button>
                  <Button
                    tone="danger"
                    disabled={lock.current || cannotWrite !== undefined || !review?.deny}
                    disabledReason={cannotWrite ?? "A current denial capability is required."}
                    onClick={() => void choose("deny")}
                  >
                    Deny
                  </Button>
                  {!saved && (
                    <Button
                      disabled={saveReason !== undefined || !review?.createRule}
                      disabledReason={saveReason ?? "Scoped rule creation is unavailable."}
                      onClick={() => setPhase("confirm")}
                    >
                      Create scoped rule
                    </Button>
                  )}
                </>
              )}
              <Button disabled={lock.current} disabledReason="A choice is awaiting confirmation." onClick={leave}>
                Cancel review
              </Button>
            </div>
          )}
          {phase === "saved" && (
            <>
              <Text style="caption">Review current authority before answering this invocation separately.</Text>
              <Button
                disabled={cannotWrite !== undefined}
                disabledReason={cannotWrite ?? "Current write authority is required."}
                onClick={() => void load()}
              >
                Review separate answer
              </Button>
              <Button onClick={leave}>Close review</Button>
            </>
          )}
          {phase === "loading" && <Text style="caption">Loading reviewed scope…</Text>}
          {outcome && outcome !== reason && <Text style="caption">{outcome}</Text>}
          {phase === "settled" && <Button onClick={leave}>Close review</Button>}
        </>
      )}
    </div>
  );
}
