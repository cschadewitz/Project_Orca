/**
 * Agents installed on this managed server, on its Config surface (#1235). Shown only while the app
 * is connected to a saved SSH profile whose server reports installed agents (#1236). **Add to
 * configuration** puts the agent's `agents:` entry (the one `orca-cli remote agent install`
 * prints) into the draft, replacing an entry with the same id; nothing is written until the
 * person reviews, saves and applies the draft as with any other edit.
 */
import { useEffect, useState, type JSX } from "react";
import type { HostAgentView } from "../../../src/daemon-connection.js";
import { Button, Text } from "../ui/index.js";
import { useConfigurationStudio } from "./configuration-studio-context.js";
import type { EditIntent } from "./structured-form/contracts.js";

type Entry = NonNullable<HostAgentView["entry"]>;

/** The edit that puts `entry` into the draft's `agents:` list: in place of one with its id, or at the end. */
export function agentEntryEdit(draft: unknown, entry: Entry): EditIntent {
  const agents =
    draft && typeof draft === "object" && !Array.isArray(draft) ? (draft as Record<string, unknown>).agents : undefined;
  if (!Array.isArray(agents)) return { kind: "set", path: ["agents"], value: [entry] };
  const index = agents.findIndex(
    (agent) => agent && typeof agent === "object" && (agent as Record<string, unknown>).id === entry.id,
  );
  return index >= 0
    ? { kind: "set", path: ["agents", index], value: entry }
    : { kind: "insert", path: ["agents"], index: agents.length, value: entry };
}

export function HostAgentsSection(): JSX.Element | null {
  const studio = useConfigurationStudio();
  const connection = window.orca.daemonConnection;
  const profiles = connection?.profiles;
  const [profile, setProfile] = useState(() => connection?.read().profile);
  const [agents, setAgents] = useState<HostAgentView[]>();
  const [, setTick] = useState(0);
  useEffect(() => connection?.subscribe((target) => setProfile(target.profile)), [connection]);
  useEffect(() => studio?.subscribe(() => setTick((n) => n + 1)), [studio]);
  useEffect(() => {
    setAgents(undefined);
    if (!profile || !profiles?.hostAgents) return;
    let current = true;
    void profiles.hostAgents(profile.id).then((result) => {
      if (current && result.ok) setAgents(result.value);
    });
    return () => {
      current = false;
    };
  }, [profile?.id, profiles]);
  const installed = agents?.filter((agent) => agent.installed && agent.entry);
  if (!profile || !studio || !installed?.length) return null;
  return (
    <section className="orca-connection-stack" aria-label={`Agents installed on ${profile.name}`}>
      <Text style="caption" as="p">
        Agents installed on {profile.name}. Adding one puts the entry that runs it into this configuration&apos;s draft;
        review, save and apply it as usual.
      </Text>
      {installed.map((agent) => {
        const edit = agentEntryEdit(studio.value, agent.entry!);
        const access = studio.editAccess([edit]);
        return (
          <div key={agent.agent} className="orca-dialog__actions">
            <Text style="caption" as="span">
              {agent.name} {agent.version}
            </Text>
            <Button
              size="sm"
              disabled={!access.allowed}
              title={access.allowed ? undefined : access.reason}
              onClick={() => studio.edit([agentEntryEdit(studio.value, agent.entry!)])}
            >
              {edit.kind === "set" && edit.path.length === 2 ? "Update in configuration" : "Add to configuration"}
            </Button>
          </div>
        );
      })}
    </section>
  );
}
