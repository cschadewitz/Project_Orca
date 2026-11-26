/** Actual Config route over the shared feed and merged #333 controls; Save and Apply stay separate. */
import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import type { ConfigDocument } from "@orca/protocol";
import type { ConnectionState } from "@orca/design";
import { useSurfaceDensity } from "../appearance-context.js";
import { useKeyboard } from "../keyboard-context.js";
import { scopeProps } from "../keyboard-map.js";
import { Button, ObjectHeader, StateView, Text, textClass } from "../ui/index.js";
import { ConnectionSource } from "../daemon-connection/source.js";
import { SURFACES } from "../chrome/surfaces.js";
import { useSidebarCollapsed } from "../chrome/use-breakpoints.js";
import { useConfig } from "./config-context.js";
import { sameEditorTarget } from "./configuration-adapter.js";
import { useConfigurationStudio } from "./configuration-studio-context.js";
import { StructuredForm } from "./structured-form/structured-form.js";
import { pathLabel } from "./structured-form/collection-model.js";
import { RawView } from "./raw-view.js";
import { CapabilityPreview } from "./capability-preview-view.js";
import { PermissionsView } from "./permissions-view.js";
import { PreferencesSection } from "./preferences-section.js";
import { StorageSection } from "./storage-section.js";
import { JudgeSetup } from "./judge-setup.js";
import { agentPolicies } from "./config-model.js";
import { DiagnosticsSection } from "../diagnostics/diagnostics-section.js";
import { FirstRunSection } from "../first-run/first-run-section.js";
import type { ReopenBinding } from "../first-run/reopen-binding.js";
import { TemplateStudioSurface } from "../template-authoring/surface.js";
import { useTemplateStudio } from "../template-authoring/context.js";
import { configurationReferenceChoices } from "./reference-choices.js";

