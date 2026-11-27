/** Guided launch workspace composed from shared primitives and injected protected admission ports. */
import { useEffect, useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
import type { WorkflowInputDeclarationView } from "@orca/protocol";
import { Button, Card, ConfigField, KeyValueList, Menu, ObjectId, StateView, Text } from "../ui/index.js";
import type { GuidedLaunchController } from "./controller.js";
import { launchReceipt } from "./controller.js";
import type { LaunchDraft, LaunchRoot, ProtectedStorageRefusalView } from "./contracts.js";
import { inputSensitive, parseInput } from "./input-model.js";
import { RequestOverrides, type RequestOverrideChoices } from "./request-overrides.js";
import { launchSelectionLines } from "../../../src/launch-provenance.js";
import "./guided-launch.css";

const STORAGE_TITLES: Record<ProtectedStorageRefusalView["reason"], string> = {
  "keyring-locked": "Keyring locked, not set up, or prompt cancelled",
  "no-keyring": "No system keyring available",
  unavailable: "Secure storage unavailable",
};

/**
 * The workspace-root menu's note: each root that cannot be chosen, named, with the reason
 * its evidence gives. Nothing at all when every root is verified, so the menu is the plain
 * list of choices it otherwise is.
 */
function rootNote(roots: readonly LaunchRoot[]): { note?: ReactNode } {
  const unavailable = roots.flatMap((root) =>
    root.evidence.state === "unavailable" ? [{ id: root.id, label: root.label, reason: root.evidence.reason }] : [],
  );
  if (unavailable.length === 0) return {};
  return {
    note: unavailable.map((root) => <div key={root.id}>{`${root.label}: ${root.reason}`}</div>),
  };
}

function InputField({
  name,
  field,
  vars,
  onChange,
  locked,
  protectedValue,
  rawText,
}: {
  name: string;
  field: WorkflowInputDeclarationView;
  vars: Record<string, unknown>;
  onChange: (vars: Record<string, unknown>, text: string | undefined) => boolean;
  locked: boolean;
  protectedValue: boolean;
  rawText: string | undefined;
}): JSX.Element {
  const present = Object.hasOwn(vars, name);
  const value = vars[name];
  const text = rawText ?? (present ? (typeof value === "string" ? value : (JSON.stringify(value) ?? "")) : "");
  const error = (() => {
    if (rawText === undefined || value !== undefined) return undefined;
    const parsed = parseInput(field, rawText);
    return parsed.ok ? "Review the value against the current input declaration." : parsed.message;
  })();
  const supported = ["string", "secret", "number", "integer", "boolean", "array", "object"].includes(field.type);
  return (
    <ConfigField
      label={name}
      path={`vars.${name}`}
      help={`${field.description ?? field.type}${field.type === "secret" ? "; the id of a configured secret, never its value" : ""}${field.required === true ? "; required" : ""}. Omitted values use runtime defaults.`}
      {...(error === undefined ? {} : { error })}
    >
      {(control) => (
        <>
          <input
            {...control}
            className="orca-input orca-text-mono-id"
            type={protectedValue || inputSensitive(field) ? "password" : "text"}
            value={text}
            disabled={locked || !supported}
            autoComplete="off"
            onChange={(event) => {
              if (locked) return;
              const raw = event.target.value;
              const parsed = parseInput(field, raw);
              // Invalid text must invalidate the old review/value, never silently submit the prior value.
              onChange({ ...vars, [name]: parsed.ok ? parsed.value : undefined }, raw);
            }}
          />
          <Button
            disabled={locked}
            disabledReason="The original launch intent is retained."
            onClick={() => {
              const next = { ...vars };
              delete next[name];
              onChange(next, undefined);
            }}
          >
            Omit value
          </Button>
          {field.nullable === true && (
            <Button
              disabled={locked}
              disabledReason="The original launch intent is retained."
              onClick={() => {
                onChange({ ...vars, [name]: null }, undefined);
              }}
            >
              Use null
            </Button>
          )}
          {!supported && <Text style="caption">This input type requires an updated editor.</Text>}
          <Text style="caption">
            {error ? "Invalid value" : present ? "Explicit value" : "Omitted"}
            {protectedValue || inputSensitive(field) ? "; value withheld from preview" : ""}
          </Text>
        </>
      )}
    </ConfigField>
  );
}

export interface GuidedLaunchProps {
  controller: GuidedLaunchController;
  requirePermissionReview?: boolean;
  protectedDraftsAvailable?: boolean;
  restoreAvailable?: boolean;
  /** Shared selection owner supplies only supported, authorized Request override controls. */
  requestOverrides?: (draft: LaunchDraft, edit: (draft: LaunchDraft) => void, locked: boolean) => ReactNode;
  overrideChoices?: RequestOverrideChoices;
  onConfiguration: () => void;
  onConnections: () => void;
  /** Parent layer owns Escape/focus restoration. Closing does not cancel server work. */
  onClose: () => void;
}
export function GuidedLaunch({
  controller,
  requirePermissionReview = false,
  protectedDraftsAvailable = true,
  restoreAvailable = true,
  requestOverrides,
  overrideChoices,
  onConfiguration,
  onConnections,
  onClose,
}: GuidedLaunchProps): JSX.Element {
  const state = useSyncExternalStore(controller.subscribe, controller.read);
  const { draft, context, review } = state;
  const [permissionConfirmed, confirmPermission] = useState(false);
  useEffect(() => confirmPermission(false), [review]);
  const workflow = context.workflows.find((w) => w.id === draft.workflowId);
  const selectedRoot = context.roots.find((root) => root.id === draft.rootId);
  const locked =
    state.busy ||
    state.intent !== undefined ||
    state.unresolvedReview !== undefined ||
    ["checking", "submitting", "recovering"].includes(state.phase);
  const reason = controller.disabledReason();
  const invalid = Object.values(draft.vars).some((value) => value === undefined);
  const receipt = state.result === undefined ? undefined : launchReceipt(state.result);
  const editableFields = Object.fromEntries(
    Object.entries(workflow?.inputSchema?.fields ?? {}).filter(
      ([name]) => draft.mode !== "request" || !["request", "__orcaAdmissionId"].includes(name),
    ),
  );
  const undeclared = Object.keys(draft.vars).filter((name) => !Object.hasOwn(editableFields, name));
  const edit = (next: LaunchDraft) => controller.edit(next);
  return (
    <section className="orca-guided-launch" aria-label="Guided launch">
      <Text style="body" as="h1">
        Launch work
      </Text>
      <ConfigField label="Launch mode" path="mode">
        {(control) => (
          <Menu
            label="Launch mode"
            triggerProps={control}
            triggerClassName="orca-input orca-text-label"
            items={[
              { id: "direct", label: "Start a workflow", disabled: locked },
              { id: "request", label: "Submit a Request", disabled: locked },
            ]}
            onChoose={(item) => edit({ ...draft, mode: item.id as LaunchDraft["mode"], overrides: undefined })}
          >
            {draft.mode === "direct" ? "Start a workflow" : "Submit a Request"}
          </Menu>
        )}
      </ConfigField>
      <Text style="caption">
        {draft.mode === "direct"
          ? "Starts a run without creating a Request."
          : "Creates a Request and admits its workflow."}
      </Text>
      <ConfigField label="Workspace root" path="root">
        {(control) => (
          <Menu
            label="Workspace root"
            triggerProps={control}
            triggerClassName="orca-input orca-text-label"
            items={context.roots.map((root) => ({
              id: root.id,
              label: root.label,
              disabled: locked || root.evidence.state !== "verified",
            }))}
            /* Why a root cannot be chosen is a sentence, so it is the menu's note rather
               than the item's `hint`: a hint is a one-word meta set uppercase and unwrapped,
               and a reason set there runs out past the menu's edge in capitals. */
            {...rootNote(context.roots)}
            onChoose={(item) => edit({ ...draft, rootId: item.id })}
          >
            {context.roots.find((root) => root.id === draft.rootId)?.label ?? "Choose a verified root"}
          </Menu>
        )}
      </ConfigField>
      <ConfigField label="Workflow" path="workflowId">
        {(control) => (
          <Menu
            label="Workflow"
            triggerProps={control}
            triggerClassName="orca-input orca-text-label"
            items={context.workflows
              .filter((w) => w.modes.includes(draft.mode) && w.rootIds.includes(draft.rootId))
              .map((w) => ({ id: w.id, label: `${w.name} (${w.version})`, disabled: locked }))}
            onChoose={(item) => edit({ ...draft, workflowId: item.id })}
          >
            {workflow === undefined ? "Choose a workflow" : `${workflow.name} (${workflow.version})`}
          </Menu>
        )}
      </ConfigField>
      {draft.mode === "request" && (
        <>
          <ConfigField label="Request title" path="title">
            {(control) => (
              <input
                {...control}
                className="orca-input orca-text-label"
                value={draft.title}
                disabled={locked}
                onChange={(event) => edit({ ...draft, title: event.target.value })}
              />
            )}
          </ConfigField>
          <ConfigField label="Request body" path="body">
            {(control) => (
              <textarea
                {...control}
                className="orca-input orca-text-body"
                value={draft.body}
                disabled={locked}
                onChange={(event) => edit({ ...draft, body: event.target.value })}
              />
            )}
          </ConfigField>
          {requestOverrides?.(draft, edit, locked)}
          {requestOverrides === undefined && overrideChoices !== undefined && (
            <RequestOverrides
              choices={overrideChoices}
              value={draft.overrides}
              locked={locked}
              onChange={(overrides) => edit({ ...draft, overrides })}
            />
          )}
          {requestOverrides === undefined && overrideChoices === undefined && (
            <Text style="caption">
              Request override choices are unavailable under the current configuration or authorization. Configured
              selections are checked by preflight.
            </Text>
          )}
          {workflow?.inputSchema?.fields.request !== undefined && (
            <Text style="caption">
              The submission service supplies the declared Request input from its title and body.
            </Text>
          )}
        </>
      )}
      {Object.entries(editableFields).map(([name, field]) => (
        <InputField
          key={`${draft.workflowId}:${state.draftTarget.epoch}:${state.inputEpoch}:${state.intent?.id ?? "unsent"}:${name}`}
          name={name}
          field={field}
          vars={draft.vars}
          rawText={state.inputText[name]}
          onChange={(vars, text) => {
            const inputText = { ...state.inputText };
            if (text === undefined) delete inputText[name];
            else inputText[name] = text;
            return controller.edit({ ...draft, vars }, inputText);
          }}
          locked={locked}
          protectedValue={state.withheldInputs.includes(name)}
        />
      ))}
      {undeclared.map((name) => (
        <div key={name}>
          <Text style="caption">
            Input {name} has no typed declaration. Its value is retained and withheld from preview.
          </Text>
          <Button
            disabled={locked}
            disabledReason="The original launch intent is retained."
            onClick={() => {
              const vars = { ...draft.vars };
              delete vars[name];
              edit({ ...draft, vars });
            }}
          >
            Omit undeclared input {name}
          </Button>
        </div>
      ))}
      <Card eyebrow="Target and configuration" className="orca-guided-launch__facts">
        <Text style="mono-id">
          {context.target.endpointId} / {context.target.workspaceId}
        </Text>
        <Text style="mono-id">Generation {context.activeGeneration}</Text>
        {selectedRoot?.evidence.state === "verified" && <Text style="caption">{selectedRoot.evidence.summary}</Text>}
        {workflow?.provenance.map((line, index) => (
          <Text key={index} style="mono-id">
            {line}
          </Text>
        ))}
        <Text style="caption">Publication is unavailable. Admission does not prove task completion.</Text>
      </Card>
      {review !== undefined && (
        <Card eyebrow="Launch preview" className="orca-guided-launch__facts">
          <Text style="mono-id">
            {review.workflowId} / {review.workflowVersion} / {review.workflowRevision}
          </Text>
          <Text style="mono-id">
            Root {review.rootId} / {review.rootRevision}
          </Text>
          {review.checkout?.state === "verified" && (
            <>
              <Text style="mono-id">
                Repository {review.checkout.repository} / base {review.checkout.baseCommit}
              </Text>
              <Text style="mono-id">
                {review.checkout.profile === "prepared-local"
                  ? `Cwd ${review.checkout.cwd} / branch ${review.checkout.branch}`
                  : `Worktree ${review.checkout.worktreeRoot} / branch prefix ${review.checkout.branchPrefix}`}
              </Text>
            </>
          )}
          {review.selectionProvenance === undefined ? (
            <Text style="caption">
              Resolved agent, model and instruction provenance is unavailable for this review.
            </Text>
          ) : (
            launchSelectionLines(review.selectionProvenance).map((line, index) => (
              <Text key={index} style="mono-id">
                {line}
              </Text>
            ))
          )}
          {/* The variables the command will send, in the display a run's variables are read in
              once it has started. A value is shown only when the review says it may be and this
              session has not withheld it; otherwise the name is listed as withheld and the
              value never reaches the document. */}
          <KeyValueList
            values={review.command.params.vars ?? {}}
            withheld={Object.keys(review.command.params.vars ?? {}).filter(
              (name) => !review.visibleInputs?.includes(name) || state.withheldInputs.includes(name),
            )}
          />
          {review.warnings.map((issue, index) => (
            <Text key={index} style="caption">
              {issue.path}: {issue.message}
            </Text>
          ))}
        </Card>
      )}
      {requirePermissionReview && review && (
        <ConfigField label="Permission review" path="permission-review">
          {(control) => (
            <label>
              <input
                {...control}
                type="checkbox"
                checked={permissionConfirmed}
                onChange={(event) => confirmPermission(event.target.checked)}
              />
              I reviewed the configured permission policy. This work may execute commands in the prepared checkout;
              permission requests still require their own confirmation.
            </label>
          )}
        </ConfigField>
      )}
      {state.storageRefusal !== undefined && state.phase === "review" ? (
        <StateView
          kind="error"
          title={STORAGE_TITLES[state.storageRefusal.reason]}
          body={state.storageRefusal.message}
          // A Linux keyring refusal holds until ORCA restarts, so only the OS keychain case retries here.
          {...(state.storageRefusal.reason === "unavailable"
            ? {
                action: {
                  label: "Retry launch",
                  onClick: () => {
                    void controller.retryProtectedStorage();
                  },
                },
              }
            : {})}
        />
      ) : (
        <Text style="body">{state.message}</Text>
      )}
      {state.errors.map((issue, index) => (
        <Text key={index} style="caption">
          {issue.path}: {issue.message}
        </Text>
      ))}
      {state.result !== undefined && (
        <Text style="mono-id">
          Original target {state.draftTarget.endpointId} / {state.draftTarget.workspaceId} /{" "}
          {"operationId" in state.result ? `Operation ${state.result.operationId} / ` : ""}
          {receipt === undefined ? "In progress" : `Admission ${receipt.admissionId} / ${receipt.state}`}
          {/* A receipt keeps its ids whole: it is the record of what was admitted. */}
          {receipt !== undefined && "requestId" in receipt && typeof receipt.requestId === "string" ? (
            <>
              {" / Request "}
              <ObjectId id={receipt.requestId} kind="request" variant="full" />
            </>
          ) : null}
          {receipt?.state === "accepted" ? (
            <>
              {" / run "}
              <ObjectId id={receipt.runId} kind="run" variant="full" />
            </>
          ) : null}
        </Text>
      )}
      <div className="orca-guided-launch__actions">
        <Button
          onClick={() => {
            void controller.preview();
          }}
          disabled={locked || reason !== undefined || invalid}
          disabledReason={
            reason ?? (invalid ? "Correct the invalid typed value before preview." : "The launch intent is retained.")
          }
        >
          Preview launch
        </Button>
        <Button
          tone="primary"
          onClick={() => {
            void controller.submit();
          }}
          disabled={
            state.busy || state.phase !== "review" || invalid || (requirePermissionReview && !permissionConfirmed)
          }
          disabledReason="Validate the exact command and review its permission policy before launching."
        >
          Launch
        </Button>
        {(state.intent !== undefined || state.unresolvedReview !== undefined) && (
          <Button
            onClick={() => {
              void controller.recover();
            }}
            disabled={state.busy || ["submitting", "checking"].includes(state.phase)}
            disabledReason="The launch is pending."
          >
            Recover original launch
          </Button>
        )}
        <Button
          onClick={() => {
            void controller.reviewTarget();
          }}
          disabled={state.busy || ["checking", "submitting"].includes(state.phase)}
          disabledReason="Pending work remains on its original target."
        >
          Review target
        </Button>
        <Button
          onClick={() => {
            void controller.saveDraft();
          }}
          disabled={locked || !protectedDraftsAvailable}
          disabledReason={
            protectedDraftsAvailable
              ? "A launch operation or protected read is pending."
              : "Protected unsent draft storage is unavailable. This session retains your draft."
          }
        >
          Save protected draft
        </Button>
        <Button
          onClick={() => {
            void controller.restore();
          }}
          disabled={state.busy || !restoreAvailable}
          disabledReason={
            restoreAvailable
              ? "A launch operation or protected read is pending."
              : "Choose the exact retained launch to restore."
          }
        >
          Restore protected launch
        </Button>
        <Button
          onClick={() => {
            void controller.loadDraft();
          }}
          disabled={state.busy || !protectedDraftsAvailable}
          disabledReason={
            protectedDraftsAvailable
              ? "A launch operation or protected read is pending."
              : "Protected unsent draft storage is unavailable. This session retains your draft."
          }
        >
          Restore protected draft
        </Button>
        <Button
          onClick={() => {
            void controller.newWork();
          }}
          disabled={state.busy}
          disabledReason="A launch operation or protected read is pending."
        >
          Start explicit new work
        </Button>
        <Button onClick={onConfiguration}>Edit configuration</Button>
        <Button onClick={onConnections}>Connection settings</Button>
        <Button onClick={onClose}>Close</Button>
      </div>
    </section>
  );
}
