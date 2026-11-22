/**
 * The use decision for catalog MCP servers (#337): a run may be given one only while the
 * principal that owns its root holds a current credential with `capabilities.use` and a grant
 * naming that server, as defined now, on the agent's host and endpoint.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mcpServerCommandAvailable,
  mcpServerDefinitionDigest,
  secretHostBinding,
  type AgentHost,
  type CapabilityUse,
} from "@orca/agents";
import { HostSpecSchema } from "@orca/core";
import {
  CredentialStore,
  LOCAL_PRINCIPAL,
  MemoryAuditSink,
  OwnershipStore,
  PRESETS,
  credentialCapabilityUse,
  loopbackCapabilityUse,
  type ResourceResolver,
} from "../src/auth/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const LOCAL_BINDING = secretHostBinding({ id: "local", type: "local" });
const GITHUB = { command: "gh-mcp", args: [], env: { GITHUB_TOKEN: { secret: "github-token" } } };
const DEFINITION = mcpServerDefinitionDigest(GITHUB);
const use = (over: Partial<CapabilityUse> = {}): CapabilityUse => ({
  kind: "mcpServer",
  id: "github",
  hostId: "local",
  hostBinding: LOCAL_BINDING,
  definition: DEFINITION,
  ...over,
});

function fixture() {
  const credentials = new CredentialStore({ now: () => new Date("2026-11-22T12:00:00Z") });
  const ownership = new OwnershipStore();
  const runs: Record<string, { workflowId: string; parentRunId?: string }> = {
    root: { workflowId: "w" },
    child: { workflowId: "w::n", parentRunId: "root" },
    orphan: { workflowId: "w" },
  };
  const resolver: ResourceResolver = {
    run: async (id) => runs[id],
    inputRun: async () => undefined,
    artifactRun: async () => undefined,
    claimRun: async () => undefined,
    workflowExists: () => true,
  };
  const audit = new MemoryAuditSink();
  const check = credentialCapabilityUse({ resolver, ownership, credentials, audit });
  return { credentials, ownership, audit, check };
}

const client = [...PRESETS.client.permissions, "capabilities.use" as const];
const grant = [
  { kind: "mcpServer" as const, id: "github", host: "local", binding: LOCAL_BINDING, definition: DEFINITION },
];
const unauthorized = { code: "CONFIG_INVALID", details: { reason: "unauthorized" } };

describe("capability use authority", () => {
  it("gives a run a server its owner's current credential grants, judged at the root", async () => {
    const f = fixture();
    f.ownership.record("root", "ci-bot");
    await f.credentials.issue({
      principal: "ci-bot",
      permissions: client,
      scope: PRESETS.client.scope,
      capabilities: grant,
    });
    await f.check({ runId: "root", uses: [use()] });
    await f.check({ runId: "child", uses: [use()] });
    expect(f.audit.records.map((r) => [r.event, r.outcome, r.actor?.principal, r.target])).toEqual([
      ["capability.use", "succeeded", "ci-bot", { runId: "root", mcpServers: "github" }],
      ["capability.use", "succeeded", "ci-bot", { runId: "child", mcpServers: "github" }],
    ]);
  });

  it("does not follow a redefined server, another host or endpoint, or a grant without capabilities.use", async () => {
    const f = fixture();
    f.ownership.record("root", "ci-bot");
    await f.credentials.issue({
      principal: "ci-bot",
      permissions: client,
      scope: PRESETS.client.scope,
      capabilities: grant,
    });
    await expect(f.check({ runId: "root", uses: [use({ id: "db" })] })).rejects.toMatchObject({
      ...unauthorized,
      details: { kind: "mcpServer", id: "db", hostId: "local", reason: "unauthorized" },
    });
    const redefined = mcpServerDefinitionDigest({ ...GITHUB, command: "/tmp/other" });
    await expect(f.check({ runId: "root", uses: [use({ definition: redefined })] })).rejects.toMatchObject(
      unauthorized,
    );
    await expect(f.check({ runId: "root", uses: [use({ hostId: "box" })] })).rejects.toMatchObject(unauthorized);
    const elsewhere = secretHostBinding(HostSpecSchema.parse({ id: "local", type: "ssh", host: "elsewhere" }));
    await expect(f.check({ runId: "root", uses: [use({ hostBinding: elsewhere })] })).rejects.toMatchObject(
      unauthorized,
    );
    // A grant alone, without the permission, gives nothing.
    const g = fixture();
    g.ownership.record("root", "viewer");
    await g.credentials.issue({ principal: "viewer", preset: "viewer", capabilities: "*" });
    await expect(g.check({ runId: "root", uses: [use()] })).rejects.toMatchObject(unauthorized);
  });

  it("stops at the next decision once the credential is revoked, and refuses unowned runs", async () => {
    const f = fixture();
    f.ownership.record("root", "ci-bot");
    const issued = await f.credentials.issue({
      principal: "ci-bot",
      permissions: client,
      scope: PRESETS.client.scope,
      capabilities: grant,
    });
    await f.check({ runId: "root", uses: [use()] });
    await f.credentials.revoke(issued.credential.id);
    await expect(f.check({ runId: "root", uses: [use()] })).rejects.toMatchObject(unauthorized);
    await expect(f.check({ runId: "orphan", uses: [use()] })).rejects.toMatchObject(unauthorized);
    expect(f.audit.records.map((r) => r.reason)).toEqual([undefined, "no current grant", "run has no recorded owner"]);
  });

  it("is granted everything by the owner preset and loopback mode, and nothing by other presets", async () => {
    expect(PRESETS.owner.capabilities).toBe("*");
    for (const preset of ["operator", "viewer", "client"] as const)
      expect("capabilities" in PRESETS[preset]).toBe(false);
    await loopbackCapabilityUse(LOCAL_PRINCIPAL)({ runId: "any", uses: [use()] });
  });
});

describe("mcpServerCommandAvailable", () => {
  it("finds a command by absolute path, or on the PATH the server or agent is configured with", async () => {
    if (process.platform === "win32") return;
    const dir = await mkdtemp(join(tmpdir(), "orca-mcp-bin-"));
    dirs.push(dir);
    await writeFile(join(dir, "tool"), "#!/bin/sh\n");
    await chmod(join(dir, "tool"), 0o755);
    await writeFile(join(dir, "plain"), "not executable");
    const local = {
      spec: { id: "local", type: "local" },
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    } as unknown as AgentHost;
    const ctx = { cwd: dir, agentEnv: {} };
    expect(await mcpServerCommandAvailable(local, { command: join(dir, "tool"), env: {} }, ctx)).toBeUndefined();
    expect(await mcpServerCommandAvailable(local, { command: "./tool", env: {} }, ctx)).toBeUndefined();
    expect(await mcpServerCommandAvailable(local, { command: join(dir, "plain"), env: {} }, ctx)).toBe("missing");
    expect(await mcpServerCommandAvailable(local, { command: "tool", env: { PATH: dir } }, ctx)).toBeUndefined();
    expect(
      await mcpServerCommandAvailable(
        local,
        { command: "tool", env: {} },
        { cwd: dir, agentEnv: { PATH: `/nowhere${delimiter}${dir}` } },
      ),
    ).toBeUndefined();
    expect(await mcpServerCommandAvailable(local, { command: "orca-no-such-tool", env: {} }, ctx)).toBe("missing");
  });

  it.each(["sh", "bash", "dash"].filter((sh) => spawnSync(sh, ["-c", "true"]).status === 0))(
    "checks an SSH host with one quiet command on that host only (%s -x)",
    async (shell) => {
      const dir = await mkdtemp(join(tmpdir(), "orca-mcp-ssh-"));
      dirs.push(dir);
      await writeFile(join(dir, "tool"), "#!/bin/sh\n");
      await chmod(join(dir, "tool"), 0o755);
      const scripts: string[] = [];
      let seen = "";
      const box = {
        spec: HostSpecSchema.parse({ id: "box", type: "ssh", host: "box.example" }),
        exec: async (script: string) => {
          scripts.push(script);
          const run = spawnSync(shell, ["-x", "-c", script], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
          seen += run.stdout + run.stderr;
          return { code: run.status, stdout: run.stdout, stderr: run.stderr };
        },
      } as unknown as AgentHost;
      const ctx = { cwd: dir, agentEnv: {} };
      expect(await mcpServerCommandAvailable(box, { command: "./tool", env: {} }, ctx)).toBeUndefined();
      expect(await mcpServerCommandAvailable(box, { command: "tool", env: { PATH: dir } }, ctx)).toBeUndefined();
      expect(await mcpServerCommandAvailable(box, { command: "tool", env: {} }, ctx)).toBe("missing");
      expect(await mcpServerCommandAvailable(box, { command: "x'; touch pwned; '", env: {} }, ctx)).toBe("missing");
      expect(existsSync(join(dir, "pwned"))).toBe(false);
      expect(
        await mcpServerCommandAvailable(box, { command: "tool", env: {} }, { cwd: "/no/such/dir", agentEnv: {} }),
      ).toBe("missing");
      expect(scripts.every((s) => s.startsWith("{ set +xv && exec 2>/dev/null; } || exit 4; "))).toBe(true);
      // Tracing went off before anything ran, so the shell printed nothing of the lookup.
      expect(seen).not.toContain("command -v");
      // A host that does not answer is unreachable, never "found" somewhere else.
      const down = { ...box, exec: async () => ({ code: 255, stdout: "", stderr: "" }) } as unknown as AgentHost;
      expect(await mcpServerCommandAvailable(down, { command: "tool", env: {} }, ctx)).toBe("unreachable");
      const thrown = { ...box, exec: async () => Promise.reject(new Error("ssh")) } as unknown as AgentHost;
      expect(await mcpServerCommandAvailable(thrown, { command: "tool", env: {} }, ctx)).toBe("unreachable");
    },
  );
});
