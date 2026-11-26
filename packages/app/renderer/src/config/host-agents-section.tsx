/**
 * Agents installed on this managed server, on its Config surface (#1235). Shown only while the app
 * is connected to a saved SSH profile whose server reports installed agents (#1236). **Add to
 * configuration** puts the agent's `agents:` entry (the one `orca-cli remote agent install`
 * prints) into the draft. An entry with the same id that an earlier install here added (the same
 * profile, the managed command and arguments at any version) has only what runs the agent
 * updated (`command`, `args` and the agent's own `env` keys), keeping its permissions and every
 * other field. Any other entry with that id, including a local ACP one the person configured, is
 * left alone with the reason. Nothing is
 * written until the person reviews, saves and applies the draft as with any other edit.
 *
 * A report belongs to the connection it was read on: its epoch and profile. It is shown, and
 * staged, only while the connection and the draft's target are still that one.
 */
import { useEffect, useState, type JSX } from "react";
import type { DaemonTargetSnapshot, HostAgentView } from "../../../src/daemon-connection.js";
import { Button, Text } from "../ui/index.js";
import { useConfigurationStudio } from "./configuration-studio-context.js";
import type { EditIntent } from "./structured-form/contracts.js";

type Entry = NonNullable<HostAgentView["entry"]>;

