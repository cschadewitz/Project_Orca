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
  type ReactNode,
} from "react";
import { CHROME_GLYPHS } from "@orca/design";
import type { OrcaBridge } from "../../../src/bridge.js";
import type { FirstRunBridge, FirstRunStatus } from "../../../src/first-run-contract.js";
import { AgentPreflightReview } from "./agent-preflight-review.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { useTransientLayer } from "../layers-context.js";
import { Button, Text } from "../ui/index.js";
import { textClass } from "../ui/text.js";
import "./first-run.css";

/** Optional for clients whose native build does not provide setup. */
export function firstRunBridge(bridge: OrcaBridge): FirstRunBridge | undefined {
  return bridge.firstRun;
}

/**
 * The last thing a setup action said. A refusal carries main's reason, which main wrote for the screen (raw failures
 * never cross the IPC boundary), and the action's own guidance on what to do next.
 */
type Outcome =
  | { kind: "done"; text: string }
  | { kind: "refused"; reason: string; guidance?: string }
  | { kind: "unavailable"; text: string };

const PRESERVED = "Existing files were preserved.";
const OWNERSHIP =
  "Review same-boot recovery, then reconcile when the owned writer has exited. Preserve all ownership evidence, work and credentials.";

export function FirstRunSection(): JSX.Element | null {
  const bridge = firstRunBridge(window.orca);
  const announce = useAnnounce();
  const [state, setState] = useState<FirstRunStatus>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
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
      // A workspace notification retires evidence from the previous target immediately.
      if (section.current?.contains(document.activeElement)) leftHoldingFocus.current = true;
      setState((previous) => (previous?.state === "configuration-review" ? undefined : previous));
      void bridge
        .status()
        .then((result) => {
          if (!alive.current || token !== revision.current) return;
          if (result.ok) setState(result.result);
          else
            setOutcome({
              kind: "refused",
              reason: result.error.message,
              guidance: "Project setup could not verify its saved selection. Choose directories again.",
            });
        })
        .catch(() => {
          if (alive.current && token === revision.current)
            setOutcome({ kind: "unavailable", text: "Project setup is unavailable. Read setup again." });
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
    /* Any step change can unmount the control that holds focus: Choose moves from the selection row into the review
       step, Create and Connect leave with theirs, and a review's Bind goes with it. Focus then goes to this region,
       never the page body (rule 10); a control that survives the change keeps it. */
    if (section.current?.contains(document.activeElement)) leftHoldingFocus.current = true;
    // Retire queued status evidence too: the handler's render may precede the status update's commit.
    // A failed rereview or binding must not leave a stale Bind control on screen.
    setState((previous) => (previous?.state === "configuration-review" ? undefined : previous));
    setBusy(true);
    setOutcome(undefined);
    try {
      const result = await action();
      if (!alive.current || token !== revision.current) return;
      if (result.ok) {
        setState(result.result);
        const text =
          result.result.state === "review" ? "Review the selected directories before creating files." : success;
        setOutcome({ kind: "done", text });
        announce(text);
      } else {
        const ownership = result.error.message.startsWith("Local startup ownership requires reconciliation.");
        const reason = ownership ? "Local startup ownership requires reconciliation." : result.error.message;
        setOutcome({
          kind: "refused",
          reason,
          ...(ownership ? { guidance: OWNERSHIP } : refused ? { guidance: refused } : {}),
        });
        announce(`Project setup was refused. ${reason}`);
      }
    } catch {
      if (alive.current && token === revision.current) {
        const text = "Setup could not complete. Read setup again before retrying; no alternate workspace was selected.";
        setOutcome({ kind: "unavailable", text });
        announce("Project setup could not complete.");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const choose = (primary: boolean) => (
    <Button
      tone={primary ? "primary" : "default"}
      disabled={busy}
      onClick={() => void perform(() => bridge.choose(), "Directory selection finished.")}
    >
      Choose project and empty workspace
    </Button>
  );
  const selected = state?.state === "review" || state?.state === "prepared";
  const reviewing = state?.state === "configuration-review";
  return (
    /* Focusable from script and never a Tab stop: where focus goes when the control holding it leaves. */
    <section
      ref={section}
      className="orca-first-run orca-config__section"
      aria-label="First-run project setup"
      tabIndex={-1}
    >
      <header className="orca-first-run__header">
        <Text style="heading" as="h2">
          Dedicated project setup
        </Text>
        <Text style="caption" as="p">
          Choose a Git project your account owns, then a separate empty folder for the app workspace. Setup shows both
          for review before it writes anything, and it never changes the project checkout.
        </Text>
      </header>

      {state?.state === "selection-required" && (
        <Text style="body" as="p">
          {state.reason}
        </Text>
      )}

      {state?.state === "review" && (
        <Step title="Review before setup writes files">
          <Facts
            label="Selected directories"
            rows={[
              ["Project", state.review.project],
              ["App workspace", state.review.workspace],
              ...(state.review.creation ? ([["Selected parent", state.review.creation.parent]] as const) : []),
              ["Prepared branch", state.review.branch],
              ["Base commit", state.review.baseCommit],
              [
                "Sample",
                `${state.review.sample.id} / ${state.review.sample.version} / ${state.review.sample.revision}`,
              ],
            ]}
          />
          <Text style="caption" as="p">
            {state.review.creation
              ? "Create the displayed new private folder and sample files. Existing parent and project permissions stay unchanged."
              : "Setup writes a new local configuration and sample assets in the app workspace."}
          </Text>
          <Actions>
            <Button
              tone="primary"
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
            {choose(false)}
          </Actions>
        </Step>
      )}

      {state?.state === "prepared" && (
        <Step title="Workspace prepared">
          <Facts
            label="Prepared directories"
            rows={[
              ["Project", state.project],
              ["App workspace", state.workspace],
            ]}
          />
          <Actions>
            <Button
              tone="primary"
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
            {choose(false)}
          </Actions>
        </Step>
      )}

      {!selected && (
        <Actions>
          {choose(!reviewing && !previousBoot && !request)}
          <Text style="caption">Cancelling a directory picker keeps the previous selection.</Text>
        </Actions>
      )}

      {outcome && <OutcomeNote outcome={outcome} />}

      {previousBoot && bridge.endPreviousSession && (
        <Step title="Previous session">
          <Text style="body" as="p">
            The last session ended without closing cleanly, before this computer restarted.
          </Text>
          <Text style="caption" as="p">
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
        </Step>
      )}

      {request && bridge.reconcileRecovery && (
        <Step title="Same-boot recovery">
          <Text style="body" as="p">
            {request.state === "surviving-owned-daemon"
              ? "The exact owned daemon is still running. No process was adopted or stopped."
              : request.state === "unknown-writer"
                ? "Writer ownership is unknown. Preserve the workspace for operator review."
                : "Recovery is ready for verification."}
          </Text>
          <Text style="caption" as="p">
            Recovery checks exclusive ownership before releasing this reservation. A surviving owned daemon stays
            preserved; an unknown writer requires operator review. Existing work and credentials stay preserved.
            Reconciliation starts no daemon and resumes no work.
          </Text>
          <Actions>
            <Button
              tone="primary"
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
          </Actions>
        </Step>
      )}

      {reviewing && bridge.bindConfiguration && (
        <Step title="Saved configuration review">
          <Text style="caption" as="p">
            Bind this saved configuration for reopening the selected workspace. Project, store and sample bindings stay
            fixed. This starts no agent and grants no permissions.
          </Text>
          <Facts label="Saved configuration" rows={[["Saved revision", state.review.revision]]} />
          <AgentPreflightReview checks={state.review.checks} />
          <Actions>
            <Button
              tone="primary"
              disabled={busy}
              onClick={() =>
                void perform(
                  () => bridge.bindConfiguration!(state.review.id),
                  "Saved configuration bound for reopening. ACP and real-agent acceptance remain separate.",
                  "Configuration binding could not be confirmed. Read setup again, then review the saved Config before retrying so any recorded binding can be reconciled. Keep the existing workspace and ownership evidence. No provider check was run.",
                )
              }
            >
              Bind reviewed saved configuration
            </Button>
            {bridge.cancelConfigurationReview && (
              <Button
                disabled={busy}
                onClick={() =>
                  void perform(
                    () => bridge.cancelConfigurationReview!(),
                    "Configuration review cancelled. Saved configuration and selected directories were preserved.",
                  )
                }
              >
                Cancel configuration review
              </Button>
            )}
          </Actions>
        </Step>
      )}

      <Step title="Reopening and recovery">
        <Actions>
          {bridge.reviewConfiguration && (
            <Button
              disabled={busy}
              onClick={() =>
                void perform(
                  () => bridge.reviewConfiguration!(),
                  "Review saved configuration and local executable checks before binding it.",
                  "Configuration review could not complete. Check that Config is saved for the selected local workspace, then retry this review. Reconnect the selected daemon if disconnected, or use offline saved-config review. No provider check was run.",
                )
              }
            >
              Review saved configuration for reopening
            </Button>
          )}
          {state?.state === "prepared" && bridge.prepareRecovery && (
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
          )}
          <Button
            disabled={busy}
            onClick={() =>
              void perform(
                () =>
                  state?.state === "configuration-review" && bridge.cancelConfigurationReview
                    ? bridge.cancelConfigurationReview()
                    : bridge.status(),
                "Project setup read again.",
              )
            }
          >
            Read setup again
          </Button>
        </Actions>
        {state?.state === "prepared" && bridge.prepareRecovery && (
          <Text style="caption" as="p">
            If app loss blocked this store, review recovery and verify exclusive writer ownership before reconciliation.
            It preserves the journal, work and credentials. It does not stop a live daemon.
          </Text>
        )}
      </Step>

      <footer className="orca-first-run__notes">
        <Text style="caption" as="p">
          On Windows, setup creates a new private child folder inside the folder you choose, after review. Open a store
          stays read-only.
        </Text>
        <Text style="caption" as="p">
          The harmless sample has no agent or provider credentials. Its completion verifies local launch only. The
          beta-first-job-v1 coding task and a real local-agent run require separate tool, sign-in, cost, transmission,
          permission and stop-limit review in Config. No real agent starts from setup.
        </Text>
      </footer>
    </section>
  );
}

/** One stage of setup: its own heading, then what it shows and what it offers. */
function Step({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  const id = useId();
  return (
    <section className="orca-first-run__step" aria-labelledby={id}>
      <Text style="label-strong" as="h3" id={id}>
        {title}
      </Text>
      {children}
    </section>
  );
}

/** The buttons of a step, on one wrapping line in reading order: the step's next act first. */
function Actions({ children }: { children: ReactNode }): JSX.Element {
  return <div className="orca-first-run__actions">{children}</div>;
}

/**
 * Directories and identities setup observed, a name in sans beside the value ORCA holds in mono (rule 8). A path
 * breaks anywhere rather than holding the pane open, and it is never cut, because the person reviews it whole.
 */
function Facts({ label, rows }: { label: string; rows: readonly (readonly [string, string])[] }): JSX.Element {
  return (
    <dl className="orca-first-run__facts" aria-label={label}>
      {rows.map(([name, value]) => (
        <div key={name} className="orca-first-run__fact">
          <dt className={textClass("caption")}>{name}</dt>
          <dd className={textClass("mono-id")}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * What the last action came to. Success is quiet (rule 6): a caption. A refusal leads with the words "Setup was
 * refused", then main's reason, then what to do, on a rail in the failed colour as the third channel (rule 4); it is
 * not the danger tone, which belongs to a control (rule 17).
 */
function OutcomeNote({ outcome }: { outcome: Outcome }): JSX.Element {
  if (outcome.kind === "done")
    return (
      <Text style="caption" as="p" className="orca-first-run__done">
        {outcome.text}
      </Text>
    );
  if (outcome.kind === "unavailable")
    return (
      <div className="orca-first-run__refusal">
        <Text style="body" as="p">
          {outcome.text}
        </Text>
      </div>
    );
  const said = `${outcome.reason} ${outcome.guidance ?? ""}`;
  return (
    <div className="orca-first-run__refusal">
      <Text style="label-strong" as="p">
        Setup was refused
      </Text>
      <Text style="body" as="p">
        {outcome.reason}
      </Text>
      {outcome.guidance && (
        <Text style="caption" as="p">
          {outcome.guidance}
        </Text>
      )}
      {!/preserved|Nothing was changed/i.test(said) && (
        <Text style="caption" as="p">
          {PRESERVED}
        </Text>
      )}
    </div>
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
