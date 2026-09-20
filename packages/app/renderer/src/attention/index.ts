/**
 * What the rest of the app may use from the Attention surface.
 *
 * The two cards are exported because they have a second mounting: step detail renders a
 * gate or a permission ask **inline in the run it came from**, with identical controls and
 * identical keyboard handling (docs/design/20-attention-and-gates.md). That wiring is the
 * integration commit's — the same way `StepDetail` was mounted into the run tree's slot —
 * and a step's card passes `placement="inline"`, its own `onAnswer`, and nothing else
 * different.
 */
export { AnswerCard, type AnswerCardProps, type AnswerRequest } from "./answer-card.js";
export { AttentionSurface, type AttentionSurfaceProps } from "./attention-surface.js";
export { GateCard, type GateCardProps } from "./gate-card.js";
export { PermissionCard, type PermissionCardProps } from "./permission-card.js";
export {
  alwaysOutcome,
  artifactsReady,
  bindOptions,
  defaultSelection,
  isFreeText,
  permissionSubject,
  waitedLabel,
  type BoundOption,
  type GateOption,
} from "./card-model.js";
export { alertItems, mergeInput, orderWaits, tierOf, type WaitTier } from "./items.js";
export { useAlertActivation } from "./use-alert-activation.js";
export { useAttention, type AttentionFeed, type AttentionState } from "./use-attention.js";
export { useControls, type ControlReport, type Controls } from "./use-controls.js";
