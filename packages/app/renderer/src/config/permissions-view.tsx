/**
 * The second document: what each agent is actually allowed to do, and which file said so.
 *
 * The whole value of this section is the *order*. `layerPermissionPolicies` concatenates
 * the configured rules and then the sidecar's, and `decidePermission` takes the first
 * match, so a list in that order is the real precedence and a list sorted any other way is
 * a different policy drawn convincingly. The daemon produced the order; nothing here
 * re-derives it (`config.ts` in `@orca/protocol`, ADR 0009).
 *
 * The rest follows from ADR 0009:
 *
 * - **each row says which document it came from**, `config` or `sidecar`, because "a
 *   standing permission grant that teammates and code review can see" only works if you can
 *   tell the hand-written ones from the machine-written ones — and `default` for the third
 *   layer, the rules `@orca/agents` appends last (#140), which are not a document at all:
 *   no file, no path, nothing `config.set` can address. They are drawn as their own
 *   read-only group so the floor reads as a floor;
 * - **a sidecar row carries its provenance** — when it was written and the tool call that
 *   was answered "always" — which is the audit trail the file exists to keep;
 * - **the `default` is configuration's and is shown as such.** The sidecar cannot carry one
 *   (answering one prompt must not change the answer to every other one), and a list of
 *   rules without the fallthrough is half a policy.
 *
 * - **plain-language rules are listed apart** (#701). A judged rule decides nothing in the
 *   first-match order: a judge is asked about it only after the typed rules answered `ask`,
 *   and its yes allows one call once. Numbering it among the typed rules would draw a
 *   precedence it does not have, so it is its own group after them, named by the id a
 *   decision record gives it.
 *
 * Nothing here writes. Editing and removing grants is #176; this issue leaves the document
 * readable, which is why the sidecar's own raw JSON is below the list rather than a form.
 */
import type { JSX } from "react";
import { Chip, Text, Time, formatAbsolute, textClass } from "../ui/index.js";
import {
  PLAIN_RULES_SETUP_NOTE,
  POLICY_LAYERS,
  rowsFrom,
  type AgentPolicyView,
  type JudgedRow,
} from "./config-model.js";

export interface PermissionsViewProps {
  policies: readonly AgentPolicyView[];
  /** Whether the daemon is answering, so the timestamps stop reading as relative. */
  live: boolean;
  /** The sidecar's path, so a person can open the file it is talking about. */
  path: string;
  /** False when no sidecar has been written yet — an ordinary state, not an error. */
  exists: boolean;
}

