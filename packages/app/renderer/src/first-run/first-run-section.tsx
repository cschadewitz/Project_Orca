/** First-run review UI over native main-owned selection; opening it starts no work. */
import { useEffect, useRef, useState, type JSX } from "react";
import type { OrcaBridge } from "../../../src/bridge.js";
import type { FirstRunBridge, FirstRunStatus } from "../../../src/first-run-contract.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { Button, Card, Text, Well } from "../ui/index.js";

/** Optional for clients whose native build does not provide setup. */
export function firstRunBridge(bridge: OrcaBridge): FirstRunBridge | undefined {
  return bridge.firstRun;
}
export function FirstRunSection(): JSX.Element | null {
  const bridge = firstRunBridge(window.orca);
  const announce = useAnnounce();
  const [state, setState] = useState<FirstRunStatus>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const revision = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    if (!bridge) return;
    const read = () => {
      const token = ++revision.current;
      void bridge
        .status()
        .then((result) => {
          if (!alive.current || token !== revision.current) return;
          if (result.ok) setState(result.result);
          else setMessage("Project setup could not verify its saved selection. Choose directories again.");
        })
        .catch(() => {
          if (alive.current && token === revision.current)
            setMessage("Project setup is unavailable. Read setup again.");
        });
    };
    read();
    const unsubscribe = window.orca.workspace.subscribe(read);
    return () => {
      alive.current = false;
      revision.current++;
      unsubscribe();
    };
  }, [bridge]);
  if (!bridge) return null;
  const perform = async (action: () => ReturnType<FirstRunBridge["status"]>, success: string) => {
    if (busy) return;
    const token = ++revision.current;
    setBusy(true);
    setMessage("");
    try {
      const result = await action();
      if (!alive.current || token !== revision.current) return;
      if (result.ok) {
        setState(result.result);
        const text =
          result.result.state === "review" ? "Review the selected directories before creating files." : success;
        setMessage(text);
        announce(text);
      } else {
        setMessage(
          result.error.message.startsWith("Local startup ownership requires reconciliation.")
            ? "Local startup ownership requires reconciliation. Review same-boot recovery, then reconcile when the owned writer has exited. Preserve all ownership evidence, work and credentials."
            : "Setup was refused. Check directory ownership, writable access and Git; retry or choose a fresh empty workspace. Existing files were preserved.",
        );
        announce("Project setup was refused. Existing files were preserved.");
      }
    } catch {
      if (alive.current && token === revision.current) {
        setMessage("Setup could not complete. Read setup again before retrying; no alternate workspace was selected.");
        announce("Project setup could not complete.");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section aria-label="First-run project setup">
      <Card>
        <Text style="label-strong">Dedicated project setup</Text>
        <Text style="body">
          Choose an owned prepared Git project, then a separate empty writable folder for the app workspace. Setup
          writes a new local configuration and sample assets in that app folder. It leaves the project checkout
          unchanged. Open a store remains read-only. Cancelling either directory picker keeps the previous selection.
        </Text>
        {state?.state === "selection-required" && <Text style="caption">{state.reason}</Text>}
        {state?.state === "review" && (
          <>
            <Well style="mono-id">Project: {state.review.project}</Well>
            <Well style="mono-id">App workspace: {state.review.workspace}</Well>
            <Well style="mono-id">
              Prepared branch: {state.review.branch} / base {state.review.baseCommit}
            </Well>
            <Well style="mono-id">
              Sample: {state.review.sample.id} / {state.review.sample.version} / {state.review.sample.revision}
            </Well>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(
                  () => bridge.prepare(state.review.id),
                  "Sample files prepared. Connect the selected local workspace when ready.",
                )
              }
            >
              Create reviewed sample files
            </Button>
          </>
        )}
        {state?.state === "prepared" && (
          <>
            <Well style="mono-id">Project: {state.project}</Well>
            <Well style="mono-id">App workspace: {state.workspace}</Well>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(
                  () => bridge.connect(),
                  "Selected workspace connected. Open Launch work and choose the harmless sample; review permissions before launching.",
                )
              }
            >
              Connect selected local workspace
            </Button>
          </>
        )}
        {state?.state === "recovery" && bridge.reconcileRecovery && (
          <>
            <Text style="caption">
              {state.recovery.state === "surviving-owned-daemon"
                ? "The exact owned daemon is still running. No process was adopted or stopped."
                : state.recovery.state === "unknown-writer"
                  ? "Writer ownership is unknown. Preserve the workspace for operator review."
                  : "Recovery is ready for verification."}
            </Text>
            <Text style="body">
              Recovery checks exclusive ownership before releasing this reservation. A surviving owned daemon stays
              preserved; an unknown writer requires operator review. Existing work and credentials stay preserved.
              Reconciliation starts no daemon and resumes no work.
            </Text>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(
                  () => bridge.reconcileRecovery!(state.recovery.requestId),
                  "Ownership reconciled. Connect explicitly, then inspect retained work before continuing it.",
                )
              }
            >
              Reconcile same-boot ownership
            </Button>
          </>
        )}
        {state?.state === "configuration-review" && bridge.bindConfiguration && (
          <>
            <Text style="body">
              Bind this saved configuration for reopening the selected workspace. Project, store and sample bindings
              stay fixed. This starts no agent and grants no permissions.
            </Text>
            <Well style="mono-id">Saved revision: {state.review.revision}</Well>
            {state.review.checks.map((check) => (
              <Text key={check.agentId} style="caption">
                {check.agentId}:{" "}
                {check.state === "handshake-required"
                  ? "Executable available; explicitly check ACP, version and sign-in before real work."
                  : check.state === "missing"
                    ? "Executable missing from the app PATH; configure an absolute executable path in Config."
                    : check.state === "architecture"
                      ? "Executable architecture is incompatible with this app."
                      : "Executable access or format could not be verified."}
              </Text>
            ))}
            <Button
              disabled={busy}
              onClick={() =>
                void perform(
                  () => bridge.bindConfiguration!(state.review.id),
                  "Saved configuration bound for reopening. ACP and real-agent acceptance remain separate.",
                )
              }
            >
              Bind reviewed saved configuration
            </Button>
          </>
        )}
        {bridge.reviewConfiguration && (
          <Button
            disabled={busy}
            onClick={() =>
              void perform(
                () => bridge.reviewConfiguration!(),
                "Review saved configuration and local executable checks before binding it.",
              )
            }
          >
            Review saved configuration for reopening
          </Button>
        )}
        {state?.state === "prepared" && bridge.prepareRecovery && (
          <>
            <Text style="caption">
              If app loss blocked this store, review recovery and verify exclusive writer ownership before
              reconciliation. It preserves the journal, work and credentials. It does not stop a live daemon.
            </Text>
            <Button
              disabled={busy}
              onClick={() =>
                void perform(
                  () => bridge.prepareRecovery!(),
                  "Recovery prepared. Reconcile to check writer quiescence.",
                )
              }
            >
              Review same-boot recovery
            </Button>
          </>
        )}
        <Button disabled={busy} onClick={() => void perform(() => bridge.choose(), "Directory selection finished.")}>
          Choose project and empty workspace
        </Button>
        <Button disabled={busy} onClick={() => void perform(() => bridge.status(), "Project setup read again.")}>
          Read setup again
        </Button>
        {message && <Text style="caption">{message}</Text>}
        <Text style="caption">
          The harmless sample has no agent or provider credentials. Its completion verifies local launch only. The #420
          coding task and a real local-agent run require separate tool, sign-in, cost, transmission, permission and
          stop-limit review in Config. No real agent starts from setup.
        </Text>
      </Card>
    </section>
  );
}
