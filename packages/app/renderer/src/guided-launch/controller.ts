/** Guided launch state machine with immutable review, target fences and opaque protected intents. */
import { RequestsSubmitParamsSchema, RunsAdmitParamsSchema } from "@orca/protocol";
import { LaunchPortFailure } from "./contracts.js";
import { inputSensitive } from "./input-model.js";
import { launchSelectionProvenance } from "../../../src/launch-provenance.js";
import type {
  LaunchContext,
  LaunchDraft,
  LaunchPorts,
  LaunchReceipt,
  LaunchResult,
  LaunchReview,
  LaunchState,
  LaunchTarget,
  ProtectedStorageRefusalView,
} from "./contracts.js";

export function sameLaunchTarget(a: LaunchTarget, b: LaunchTarget): boolean {
  return (
    a.endpointId === b.endpointId &&
    a.workspaceId === b.workspaceId &&
    a.instanceId === b.instanceId &&
    a.principalId === b.principalId &&
    a.epoch === b.epoch
  );
}
function sameScope(a: LaunchTarget, b: LaunchTarget): boolean {
  return a.endpointId === b.endpointId && a.workspaceId === b.workspaceId && a.principalId === b.principalId;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function launchReceipt(result: LaunchResult): LaunchReceipt | undefined {
  return result.state === "in-progress" ? undefined : result.state === "resolved" ? result.result : result;
}
function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(jsonValue)
  );
}
function protectedInputs(context: LaunchContext, draft: LaunchDraft, previous: readonly string[] = []): string[] {
  const fields = context.workflows.find((workflow) => workflow.id === draft.workflowId)?.inputSchema?.fields ?? {};
  return [
    ...new Set([
      ...previous,
      ...Object.entries(fields)
        .filter(([, field]) => inputSensitive(field))
        .map(([name]) => name),
      ...Object.keys(draft.vars).filter((name) => !Object.hasOwn(fields, name)),
    ]),
  ];
}
/** Recovery found the journal readable and no retained launch for the refused review. */
class VerifiedNewLaunch extends Error {}
/** No connection, persistence or retry implementation: all effects go through the shared owner. */
export class GuidedLaunchController {
  private state: LaunchState;
  private listeners = new Set<() => void>();
  private get pending(): boolean {
    return this.state.busy;
  }
  private set pending(value: boolean) {
    this.update({ busy: value });
  }
  private fence = 0;
  /**
   * Set when this submit was refused because an existing protected journal could not be read
   * (`unconfirmed`): nothing was sent by it, but an earlier retained launch may exist. Recover
   * then reads the journal; if it finds no retained launch for this review, the review is
   * verified as new and becomes launchable again (#857 review).
   */
  private storageUnconfirmedSubmit = false;
  constructor(
    context: LaunchContext,
    draft: LaunchDraft,
    private readonly ports: LaunchPorts,
  ) {
    this.state = freeze({
      context: structuredClone(context),
      draftTarget: structuredClone(context.target),
      draft: structuredClone(draft),
      sequence: 0,
      inputEpoch: 0,
      inputText: {},
      busy: false,
      withheldInputs: protectedInputs(context, draft),
      phase: "editing",
      message: "",
      errors: [],
    });
  }
  read = (): LaunchState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<LaunchState>): void {
    // A storage refusal describes one refused submit; any other phase change retires it.
    if (patch.phase !== undefined && !Object.hasOwn(patch, "storageRefusal"))
      patch = { ...patch, storageRefusal: undefined };
    this.state = freeze({ ...this.state, ...patch });
    this.listeners.forEach((listener) => listener());
  }
  private block(message: string): void {
    this.update({ phase: "blocked", message, review: undefined });
    this.ports.announce(message);
  }
  contextChanged(context: LaunchContext): void {
    this.fence += 1;
    this.update({
      context: structuredClone(context),
      review: undefined,
      withheldInputs: protectedInputs(context, this.state.draft, this.state.withheldInputs),
    });
    this.block(
      sameLaunchTarget(context.target, this.state.draftTarget)
        ? "Configuration or connection changed. Review the draft again."
        : "Target changed. Return to the original target to recover pending work, or explicitly review this draft for the new target.",
    );
  }
  edit(draft: LaunchDraft, inputText?: Readonly<Record<string, string>>): boolean {
    if (this.pending || this.state.intent !== undefined || this.state.unresolvedReview !== undefined) return false;
    this.fence += 1;
    this.update({
      draft: structuredClone(draft),
      inputText: structuredClone(
        inputText ??
          Object.fromEntries(
            Object.entries(this.state.inputText).filter(
              ([name]) => Object.hasOwn(draft.vars, name) && draft.vars[name] === this.state.draft.vars[name],
            ),
          ),
      ),
      sequence: this.state.sequence + 1,
      phase: "editing",
      review: undefined,
      errors: [],
      message: "",
      withheldInputs: protectedInputs(this.state.context, draft, this.state.withheldInputs),
    });
    return true;
  }
  /** Explicit target review can transfer only an unsent draft. Pending intents never transfer. */
  reviewTarget(): void {
    if (this.pending) return;
    if (
      (this.state.intent !== undefined || this.state.unresolvedReview !== undefined) &&
      !sameScope(this.state.draftTarget, this.state.context.target)
    )
      return;
    this.fence += 1;
    this.update({
      draftTarget: structuredClone(this.state.context.target),
      phase: "editing",
      review: undefined,
      message:
        this.state.intent === undefined && this.state.unresolvedReview === undefined
          ? "Target reviewed. Validate the workflow and inputs before launching."
          : "Original target scope reviewed after reconnect. Recover the retained intent under current authority.",
    });
  }
  disabledReason(): string | undefined {
    const { context, draft, draftTarget } = this.state;
    if (!sameLaunchTarget(context.target, draftTarget)) return "Review the target before launching.";
    if (context.unavailableReason !== undefined) return context.unavailableReason;
    const reason = draft.mode === "direct" ? context.directReason : context.requestReason;
    if (reason !== undefined) return reason;
    if ((this.ports.retain === undefined || this.ports.submit === undefined) && this.ports.launch === undefined)
      return "Protected guided-launch intent storage is unavailable.";
    const root = context.roots.find((r) => r.id === draft.rootId);
    if (root?.evidence.state !== "verified") return root?.evidence.reason ?? "Choose a verified workspace root.";
    const workflow = context.workflows.find((w) => w.id === draft.workflowId);
    if (!workflow?.modes.includes(draft.mode) || !workflow.rootIds.includes(draft.rootId))
      return "Choose a supported workflow for this root and launch mode.";
    if (!context.activeGeneration || !workflow.version || !workflow.revision)
      return "The active configuration and workflow binding are unavailable.";
    return undefined;
  }
  async preview(): Promise<void> {
    if (this.pending || this.state.intent !== undefined || this.state.unresolvedReview !== undefined) return;
    const reason = this.disabledReason();
    if (reason !== undefined) {
      this.block(reason);
      return;
    }
    const { context, draft, sequence, draftTarget } = this.state;
    const workflow = context.workflows.find((w) => w.id === draft.workflowId)!;
    const root = context.roots.find((r) => r.id === draft.rootId)!;
    if (root.evidence.state !== "verified") return;
    if (!jsonValue(draft.vars)) {
      this.block("Correct the invalid typed input before preview. Your draft is retained.");
      return;
    }
    if (draft.mode === "direct" && draft.overrides !== undefined) {
      this.block("Direct workflow launches do not support overrides.");
      return;
    }
    const fence = this.fence;
    this.pending = true;
    this.update({ phase: "checking", errors: [], message: "Validating inputs and the active configuration." });
    try {
      const result = await this.ports.preflight({
        target: draftTarget,
        mode: draft.mode,
        rootId: root.id,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        expectedWorkflowRevision: workflow.revision,
        expectedConfigGeneration: context.activeGeneration,
        vars: draft.vars,
        ...(draft.overrides === undefined ? {} : { overrides: draft.overrides }),
        ...(draft.mode === "request" ? { request: { title: draft.title, body: draft.body } } : {}),
      });
      if (fence !== this.fence) return;
      if (
        result.target.workspaceId !== draftTarget.workspaceId ||
        result.target.instanceId !== draftTarget.instanceId ||
        result.workflowId !== workflow.id ||
        result.workflowVersion !== workflow.version ||
        result.expectedWorkflowRevision !== workflow.revision ||
        result.expectedConfigGeneration !== context.activeGeneration ||
        result.rootId !== root.id ||
        result.rootRevision !== root.evidence.revision
      ) {
        this.block("The workflow, target or active configuration changed. Refresh and review again.");
        return;
      }
      if (!result.validation.ok || result.validation.errors.length !== 0) {
        this.update({ errors: result.validation.errors });
        this.block("Inputs could not be validated. Your draft is retained.");
        return;
      }
      const guards = {
        workflowId: workflow.id,
        workflowVersion: result.workflowVersion,
        expectedWorkflowRevision: result.expectedWorkflowRevision,
        expectedConfigGeneration: result.expectedConfigGeneration,
        vars: draft.vars,
      };
      const fields = result.inputSchema?.fields ?? {};
      const withheldInputs = [
        ...new Set([
          ...this.state.withheldInputs,
          ...Object.keys(draft.vars).filter((name) => !Object.hasOwn(fields, name)),
          ...Object.entries(fields)
            .filter(([, field]) => inputSensitive(field))
            .map(([name]) => name),
        ]),
      ];
      const selectionProvenance = launchSelectionProvenance(result);
      const command =
        draft.mode === "direct"
          ? {
              mode: "direct" as const,
              params: RunsAdmitParamsSchema.parse(guards),
            }
          : {
              mode: "request" as const,
              params: RequestsSubmitParamsSchema.parse({
                ...guards,
                title: draft.title,
                body: draft.body,
                ...(draft.overrides === undefined ? {} : { overrides: draft.overrides }),
              }),
            };
      const review: LaunchReview = {
        target: draftTarget,
        draftSequence: sequence,
        rootId: root.id,
        rootRevision: root.evidence.revision,
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        workflowRevision: workflow.revision,
        generation: context.activeGeneration,
        command,
        warnings: result.validation.warnings,
        visibleInputs: Object.keys(fields).filter((name) => !withheldInputs.includes(name)),
        ...(selectionProvenance === undefined ? {} : { selectionProvenance }),
        ...(result.checkout === undefined ? {} : { checkout: result.checkout }),
      };
      this.update({
        phase: "review",
        review,
        withheldInputs,
        message: "Review the exact target, workflow and inputs before launching.",
      });
    } catch (error) {
      if (fence === this.fence)
        this.block(
          error instanceof LaunchPortFailure
            ? this.failureMessage(error)
            : "Validation is unavailable or the command is invalid. Your draft is retained.",
        );
    } finally {
      this.pending = false;
    }
  }
  async submit(): Promise<void> {
    if (this.pending || this.state.phase !== "review" || this.state.review === undefined) return;
    const reason = this.disabledReason();
    if (reason !== undefined) {
      this.block(reason);
      return;
    }
    const review = this.state.review;
    const retain = this.ports.retain;
    const launch = this.ports.launch;
    if (retain === undefined && launch === undefined) return;
    this.pending = true;
    const fence = this.fence;
    this.update({ phase: "submitting", message: "Retaining the protected launch intent." });
    if (launch !== undefined) {
      this.storageUnconfirmedSubmit = false;
      this.update({ unresolvedReview: review });
      try {
        await this.receive(
          async () => {
            const result = await launch(review);
            this.update({ intent: result.intent, unresolvedReview: undefined });
            return result.response;
          },
          fence,
          review,
        );
      } finally {
        this.pending = false;
      }
      return;
    }
    try {
      const intent = await retain!(review);
      this.update({ intent });
      if (fence !== this.fence) return;
      this.update({ message: "Submitting the retained launch intent." });
      await this.receive(() => this.ports.submit!(intent), fence, review);
    } catch (error) {
      if (fence !== this.fence) return;
      if (
        error instanceof LaunchPortFailure &&
        error.storage?.stage === "before-send" &&
        this.state.intent === undefined
      )
        this.refuseStorage(review, error.storage);
      else if (error instanceof LaunchPortFailure && error.storage !== undefined)
        this.block(this.failureMessage(error));
      else
        this.block(
          "Protected intent storage is unavailable. No launch was sent by this controller; your draft is retained.",
        );
    } finally {
      this.pending = false;
    }
  }
  async recover(): Promise<void> {
    if (!this.pending && this.state.intent === undefined && this.state.unresolvedReview !== undefined) {
      const review = this.state.unresolvedReview;
      if (this.ports.resolveIntent !== undefined) {
        if (
          !sameScope(review.target, this.state.context.target) ||
          !sameLaunchTarget(this.state.draftTarget, this.state.context.target) ||
          this.state.context.unavailableReason ||
          this.state.context.recoveryReason
        ) {
          this.block("Review the original authorized target before recovering the exact protected launch.");
          return;
        }
        this.pending = true;
        const fence = this.fence;
        this.update({
          phase: "recovering",
          message: "Looking up the exact protected launch, without submitting new work.",
        });
        try {
          await this.receive(async () => {
            const intent = await this.ports.resolveIntent!(review);
            if (fence !== this.fence) throw new LaunchPortFailure("stale");
            if (!intent && this.storageUnconfirmedSubmit) throw new VerifiedNewLaunch();
            if (!intent) throw new LaunchPortFailure("unavailable");
            this.storageUnconfirmedSubmit = false;
            this.update({ intent, unresolvedReview: undefined });
            return this.ports.recover(intent);
          }, fence);
        } finally {
          this.pending = false;
        }
        return;
      }
      if (!sameLaunchTarget(review.target, this.state.context.target) || this.ports.launch === undefined) {
        this.block(
          "The protected intent handle is unavailable after target/configuration movement. Inspect retained work through the original main-owned connection; do not submit new work.",
        );
        return;
      }
      const { context, draft } = this.state;
      const reason =
        context.unavailableReason ?? (draft.mode === "direct" ? context.directReason : context.requestReason);
      if (reason !== undefined) {
        this.block(reason);
        return;
      }
      this.pending = true;
      const fence = this.fence;
      this.update({
        phase: "recovering",
        message: "Retrying the exact original review through protected main ownership.",
      });
      try {
        await this.receive(
          async () => {
            const result = await this.ports.launch!(review);
            this.update({ intent: result.intent, unresolvedReview: undefined });
            return result.response;
          },
          fence,
          review,
        );
      } finally {
        this.pending = false;
      }
      return;
    }
    if (
      this.pending ||
      this.state.intent === undefined ||
      !sameLaunchTarget(this.state.draftTarget, this.state.context.target)
    )
      return;
    // Recovery must not depend on changed workflow/configuration choices; only current authority/target.
    const { context } = this.state;
    const authority = context.unavailableReason ?? context.recoveryReason;
    if (authority !== undefined) {
      this.block(authority);
      return;
    }
    this.pending = true;
    this.update({ phase: "recovering", message: "Recovering the original protected intent." });
    try {
      await this.receive(() => this.ports.recover(this.state.intent!), this.fence);
    } finally {
      this.pending = false;
    }
  }
  private async receive(call: () => Promise<LaunchResult>, fence: number, review?: LaunchReview): Promise<void> {
    try {
      const result = await call();
      if (fence !== this.fence) return;
      this.update({ result });
      const receipt = launchReceipt(result);
      if (receipt?.state === "accepted") {
        if ((this.state.draft.mode === "request") !== "requestId" in receipt) {
          this.block("The admission receipt does not match the retained launch mode. Recover the original intent.");
          return;
        }
        this.update({ phase: "admitted", message: "Work admitted. Execution is not yet confirmed complete." });
        try {
          this.ports.navigate(receipt, review?.target ?? this.state.draftTarget);
        } catch {
          this.update({
            message: "Work admitted. Navigation is unavailable; use the persistent receipt to open the original work.",
          });
        }
      } else
        this.update({
          phase: "recovering",
          message: "Admission is unresolved. Recover the retained intent to inspect or reconcile it.",
        });
    } catch (error) {
      // Only a confirmed before-send refusal means nothing was sent, so only then does the exact
      // review stay ready for a fresh Retry. After a send, or when retained intents could not be
      // read, block instead: the intent and unresolved review stay, and Recover is the way on.
      if (
        fence === this.fence &&
        error instanceof LaunchPortFailure &&
        error.storage?.stage === "before-send" &&
        review &&
        this.state.intent === undefined
      )
        this.refuseStorage(review, error.storage);
      else if (fence === this.fence && error instanceof VerifiedNewLaunch) this.verifiedNew();
      else if (fence === this.fence && error instanceof LaunchPortFailure) {
        if (error.storage?.stage === "unconfirmed" && review && this.state.intent === undefined)
          this.storageUnconfirmedSubmit = true;
        this.block(this.failureMessage(error));
      } else if (fence === this.fence)
        this.update({
          phase: "recovering",
          message: "The launch acknowledgement is unavailable. Recover the original intent; do not submit new work.",
        });
    }
  }
  /** The journal is readable again and holds no retained launch for the refused review. */
  private verifiedNew(): void {
    const review = this.state.unresolvedReview;
    this.storageUnconfirmedSubmit = false;
    if (review === undefined) return;
    const message =
      "Secure storage is available and no retained launch exists for this review, so nothing was submitted. Choose Launch to send it.";
    this.update({ phase: "review", review, unresolvedReview: undefined, message });
    this.ports.announce(message);
  }
  private refuseStorage(review: LaunchReview, storage: ProtectedStorageRefusalView): void {
    const message = `${storage.message} Your draft is retained.`;
    this.update({
      phase: "review",
      review,
      unresolvedReview: undefined,
      storageRefusal: { reason: storage.reason, stage: storage.stage, message },
      message,
    });
    this.ports.announce(message);
  }
  /** Retry after a protected-storage refusal: the same reviewed command, checked again by main. */
  async retryProtectedStorage(): Promise<void> {
    if (this.state.storageRefusal === undefined) return;
    await this.submit();
  }
  private failureMessage(error: LaunchPortFailure): string {
    if (error.storage !== undefined)
      return `${error.storage.message} Your draft and any retained intent are preserved; choose Recover original launch once storage is available.`;
    const messages = {
      unauthorized:
        "Current authorization refused the launch operation. Your draft and any retained intent are preserved.",
      stale: "The target, workflow or active configuration is stale. Your draft and any retained intent are preserved.",
      validation: "The runtime refused input validation. Your draft and any retained intent are preserved.",
      unavailable: "The launch operation is unavailable. Your draft and any retained intent are preserved.",
      "protected-storage":
        "Secure run-intent storage is unavailable. Restore the OS keychain, then retry. Your draft and any retained intent are preserved.",
    };
    return messages[error.reason];
  }
  async saveDraft(): Promise<void> {
    if (this.pending || this.state.intent !== undefined || this.state.unresolvedReview !== undefined) return;
    if (!jsonValue(this.state.draft.vars)) {
      this.block("Correct invalid typed values before saving a protected draft. The draft remains in this session.");
      return;
    }
    if (this.ports.drafts === undefined) {
      this.block("Protected guided-draft persistence is unavailable. The draft remains in this session only.");
      return;
    }
    const fence = this.fence;
    const { draftTarget, draft } = this.state;
    this.pending = true;
    try {
      await this.ports.drafts.save(draftTarget, draft);
      if (fence === this.fence) this.update({ message: "Draft saved through protected storage." });
    } catch {
      if (fence === this.fence) this.block("Protected draft storage failed. Your draft is retained in this session.");
    } finally {
      this.pending = false;
    }
  }
  async loadDraft(): Promise<void> {
    if (this.pending || this.state.intent !== undefined || this.state.unresolvedReview !== undefined) return;
    if (this.ports.drafts === undefined) {
      this.block("Protected guided-draft persistence is unavailable.");
      return;
    }
    const target = this.state.draftTarget;
    const fence = this.fence;
    this.pending = true;
    this.update({ message: "Reading the protected draft. Editing is paused until the read finishes." });
    try {
      const draft = await this.ports.drafts.load(target);
      if (fence !== this.fence) return;
      if (draft === undefined) {
        this.update({ message: "No protected draft was found. Your current draft is retained." });
        return;
      }
      this.update({
        draft: structuredClone(draft),
        sequence: this.state.sequence + 1,
        inputEpoch: this.state.inputEpoch + 1,
        inputText: {},
        withheldInputs: [...new Set([...this.state.withheldInputs, ...Object.keys(draft.vars)])],
        review: undefined,
        phase: "editing",
        message: "Protected draft restored. Review target, configuration and inputs before launching.",
      });
    } catch {
      if (fence === this.fence) this.block("Protected draft recovery failed. Your current draft is retained.");
    } finally {
      this.pending = false;
    }
  }
  async restore(): Promise<void> {
    if (this.pending || this.state.intent !== undefined) return;
    if (this.state.unresolvedReview !== undefined) {
      this.block("The current launch intent is unresolved. Recover it before restoring another protected launch.");
      return;
    }
    if (this.ports.restore === undefined) {
      this.block("Protected guided-launch restart recovery is unavailable.");
      return;
    }
    const target = this.state.context.target;
    const fence = this.fence;
    this.pending = true;
    this.update({ message: "Reading the protected launch. Editing is paused until the read finishes." });
    try {
      const saved = await this.ports.restore(target);
      if (fence !== this.fence) return;
      if (saved === undefined) {
        this.update({ message: "No protected launch was found. Your current draft is retained." });
        return;
      }
      if (!sameScope(saved.review.target, target)) {
        this.block("The saved intent belongs to another target or principal.");
        return;
      }
      this.update({
        draft: structuredClone(saved.draft),
        draftTarget: structuredClone(target),
        sequence: saved.review.draftSequence,
        inputEpoch: this.state.inputEpoch + 1,
        inputText: {},
        withheldInputs: [
          ...new Set([
            ...this.state.withheldInputs,
            ...Object.keys(saved.draft.vars),
            ...Object.keys(saved.review.command.params.vars ?? {}),
          ]),
        ],
        review: structuredClone(saved.review),
        intent: saved.intent,
        unresolvedReview: undefined,
        phase: "recovering",
        message: "A protected launch intent was restored. Recover its original outcome.",
      });
    } catch {
      if (fence === this.fence) this.block("The protected launch intent could not be restored.");
    } finally {
      this.pending = false;
    }
  }
  async newWork(): Promise<void> {
    if (this.pending) return;
    if (this.state.unresolvedReview !== undefined) {
      this.block(
        "The original launch acknowledgement and intent handle are unresolved. Recover or inspect its protected main-owned intent before starting new work.",
      );
      return;
    }
    if (this.state.intent !== undefined) {
      if (!sameLaunchTarget(this.state.draftTarget, this.state.context.target)) {
        this.block("Return to the original target before abandoning this intent.");
        return;
      }
      const abandon = this.ports.abandon;
      if (abandon === undefined) {
        this.block("Explicit intent abandonment is unavailable. Recover the original work first.");
        return;
      }
      const intent = this.state.intent;
      const target = this.state.draftTarget;
      this.pending = true;
      try {
        // Main rechecks authority and confirms abandonment. A same-target context refresh
        // invalidates launch reviews, but must not resurrect that acknowledged old handle.
        if (
          !(await abandon(intent)) ||
          !sameLaunchTarget(target, this.state.context.target) ||
          this.state.intent?.id !== intent.id
        )
          return;
      } catch {
        this.block("The original intent could not be abandoned. Recover it before starting new work.");
        return;
      } finally {
        this.pending = false;
      }
    }
    this.fence += 1;
    this.update({
      phase: "editing",
      intent: undefined,
      review: undefined,
      result: undefined,
      errors: [],
      sequence: this.state.sequence + 1,
      message: "New work selected. Review before launching; previous work was not cancelled.",
    });
  }
}