export function ConfigurationStudioSurface({
  connection,
  open,
  launch,
  onLaunch,
  onCloseLaunch,
}: {
  connection: ConnectionState;
  open?: ConfigDocument;
  launch?: ReactNode;
  onLaunch?: () => void;
  /** Leaves Launch work for the configuration; the header's views call it first (#1112). */
  onCloseLaunch?: () => void;
}): JSX.Element {
  useSurfaceDensity();
  const narrow = useSidebarCollapsed();
  const feed = useConfig();
  const studio = useConfigurationStudio();
  const templateStudio = useTemplateStudio().studio;
  const keyboard = useKeyboard();
  const [replace, setReplace] = useState<"form" | "raw">();
  const [privatePreview, setPrivatePreview] = useState(false);
  const [policyConfirmed, setPolicyConfirmed] = useState(false);
  const [templates, showTemplates] = useState(false);
  const sequence = studio?.state.sequence;
  useEffect(() => {
    setPolicyConfirmed(false);
    setPrivatePreview(false);
  }, [sequence]);
  const switchMode = useCallback(
    (mode: "form" | "raw") => {
      showTemplates(false);
      if (studio && !studio.switchMode(mode)) setReplace(mode);
    },
    [studio],
  );
  useEffect(() => {
    if (open === "config") switchMode("raw");
  }, [open, switchMode]);
  const save = useRef(() => {
    void studio?.save(policyConfirmed);
  });
  save.current = () => {
    void studio?.save(policyConfirmed);
  };
  const canSave = !launch && studio?.review !== undefined && !studio.busy && studio.reason("save") === undefined;
  useEffect(() => {
    if (!canSave || templates) return;
    return keyboard.register({
      scope: "config",
      key: "Mod+S",
      label: "Save reviewed configuration",
      action: () => save.current(),
    });
  }, [canSave, templates, keyboard]);
  const sourceAuthorized = studio?.readable ?? true;
  const data = sourceAuthorized
    ? (studio?.source ?? (feed.state.phase === "ready" ? feed.state.data : undefined))
    : undefined;
  // Sidecar notifications remain current while the config session retains its original base.
  const permissions =
    sourceAuthorized && feed.state.phase === "ready" && (!studio || sameEditorTarget(feed.state.target, studio.target))
      ? feed.state.data
      : data;
  const state = studio?.state;
  const review = studio?.review;
  const generation = data?.generation;
  return (
    <div
      className="orca-config"
      data-surface="config"
      data-config-layout={narrow ? "stacked" : "columns"}
      {...scopeProps("config")}
    >
      {window.orca.daemonConnection && <ConnectionSource bridge={window.orca.daemonConnection} />}
      <ObjectHeader
        crumbs={[{ type: "config", id: data?.config.path ?? "config", label: "Configuration", current: true }]}
        actions={
          <div className="orca-seg" role="group" aria-label="View">
            {onLaunch && !launch && (
              <Button onClick={onLaunch} data-launch-entry>
                Launch work
              </Button>
            )}
            {/* The views stay in the header while Launch work is open, so there is a way back
                to the configuration from where a person looks for one (#1112). Choosing one
                leaves Launch work first; none of them is pressed while it is open. */}
            <button
              type="button"
              className={`orca-seg__btn ${textClass("label")}`}
              aria-pressed={!launch && templates}
              onClick={() => {
                onCloseLaunch?.();
                showTemplates(true);
              }}
            >
              Templates
            </button>
            {(["form", "raw"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`orca-seg__btn ${textClass("label")}`}
                aria-pressed={!launch && !templates && (studio?.mode ?? "form") === mode}
                onClick={() => {
                  onCloseLaunch?.();
                  switchMode(mode);
                }}
              >
                {mode === "form" ? "Form" : "Raw"}
              </button>
            ))}
          </div>
        }
      />
      <div className="orca-config__body">
        <FirstRunSection key="first-run" />
        <DiagnosticsSection key="diagnostics" />
        {launch ? (
          launch
        ) : templates ? (
          <TemplateStudioSurface />
        ) : !sourceAuthorized ? (
          <StateView
            kind="disconnected"
            title="Configuration source withheld"
            body="Source authority or daemon target changed. Retained edits remain private until access is restored and current state is reviewed."
          />
        ) : !data ? (
          feed.state.phase === "error" ? (
            <StateView
              kind="error"
              title="Read configuration"
              body="The daemon could not provide the configuration. Read current state before editing."
              action={{ label: "Read current configuration", onClick: feed.reload }}
            />
          ) : (
            <StateView kind="loading" title="Read configuration" />
          )
        ) : !studio ? (
          <StateView
            kind="disconnected"
            title="Waiting for an authoritative daemon target"
            body="Editor actions remain unavailable until workspace and instance identity are known."
          />
        ) : (
          <>
            {replace && (
              <section aria-label="Replace configuration draft">
                <Text style="body">
                  Switching to {replace === "raw" ? "Raw" : "Form"} replaces the unsaved draft. Keep editing or
                  explicitly discard it.
                </Text>
                <Button
                  disabled={studio.busy}
                  onClick={() => {
                    if (studio.switchMode(replace, true)) setReplace(undefined);
                  }}
                >
                  Discard draft and switch
                </Button>
                <Button onClick={() => setReplace(undefined)}>Keep editing</Button>
              </section>
            )}
            {connection !== "live" && (
              <Text style="caption">Last-known configuration. Wait for the connection before sending changes.</Text>
            )}
            {studio.mode === "form" ? (
              studio.shape ? (
                <StructuredForm
                  shape={studio.shape}
                  value={studio.value}
                  path={[]}
                  label="Configuration"
                  errors={state?.errors ?? []}
                  access={(edits) => studio.editAccess(edits)}
                  onEdit={(edits) => studio.edit(edits)}
                  rowKey={studio.rowKey}
                  referenceChoices={(path) =>
                    configurationReferenceChoices(studio.value, templateStudio?.adapter.current, path)
                  }
                  onShowRaw={() => switchMode("raw")}
                />
              ) : (
                <StateView
                  kind="empty"
                  title="Structured metadata unavailable"
                  body="Use the authorized raw editor; values are not inferred from the legacy schema."
                />
              )
            ) : (
              <RawView
                path={data.config.path}
                text={studio.raw}
                label="orca.config.yaml"
                autoFocus={open === "config"}
                {...(!studio.reason("validate") ? { onChange: (text: string) => studio.editRaw(text) } : {})}
              />
            )}
            {state && (
              <section aria-label="Configuration review and activation" className="orca-config__section">
                {studio.reopenBinding && <ReopenBindingNotice binding={studio.reopenBinding} />}
                {state.message && (
                  <Text style="body">
                    {state.message}
                    {studio.reopenBinding?.state === "refused" && state.message.startsWith("Apply outcome:")
                      ? " The saved configuration is not bound for reopening, so a restart will not open this workspace until it is."
                      : ""}
                  </Text>
                )}
                {state.errors.length > 0 && (
                  <ul>
                    {state.errors.map((error, index) => (
                      <li key={index}>
                        <Text style="caption">
                          {error.path.length ? `${pathLabel(error.path)}: ` : ""}
                          {error.message}
                        </Text>
                      </li>
                    ))}
                  </ul>
                )}
                {review && (
                  <>
                    <Text style="heading" as="h2">
                      Review configuration changes
                    </Text>
                    <Text style="caption">
                      Values are withheld from this summary. Save uses these exact reviewed candidate bytes.
                    </Text>
                    <ul>
                      {review.changes.map((change, index) => (
                        <li key={index}>
                          <Text style="mono-id">{change.path.length ? pathLabel(change.path) : "Configuration"}</Text>{" "}
                          <Text style="caption">{change.kind}</Text>
                        </li>
                      ))}
                    </ul>
                    {!review.changes.length && (
                      <Text style="caption">Parsed values are unchanged; review the private source formatting.</Text>
                    )}
                    {review.capabilities && <CapabilityPreview agents={review.capabilities} />}
                    <Button onClick={() => setPrivatePreview((current) => !current)}>Review private YAML</Button>
                    {privatePreview && (
                      <RawView
                        path={data.config.path}
                        text={studio.privateCandidate ?? ""}
                        label="Reviewed configuration candidate"
                      />
                    )}
                    {studio.policyChange() && (
                      <label className={textClass("caption")}>
                        <input
                          type="checkbox"
                          checked={policyConfirmed}
                          onChange={(event) => setPolicyConfirmed(event.target.checked)}
                        />
                        Confirm the reviewed permission-policy changes
                      </label>
                    )}
                  </>
                )}
                {studio.dirty && (
                  <div
                    className={`orca-draftbar ${textClass("caption")}`}
                    role="group"
                    aria-label="Unsaved configuration changes"
                  >
                    <Text style="caption">Draft retained in this window</Text>
                    <Button
                      disabled={studio.busy || !!studio.reason("validate")}
                      {...(studio.reason("validate") ? { disabledReason: studio.reason("validate")! } : {})}
                      onClick={() => {
                        void studio.validate();
                      }}
                    >
                      Validate and review
                    </Button>
                    <Button
                      tone="primary"
                      disabled={!canSave || (!!review && studio.policyChange() && !policyConfirmed)}
                      disabledReason={studio.reason("save") ?? "Validate and review this draft before saving."}
                      onClick={() => {
                        void studio.save(policyConfirmed);
                      }}
                    >
                      Save reviewed changes
                    </Button>
                    <Button disabled={studio.busy} onClick={() => studio.discard()}>
                      Discard draft
                    </Button>
                  </div>
                )}
                {state.phase === "saved" && (
                  <Button
                    disabled={studio.busy || !!studio.reason("apply")}
                    {...(studio.reason("apply") ? { disabledReason: studio.reason("apply")! } : {})}
                    onClick={() => {
                      void studio.apply();
                    }}
                  >
                    Apply saved configuration
                  </Button>
                )}
                <Button
                  disabled={studio.busy}
                  onClick={() => {
                    void studio.readCurrent();
                  }}
                >
                  Read current configuration
                </Button>
                {studio.frozen && (
                  <>
                    <Text style="caption">
                      Overlapping edits and raw replacements stay retained. Reading reconciles independent form edits
                      and requires a fresh review; it never retries a write.
                    </Text>
                    <Button
                      disabled={studio.busy}
                      onClick={() => {
                        void studio.readCurrent(true);
                      }}
                    >
                      Discard draft and load current revision
                    </Button>
                  </>
                )}
                {generation ? (
                  <>
                    <Text style="caption">
                      Saved source state: {generation.state}. Apply is separate from Save; existing runs retain admitted
                      configuration.
                    </Text>
                    <Text style="mono-id">Saved revision: {generation.savedRevision}</Text>
                    <Text style="mono-id">Active generation: {generation.activeGeneration}</Text>
                  </>
                ) : (
                  <Text style="caption">Active generation status is unavailable. Saving never claims activation.</Text>
                )}
              </section>
            )}
          </>
        )}
        {permissions && (
          <>
            <PermissionsView
              policies={agentPolicies(permissions.effective)}
              live={connection === "live"}
              path={permissions.permissions.path}
              exists={permissions.permissions.exists}
            />
            <RawView
              path={permissions.permissions.path}
              text={permissions.permissions.text}
              label="orca.permissions.json"
              autoFocus={open === "permissions"}
            />
          </>
        )}
        {/* Where the plain-language rule judge's setup stands (#701); offered only by a daemon that lists it. */}
        <JudgeSetup />
        <StorageSection />
        <PreferencesSection surfaces={SURFACES.map((surface) => ({ id: surface.id, label: surface.label }))} />
      </div>
    </div>
  );
}

/** Whether this workspace still reopens after the save (#1192). A refusal says what to do before quitting. */
function ReopenBindingNotice({ binding }: { binding: ReopenBinding }): JSX.Element {
  return (
    <div role="status" data-reopen-binding={binding.state}>
      <Text style="caption" as="p">
        {binding.state === "binding"
          ? "Binding the saved configuration so this workspace reopens with it. Apply waits for this."
          : binding.state === "bound"
            ? "Saved configuration bound for reopening. The app starts this workspace with it next time."
            : `Saved, but not bound for reopening: ${binding.reason} Before quitting, open Project setup above and choose Review saved configuration for reopening, then bind it.`}
      </Text>
    </div>
  );
}
