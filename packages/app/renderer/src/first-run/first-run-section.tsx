/** First-run review UI over native main-owned selection; opening it starts no work. */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type JSX,
} from "react";
import { CHROME_GLYPHS } from "@orca/design";
import type { OrcaBridge } from "../../../src/bridge.js";
import type { FirstRunBridge, FirstRunStatus } from "../../../src/first-run-contract.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { useTransientLayer } from "../layers-context.js";
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
  const section = useRef<HTMLElement>(null);
  /* Set as the previous-session row leaves holding focus, read once the state that replaced it has rendered:
     focus goes to this region rather than the page body (rule 10). */
  const leftHoldingFocus = useRef(false);
  const onLeaveHoldingFocus = useCallback(() => {
    leftHoldingFocus.current = true;
  }, []);
  useLayoutEffect(() => {
    if (!leftHoldingFocus.current) return;
    leftHoldingFocus.current = false;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    section.current?.focus();
  }, [state]);
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
  const recovery = state?.state === "recovery" ? state.recovery : undefined;
  const previousBoot = recovery?.state === "previous-boot" ? recovery : undefined;
  const request = recovery?.state === "previous-boot" ? undefined : recovery;
  const perform = async (action: () => ReturnType<FirstRunBridge["status"]>, success: string, refused?: string) => {
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
          refused ??
            (result.error.message.startsWith("Local startup ownership requires reconciliation.")
              ? "Local startup ownership requires reconciliation. Review same-boot recovery, then reconcile when the owned writer has exited. Preserve all ownership evidence, work and credentials."
              : "Setup was refused. Check directory ownership, writable access and Git; retry or choose a fresh empty workspace. Existing files were preserved."),
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
    /* Focusable from script and never a Tab stop: where focus goes when the control holding it leaves. */
    <section ref={section} aria-label="First-run project setup" tabIndex={-1}>
      <Card>
        <Text style="label-strong">Dedicated project setup</Text>
        <Text style="body">
          Choose an owned prepared Git project, then a separate empty writable folder for the app workspace. Setup on
          Windows creates a new private child folder after review. Setup writes a new local configuration and sample
          assets in that app folder. It leaves the project checkout unchanged. Open a store remains read-only.
          Cancelling either directory picker keeps the previous selection.
        </Text>
        {state?.state === "selection-required" && <Text style="caption">{state.reason}</Text>}
        {state?.state === "review" && (
          <>
            <Well style="mono-id">Project: {state.review.project}</Well>
            <Well style="mono-id">App workspace: {state.review.workspace}</Well>
            {state.review.creation && (
              <>
                <Well style="mono-id">Selected parent: {state.review.creation.parent}</Well>
                <Text style="body">
                  Create the displayed new private folder and sample files. Existing parent and project permissions stay
                  unchanged.
                </Text>
              </>
            )}
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
              {state.review.creation
                ? "Create reviewed private workspace and sample files"
                : "Create reviewed sample files"}
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
        {previousBoot && bridge.endPreviousSession && (
          <>
            <Text style="caption">The last session ended without closing cleanly, before this computer restarted.</Text>
            <Text style="body">
              A restart ends every process from that session, but the app never settles it on its own. Mark it ended so
              this workspace can be connected again. Its work, journal and credentials stay as they are; nothing is
              resumed, and unfinished runs wait for you to inspect and continue them.
            </Text>
            <PreviousSessionAsk
              busy={busy}
              onLeaveHoldingFocus={onLeaveHoldingFocus}
              onConfirm={() =>
                void perform(
                  () => bridge.endPreviousSession!(previousBoot.attemptId),
                  "Previous session marked ended. Connect the selected workspace, then inspect retained work before continuing it.",
                  "The previous session was not marked ended. Another process may still hold this workspace, or its evidence changed. Nothing was changed. Close other app windows for this workspace, read setup again, then retry.",
                )
              }
            />
          </>
        )}
        {request && bridge.reconcileRecovery && (
          <>
            <Text style="caption">
              {request.state === "surviving-owned-daemon"
                ? "The exact owned daemon is still running. No process was adopted or stopped."
                : request.state === "unknown-writer"
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
                  () => bridge.reconcileRecovery!(request.requestId),
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

/**
 * **Mark previous session ended**, the one setup action with no way back, so it asks on its own row (RULES.md
 * rule 17) the way a claim's Release does. At rest it is a quiet default-tone button. Pressed, the row becomes
 * **Keep**, which takes focus so a second `Enter` keeps things as they are, then **✕ Confirm previous session ended**
 * in the danger tone, with the consequence as the row's second line. Keep, `Esc` (the row is on the transient layer
 * stack while it asks) and Confirm hand focus back to the button; focus leaving the row withdraws the question and
 * stays where the person put it. Nothing is sent until Confirm.
 */
function PreviousSessionAsk({
  busy,
  onConfirm,
  onLeaveHoldingFocus,
}: {
  busy: boolean;
  onConfirm: () => void;
  /** Said once, as the row unmounts, if focus was inside it: the section decides where it goes. */
  onLeaveHoldingFocus: () => void;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  const asking = armed && !busy;
  const row = useRef<HTMLDivElement>(null);
  const consequence = useId();
  /* Whether focus has reached Keep yet: until then a focusout is the button leaving the document. */
  const settled = useRef(false);
  /* Set by the disarms that start inside the row, which return focus to the button. */
  const restore = useRef(false);
  const disarm = (refocus: boolean): void => {
    restore.current = refocus;
    setArmed(false);
  };
  useTransientLayer(asking, { name: "previous-session-confirm", close: () => disarm(true) });
  useLayoutEffect(() => {
    if (asking) {
      row.current?.querySelector<HTMLElement>("[data-previous-session-keep]")?.focus();
      settled.current = true;
      return;
    }
    settled.current = false;
    if (restore.current) {
      restore.current = false;
      row.current?.querySelector<HTMLElement>("[data-previous-session-trigger]")?.focus();
    }
  }, [asking]);
  useLayoutEffect(() => {
    const element = row.current;
    return () => {
      if (element?.contains(document.activeElement)) onLeaveHoldingFocus();
    };
  }, [onLeaveHoldingFocus]);
  const onBlur = (event: ReactFocusEvent<HTMLDivElement>): void => {
    if (!asking || !settled.current) return;
    const next = event.relatedTarget;
    if (next !== null && event.currentTarget.contains(next)) return;
    if (next === null && !document.hasFocus()) return;
    disarm(false);
  };
  return (
    <div ref={row} onBlur={onBlur}>
      {asking ? (
        <span role="group" aria-label="Mark the previous session ended?" aria-describedby={consequence}>
          <Button size="sm" data-previous-session-keep="" onClick={() => disarm(true)}>
            Keep
          </Button>
          <Button
            size="sm"
            tone="danger"
            aria-describedby={consequence}
            onClick={() => {
              disarm(true);
              onConfirm();
            }}
          >
            <span aria-hidden="true">{CHROME_GLYPHS.danger}</span> Confirm previous session ended
          </Button>
        </span>
      ) : (
        <Button data-previous-session-trigger="" disabled={busy} onClick={() => setArmed(true)}>
          Mark previous session ended
        </Button>
      )}
      {asking && (
        <Text id={consequence} style="caption">
          This cannot be undone. It records that the session before the restart is over, so this workspace can start
          again; run history and credentials are kept.
        </Text>
      )}
    </div>
  );
}
