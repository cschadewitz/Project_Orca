/** SshHost's SFTP file system against a local SFTP server fixture: no sshd, runs on Windows too. */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostSpecSchema } from "@orca/core";
import { SshHost, type SshHostOptions } from "@orca/agents";

const server = fileURLToPath(new URL("./fixtures/fake-sftp-server.ts", import.meta.url));
let root: string;
let counter: string;
const hosts: SshHost[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "orca-sftp-"));
  counter = join(root, "sessions.log");
});
afterEach(async () => {
  for (const h of hosts.splice(0)) h.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

/** A host whose SFTP channel is the fixture; `env(n)` sets the fixture's knobs for the n-th session. */
function host(env: (session: number) => Record<string, string> = () => ({}), options: SshHostOptions = {}) {
  let session = 0;
  const h = new SshHost(
    HostSpecSchema.parse({ id: "remote", type: "ssh", host: "invalid", sshBinary: "orca-no-such-ssh-binary" }) as never,
    {
      openSftpChannel: () =>
        spawn(process.execPath, ["--import", "tsx", server], {
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, FAKE_SFTP_COUNT_FILE: counter, ...env(++session) },
        }),
      ...options,
    },
  );
  hosts.push(h);
  return h;
}
const sessions = async () => (await readFile(counter, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
const p = (...parts: string[]) => join(root, ...parts).replace(/\\/g, "/");

it("reads, writes, stats and creates directories over one session", async () => {
  const h = host();
  const exec = vi.spyOn(h, "exec");
  const target = p("deep", "er", "report.md");
  await h.fs.writeFile(target, "# report\nwith ünïcode ✓\n");
  expect(await readFile(target, "utf8")).toBe("# report\nwith ünïcode ✓\n");
  expect(await h.fs.readFile(target)).toBe("# report\nwith ünïcode ✓\n");
  await h.fs.writeFile(target, "short"); // truncates
  expect(await h.fs.readFile(target)).toBe("short");
  await h.fs.writeFile(p("empty"), "");
  expect(await h.fs.readFile(p("empty"))).toBe("");

  expect(await h.fs.exists(target)).toBe(true);
  expect(await h.fs.exists(p("nope"))).toBe(false);
  expect(await h.fs.existsMany([target, p("nope"), p("deep")])).toEqual([true, false, true]);
  expect(await h.fs.existsMany([])).toEqual([]);

  await h.fs.mkdirp(p("a", "b", "c"));
  await h.fs.mkdirp(p("a", "b", "c")); // idempotent
  expect(await h.fs.exists(p("a", "b", "c"))).toBe(true);

  expect(exec).not.toHaveBeenCalled();
  expect(await sessions()).toBe(1);
});

it("keeps the per-command error shape", async () => {
  const h = host();
  await expect(h.fs.readFile(p("missing"))).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    message: expect.stringMatching(/^ssh read failed for .*missing: No such file/),
    details: { hostId: "remote", path: p("missing") },
  });
  await writeFile(p("file"), "x");
  await expect(h.fs.mkdirp(p("file"))).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    message: expect.stringContaining("ssh mkdir failed for"),
    details: { path: p("file") },
  });
  await expect(h.fs.writeFile(p("file", "child"), "x")).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    message: expect.stringContaining("ssh write failed for"),
  });
});

it("streams files larger than the read window intact", async () => {
  const h = host();
  // Multi-byte characters straddle every 32 KiB chunk boundary somewhere in 3 MiB.
  const content = "αβγ-0123456789-✓\n".repeat(150_000);
  await h.fs.writeFile(p("big.txt"), content);
  expect(await readFile(p("big.txt"), "utf8")).toBe(content);
  expect(await h.fs.readFile(p("big.txt"))).toBe(content);
});

it("falls back to per-command ssh when the sftp subsystem is unavailable, and retries later", async () => {
  const h = host(() => ({ FAKE_SFTP_REFUSE: "1" }), { retryMs: 60_000 });
  const exec = vi.spyOn(h, "exec").mockResolvedValue({ code: 0, stdout: "via exec", stderr: "" });
  expect(await h.fs.readFile("/w/a")).toBe("via exec");
  expect(exec).toHaveBeenCalledWith("cat /w/a");
  await h.fs.writeFile("/w/b", "x");
  expect(exec).toHaveBeenLastCalledWith("mkdir -p /w && cat > /w/b", { stdin: "x" });
  exec.mockResolvedValue({ code: 0, stdout: "1\n0\n", stderr: "" });
  expect(await h.fs.existsMany(["/w/a", "/w/c"])).toEqual([true, false]);
  // Inside the retry window no new session is attempted.
  expect(await sessions()).toBe(1);

  const eager = host(() => ({ FAKE_SFTP_REFUSE: "1" }), { retryMs: 0 });
  vi.spyOn(eager, "exec").mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  await eager.fs.mkdirp("/w");
  await eager.fs.mkdirp("/w");
  expect(await sessions()).toBe(3);
});

it("can be switched off", async () => {
  const h = host(undefined, { sftp: false });
  const exec = vi.spyOn(h, "exec").mockResolvedValue({ code: 0, stdout: "text", stderr: "" });
  expect(await h.fs.readFile("/w/a")).toBe("text");
  expect(exec).toHaveBeenCalledOnce();
  expect(await sessions()).toBe(0);
});

it("re-establishes a dropped session once", async () => {
  await writeFile(p("f"), "content");
  // Session 1 serves one request then dies; session 2 is healthy.
  const h = host((n) => (n === 1 ? { FAKE_SFTP_DROP_AFTER: "1" } : {}));
  const exec = vi.spyOn(h, "exec");
  expect(await h.fs.exists(p("f"))).toBe(true);
  expect(await h.fs.readFile(p("f"))).toBe("content");
  expect(await sessions()).toBe(2);
  expect(exec).not.toHaveBeenCalled();
});

it("fails with the typed error when the re-established session drops too", async () => {
  await writeFile(p("f"), "content");
  const h = host(() => ({ FAKE_SFTP_DROP_AFTER: "0" }));
  const exec = vi.spyOn(h, "exec");
  await expect(h.fs.readFile(p("f"))).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    message: expect.stringMatching(/^ssh read failed for .*sftp session ended/),
    details: { hostId: "remote", path: p("f") },
  });
  expect(await sessions()).toBe(2);
  await expect(h.fs.writeFile(p("g"), "x")).rejects.toMatchObject({ code: "AGENT_TRANSPORT" });
  await expect(h.fs.mkdirp(p("d"))).rejects.toMatchObject({ code: "AGENT_TRANSPORT" });
  expect(await h.fs.existsMany([p("f"), p("g")])).toEqual([false, false]);
  // A lost session is not "sftp unavailable": no silent switch to the per-command path.
  expect(exec).not.toHaveBeenCalled();
});

it("closes an idle session and opens a new one on demand", async () => {
  const h = host(undefined, { idleMs: 10 });
  await h.fs.mkdirp(p("x"));
  await new Promise((r) => setTimeout(r, 100));
  await h.fs.mkdirp(p("y"));
  expect(await sessions()).toBe(2);
});
