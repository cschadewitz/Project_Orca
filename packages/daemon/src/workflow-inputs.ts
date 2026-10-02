/**
 * `workflows.validateInputs` (#330), the launch preflight: which definition a launch would
 * start on, its revision, and what is wrong with the vars - without starting anything.
 *
 * The model is the method's body and nothing else. It is not registered in `methods.ts` yet:
 * registration, authorization of the selected workflow (#328) and capability advertisement are
 * the integration's, so this takes its definition resolver by injection - the orchestrator's
 * `selectDefinition` in a daemon, a fixture in a test. The resolver being the one admission
 * uses is what keeps a preflight and the launch it guards on the same definition.
 */
import { validateWorkflowInputs, type WorkflowDefinition } from "@orca/core";
import { workflowRevision, type Orchestrator } from "@orca/engine";
import {
  WorkflowsValidateInputsParamsSchema,
  type WorkflowsValidateInputsParams,
  type WorkflowsValidateInputsResult,
} from "@orca/protocol";

/**
 * The definition a launch of `workflowId` (at `version`, when given) would be admitted on. It
 * throws what admission would: `WORKFLOW_NOT_FOUND`, `WORKFLOW_VERSION_NOT_FOUND`, or
 * `WORKFLOW_INVALID` for a same-version edit of a recorded definition.
 */
export type WorkflowDefinitionResolver = (workflowId: string, version?: string) => Promise<WorkflowDefinition>;

export interface WorkflowInputsModelOptions {
  resolve: WorkflowDefinitionResolver;
  /** The content digest; `workflowRevision` unless a test pins it. */
  revision?: (def: WorkflowDefinition) => string;
}

export class WorkflowInputsModel {
  private readonly resolve: WorkflowDefinitionResolver;
  private readonly revision: (def: WorkflowDefinition) => string;

  constructor(o: WorkflowInputsModelOptions) {
    this.resolve = o.resolve;
    this.revision = o.revision ?? workflowRevision;
  }

  /** Field failures come back in `validation`; only an unresolvable workflow throws. */
  async validateInputs(params: WorkflowsValidateInputsParams): Promise<WorkflowsValidateInputsResult> {
    const { workflowId, version, vars } = WorkflowsValidateInputsParamsSchema.parse(params);
    const def = await this.resolve(workflowId, version);
    // The resolved vars stay here: the wire result never echoes values (they may be sensitive).
    const { validation } = validateWorkflowInputs(def, vars);
    return { workflowId: def.id, version: def.version, revision: this.revision(def), validation };
  }
}

/** The resolver a daemon uses: exactly the selection `Orchestrator.startRun` admits on. */
export function orchestratorDefinitionResolver(orchestrator: Orchestrator): WorkflowDefinitionResolver {
  return (workflowId, version) => orchestrator.selectDefinition(workflowId, version);
}
