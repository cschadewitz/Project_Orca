/**
 * Secret delivery over a real SSH connection (#336): a throwaway loopback sshd, the real
 * `ssh` client and the default `bash -lc` remote shell. Both ends are on this machine, so a
 * scan of every process's argument list while the agent starts covers the client and the
 * server side. Skipped without `/usr/sbin/sshd`, unless ORCA_REQUIRE_SSHD=1 (the Two daemons
 * workflow sets it).
 */
import { readdir, readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentSpecSchema, HostSpecSchema } from "@orca/core";
import { SshHost } from "@orca/agents";
import { loopbackSshd, type LoopbackSshd } from "@orca/testing/two-daemons";

let sshd: LoopbackSshd | undefined;
let dir: string;
beforeAll(async () => {
  sshd = await loopbackSshd({ commands: true });
  dir = await mkdtemp(join(tmpdir(), "orca-ssh-secrets-"));
}, 60_000);
afterAll(async () => {
  await sshd?.close();
  await rm(dir, { recursive: true, force: true });
});

/** Every process's argv on this machine, read from /proc. */
async function allArgv(): Promise<string[]> {
  const out: string[] = [];
  for (const pid of (await readdir("/proc")).filter((p) => /^\d+$/.test(p)))
    out.push(
      await readFile(`/proc/${pid}/cmdline`, "utf8").then(
        (c) => c.split("\0").join(" "),
        () => "",
      ),
    );
  return out;
}

describe("secret delivery over a real sshd", () => {
  it("reads the value in the agent's own connection and never shows it in any argument list", async (context) => {
    if (!sshd) return context.skip("no /usr/sbin/sshd; set ORCA_REQUIRE_SSHD=1 to require it");
    const value = "native-secret-value-5555";
    await writeFile(join(dir, "token"), `${value}\n`, { mode: 0o600 });
    const out = join(dir, "seen");
    const host = new SshHost(
      HostSpecSchema.parse({
        id: "loopback",
        type: "ssh",
        host: "127.0.0.1",
        user: sshd.user,
        sshArgs: sshd.sshArgs.slice(0, -1),
      }) as never,
      { sftp: false },
    );
    // Sample every process's argv until the agent has reported, the preamble included.
    const leaks: string[] = [];
    let sampling = true;
    const needles = [value, Buffer.from(value).toString("base64")];
    const sampler = (async () => {
      while (sampling) {
        for (const argv of await allArgv()) if (needles.some((n) => argv.includes(n))) leaks.push(argv);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const script = `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ token: process.env.TOKEN }));`;
    const proc = await host.spawnAgent(
      AgentSpecSchema.parse({ id: "a", command: process.execPath, args: ["-e", script] }),
      {
        cwd: dir,
        secrets: [{ id: "token", source: { provider: "file", path: join(dir, "token") }, env: ["TOKEN"] }],
      },
    );
    expect(proc.secretValues?.get("token")).toBe(value);
    await proc.exited;
    sampling = false;
    await sampler;
    expect(JSON.parse(await readFile(out, "utf8"))).toEqual({ token: value });
    expect(leaks).toEqual([]);
  }, 60_000);
});
