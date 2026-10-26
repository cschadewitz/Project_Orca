/** Authenticated scoped permission adapter; private command authority stays in the daemon. */
import type { GuardDecisionView } from "../../../../protocol/src/guard-decision-projection.js";
/** UI adapter carries opaque handles only; server retains all command authority. */
import type { LiveDecisionTarget } from "@orca/protocol";
import type { OrcaBridge } from "../../../src/bridge.js";
import type { ScopedRuleReviewPort, ScopedChoiceResult } from "./scoped-rule-review.js";
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
      if (!result.ok || !isCurrent()) return undefined;
      const review = result.result;
      const choose = async (choice: "save" | "allow-once" | "deny"): Promise<ScopedChoiceResult> => {
        if (!isCurrent()) return "stale";
        try {
          const r = await rpc.call("scopedPermissions.choose", { target, handle: review.handle, choice });
          return r.ok
            ? r.result.outcome === "saved" || r.result.outcome === "answered"
              ? "confirmed"
              : "uncertain"
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
        createRule: () => choose("save"),
      };
    },
  };
}
