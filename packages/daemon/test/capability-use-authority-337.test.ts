/**
 * The use decision for catalog MCP servers (#337): a run may be given one only while the
 * principal that owns its root holds a current credential with `capabilities.use` and a grant
 * naming that server, as defined now, on the agent's host and endpoint.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { chmod, chown, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalHost,
  resolveMcpServerCommand,
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
const GITHUB = { command: "/opt/mcp/gh-mcp", args: [], env: { GITHUB_TOKEN: { secret: "github-token" } } };
const DEFINITION = mcpServerDefinitionDigest(GITHUB);
const use = (over: Partial<CapabilityUse> = {}): CapabilityUse => ({
  kind: "mcpServer",
  id: "github",
  hostId: "local",
  hostBinding: LOCAL_BINDING,
  definition: DEFINITION,
  trustedExecutable: true,
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

  it("covers a command found by PATH or working directory, or an untrusted executable, only with '*'", async () => {
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
      f.check({ runId: "root", uses: [use({ definition: bare, trustedExecutable: false })] }),
    ).rejects.toMatchObject({ ...unauthorized, message: expect.stringMatching(/only root or the agent's account/) });
    // A grant naming an absolute command covers it only while its executable is trusted there.
    await f.credentials.issue({
      principal: "ci-bot",
      permissions: client,
      scope: PRESETS.client.scope,
      capabilities: grant,
    });
    await f.check({ runId: "root", uses: [use()] });
    await expect(f.check({ runId: "root", uses: [use({ trustedExecutable: false })] })).rejects.toMatchObject(
      unauthorized,
    );
    const g = fixture();
    g.ownership.record("root", "owner");
    await g.credentials.issue({ principal: "owner", preset: "owner" });
    await g.check({ runId: "root", uses: [use({ definition: bare, trustedExecutable: false })] });
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

/** Whether `path` meets the trusted-executable policy on this machine, checked independently. */
function trustedHere(path: string): boolean {
  const chain: string[] = [];
  for (let at = path; ; at = dirname(at)) {
    chain.push(at);
    if (at === dirname(at)) break;
  }
  const uid = process.getuid?.();
  return chain.every((at) => {
    const info = lstatSync(at);
    return !info.isSymbolicLink() && (info.uid === 0 || info.uid === uid) && (info.mode & 0o022) === 0;
  });
}

