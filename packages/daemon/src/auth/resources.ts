/**
 * Resource authorization: may this principal see this run, workflow, artifact or gate?
 *
 * Every rule reduces to two questions about a run's *root* - the run at the top of its
 * parent chain. Is the root's workflow in the principal's workflow scope, and (for an
 * `owned` principal) did this principal start the root? A child run, its steps, its events,
 * its artifacts and its gates are reachable exactly when its root is. That is the
 * inheritance rule, and it is the only one: nothing is reachable through a link that its own
 * root would not grant.
 *
 * What a run *is* - its workflow and its parent - never changes once `run.created` is
 * written, so it is cached; who *owns* a root is read from `OwnershipStore` every time. An
 * unrestricted principal is never resolved at all: it can see everything, so the guard
 * passes its calls straight through and the models answer exactly as they always have.
 */
import type { OrcaEvent } from "@orca/core";
import type { OwnershipStore } from "./ownership.js";
import { isUnrestricted, workflowAllowed, type Principal } from "./principal.js";

export interface RunFacts {
  workflowId: string;
  parentRunId?: string | undefined;
}

/**
 * What resource checks need to know about the store. Stated structurally so tests can drive
 * it with a fixture; `orchestratorResolver` builds it from the engine.
 */
export interface ResourceResolver {
  /** A run's workflow and parent, from its `run.created`; `undefined` when there is no such run. */
  run(runId: string): Promise<RunFacts | undefined>;
  /** The run an *open* gate or permission ask belongs to. */
  inputRun(requestId: string): Promise<string | undefined>;
  /** The run an artifact belongs to. */
  artifactRun(artifactId: string): Promise<string | undefined>;
  /** The run holding a claim on a work item. */
  claimRun(workItemId: string): Promise<string | undefined>;
  /** Whether a workflow id is registered (an inline `parent::node` id is judged by its root). */
  workflowExists(workflowId: string): boolean;
}

/** The slice of `Orchestrator` the resolver reads. `Orchestrator` satisfies it as it stands. */
export interface ResolverSource {
  eventsRange(runId: string, range?: { limit?: number | undefined }): Promise<OrcaEvent[]>;
  pendingInputs(runId?: string): Promise<{ id: string; runId: string }[]>;
  stores: {
    artifacts: { get(id: string): Promise<{ producedBy: { runId: string } } | undefined> };
    claims: { get(workItemId: string): Promise<{ runId: string } | undefined> };
  };
  workflows: { has(id: string): boolean };
}

export function orchestratorResolver(source: ResolverSource): ResourceResolver {
  return {
    async run(runId) {
      const [first] = await source.eventsRange(runId, { limit: 1 });
      if (!first || first.type !== "run.created") return undefined;
      return { workflowId: first.payload.workflowId, parentRunId: first.payload.parentRunId };
    },
    async inputRun(requestId) {
      return (await source.pendingInputs()).find((r) => r.id === requestId)?.runId;
    },
    async artifactRun(artifactId) {
      return (await source.stores.artifacts.get(artifactId))?.producedBy.runId;
    },
    async claimRun(workItemId) {
      return (await source.stores.claims.get(workItemId))?.runId;
    },
    workflowExists(workflowId) {
      return source.workflows.has(workflowId.split("::")[0]!);
    },
  };
}

/** How deep a parent chain is followed before it is treated as broken (and so denied). */
const MAX_DEPTH = 64;
const MAX_CACHED = 50_000;

export interface RunRoot {
  rootRunId: string;
  workflowId: string;
}

export class RunAccess {
  private readonly facts = new Map<string, RunFacts>();

  constructor(
    readonly resolver: ResourceResolver,
    readonly ownership: OwnershipStore,
  ) {}

  /** Seed the cache from a row the caller already holds (a `runs.list` page carries both facts). */
  learn(runId: string, facts: RunFacts): void {
    if (this.facts.size >= MAX_CACHED) this.facts.clear();
    this.facts.set(runId, facts);
  }

  private async factsOf(runId: string): Promise<RunFacts | undefined> {
    const cached = this.facts.get(runId);
    if (cached) return cached;
    let found: RunFacts | undefined;
    try {
      found = await this.resolver.run(runId);
    } catch {
      // A log that cannot be read is a run this check cannot vouch for: deny, never allow.
      return undefined;
    }
    // Absence is not cached: the run may be created a moment from now.
    if (found) this.learn(runId, found);
    return found;
  }

  /** The run's root and the root's workflow, or `undefined` when the chain is missing or broken. */
  async root(runId: string): Promise<RunRoot | undefined> {
    let id = runId;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const facts = await this.factsOf(id);
      if (!facts) return undefined;
      if (!facts.parentRunId) return { rootRunId: id, workflowId: facts.workflowId };
      id = facts.parentRunId;
    }
    return undefined;
  }

  /**
   * Whether `principal` may see `runId`. For an unrestricted principal this is true without
   * a lookup - including for an id that names nothing, whose not-found is then the model's.
   */
  async allows(principal: Principal, runId: string): Promise<boolean> {
    if (isUnrestricted(principal.scope)) return true;
    const root = await this.root(runId);
    if (!root) return false;
    return this.rootAllows(principal, root);
  }

  rootAllows(principal: Principal, root: RunRoot): boolean {
    if (!workflowAllowed(principal.scope, root.workflowId)) return false;
    return principal.scope.runs === "all" || this.ownership.owner(root.rootRunId) === principal.id;
  }

  /** Whether `ancestor` is `runId` or one of its ancestors - "this run and its descendants". */
  async within(runId: string, ancestor: string): Promise<boolean> {
    let id: string | undefined = runId;
    for (let depth = 0; id && depth < MAX_DEPTH; depth++) {
      if (id === ancestor) return true;
      id = (await this.factsOf(id))?.parentRunId;
    }
    return false;
  }
}
