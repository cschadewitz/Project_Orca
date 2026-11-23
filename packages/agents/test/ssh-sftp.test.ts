/** SshHost's SFTP file system against a local SFTP server fixture: no sshd, runs on Windows too. */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostSpecSchema } from "@orca/core";
import { isHostFileMissing, SshHost, type SshHostOptions } from "@orca/agents";

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
function host(
  env: (session: number) => Record<string, string> = () => ({}),
  options: SshHostOptions = {},
  spec: Record<string, unknown> = {},
) {
  let session = 0;
  const h = new SshHost(
    HostSpecSchema.parse({
      id: "remote",
      type: "ssh",
      host: "invalid",
      sshBinary: "orca-no-such-ssh-binary",
      ...spec,
    }) as never,
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

describe("a read of a file that is not there (#703)", () => {
  it("is marked missing only on the server's own no-such-file status, with the same error shape", async () => {
    const h = host();
    const error = await h.fs.readFile(p("missing")).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "AGENT_TRANSPORT", details: { path: p("missing") } });
    expect(isHostFileMissing(error)).toBe(true);
  });

  it("is not claimed when the transport failed, even though ssh's own spawn said ENOENT", async () => {
    const h = new SshHost(
      HostSpecSchema.parse({
        id: "remote",
        type: "ssh",
        host: "invalid",
        sshBinary: "orca-no-such-ssh-binary",
      }) as never,
    );
    hosts.push(h);
    const error = await h.fs.readFile(p("missing")).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "AGENT_TRANSPORT" });
    expect(isHostFileMissing(error)).toBe(false);
  });

  it("is not claimed for another status, or by the per-command fallback that cannot tell", async () => {
    const h = host();
    const directory = await h.fs.readFile(root.replace(/\\/g, "/")).catch((e: unknown) => e);
    expect(isHostFileMissing(directory)).toBe(false);

    const viaExec = host(() => ({ FAKE_SFTP_REFUSE: "1" }), { retryMs: 60_000 });
    vi.spyOn(viaExec, "exec").mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "cat: /w/a: No such file or directory",
    });
    const fallback = await viaExec.fs.readFile("/w/a").catch((e: unknown) => e);
    expect(fallback).toMatchObject({ code: "AGENT_TRANSPORT" });
    expect(isHostFileMissing(fallback)).toBe(false);
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

it("settles every waiter when a request misses its deadline, retries once, then fails typed", async () => {
  await writeFile(p("f"), "content");
  // Session 1 answers the handshake and then nothing; session 2 is healthy.
  const healed = host((n) => (n === 1 ? { FAKE_SFTP_HANG_AFTER: "0" } : {}), { requestTimeoutMs: 200 });
  const started = Date.now();
  expect(await healed.fs.readFile(p("f"))).toBe("content");
  expect(Date.now() - started).toBeLessThan(5_000);

  const hung = host(() => ({ FAKE_SFTP_HANG_AFTER: "0" }), { requestTimeoutMs: 200 });
  await expect(hung.fs.readFile(p("f"))).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    message: expect.stringContaining("timed out after 200 ms"),
  });
  // Nothing is left in flight: the idle timer can close the session again.
  expect(await hung.fs.existsMany([p("f"), p("g")])).toEqual([false, false]);
  expect(await sessions()).toBe(2 + 4);
});

it("fails the session on an undecodable reply instead of stranding the request", async () => {
  await writeFile(p("f"), "content");
  const h = host((n) => (n === 1 ? { FAKE_SFTP_MALFORMED_AFTER: "0" } : {}), { requestTimeoutMs: 30_000 });
  const started = Date.now();
  expect(await h.fs.exists(p("f"))).toBe(true);
  expect(Date.now() - started).toBeLessThan(5_000); // settled by the session failure, not the deadline
  expect(await sessions()).toBe(2);

  const bad = host(() => ({ FAKE_SFTP_MALFORMED_AFTER: "0" }), { requestTimeoutMs: 30_000 });
  await expect(bad.fs.mkdirp(p("d"))).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    message: expect.stringContaining("malformed sftp packet"),
  });
});

