/**
 * `secrets.list` and `secrets.check` (#336, part B2): metadata only, filtered to the caller's
 * grant, checked on the reference's own host without reading the value.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secretHostBinding, type AgentHost } from "@orca/agents";
import { HostSpecSchema, type HostSpec, type SecretsConfig } from "@orca/core";
import { LOCAL_PRINCIPAL, PRESETS, UNRESTRICTED, SecretsReadModel, type Principal } from "../src/index.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const LOCAL: HostSpec = { id: "local", type: "local" };
const BOX = HostSpecSchema.parse({ id: "box", type: "ssh", host: "box.example" });

function source(secrets: SecretsConfig, exec: AgentHost["exec"] = async () => ({ code: 0, stdout: "", stderr: "" })) {
  const hosts = new Map<string, AgentHost>(
    [LOCAL, BOX].map((spec) => [spec.id, { id: spec.id, spec, exec } as unknown as AgentHost]),
  );
  return () => ({
    secrets: () => secrets,
    hasHost: (id: string) => hosts.has(id),
    host: (id: string) => hosts.get(id)!,
  });
}

const principal = (secrets: Principal["secrets"], configRead = false): Principal => ({
  id: "ci-bot",
  kind: "credential",
  permissions: new Set(["secrets.read", ...(configRead ? (["config.read"] as const) : [])]),
  scope: UNRESTRICTED,
  secrets,
});

const catalog: SecretsConfig = {
  token: { host: "local", provider: "env", name: "ORCA_T_336", description: "CI token" },
  key: { host: "box", provider: "file", path: "/etc/orca/key" },
  other: { host: "local", provider: "env", name: "ORCA_OTHER_336" },
};

describe("secrets.list", () => {
  it("lists every reference for '*', and shows where a value lives only with config.read", () => {
    const model = new SecretsReadModel(source(catalog));
    expect(model.list(principal("*")).secrets).toEqual([
      { id: "key", host: "box", provider: "file" },
      { id: "other", host: "local", provider: "env" },
      { id: "token", host: "local", provider: "env", description: "CI token" },
    ]);
    expect(model.list({ ...LOCAL_PRINCIPAL }).secrets.find((s) => s.id === "key")).toEqual({
      id: "key",
      host: "box",
      provider: "file",
      path: "/etc/orca/key",
    });
    expect(PRESETS.owner.permissions).toContain("secrets.read");
  });

  it("shows a narrow grant only what it names on the host and endpoint bound now", () => {
    const model = new SecretsReadModel(source(catalog));
    const grant = [
      { secret: "token", provider: "env" as const, host: "local", binding: secretHostBinding(LOCAL) },
      // Granted for another endpoint of `box`: not shown.
      {
        secret: "key",
        provider: "file" as const,
        host: "box",
        binding: secretHostBinding(HostSpecSchema.parse({ id: "box", type: "ssh", host: "old.example" })),
      },
    ];
    expect(model.list(principal(grant)).secrets.map((s) => s.id)).toEqual(["token"]);
    expect(model.list(principal(undefined)).secrets).toEqual([]);
  });
});

describe("secrets.check", () => {
  it("checks a local variable and file without returning a value", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-secrets-check-"));
    dirs.push(dir);
    await writeFile(join(dir, "full"), "v");
    await writeFile(join(dir, "empty"), "");
    const model = new SecretsReadModel(
      source({
        ...catalog,
        full: { host: "local", provider: "file", path: join(dir, "full") },
        empty: { host: "local", provider: "file", path: join(dir, "empty") },
        absent: { host: "local", provider: "file", path: join(dir, "absent") },
      }),
    );
    const all = principal("*");
    vi.stubEnv("ORCA_T_336", "the-value");
    vi.stubEnv("ORCA_OTHER_336", "");
    const token = await model.check(all, "token");
    expect(token).toEqual({ id: "token", host: "local", available: true });
    expect(JSON.stringify(token)).not.toContain("the-value");
    expect(await model.check(all, "other")).toEqual({
      id: "other",
      host: "local",
      available: false,
      reason: "missing",
    });
    expect((await model.check(all, "full")).available).toBe(true);
    expect((await model.check(all, "empty")).reason).toBe("missing");
    expect((await model.check(all, "absent")).reason).toBe("missing");
  });

  it("runs one quiet test on an SSH host, and reports a host that does not answer", async () => {
    const commands: string[] = [];
    let code: number | null = 0;
    const model = new SecretsReadModel(
      source(catalog, async (command) => {
        commands.push(command);
        if (code === null) throw new Error("connection refused");
        return { code, stdout: "", stderr: "" };
      }),
    );
    const all = principal("*");
    expect(await model.check(all, "key")).toEqual({ id: "key", host: "box", available: true });
    expect(commands[0]).toMatch(/^set \+xv; exec 2>\/dev\/null; /);
    expect(commands[0]).toContain("test -s '/etc/orca/key'");
    code = 3;
    expect((await model.check(all, "key")).reason).toBe("missing");
    code = 255;
    expect((await model.check(all, "key")).reason).toBe("unreachable");
    code = null;
    expect((await model.check(all, "key")).reason).toBe("unreachable");
  });

  it("treats a reference outside the grant as not found, and never checks it", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const model = new SecretsReadModel(source(catalog, exec));
    const grant = [{ secret: "token", provider: "env" as const, host: "local", binding: secretHostBinding(LOCAL) }];
    await expect(model.check(principal(grant), "key")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      details: { secret: "key", reason: "not-found" },
    });
    await expect(model.check(principal("*"), "nope")).rejects.toMatchObject({ details: { reason: "not-found" } });
    expect(exec).not.toHaveBeenCalled();
  });
});