export function PermissionsView({ policies, live, path, exists }: PermissionsViewProps): JSX.Element {
  return (
    <section className="orca-config__section" aria-label="Permissions">
      <Text style="heading" as="h2">
        Permissions
      </Text>
      <Text style="caption">
        What each agent may do, in the order ORCA evaluates it: the rules in the config first, then the ones written to
        the sidecar by an answer of &quot;allow always&quot;, then ORCA&apos;s own defaults. The first rule that matches
        decides.
      </Text>
      <span className={`orca-config__path ${textClass("mono-id")}`}>{path}</span>
      {!exists && (
        <Text style="caption">
          No sidecar has been written yet. Nothing has been granted with &quot;always&quot; in this workspace.
        </Text>
      )}

      {policies.length === 0 ? (
        <Text style="caption" className="orca-config__none">
          No agents are configured, so there is no policy to show.
        </Text>
      ) : (
        policies.map((policy) => (
          <div key={policy.agentId} className="orca-config__policy">
            <div className="orca-config__policy-head">
              <span className={`orca-id ${textClass("mono-strong")}`}>{policy.agentId}</span>
              <Text style="caption">
                {`Anything no rule matches: ${policy.default}`}
                {/* Where the fallthrough comes from, said out loud: it is not the sidecar's. */}
                {" — from the config"}
              </Text>
            </div>
            {policy.rows.length === 0 ? (
              <Text style="caption" className="orca-config__none">
                No rules; every tool call takes the fallthrough above.
              </Text>
            ) : (
              /* One group per layer, in evaluation order. Grouping reorders nothing: the
                 layers are concatenated, so a layer's rules are already contiguous, and the
                 order numbers are the daemon's either way. */
              POLICY_LAYERS.map((layer) => {
                const rows = rowsFrom(policy, layer.source);
                if (rows.length === 0) return null;
                return (
                  <div key={layer.source} className="orca-config__layer">
                    <div className="orca-config__layer-head">
                      <Text style="label-strong">{layer.title}</Text>
                      <Chip>{layer.source}</Chip>
                    </div>
                    {layer.source === "default" && (
                      <Text style="caption" className="orca-config__none">
                        {/* Why this group has no file beside it, said rather than left to be
                            guessed at: there is nothing to open and nothing to edit. */}
                        ORCA&apos;s own floor, applied when the config left the fallthrough unset. No file holds them,
                        so they cannot be edited anywhere.
                      </Text>
                    )}
                    <ol className="orca-config__rules">
                      {rows.map((row) => (
                        <li key={`${row.order}`} className="orca-config__rule">
                          <span className={`orca-config__order ${textClass("mono-id")}`}>{row.order}</span>
                          <span className={`orca-config__rule-text ${textClass("mono-body")}`} title={row.text}>
                            {row.text}
                          </span>
                          <Chip>{row.source}</Chip>
                          {row.addedAt !== undefined && (
                            <Time at={new Date(row.addedAt)} show={live ? "both" : "absolute"} />
                          )}
                          {row.grantedFor !== undefined && (
                            <Text style="caption" className="orca-config__granted">
                              {`granted for ${row.grantedFor}`}
                            </Text>
                          )}
                          {row.expiresAt !== undefined && (
                            <Text style="caption" className="orca-config__granted">
                              {`expires ${formatAbsolute(new Date(row.expiresAt))}`}
                            </Text>
                          )}
                        </li>
                      ))}
                    </ol>
                  </div>
                );
              })
            )}
            {policy.judged.length > 0 && <JudgedRules rows={policy.judged} live={live} />}
          </div>
        ))
      )}
    </section>
  );
}

/**
 * An agent's plain-language rules (#701), after its typed ones and unnumbered. Each is a
 * declared two-line row: the gate and where it came from on the first, the sentence a person
 * wrote on the second, cut at its end with the whole of it in its title.
 */
function JudgedRules({ rows, live }: { rows: readonly JudgedRow[]; live: boolean }): JSX.Element {
  return (
    <div className="orca-config__layer" aria-label="Plain-language rules">
      <div className="orca-config__layer-head">
        <Text style="label-strong">Plain-language rules</Text>
      </div>
      <Text style="caption" className="orca-config__none">
        A judge is asked about these only when the rules above answer ask, only for a file ORCA reads for the agent, and
        only in a session given a judge. A yes allows that one read once; anything else, searches and reads the agent
        makes itself included, goes to a person. {PLAIN_RULES_SETUP_NOTE}
      </Text>
      <ol className="orca-config__rules">
        {rows.map((row) => (
          <li key={row.ruleId} className="orca-config__judged">
            <span className="orca-config__judged-line">
              <span className={`orca-config__order ${textClass("mono-id")}`}>{row.ruleId}</span>
              <span className={`orca-config__rule-text ${textClass("mono-body")}`} title={row.gate}>
                {row.gate}
              </span>
              <Chip>{row.source}</Chip>
              {row.addedAt !== undefined && <Time at={new Date(row.addedAt)} show={live ? "both" : "absolute"} />}
              {row.expiresAt !== undefined && (
                <Text style="caption" className="orca-config__granted">
                  {`expires ${formatAbsolute(new Date(row.expiresAt))}`}
                </Text>
              )}
            </span>
            <Text style="body" className="orca-config__judged-criterion" title={row.criterion}>
              {row.criterion}
            </Text>
          </li>
        ))}
      </ol>
    </div>
  );
}
