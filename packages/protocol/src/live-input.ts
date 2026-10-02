/** Additive live-permission identity. An instance/session/turn/invocation is never a reusable approval. */
import { z } from "zod";

export const LiveDecisionIdentitySchema = z.object({
  instanceId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  invocationId: z.string().min(1),
});
export const LiveDecisionTargetSchema = LiveDecisionIdentitySchema.extend({
  runId: z.string().min(1),
  stepRunId: z.string().min(1),
  requestId: z.string().min(1),
});
export const LiveInputViewSchema = z.object({
  target: LiveDecisionTargetSchema,
  state: z.enum(["pending", "accepting", "expired", "owner-unavailable"]),
});
export type LiveDecisionTarget = z.infer<typeof LiveDecisionTargetSchema>;
export type LiveInputView = z.infer<typeof LiveInputViewSchema>;
