/** Host processes use Node fixtures so transport tests also exercise Windows. */
import { describe, expect, it, vi } from "vitest";
import { AgentSpecSchema } from "@orca/core";
import { LocalHost } from "@orca/agents";

describe("hosts", () => {
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
});
