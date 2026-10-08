/** Authorized app projections and protected handles; execution keys and ciphertext stay in main. */
import type { WorkflowInputSchemaView } from "@orca/protocol";
import type { CheckoutEvidence, EditorTarget, LaunchReview, RetainedLaunch } from "./configuration-launch-contract.js";

export interface GuidedWorkflowBinding {
  id: string;
  name: string;
  version: string;
  revision: string;
  inputSchema?: WorkflowInputSchemaView;
}
export interface GuidedLaunchSnapshot {
  target: EditorTarget;
  endpointId: string;
  principalId: string;
  activeGeneration: string;
  operations: readonly string[];
  checkout: CheckoutEvidence;
  workflows: readonly GuidedWorkflowBinding[];
}
export interface ProtectedGuidedLaunch {
  intent: RetainedLaunch;
  review: LaunchReview;
}
