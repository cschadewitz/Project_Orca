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
 *   tell the hand-written ones from the machine-written ones;
 * - **a sidecar row carries its provenance** — when it was written and the tool call that
 *   was answered "always" — which is the audit trail the file exists to keep;
 * - **the `default` is configuration's and is shown as such.** The sidecar cannot carry one
 *   (answering one prompt must not change the answer to every other one), and a list of
 *   rules without the fallthrough is half a policy.
 *
 * Nothing here writes. Editing and removing grants is #176; this issue leaves the document
 * readable, which is why the sidecar's own raw JSON is below the list rather than a form.
 */
import type { JSX } from "react";
import { Chip, Text, Time, textClass } from "../ui/index.js";
import type { AgentPolicyView } from "./config-model.js";

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
        the sidecar by an answer of &quot;allow always&quot;. The first rule that matches decides.
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
              <ol className="orca-config__rules">
                {policy.rows.map((row) => (
                  <li key={`${row.order}`} className="orca-config__rule">
                    <span className={`orca-config__order ${textClass("mono-id")}`}>{row.order}</span>
                    <span className={`orca-config__rule-text ${textClass("mono-body")}`}>{row.text}</span>
                    <Chip>{row.source}</Chip>
                    {row.addedAt !== undefined && (
                      <Time at={new Date(row.addedAt)} show={live ? "both" : "absolute"} />
                    )}
                    {row.grantedFor !== undefined && (
                      <Text style="caption" className="orca-config__granted">
                        {`granted for ${row.grantedFor}`}
                      </Text>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ))
      )}
    </section>
  );
}
