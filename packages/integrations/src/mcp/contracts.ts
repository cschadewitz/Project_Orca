/** Shared production contracts; no adapter-local receipt or retry state. */
import { z } from "zod";
import {
  OperatorTargetSchema as target,
  OperatorPageParamsSchema,
  OperatorBoundaryPageResultSchema,
  OperatorMutationContracts,
  OperatorDiscoverySchema,
  OperatorConfigSchema,
  OperatorPreflightParamsSchema,
  OperatorPreflightResultSchema,
  OperatorArtifactParamsSchema,
  OperatorArtifactResultSchema,
} from "@orca/protocol";

/** Explicit private-daemon adapter endpoints. Each delegates to one shared application service. */
export const MCP_OPERATIONS = {
  discover: { method: "operator.discover", input: z.strictObject({}), output: OperatorDiscoverySchema, write: false },
  page: {
    method: "operator.page",
    input: OperatorPageParamsSchema,
    output: OperatorBoundaryPageResultSchema,
    write: false,
  },
  config: { method: "operator.config", input: z.strictObject({ target }), output: OperatorConfigSchema, write: false },
  preflight: {
    method: "operator.preflight",
    input: OperatorPreflightParamsSchema,
    output: OperatorPreflightResultSchema,
    write: false,
  },
  artifact: {
    method: "operator.artifact",
    input: OperatorArtifactParamsSchema,
    output: OperatorArtifactResultSchema,
    write: false,
  },
  submitRequest: {
    method: "operator.submitRequest",
    input: OperatorMutationContracts["operator.submitRequest"].params,
    output: OperatorMutationContracts["operator.submitRequest"].result,
    write: true,
  },
  admitRun: {
    method: "operator.admitRun",
    input: OperatorMutationContracts["operator.admitRun"].params,
    output: OperatorMutationContracts["operator.admitRun"].result,
    write: true,
  },
  admission: {
    method: "operator.admission",
    input: OperatorMutationContracts["operator.admission"].params,
    output: OperatorMutationContracts["operator.admission"].result,
    write: false,
  },
  reconcileAdmission: {
    method: "operator.reconcileAdmission",
    input: OperatorMutationContracts["operator.reconcileAdmission"].params,
    output: OperatorMutationContracts["operator.reconcileAdmission"].result,
    write: true,
  },
  cancel: {
    method: "operator.cancel",
    input: OperatorMutationContracts["operator.cancel"].params,
    output: OperatorMutationContracts["operator.cancel"].result,
    write: true,
  },
  answer: {
    method: "operator.answer",
    input: OperatorMutationContracts["operator.answer"].params,
    output: OperatorMutationContracts["operator.answer"].result,
    write: true,
  },
  continueRun: {
    method: "operator.continueRun",
    input: OperatorMutationContracts["operator.continueRun"].params,
    output: OperatorMutationContracts["operator.continueRun"].result,
    write: true,
  },
  continuation: {
    method: "operator.continuation",
    input: OperatorMutationContracts["operator.continuation"].params,
    output: OperatorMutationContracts["operator.continuation"].result,
    write: false,
  },
  reconcileContinuation: {
    method: "operator.reconcileContinuation",
    input: OperatorMutationContracts["operator.reconcileContinuation"].params,
    output: OperatorMutationContracts["operator.reconcileContinuation"].result,
    write: true,
  },
  revise: {
    method: "operator.revise",
    input: OperatorMutationContracts["operator.revise"].params,
    output: OperatorMutationContracts["operator.revise"].result,
    write: true,
  },
} as const;
export type McpOperation = keyof typeof MCP_OPERATIONS;
export type McpInput<K extends McpOperation> = z.input<(typeof MCP_OPERATIONS)[K]["input"]>;
export type McpOutput<K extends McpOperation> = z.output<(typeof MCP_OPERATIONS)[K]["output"]>;

/** Server-created authenticated path. Implementations recheck credentials/grants before diagnostics and effects. */
export interface AuthenticatedOperatorBackend {
  call<K extends McpOperation>(operation: K, input: McpInput<K>): Promise<McpOutput<K>>;
}