/** What adding `entry` to the draft does. */
export type AgentEntryPlan =
  { kind: "add" | "update"; edits: EditIntent[] } | { kind: "current" } | { kind: "conflict"; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const sameStrings = (a: unknown, b: readonly string[]) =>
  Array.isArray(a) && a.length === b.length && a.every((item, i) => item === b[i]);

/**
 * The edits that put `entry` into the draft's `agents:` list. A new id goes at the end. For an
 * existing entry with its id that an install here added (see `managedBy`), only `command`, `args`
 * and the entry's own `env` keys are set: its name, permissions, roles, other env and the rest
 * stay as the person wrote them. Any other entry with that id is left alone, with the reason.
 */
export function agentEntryPlan(draft: unknown, entry: Entry): AgentEntryPlan {
  const agents = isRecord(draft) ? draft.agents : undefined;
  if (agents === undefined || agents === null)
    return { kind: "add", edits: [{ kind: "set", path: ["agents"], value: [entry] }] };
  if (!Array.isArray(agents)) return { kind: "conflict", reason: "This configuration's agents: is not a list." };
  const index = agents.findIndex((agent) => isRecord(agent) && agent.id === entry.id);
  if (index < 0)
    return { kind: "add", edits: [{ kind: "insert", path: ["agents"], index: agents.length, value: entry }] };
  const existing = agents[index] as Record<string, unknown>;
  const conflict = (why: string): AgentEntryPlan => ({
    kind: "conflict",
    reason: `This configuration already has an agent called ${entry.id} ${why}. Remove or rename it to add the one installed here.`,
  });
  if (existing.type !== undefined && existing.type !== "acp") return conflict("that is not an ACP agent");
  if (existing.hostId !== undefined && existing.hostId !== "local") return conflict("that runs on another host");
  if (!isRecord(existing.env)) return conflict("that was not added from this server's install");
  if (!managedBy(existing as Record<string, unknown> & { env: Record<string, unknown> }, entry))
    return conflict("that was not added from this server's install (its command, arguments or profile differ)");
  const edits: EditIntent[] = [];
  const at = ["agents", index] as const;
  if (existing.command !== entry.command) edits.push({ kind: "set", path: [...at, "command"], value: entry.command });
  if (!sameStrings(existing.args, entry.args)) edits.push({ kind: "set", path: [...at, "args"], value: entry.args });
  for (const [name, value] of Object.entries(entry.env))
    if (existing.env[name] !== value) edits.push({ kind: "set", path: [...at, "env", name], value });
  return edits.length ? { kind: "update", edits } : { kind: "current" };
}

/**
 * Whether `existing` is an entry for this agent as installed on this server, at any version: the
 * same profile (its home under the server root), and a command and arguments that are the
 * managed ones but for the version directory. Only such an entry is updated in place; one the
 * person configured themselves, even a local ACP one with the same id, is not.
 */
function managedBy(existing: Record<string, unknown> & { env: Record<string, unknown> }, entry: Entry): boolean {
  const suffix = `/agents/${entry.id}/home`;
  const homeKey = Object.keys(entry.env).find((name) => entry.env[name]!.endsWith(suffix));
  if (!homeKey || existing.env[homeKey] !== entry.env[homeKey]) return false;
  const prefix = `${entry.env[homeKey]!.slice(0, -suffix.length)}/agents/${entry.id}/`;
  const unversioned = (value: unknown) =>
    typeof value === "string" && value.startsWith(prefix)
      ? prefix + value.slice(prefix.length).replace(/^\d+\.\d+\.\d+\//, "*/")
      : value;
  return (
    unversioned(existing.command) === unversioned(entry.command) &&
    Array.isArray(existing.args) &&
    existing.args.length === entry.args.length &&
    existing.args.every((arg, i) => unversioned(arg) === unversioned(entry.args[i]))
  );
}

/** The agents a server reported, with the connection they were read on. */
interface Report {
  epoch: number;
  profileId: string;
  agents: HostAgentView[];
}

/** Whether `report` still belongs to the connection now, and to the draft's target. */
function current(report: Report | undefined, now: DaemonTargetSnapshot | undefined, targetEpoch: number | undefined) {
  return (
    !!report &&
    !!now?.profile &&
    report.epoch === now.epoch &&
    report.profileId === now.profile.id &&
    report.epoch === targetEpoch
  );
}

export function HostAgentsSection(): JSX.Element | null {
  const studio = useConfigurationStudio();
  const connection = window.orca.daemonConnection;
  const profiles = connection?.profiles;
  const [snapshot, setSnapshot] = useState(() => connection?.read());
  const [report, setReport] = useState<Report>();
  const [, setTick] = useState(0);
  useEffect(() => connection?.subscribe(setSnapshot), [connection]);
  useEffect(() => studio?.subscribe(() => setTick((n) => n + 1)), [studio]);
  const epoch = snapshot?.epoch;
  const profileId = snapshot?.profile?.id;
  useEffect(() => {
    setReport(undefined);
    if (epoch === undefined || !profileId || !profiles?.hostAgents) return;
    let live = true;
    void profiles.hostAgents(profileId).then((result) => {
      // A reply for an earlier connection, even to the same profile, is not this one's.
      const now = connection?.read();
      if (live && result.ok && now?.epoch === epoch && now.profile?.id === profileId)
        setReport({ epoch, profileId, agents: result.value });
    });
    return () => {
      live = false;
    };
  }, [epoch, profileId, profiles, connection]);
  const profile = snapshot?.profile;
  if (!profile || !studio || !current(report, snapshot, studio.target.epoch)) return null;
  const installed = report!.agents.filter((agent) => agent.installed && agent.entry);
  if (!installed.length) return null;
  const add = (entry: Entry) => {
    // Checked again at the click: the connection, the report and the draft's target are one.
    if (!current(report, connection?.read(), studio.target.epoch)) return;
    const plan = agentEntryPlan(studio.value, entry);
    if (plan.kind === "add" || plan.kind === "update") studio.edit(plan.edits);
  };
  return (
    <section className="orca-connection-stack" aria-label={`Agents installed on ${profile.name}`}>
      <Text style="caption" as="p">
        Agents installed on {profile.name}. Adding one puts the entry that runs it into this configuration&apos;s draft;
        review, save and apply it as usual.
      </Text>
      {installed.map((agent) => {
        const plan = agentEntryPlan(studio.value, agent.entry!);
        const access =
          plan.kind === "conflict"
            ? { allowed: false as const, reason: plan.reason }
            : plan.kind === "current"
              ? { allowed: false as const, reason: "This configuration already runs it." }
              : studio.editAccess(plan.edits);
        return (
          <div key={agent.agent} className="orca-dialog__actions">
            <Text style="caption" as="span">
              {agent.name} {agent.version}
            </Text>
            {plan.kind === "conflict" ? (
              <Text style="caption" as="span">
                {plan.reason}
              </Text>
            ) : null}
            <Button
              size="sm"
              disabled={!access.allowed}
              {...(access.allowed ? {} : { disabledReason: access.reason })}
              onClick={() => add(agent.entry!)}
            >
              {plan.kind === "current"
                ? "In configuration"
                : plan.kind === "add"
                  ? "Add to configuration"
                  : "Update in configuration"}
            </Button>
          </div>
        );
      })}
    </section>
  );
}
