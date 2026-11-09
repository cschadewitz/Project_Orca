/** Authenticated scoped permission adapter; private command authority stays in the daemon. */
import type { GuardDecisionView } from "../../../../protocol/src/guard-decision-projection.js";
/** UI adapter carries opaque handles only; server retains all command authority. */
import type { LiveDecisionTarget } from "@orca/protocol";
import type { OrcaBridge } from "../../../src/bridge.js";
import type { ScopedRuleReviewPort, ScopedChoiceResult } from "./scoped-rule-review.js";
/** The main process resolves a reply lost after dispatch as one of these; the owner may have acted. */
const lostReply = new Set(["AGENT_TRANSPORT", "PROTOCOL_MESSAGE"]);
export function scopedRulePort(bridge: OrcaBridge, input: LiveDecisionTarget): ScopedRuleReviewPort | undefined {
  const snapshot = bridge.connection.read();
  const rpc = bridge.scopedPermissions;
  if (!rpc || snapshot.state !== "live" || !snapshot.methods?.includes("scopedPermissions.review")) return undefined;
  const scopeKey = JSON.stringify([snapshot.generation, input]);
  const isCurrent = () => {
    const now = bridge.connection.read();
    return now.state === "live" && now.generation === snapshot.generation;
  };
  return {
    scopeKey,
    review: async () => {
      if (!isCurrent()) return undefined;
      const hello = await bridge.hello();
      if (!hello.ok || !hello.result.identity || !isCurrent()) return undefined;
      const target = hello.result.identity;
      const result = await rpc.call("scopedPermissions.review", { target, input });
      if (!result.ok) return undefined;
      if (!isCurrent()) {
        // Nothing will ever choose on a handle that arrived late; release it rather than leave it ready.
        void rpc.call("scopedPermissions.cancel", { target, handle: result.result.handle }).catch(() => undefined);
        return undefined;
      }
      const review = result.result;
      const choose = async (choice: "save" | "allow-once" | "deny"): Promise<ScopedChoiceResult> => {
        if (!isCurrent()) return "stale";
        try {
          const r = await rpc.call("scopedPermissions.choose", { target, handle: review.handle, choice });
          if (!isCurrent()) return "uncertain";
          return r.ok
            ? r.result.outcome === (choice === "save" ? "saved" : "answered")
              ? "confirmed"
              : "uncertain"
            : lostReply.has(r.error.code)
              ? "uncertain"
              : "refused";
        } catch {
          return "uncertain";
        }
      };
      return {
        ...review,
        decision: review.decision as GuardDecisionView,
        isCurrent,
        cancel: async () => {
          try {
            await rpc.call("scopedPermissions.cancel", { target, handle: review.handle });
          } catch {
            /* No success or replay is inferred from a lost cancellation response. */
          }
        },
        allowOnce: () => choose("allow-once"),
        deny: () => choose("deny"),
        ...(review.standingReview !== "unavailable" && review.saveEligibility !== "unavailable"
          ? { createRule: () => choose("save") }
          : {}),
      };
    },
  };
}
