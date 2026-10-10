/** Mounted Config journey; closing/navigation keeps the provider's draft and encrypted intent. */
import { useEffect, useRef, type JSX } from "react";
import { useTransientLayer } from "../layers-context.js";
import { Button, ConfigField, Menu, StateView, Text, Well } from "../ui/index.js";
import { GuidedLaunch } from "./guided-launch.js";
import { useGuidedLaunch } from "./launch-context.js";
import { FIRST_RUN_SAMPLE, FIRST_RUN_SAMPLE_ASSETS, FIRST_RUN_SAMPLE_TASK } from "../../../src/first-run-sample.js";
import { CONFIGURED_ROOT } from "./production-bindings.js";
export function GuidedLaunchRoute({
  onConfiguration,
  onClose,
}: {
  onConfiguration: () => void;
  onClose: () => void;
}): JSX.Element {
  const session = useGuidedLaunch();
  const launchState = session.controller?.read();
  const focus = useRef<HTMLDivElement>(null);
  const closed = useRef(false);
  const close = () => {
    closed.current = true;
    onClose();
  };
  useTransientLayer(true, { name: "Guided launch", close, hasUnsentDraft: () => false });
  useEffect(() => {
    focus.current?.focus();
    return () => {
      if (closed.current)
        window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-launch-entry]")?.focus());
    };
  }, []);
  return (
    <div ref={focus} tabIndex={-1} aria-label="Launch work workspace">
      {session.message && (
        <StateView
          kind="disconnected"
          title="Prepare to launch work"
          body={session.message}
          action={{ label: "Read current launch context", onClick: session.refresh }}
        />
      )}
      <Text style="caption">
        The project checkout comes from applied Config. A beta sample is available only when its reviewed workflow is
        registered. Publication is unavailable.
      </Text>
      <Text style="caption">
        Harmless local sample: agent-free launch smoke check. Completion proves no coding fix or real-agent first job.
        The separately bound beta-first-job-v1 coding task needs explicit real-agent setup and authorization.
      </Text>
      <details>
        <summary>Verified sample binding</summary>
        <Well style="mono-id">{`Sample ${FIRST_RUN_SAMPLE.id} / ${FIRST_RUN_SAMPLE.version} / ${FIRST_RUN_SAMPLE.revision}\nTask ${FIRST_RUN_SAMPLE_ASSETS.task.revision}\nInstruction ${FIRST_RUN_SAMPLE_ASSETS.instruction.revision}\nResult ${FIRST_RUN_SAMPLE_ASSETS.result.revision}`}</Well>
      </details>
      <Button
        disabled={
          launchState?.busy === true ||
          launchState?.intent !== undefined ||
          launchState?.unresolvedReview !== undefined ||
          !session.controller
            ?.read()
            .context.workflows.some(
              (workflow) =>
                workflow.id === FIRST_RUN_SAMPLE.id &&
                workflow.version === FIRST_RUN_SAMPLE.version &&
                workflow.revision === FIRST_RUN_SAMPLE.revision,
            )
        }
        disabledReason="Prepare and connect the dedicated app workspace with the exact registered sample first."
        onClick={() => {
          const controller = session.controller;
          if (!controller) return;
          controller.edit(
            {
              ...controller.read().draft,
              mode: "direct",
              rootId: CONFIGURED_ROOT,
              workflowId: FIRST_RUN_SAMPLE.id,
              vars: { task: FIRST_RUN_SAMPLE_TASK },
              title: "",
              body: "",
              overrides: undefined,
            },
            {},
          );
        }}
      >
        Choose harmless launch smoke check
      </Button>
      <Button onClick={session.refresh}>Read current launch context</Button>
      {session.controller ? (
        <>
          <ConfigField label="Protected launch to restore" path="retained-launch">
            {(control) => (
              <Menu
                label="Protected launch to restore"
                triggerProps={control}
                triggerClassName="orca-input orca-text-label"
                items={session.retained.map((intent) => ({
                  id: intent.intentId,
                  label: `${intent.workflowId} (${intent.mode})`,
                  hint: intent.operationId ?? intent.intentId,
                }))}
                onChoose={(item) => session.select(item.id)}
              >
                {session.retained.find((intent) => intent.intentId === session.selected)?.workflowId ??
                  "Choose an exact retained launch"}
              </Menu>
            )}
          </ConfigField>
          <GuidedLaunch
            controller={session.controller}
            requirePermissionReview
            protectedDraftsAvailable={false}
            restoreAvailable={session.selected !== ""}
            {...(launchState?.context.overrideChoices === undefined
              ? {}
              : { overrideChoices: launchState.context.overrideChoices })}
            onConfiguration={onConfiguration}
            onConnections={() => window.orca.daemonConnection?.show()}
            onClose={close}
          />
        </>
      ) : (
        <>
          <Button onClick={onConfiguration}>Edit configuration</Button>
          <Button onClick={() => window.orca.daemonConnection?.show()}>Connection settings</Button>
          <Button onClick={close}>Close</Button>
        </>
      )}
    </div>
  );
}
