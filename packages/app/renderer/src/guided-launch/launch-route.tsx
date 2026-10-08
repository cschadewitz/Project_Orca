/** Mounted Config journey; closing/navigation keeps the provider's draft and encrypted intent. */
import { useEffect, useRef, type JSX } from "react";
import { useTransientLayer } from "../layers-context.js";
import { Button, ConfigField, Menu, StateView, Text } from "../ui/index.js";
import { GuidedLaunch } from "./guided-launch.js";
import { useGuidedLaunch } from "./launch-context.js";
export function GuidedLaunchRoute({
  onConfiguration,
  onClose,
}: {
  onConfiguration: () => void;
  onClose: () => void;
}): JSX.Element {
  const session = useGuidedLaunch();
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
