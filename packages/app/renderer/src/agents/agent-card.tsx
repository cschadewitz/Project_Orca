/**
 * `AgentHealthCard` — one configured agent: who it is, where it runs, and how it is
 * (`component-api.d.ts`, corrected in this change).
 *
 * The card is the design system's `.orca-agent`, so the border, the grid and the three
 * health modifiers are the component layer's and nothing here restates them. What it adds is
 * the reading of `AgentView`:
 *
 * - **Never colour alone (rule 4).** The state is its glyph *and* its word, both from
 *   `AGENT_HEALTH_PRESENTATION`; the tinted border is the third channel. There is no local
 *   list of states here and there must never be one.
 * - **`unknown` is said out loud.** Health is tracked in the daemon's process and never
 *   persisted (#222), so on a freshly started daemon every agent is `unknown` — and the
 *   card says "not contacted since the daemon started" rather than leaving a person to read
 *   a blank card as a broken one. It is the honest state, not a missing one.
 * - **Two timestamps, because they answer different questions (#227).** `lastHandshakeAt`
 *   is when ORCA last established a connection — what the state, the round trip and the
 *   failure count are about — and `lastSeenAt` is when the agent last said anything. Both
 *   are the `Time` primitive, and both drop to absolute when the daemon is not answering,
 *   because a relative time read off a stale clock is a lie
 *   (docs/design/40-connection-states.md).
 * - **There is no "working on" line.** A claim names the work item and the *run* that holds
 *   it and no agent, and an `AgentView` names no run, so `agents.list` cannot say what this
 *   agent is on. The surface renders the claims as their own region instead of guessing
 *   (RULES.md rule 12).
 */
import type { JSX } from "react";
import { AGENT_HEALTH_PRESENTATION } from "@orca/design";
import type { AgentView } from "@orca/protocol";
import { Button, Chip, Text, Time, textClass } from "../ui/index.js";
import { transportLabel } from "./agent-groups.js";

export interface AgentCardProps {
  agent: AgentView;
  /** False when the daemon is not answering: the timestamps stop reading as relative. */
  live: boolean;
  /**
   * Open this agent's permission policy (#176). A read, not a write — the policy is
   * `config.get`'s and a `--read-only` daemon answers it — so the action is present
   * whatever the connection says, and it is the *editor* inside that goes read-only.
   *
   * Absent means there is nowhere to open it: the card is mounted somewhere with no panel
   * to put it in, and a button that did nothing would be worse than no button.
   */
  onEditPermissions?: () => void;
}

export function AgentCard({ agent, live, onEditPermissions }: AgentCardProps): JSX.Element {
  const { word, glyph } = AGENT_HEALTH_PRESENTATION[agent.state];
  const transport = transportLabel(agent.hostType);
  const show = live ? "both" : "absolute";

  return (
    <article
      className={["orca-agent", agent.state === "ok" ? "" : `orca-agent--${agent.state}`].filter(Boolean).join(" ")}
      /* The state word first, so the card reads as "degraded, gemini" — the same ordering
         the run rows use (docs/design/50-accessibility-and-keyboard.md). */
      aria-label={`${word}, ${agent.id}`}
    >
      <span className={`orca-agent__health orca-agent__health--${agent.state} ${textClass("caption")}`}>
        <span aria-hidden="true">{glyph}</span>
        <span>{word}</span>
      </span>
      <span className={`orca-agent__name ${textClass("mono-strong")}`}>{agent.id}</span>
      <span className={`orca-agent__host ${textClass("caption")}`}>
        <span className={`orca-id ${textClass("mono-id")}`}>{agent.hostId}</span>
        {transport !== undefined && <Text style="caption">{` · ${transport}`}</Text>}
      </span>

      {agent.roles.length > 0 && (
        <span className="orca-agent__roles">
          {agent.roles.map((role) => (
            <Chip key={role}>{role}</Chip>
          ))}
        </span>
      )}

      <div className="orca-agents__meta">
        {agent.state === "unknown" ? (
          /* Not a placeholder and not an error: nothing has asked this agent anything since
             the daemon started, and there is nothing older to fall back on because health
             does not survive a restart (#222). */
          <Text style="caption" className="orca-agents__unknown">
            Not contacted since the daemon started.
          </Text>
        ) : (
          <>
            {agent.lastHandshakeAt !== undefined && (
              <Metric label="Handshake">
                <Time at={new Date(agent.lastHandshakeAt)} show={show} />
              </Metric>
            )}
            {agent.lastSeenAt !== undefined && (
              <Metric label="Last seen">
                <Time at={new Date(agent.lastSeenAt)} show={show} />
              </Metric>
            )}
            {agent.roundTripMs !== undefined && (
              <Metric label="Round trip">
                {/* The last *successful* handshake's, which survives a later failure: a down
                    agent still reports what it cost when it last worked. */}
                <span className={`orca-agent__metric ${textClass("mono-id")}`}>{`${agent.roundTripMs} ms`}</span>
              </Metric>
            )}
            {agent.consecutiveFailures > 0 && (
              <Metric label="Failed handshakes">
                <span className={`orca-agent__metric ${textClass("mono-id")}`}>{agent.consecutiveFailures}</span>
              </Metric>
            )}
          </>
        )}
      </div>

      {/* Only a down agent has one — the tracker keeps it exactly while the state holds —
          and it is the whole of why the card is red, so it is on the card and not in a
          tooltip. Mono: the daemon produced it (rule 8). */}
      {agent.lastError !== undefined && (
        <div className={`orca-agents__error ${textClass("mono-log")}`}>
          <span className="orca-agents__error-code">{agent.lastError.code}</span>
          <span>{agent.lastError.message}</span>
        </div>
      )}

      {/* The one action on the card. It names the agent so that the accessible name is
          unambiguous with four cards on screen, and so the palette's keyless entry and this
          button read as the same command. */}
      {onEditPermissions !== undefined && (
        <div className="orca-agents__actions">
          <Button size="sm" tone="ghost" onClick={onEditPermissions} aria-label={`Permissions for ${agent.id}`}>
            Permissions
          </Button>
        </div>
      )}
    </article>
  );
}

/** A label and its value, on one line of the card's metric block. */
function Metric({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <span className="orca-agents__metric-row">
      <Text style="caption" className="orca-agents__metric-label">
        {label}
      </Text>
      {children}
    </span>
  );
}
