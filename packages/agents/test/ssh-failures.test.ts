/** Per-command remote filesystem quoting and failures, tested without an SSH server (the SFTP path: ssh-sftp.test.ts). */
import { afterEach, expect, it, vi } from "vitest";
import { AgentSpecSchema, HostSpecSchema } from "@orca/core";
import { SshHost } from "@orca/agents";

afterEach(() => vi.restoreAllMocks());
const host = () =>
  new SshHost(
    HostSpecSchema.parse({ id: "remote", type: "ssh", host: "invalid", sshBinary: "orca-no-such-ssh-binary" }) as never,
    { sftp: false },
  );

it("maps SSH spawn failure to a transport error with host context", async () => {
  await expect(
    host().spawnAgent(AgentSpecSchema.parse({ id: "agent", command: "unused" }), { cwd: "/work" }),
  ).rejects.toMatchObject({ code: "AGENT_TRANSPORT", details: { hostId: "remote" } });
});

it.each(["readFile", "writeFile", "mkdirp"] as const)("reports %s transport failure", async (method) => {
  const h = host();
  const exec = vi.spyOn(h, "exec").mockResolvedValue({ code: 255, stdout: "", stderr: "connection lost" });
  await expect(h.fs[method]("/work/a'b", "payload")).rejects.toMatchObject({
    code: "AGENT_TRANSPORT",
    details: { path: "/work/a'b", hostId: "remote" },
  });
  expect(exec.mock.calls[0]![0]).toContain("'\\''");
});

it("passes file contents only on stdin and preserves quoted paths", async () => {
  const h = host();
  const exec = vi.spyOn(h, "exec").mockResolvedValue({ code: 0, stdout: "text", stderr: "" });
  const content = "$(dangerous) ' quoted\n";
  await h.fs.writeFile("/work/a b/report", content);
  expect(exec).toHaveBeenCalledWith("mkdir -p '/work/a b' && cat > '/work/a b/report'", { stdin: content });
  expect(await h.fs.readFile("/work/a b/report")).toBe("text");
  await h.fs.mkdirp("/work/a b");
  expect(h.joinPath("/work", "a", "..", "b")).toBe("/work/b");
});

it("does not credit malformed or truncated existence responses", async () => {
  const h = host();
  const exec = vi.spyOn(h, "exec").mockResolvedValue({ code: 0, stdout: "1\n", stderr: "" });
  expect(await h.fs.existsMany(["/a", "/b"])).toEqual([false, false]);
  exec.mockResolvedValue({ code: 0, stdout: "1\n0\n", stderr: "" });
  expect(await h.fs.existsMany(["/a", "/b"])).toEqual([true, false]);
  exec.mockResolvedValue({ code: 255, stdout: "", stderr: "unreachable" });
  expect(await h.fs.exists("/a")).toBe(false);
  exec.mockClear();
  expect(await h.fs.existsMany([])).toEqual([]);
  expect(exec).not.toHaveBeenCalled();
});
