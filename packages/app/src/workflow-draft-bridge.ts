/** Typed IPC surface for workflow drafts (#180); the renderer's visual editor (#181) calls it. */
import type { z } from "zod";
import type { WORKFLOW_DRAFT_METHOD_CONTRACTS } from "@orca/protocol";
import type { BridgeResult } from "./bridge.js";
export type WorkflowDraftMethodName = keyof typeof WORKFLOW_DRAFT_METHOD_CONTRACTS;
export interface WorkflowDraftBridge {
  call<M extends WorkflowDraftMethodName>(
    method: M,
    params: z.input<(typeof WORKFLOW_DRAFT_METHOD_CONTRACTS)[M]["params"]>,
  ): Promise<BridgeResult<z.output<(typeof WORKFLOW_DRAFT_METHOD_CONTRACTS)[M]["result"]>>>;
}
