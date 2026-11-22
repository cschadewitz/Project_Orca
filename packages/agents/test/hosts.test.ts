/** Host processes use Node fixtures so transport tests also exercise Windows. */
import { describe, expect, it, vi } from "vitest";
import { AgentSpecSchema, HostSpecSchema } from "@orca/core";
import { AgentRegistry, decidePermission, LocalHost, shellQuote, SshHost } from "@orca/agents";

describe("hosts", () => {
  it("builds ssh arguments that tunnel the ACP stdio transport", () => {
    const host = new SshHost(
      HostSpecSchema.parse({
        id: "box",
        type: "ssh",
        host: "build.example",
        user: "ci",
        port: 2222,
        identityFile: "~/.ssh/ci",
        sshArgs: ["-o", "ProxyJump=bastion"],
      }) as never,
    );
    expect(host.baseArgs()).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=20",
      "-o",
      "ProxyJump=bastion",
      "-p",
      "2222",
      "-i",
      "~/.ssh/ci",
      "ci@build.example",
    ]);
    expect(host.sftpArgs().slice(-5)).toEqual(["~/.ssh/ci", "-s", "ci@build.example", "--", "sftp"]);
    expect(host.sftpArgs().slice(0, -4)).toEqual(host.baseArgs().slice(0, -1));
    expect(host.remoteCommand("cd /w && exec claude-code-acp")).toEqual([
      "bash",
      "-lc",
      "'cd /w && exec claude-code-acp'",
    ]);
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
  it("runs commands and serves files locally", async () => {
    const host = new LocalHost({ id: "local", type: "local" });
    const r = await host.exec("echo hi");
    expect(r.stdout.trim()).toBe("hi");
    expect(await host.fs.exists("/definitely/not/here")).toBe(false);
    expect(await host.fs.existsMany([process.cwd(), "/definitely/not/here"])).toEqual([true, false]);
    expect(await host.fs.existsMany([])).toEqual([]);
  });
  it("feeds stdin, survives commands that never read it, and kills on timeout", async () => {
    const host = new LocalHost({ id: "local", type: "local" });
    const echoInput = `"${process.execPath}" -e "process.stdin.pipe(process.stdout)"`;
    expect((await host.exec(echoInput)).stdout).toBe("");
    expect((await host.exec(echoInput, { stdin: "piped\n" })).stdout).toBe("piped\n");
    // `echo` exits without draining stdin: the write must fail silently, not reject.
    expect((await host.exec("echo hi", { stdin: "x".repeat(100_000) })).code).toBe(0);
    // Must return promptly: the killed `sh` leaves `sleep` holding the stdout pipe.
    const started = Date.now();
    const slow = await host.exec(`"${process.execPath}" -e "setTimeout(()=>{},30000)"`, { timeoutMs: 50 });
    expect(slow.code).toBe(null);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
  it("escalates SIGTERM to SIGKILL on a process that ignores SIGTERM", async () => {
    const host = new LocalHost({ id: "local", type: "local" });
    const agent = AgentSpecSchema.parse({
      id: "stubborn",
      command: process.execPath,
      args: ["-e", 'process.on("SIGTERM",()=>{}); process.stderr.write("READY"); setInterval(()=>{},1000)'],
    });
    const proc = await host.spawnAgent(agent, { cwd: process.cwd() });
    await vi.waitFor(() => expect(proc.stderrTail()).toContain("READY"));
    const pending = Symbol("pending");
    const settled = () =>
      Promise.race([proc.exited, new Promise<typeof pending>((r) => setTimeout(() => r(pending), 300))]);

    proc.kill(); // SIGTERM: ignored by the child; this also flips child.killed=true
    // Windows terminates unconditionally for SIGTERM; it cannot model POSIX SIG_IGN.
    if (process.platform === "win32") {
      expect(await proc.exited).toMatchObject({ signal: "SIGTERM" });
      expect(() => proc.kill("SIGKILL")).not.toThrow();
      return;
    }
    expect(await settled()).toBe(pending);

    proc.kill("SIGKILL"); // must not be short-circuited by child.killed
    const exit = await settled();
    expect(exit).not.toBe(pending);
    expect((exit as { signal: string | null }).signal).toBe("SIGKILL");

    expect(() => proc.kill("SIGKILL")).not.toThrow(); // no-op after exit
  });
  it("resolves agents by id and role", () => {
    const reg = new AgentRegistry()
      .addHost(new LocalHost({ id: "local", type: "local" }))
      .addAgent(AgentSpecSchema.parse({ id: "a", command: "x", roles: ["builder"] }))
      .addAgent(AgentSpecSchema.parse({ id: "b", command: "y", roles: ["builder", "reviewer"] }))
      .mapRole("reviewer", "a");
    expect(reg.resolve("b").agent.id).toBe("b");
    expect(reg.resolve({ role: "builder" }).agent.id).toBe("a");
    expect(reg.resolve({ role: "reviewer" }).agent.id).toBe("a");
    expect(reg.canResolve({ role: "nope" })).toBe(false);
  });
});

describe("permission policy", () => {
  const req = (kind: string, title: string, path?: string) =>
    ({
      sessionId: "s",
      toolCall: { toolCallId: "t", title, kind, locations: path ? [{ path }] : [] },
      options: [],
    }) as never;
  it("applies the first matching rule, else the default", () => {
    const policy = {
      default: "allow" as const,
      rules: [
        { match: { kind: "execute" as const, titlePattern: "rm -rf" }, decision: "deny" as const },
        { match: { pathPrefix: "/etc" }, decision: "ask" as const },
      ],
    };
    expect(decidePermission(policy, req("execute", "rm -rf /"))).toBe("deny");
    expect(decidePermission(policy, req("edit", "write", "/etc/hosts"))).toBe("ask");
    expect(decidePermission(policy, req("edit", "write", "/w/a.ts"))).toBe("allow");
  });
});