describe("resolveMcpServerCommand", () => {
  // Nothing under the shared temp directory is a trusted executable: /tmp is world-writable.
  const found = (path: string, trusted = false) => ({ path, trusted });
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

  it("trusts only an exact, canonical, administrator-owned absolute command on the daemon's machine", async () => {
    if (process.platform === "win32") return;
    const local = new LocalHost({ id: "local", type: "local" });
    const ctx = { cwd: tmpdir(), agentEnv: {} };
    if (existsSync("/usr/bin/env")) {
      expect(await resolveMcpServerCommand(local, { command: "/usr/bin/env", env: {} }, ctx)).toEqual(
        found("/usr/bin/env", trustedHere("/usr/bin/env")),
      );
      // Not its own canonical spelling.
      expect(await resolveMcpServerCommand(local, { command: "/usr/bin/../bin/env", env: {} }, ctx)).toEqual(
        found("/usr/bin/../bin/env"),
      );
      // Found by search: handed over, never trusted.
      expect(await resolveMcpServerCommand(local, { command: "env", env: { PATH: "/usr/bin" } }, ctx)).toEqual(
        found("/usr/bin/env"),
      );
    }
    // A file under a world-writable directory.
    const dir = await mkdtemp(join(tmpdir(), "orca-mcp-trust-"));
    dirs.push(dir);
    await writeFile(join(dir, "tool"), "#!/bin/sh\n");
    await chmod(join(dir, "tool"), 0o755);
    expect(await resolveMcpServerCommand(local, { command: join(dir, "tool"), env: {} }, ctx)).toEqual(
      found(join(dir, "tool")),
    );
  });

  it("refuses trust for a symbolic link, a writable directory or another owner (as root)", async (context) => {
    if (process.platform === "win32" || process.getuid?.() !== 0) return context.skip();
    // A directory this test owns, in a chain only root can change.
    const base = await mkdtemp(join(homedir(), ".orca-mcp-trust-"));
    dirs.push(base);
    await chmod(base, 0o755);
    if (!trustedHere(base)) return context.skip();
    const local = new LocalHost({ id: "local", type: "local" });
    const ctx = { cwd: base, agentEnv: {} };
    const tool = join(base, "tool");
    await writeFile(tool, "#!/bin/sh\n");
    await chmod(tool, 0o755);
    const trusted = async (command: string) => {
      const r = await resolveMcpServerCommand(local, { command, env: {} }, ctx);
      return "path" in r && r.trusted;
    };
    expect(await trusted(tool)).toBe(true);
    await symlink(tool, join(base, "link"));
    expect(await trusted(join(base, "link"))).toBe(false);
    await mkdir(join(base, "real"));
    await chmod(join(base, "real"), 0o755);
    await writeFile(join(base, "real", "tool"), "#!/bin/sh\n");
    await chmod(join(base, "real", "tool"), 0o755);
    await symlink(join(base, "real"), join(base, "alias"));
    expect(await trusted(join(base, "real", "tool"))).toBe(true);
    // A symbolic link in a directory above the file.
    expect(await trusted(join(base, "alias", "tool"))).toBe(false);
    await chmod(join(base, "real"), 0o775);
    expect(await trusted(join(base, "real", "tool"))).toBe(false);
    await chmod(join(base, "real"), 0o755);
    await chmod(tool, 0o757);
    expect(await trusted(tool)).toBe(false);
    await chmod(tool, 0o755);
    await chown(tool, 65534, 65534);
    expect(await trusted(tool)).toBe(false);
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
      // An administrator-owned absolute command is a trusted executable; a spelling that is
      // not its own canonical path, or a symbolic link, is not (#337).
      if (existsSync("/usr/bin/env")) {
        expect(await resolveMcpServerCommand(box, { command: "/usr/bin/env", env: {} }, ctx)).toEqual(
          found("/usr/bin/env", trustedHere("/usr/bin/env")),
        );
        expect(await resolveMcpServerCommand(box, { command: "/usr/bin/../bin/env", env: {} }, ctx)).toEqual(
          found("/usr/bin/../bin/env"),
        );
      }
      // A configured search path cannot change the verdict: its own `ls` and `id` claim every
      // file is root's and unwritable, and are never asked.
      const fake = join(dir, "fake-bin");
      await mkdir(fake);
      for (const [name, body] of [
        ["ls", "echo '-rwxr-xr-x 1 0 0 0 Jan 1 00:00 x'"],
        ["id", "echo 0"],
      ] as const) {
        await writeFile(join(fake, name), `#!/bin/sh\n${body}\n`);
        await chmod(join(fake, name), 0o755);
      }
      expect(
        await resolveMcpServerCommand(box, { command: tool, env: { PATH: `${fake}:/usr/bin:/bin` } }, ctx),
      ).toEqual(found(tool));
      await symlink(tool, join(dir, "link"));
      expect(await resolveMcpServerCommand(box, { command: join(dir, "link"), env: {} }, ctx)).toEqual(
        found(join(dir, "link")),
      );
      expect(scripts.every((s) => s.startsWith("{ set +xv && exec 2>/dev/null; } || exit 4\n"))).toBe(true);
      // Tracing went off before anything ran, so the shell traced nothing of the lookup.
      expect(trace).not.toContain("command -v");
      const answer = (stdout: string, code = 0) =>
        resolveMcpServerCommand(
          { ...box, exec: async () => ({ code, stdout, stderr: "" }) },
          { command: "tool", env: {} },
          ctx,
        );
      // Only a marked absolute path on the last line is an answer.
      expect(await answer("noise\n__orca_path__=0:/usr/bin/tool\n")).toEqual(found("/usr/bin/tool"));
      // A name found by search is never trusted, whatever the host says.
      expect(await answer("__orca_path__=1:/usr/bin/tool\n")).toEqual(found("/usr/bin/tool"));
      expect(await answer("__orca_path__=/usr/bin/tool\n")).toEqual({ reason: "unreachable" });
      expect(await answer("/usr/bin/tool\n")).toEqual({ reason: "unreachable" });
      expect(await answer("__orca_path__=0:tool\n")).toEqual({ reason: "unreachable" });
      expect(await answer("__orca_path__=0:/usr/bin/tool\n", 255)).toEqual({ reason: "unreachable" });
      const thrown = { ...box, exec: async () => Promise.reject(new Error("ssh")) } as unknown as AgentHost;
      expect(await resolveMcpServerCommand(thrown, { command: "tool", env: {} }, ctx)).toEqual({
        reason: "unreachable",
      });
    },
  );
});
