/** `orca auth issue --secret` writes a credential's secret grant (#336, part B). */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { secretHostBinding, secretSourceBinding } from "@orca/agents";
import { HostSpecSchema } from "@orca/core";
import { openAuthDirectory } from "@orca/daemon";
import { authCommand } from "../src/commands/auth.js";
import type { CommandContext } from "../src/commands/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-auth-secret-"));
  await writeFile(
    join(dir, "orca.config.yaml"),
    [
      "version: 1",
      "workflows: []",
      "templates: []",
      "hosts:",
      "  - { id: local, type: local }",
      "  - { id: build-box, type: ssh, host: build.example }",
      "secrets:",
      "  github-token: { host: build-box, provider: file, path: /etc/orca/gh }",
      "  npm: { host: local, provider: env, name: NPM_TOKEN }",
      "  judge-key: { host: local, provider: env, name: JUDGE_KEY, destination: 'https://judge.invalid/v0' }",
      "",
    ].join("\n"),
    "utf8",
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function issue(principal: string, flags: CommandContext["flags"]): Promise<number> {
  return authCommand({
    cwd: dir,
    flags: { json: true, ...flags },
    positionals: ["issue", principal],
    out: () => {},
    err: () => {},
  });
}

const stored = (principal: string) =>
  openAuthDirectory(join(dir, "auth"))
    .credentials.list()
    .find((c) => c.principal === principal)!;

describe("auth issue --secret", () => {
  it("grants each id@host and adds secrets.use to the preset", async () => {
    expect(await issue("ci-bot", { secret: ["github-token@build-box", "npm@local", "npm@local"] })).toBe(0);
    const c = stored("ci-bot");
    expect(c.secrets).toEqual([
      {
        secret: "github-token",
        provider: "file",
        host: "build-box",
        binding: secretHostBinding(HostSpecSchema.parse({ id: "build-box", type: "ssh", host: "build.example" })),
      },
      { secret: "npm", provider: "env", host: "local", binding: secretHostBinding({ id: "local", type: "local" }) },
    ]);
    expect(c.permissions).toContain("secrets.use");
  });

  it("grants a pinned secret for review-judge use at its destination only (#701)", async () => {
    expect(await issue("judge", { secret: ["judge-key@local"] })).toBe(0);
    expect(stored("judge").secrets).toEqual([
      {
        secret: "judge-key",
        provider: "env",
        host: "local",
        binding: secretHostBinding({ id: "local", type: "local" }),
        purpose: "review-judge",
        destination: "https://judge.invalid/v0",
        source: secretSourceBinding({ provider: "env", name: "JUDGE_KEY" }),
      },
    ]);
  });

  it("grants every reference with '*', and none without the flag", async () => {
    expect(await issue("all", { secret: ["*"] })).toBe(0);
    expect(stored("all").secrets).toBe("*");
    expect(await issue("none", {})).toBe(0);
    expect(stored("none").secrets).toBeUndefined();
    expect(stored("none").permissions).not.toContain("secrets.use");
  });

  it("refuses a grant without a host, for an unconfigured id or another host, or '*' mixed with ids", async () => {
    await expect(issue("a", { secret: ["npm"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(issue("a", { secret: ["absent@local"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(issue("a", { secret: ["npm@build-box"] })).rejects.toMatchObject({
      message: "--secret 'npm' is bound to host 'local', not 'build-box'",
    });
    await expect(issue("b", { secret: ["bad id@local"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(issue("c", { secret: ["*", "npm@local"] })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
