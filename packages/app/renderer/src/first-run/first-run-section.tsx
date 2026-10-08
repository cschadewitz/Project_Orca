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
          "Setup was refused. Check directory ownership, writable access and Git; retry or choose a fresh empty workspace. Existing files were preserved.",
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
