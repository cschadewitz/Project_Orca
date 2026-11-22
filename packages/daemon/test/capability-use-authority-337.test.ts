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
  resolveMcpServerCommand,
  mcpServerDefinitionDigest,
  secretHostBinding,
  type AgentHost,
  type McpServerUse,
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
const GITHUB = { command: "/opt/mcp/gh-mcp", args: [], env: { GITHUB_TOKEN: { secret: "github-token" } } };
const DEFINITION = mcpServerDefinitionDigest(GITHUB);
const use = (over: Partial<McpServerUse> = {}): McpServerUse => ({
  kind: "mcpServer",
  id: "github",
  hostId: "local",
  hostBinding: LOCAL_BINDING,
  definition: DEFINITION,
  absoluteCommand: true,
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

  it("needs one credential that grants the whole selected set; disjoint grants do not combine", async () => {
    const f = fixture();
    f.ownership.record("root", "ci-bot");
    const DB = { command: "/opt/mcp/db-mcp", args: [], env: {} };
    const db = use({ id: "db", definition: mcpServerDefinitionDigest(DB) });
    const entry = (id: string, definition: string) => ({
      kind: "mcpServer" as const,
      id,
      host: "local",
      binding: LOCAL_BINDING,
      definition,
    });
    for (const grant of [[entry("github", DEFINITION)], [entry("db", db.definition)]])
      await f.credentials.issue({
        principal: "ci-bot",
        permissions: client,
        scope: PRESETS.client.scope,
        capabilities: grant,
      });
    // Each server alone is granted, by one credential or the other...
    await f.check({ runId: "root", uses: [use()] });
    await f.check({ runId: "root", uses: [db] });
    // ...but no single credential grants both, so the set is refused.
    await expect(f.check({ runId: "root", uses: [use(), db] })).rejects.toMatchObject(unauthorized);
    expect(f.audit.records.at(-1)?.reason).toBe("no single credential grants the whole set");
    await f.credentials.issue({
      principal: "ci-bot",
      permissions: client,
      scope: PRESETS.client.scope,
      capabilities: [entry("github", DEFINITION), entry("db", db.definition)],
    });
    await f.check({ runId: "root", uses: [use(), db] });
  });

  it("covers a command found by PATH or working directory only with '*', never with a narrow grant", async () => {
    const f = fixture();
    f.ownership.record("root", "ci-bot");
    const bare = mcpServerDefinitionDigest({ ...GITHUB, command: "gh-mcp" });
    await f.credentials.issue({
      principal: "ci-bot",
      permissions: client,
      scope: PRESETS.client.scope,
      capabilities: [{ kind: "mcpServer", id: "github", host: "local", binding: LOCAL_BINDING, definition: bare }],
    });
    await expect(
      f.check({ runId: "root", uses: [use({ definition: bare, absoluteCommand: false })] }),
    ).rejects.toMatchObject(unauthorized);
    const g = fixture();
    g.ownership.record("root", "owner");
    await g.credentials.issue({ principal: "owner", preset: "owner" });
    await g.check({ runId: "root", uses: [use({ definition: bare, absoluteCommand: false })] });
  });

  it("grants a skill by its exact content, and takes servers and skills as one set", async () => {
    const f = fixture();
    f.ownership.record("root", "ci-bot");
    const digest = `sha256:${"a".repeat(64)}`;
    const skill = { kind: "skill" as const, id: "review", digest };
    await f.credentials.issue({
      principal: "ci-bot",
      permissions: client,
      scope: PRESETS.client.scope,
      capabilities: [
        { kind: "mcpServer", id: "github", host: "local", binding: LOCAL_BINDING, definition: DEFINITION },
        { kind: "skill", id: "review", digest },
      ],
    });
    await f.check({ runId: "root", uses: [use(), skill] });
    expect(f.audit.records.at(-1)?.target).toEqual({ runId: "root", mcpServers: "github", skills: "review" });
    // An edited skill has another digest: not covered.
    await expect(
      f.check({ runId: "root", uses: [{ ...skill, digest: `sha256:${"b".repeat(64)}` }] }),
    ).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      details: { kind: "skill", id: "review", reason: "unauthorized" },
    });
    await expect(f.check({ runId: "root", uses: [{ ...skill, id: "other" }] })).rejects.toMatchObject(unauthorized);
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

describe("resolveMcpServerCommand", () => {
  const found = (path: string) => ({ path });
  const missing = { reason: "missing" };

  it("resolves a command to the executable file the agent is handed, or refuses it", async () => {
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
    const tool = join(dir, "tool");
    expect(await resolveMcpServerCommand(local, { command: tool, env: {} }, ctx)).toEqual(found(tool));
    expect(await resolveMcpServerCommand(local, { command: "./tool", env: {} }, ctx)).toEqual(found(tool));
    expect(await resolveMcpServerCommand(local, { command: join(dir, "plain"), env: {} }, ctx)).toEqual(missing);
    expect(await resolveMcpServerCommand(local, { command: dir, env: {} }, ctx)).toEqual(missing);
    expect(await resolveMcpServerCommand(local, { command: "tool", env: { PATH: dir } }, ctx)).toEqual(found(tool));
    expect(
      await resolveMcpServerCommand(
        local,
        { command: "tool", env: {} },
        { cwd: dir, agentEnv: { PATH: `/nowhere${delimiter}${dir}` } },
      ),
    ).toEqual(found(tool));
    expect(await resolveMcpServerCommand(local, { command: "orca-no-such-tool", env: {} }, ctx)).toEqual(missing);
  });

  it.each(["sh", "bash", "dash"].filter((sh) => spawnSync(sh, ["-c", "true"]).status === 0))(
    "resolves on an SSH host with one quiet command on that host only (%s -x)",
    async (shell) => {
      const dir = await mkdtemp(join(tmpdir(), "orca-mcp-ssh-"));
      dirs.push(dir);
      await writeFile(join(dir, "tool"), "#!/bin/sh\n");
      await chmod(join(dir, "tool"), 0o755);
      const scripts: string[] = [];
      let trace = "";
      // A login profile that prints before the command runs.
      const box = {
        spec: HostSpecSchema.parse({ id: "box", type: "ssh", host: "box.example" }),
        exec: async (script: string) => {
          scripts.push(script);
          const run = spawnSync(shell, ["-x", "-c", `echo welcome; ${script}`], {
            env: { PATH: "/usr/bin:/bin" },
            encoding: "utf8",
          });
          trace += run.stderr;
          return { code: run.status, stdout: run.stdout, stderr: run.stderr };
        },
      } as unknown as AgentHost;
      const ctx = { cwd: dir, agentEnv: {} };
      const tool = join(dir, "tool");
      expect(await resolveMcpServerCommand(box, { command: tool, env: {} }, ctx)).toEqual(found(tool));
      expect(await resolveMcpServerCommand(box, { command: "./tool", env: {} }, ctx)).toEqual(found(`${dir}/./tool`));
      expect(await resolveMcpServerCommand(box, { command: "tool", env: { PATH: dir } }, ctx)).toEqual(found(tool));
      expect(await resolveMcpServerCommand(box, { command: "tool", env: {} }, ctx)).toEqual(missing);
      // A shell builtin is not an executable file.
      expect(await resolveMcpServerCommand(box, { command: "cd", env: {} }, ctx)).toEqual(missing);
      expect(await resolveMcpServerCommand(box, { command: "x'; touch pwned; '", env: {} }, ctx)).toEqual(missing);
      expect(existsSync(join(dir, "pwned"))).toBe(false);
      expect(
        await resolveMcpServerCommand(box, { command: "tool", env: {} }, { cwd: "/no/such/dir", agentEnv: {} }),
      ).toEqual(missing);
      expect(scripts.every((s) => s.startsWith("{ set +xv && exec 2>/dev/null; } || exit 4; "))).toBe(true);
      // Tracing went off before anything ran, so the shell traced nothing of the lookup.
      expect(trace).not.toContain("command -v");
      const answer = (stdout: string, code = 0) =>
        resolveMcpServerCommand(
          { ...box, exec: async () => ({ code, stdout, stderr: "" }) },
          { command: "tool", env: {} },
          ctx,
        );
      // Only a marked absolute path on the last line is an answer.
      expect(await answer("noise\n__orca_path__=/usr/bin/tool\n")).toEqual(found("/usr/bin/tool"));
      expect(await answer("/usr/bin/tool\n")).toEqual({ reason: "unreachable" });
      expect(await answer("__orca_path__=tool\n")).toEqual({ reason: "unreachable" });
      expect(await answer("__orca_path__=/usr/bin/tool\n", 255)).toEqual({ reason: "unreachable" });
      const thrown = { ...box, exec: async () => Promise.reject(new Error("ssh")) } as unknown as AgentHost;
      expect(await resolveMcpServerCommand(thrown, { command: "tool", env: {} }, ctx)).toEqual({
        reason: "unreachable",
      });
    },
  );
});
