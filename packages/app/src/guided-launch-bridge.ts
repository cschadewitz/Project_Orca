/** Authorized app projections and protected handles; execution keys and ciphertext stay in main. */
import type { OperatorRow, WorkflowInputSchemaView } from "@orca/protocol";
import type {
  CheckoutEvidence,
  EditorTarget,
  LaunchReview,
  LaunchSelectionProvenance,
  RetainedLaunch,
} from "./configuration-launch-contract.js";

export interface GuidedWorkflowBinding {
  id: string;
  name: string;
  version: string;
  revision: string;
  inputSchema?: WorkflowInputSchemaView;
  selectionProvenance?: LaunchSelectionProvenance;
}
export interface GuidedLaunchSnapshot {
  target: EditorTarget;
  endpointId: string;
  principalId: string;
  activeGeneration: string;
  operations: readonly string[];
  checkout: CheckoutEvidence;
  workflows: readonly GuidedWorkflowBinding[];
  /** Authorized choices from one active generation; absence disables optional override editing. */
  choices?: readonly OperatorRow[];
}
export interface ProtectedGuidedLaunch {
  intent: RetainedLaunch;
  review: LaunchReview;
}
