/** Host construction from config (`local` / `ssh`) and the registry the engine looks agents up in. */
import { OrcaError, type AgentSelector, type AgentSpec, type HostSpec } from "@orca/core";
import type { AgentHost } from "../host.js";
import { LocalHost } from "./local-host.js";
import { SshHost } from "./ssh-host.js";

export function createHost(spec: HostSpec): AgentHost {
  switch (spec.type) {
    case "local":
      return new LocalHost(spec);
    case "ssh":
      return new SshHost(spec);
  }
}

/** Resolves hosts and agents from config; the engine's single lookup point. */
export class AgentRegistry {
  private readonly hosts = new Map<string, AgentHost>();
  private readonly agents = new Map<string, AgentSpec>();
  private readonly roles = new Map<string, string>();

  addHost(host: AgentHost): this {
    this.hosts.set(host.id, host);
    return this;
  }
  addAgent(spec: AgentSpec): this {
    this.agents.set(spec.id, spec);
    return this;
  }
  mapRole(role: string, agentId: string): this {
    this.roles.set(role, agentId);
    return this;
  }
  static fromConfig(cfg: { hosts: HostSpec[]; agents: AgentSpec[]; roles: Record<string, string> }): AgentRegistry {
    const r = new AgentRegistry();
    for (const h of cfg.hosts) r.addHost(createHost(h));
    for (const a of cfg.agents) r.addAgent(a);
    for (const [role, id] of Object.entries(cfg.roles)) r.mapRole(role, id);
    return r;
  }

  host(id: string): AgentHost {
    const h = this.hosts.get(id);
    if (!h) throw new OrcaError("AGENT_HOST_NOT_FOUND", `host '${id}' not configured`, { known: [...this.hosts.keys()] });
    return h;
  }
  hasHost(id: string): boolean {
    return this.hosts.has(id);
  }
  listHosts(): AgentHost[] {
    return [...this.hosts.values()];
  }
  listAgents(): AgentSpec[] {
    return [...this.agents.values()];
  }

  canResolve(selector: AgentSelector): boolean {
    try {
      this.resolve(selector);
      return true;
    } catch {
      return false;
    }
  }

  resolve(selector: AgentSelector): { agent: AgentSpec; host: AgentHost } {
    let id: string | undefined;
    if (typeof selector === "string") id = selector;
    else if ("id" in selector) id = selector.id;
    else {
      id = this.roles.get(selector.role) ?? [...this.agents.values()].find((a) => a.roles.includes(selector.role))?.id;
      if (!id) throw new OrcaError("AGENT_NOT_FOUND", `no agent fills role '${selector.role}'`, { role: selector.role });
    }
    const agent = this.agents.get(id);
    if (!agent) throw new OrcaError("AGENT_NOT_FOUND", `agent '${id}' not configured`, { known: [...this.agents.keys()] });
    return { agent, host: this.host(agent.hostId) };
  }
}