it("bounds reads by a byte budget instead of trusting the stat size", async () => {
  await writeFile(p("big"), "x".repeat(4_000));
  const capped = host(undefined, { maxReadBytes: 1_000 });
  await expect(capped.fs.readFile(p("big"))).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    message: expect.stringContaining("4000 bytes, over the 1000-byte read limit"),
  });
  // A size of 2^50 is refused before a single read, and nothing is allocated for it.
  const huge = host(() => ({ FAKE_SFTP_STAT_SIZE: String(2 ** 50) }));
  await expect(huge.fs.readFile(p("big"))).rejects.toMatchObject({ message: expect.stringContaining("read limit") });
  // A stat that under-reports still cannot get past the budget: received bytes count too.
  const lying = host(() => ({ FAKE_SFTP_STAT_SIZE: "0" }), { maxReadBytes: 1_000 });
  await expect(lying.fs.readFile(p("big"))).rejects.toMatchObject({
    message: expect.stringContaining("over the 1000-byte read limit"),
  });
  // An under-reported size is otherwise only a hint: the file grows past it and is read whole.
  const stale = host(() => ({ FAKE_SFTP_STAT_SIZE: "10" }));
  const content = "y".repeat(200_000);
  await writeFile(p("grown"), content);
  expect(await stale.fs.readFile(p("grown"))).toBe(content);
});

it("stops writing on the first failed chunk and closes only after every write has settled", async () => {
  const log = join(root, "server.log");
  const chunks = 200;
  const h = host(() => ({ FAKE_SFTP_WRITE_FAIL_AT: String(10 * 32 * 1024), FAKE_SFTP_LOG: log }));
  await expect(h.fs.writeFile(p("out"), "z".repeat(chunks * 32 * 1024))).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    message: expect.stringContaining("ssh write failed for"),
  });
  const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
  const writes = lines.filter((l) => l.startsWith("write "));
  expect(writes.length).toBeLessThan(chunks / 2); // no new chunks after the failure
  expect(lines).not.toContain("write-after-close");
  expect(lines.at(-1)).toBe("close"); // the close came after the last write
  expect(await sessions()).toBe(1); // a disk-full status is final, not retried
});

describe("opening a session", () => {
  it.each([
    ["ssh cannot authenticate", { FAKE_SFTP_EXIT_EARLY: "Permission denied (publickey)." }, "Permission denied"],
    ["the server speaks an older version", { FAKE_SFTP_VERSION: "2" }, "version 2; 3 is required"],
    ["the VERSION packet is truncated", { FAKE_SFTP_VERSION: "short" }, "malformed sftp packet"],
    ["the handshake never completes", { FAKE_SFTP_SILENT_INIT: "1" }, "handshake timed out after 300 ms"],
  ])("fails typed, without falling back, when %s", async (_, env, reason) => {
    await writeFile(p("f"), "content");
    const h = host(() => env, { requestTimeoutMs: 200 }, { connectTimeoutMs: 100 });
    const exec = vi.spyOn(h, "exec");
    const started = Date.now();
    await expect(h.fs.readFile(p("f"))).rejects.toMatchObject({
      code: "AGENT_TRANSPORT",
      message: expect.stringContaining(reason),
      details: { hostId: "remote", path: p("f") },
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await h.fs.exists(p("f"))).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("fails typed when ssh itself cannot be started", async () => {
    const h = new SshHost(
      HostSpecSchema.parse({
        id: "remote",
        type: "ssh",
        host: "invalid",
        sshBinary: "orca-no-such-ssh-binary",
      }) as never,
    );
    hosts.push(h);
    const exec = vi.spyOn(h, "exec");
    await expect(h.fs.readFile("/w/a")).rejects.toMatchObject({
      code: "AGENT_TRANSPORT",
      message: expect.stringContaining("cannot start ssh for host 'remote'"),
    });
    expect(exec).not.toHaveBeenCalled();
  });
});

it("cancels calls in flight on an explicit close instead of reconnecting them", async () => {
  await writeFile(p("f"), "content");
  const h = host(() => ({ FAKE_SFTP_HANG_AFTER: "0" }), { requestTimeoutMs: 30_000 });
  const pending = h.fs.readFile(p("f"));
  await vi.waitFor(async () => expect(await sessions()).toBe(1));
  await new Promise((r) => setTimeout(r, 200)); // let the handshake finish and the reads go out
  const started = Date.now();
  h.close();
  await expect(pending).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    message: expect.stringContaining("sftp session closed"),
  });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(await sessions()).toBe(1);
});
