/**
 * What the rest of the app may use from the Attention surface.
 *
 * The two cards are exported because they have a second mounting: step detail renders a
 * gate or a permission ask **inline in the run it came from**, with identical controls and
 * identical keyboard handling (docs/design/20-attention-and-gates.md). `StepAsks` is that
 * mounting, over the one feed `App.tsx` holds — a card there passes `placement="inline"`,
 * its own `onAnswer`, and nothing else different.
 */
export { AnswerCard, cardName, type AnswerCardProps, type AnswerRequest } from "./answer-card.js";
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
export { InlineAsksProvider, StepAsks, type StepAsksProps } from "./inline-asks.js";
export { useAlertActivation } from "./use-alert-activation.js";
export { useAttention, type AttentionFeed, type AttentionState } from "./use-attention.js";
export { useControls, type ControlReport, type Controls } from "./use-controls.js";
export type { AttentionRevision, RevisionsFeed } from "./use-revisions.js";
