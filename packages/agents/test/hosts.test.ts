import { describe, expect, it } from "vitest";
import { AgentSpecSchema, HostSpecSchema } from "@orca/core";
import { AgentRegistry, decidePermission, LocalHost, shellQuote, SshHost } from "@orca/agents";

describe("hosts", () => {
  it("builds ssh arguments that tunnel the ACP stdio transport", () => {
    const host = new SshHost(HostSpecSchema.parse({ id: "box", type: "ssh", host: "build.example", user: "ci", port: 2222, identityFile: "~/.ssh/ci", sshArgs: ["-o", "ProxyJump=bastion"] }) as never);
    expect(host.baseArgs()).toEqual(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", "-o", "ProxyJump=bastion", "-p", "2222", "-i", "~/.ssh/ci", "ci@build.example"]);
    expect(host.remoteCommand("cd /w && exec claude-code-acp")).toEqual(["bash", "-lc", "'cd /w && exec claude-code-acp'"]);
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  it("runs commands and serves files locally", async () => {
    const host = new LocalHost({ id: "local", type: "local" });
    const r = await host.exec("echo hi");
    expect(r.stdout.trim()).toBe("hi");
    expect(await host.fs.exists("/definitely/not/here")).toBe(false);
  });
  it("resolves agents by id and role", () => {
    const reg = new AgentRegistry().addHost(new LocalHost({ id: "local", type: "local" })).addAgent(AgentSpecSchema.parse({ id: "a", command: "x", roles: ["builder"] })).addAgent(AgentSpecSchema.parse({ id: "b", command: "y", roles: ["builder", "reviewer"] })).mapRole("reviewer", "a");
    expect(reg.resolve("b").agent.id).toBe("b");
    expect(reg.resolve({ role: "builder" }).agent.id).toBe("a");
    expect(reg.resolve({ role: "reviewer" }).agent.id).toBe("a");
    expect(reg.canResolve({ role: "nope" })).toBe(false);
  });
});

describe("permission policy", () => {
  const req = (kind: string, title: string, path?: string) => ({ sessionId: "s", toolCall: { toolCallId: "t", title, kind, locations: path ? [{ path }] : [] }, options: [] }) as never;
  it("applies the first matching rule, else the default", () => {
    const policy = { default: "allow" as const, rules: [{ match: { kind: "execute" as const, titlePattern: "rm -rf" }, decision: "deny" as const }, { match: { pathPrefix: "/etc" }, decision: "ask" as const }] };
    expect(decidePermission(policy, req("execute", "rm -rf /"))).toBe("deny");
    expect(decidePermission(policy, req("edit", "write", "/etc/hosts"))).toBe("ask");
    expect(decidePermission(policy, req("edit", "write", "/w/a.ts"))).toBe("allow");
  });
});
