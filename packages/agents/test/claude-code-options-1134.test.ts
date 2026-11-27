/**
 * An agent's `claudeCode` config (#1134) turned into `_meta.claudeCode.options`. What the
 * real adapter and Claude Code do with them is observed in
 * `packages/cli/test/claude-hook-acceptance-704.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentSpecSchema } from "@orca/core";
import {
  claudeCodeOptions,
  claudeCodeSessionMeta,
  claudeSandboxSettings,
  withClaudeCodeOptions,
} from "../src/index.js";

const claude = { name: "@agentclientprotocol/claude-agent-acp", version: "0.109.1" };
const protectedPaths = {
  readOnly: ["/cfg/orca.yaml", "/cfg/.orca"],
  noAccess: ["/cfg/auth", "/cfg/.orca/private-execution"],
  agentAreas: ["/cfg/.orca/work"],
};

describe("claudeCodeOptions", () => {
  it("sends nothing when the config asks for nothing", () => {
    expect(claudeCodeOptions(undefined, protectedPaths)).toBeUndefined();
    expect(claudeCodeOptions({}, protectedPaths)).toBeUndefined();
    expect(claudeCodeOptions({ sandbox: "off" }, protectedPaths)).toBeUndefined();
  });

  it("refuses a sandbox while any settings file is loaded, since their sandbox exceptions merge in", () => {
    expect(() => claudeCodeOptions({ sandbox: "on" }, undefined)).toThrow(/needs settingSources: \[\]/);
    expect(() => claudeCodeOptions({ sandbox: "on", settingSources: ["user"] }, undefined)).toThrow(
      /needs settingSources: \[\]/,
    );
  });

  it("passes the chosen sources, and turns bypass off when the checkout's are left out", () => {
    expect(claudeCodeOptions({ settingSources: [] }, undefined)).toEqual({
      settingSources: [],
      allowDangerouslySkipPermissions: false,
    });
    expect(claudeCodeOptions({ settingSources: ["user", "local"] }, undefined)).toEqual({
      settingSources: ["user", "local"],
      allowDangerouslySkipPermissions: false,
    });
    expect(claudeCodeOptions({ settingSources: ["user", "project", "local"] }, undefined)).toEqual({
      settingSources: ["user", "project", "local"],
    });
  });

  it("puts the sandbox in the settings layer, asking about every command and never letting one out", () => {
    const options = claudeCodeOptions({ settingSources: [], sandbox: "on" }, protectedPaths);
    expect(options).toEqual({
      settingSources: [],
      allowDangerouslySkipPermissions: false,
      settings: { sandbox: claudeSandboxSettings(protectedPaths) },
    });
    expect(claudeSandboxSettings(protectedPaths)).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: ["/cfg/auth", "/cfg/.orca/private-execution"],
        // The whole store, agent areas included: an exception beneath a deny does not hold.
        denyWrite: ["/cfg/orca.yaml", "/cfg/.orca", "/cfg/auth", "/cfg/.orca/private-execution"],
      },
    });
    expect(claudeSandboxSettings(undefined)).toEqual({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
    });
  });
});

describe("withClaudeCodeOptions", () => {
  const hook = { claudeCode: { options: { settings: { hooks: { PreToolUse: [] } } } } };

  it("adds options beside ORCA's hook settings", () => {
    expect(withClaudeCodeOptions(hook, { settingSources: [], settings: { sandbox: { enabled: true } } })).toEqual({
      claudeCode: {
        options: { settingSources: [], settings: { hooks: { PreToolUse: [] }, sandbox: { enabled: true } } },
      },
    });
    expect(withClaudeCodeOptions(undefined, { settingSources: ["user"] })).toEqual({
      claudeCode: { options: { settingSources: ["user"] } },
    });
  });

  it("refuses to set an option or a setting twice", () => {
    expect(() => withClaudeCodeOptions(hook, { settings: { hooks: {} } })).toThrow(/hooks is set twice/);
    expect(() =>
      withClaudeCodeOptions({ claudeCode: { options: { settingSources: [] } } }, { settingSources: ["user"] }),
    ).toThrow(/settingSources is set twice/);
  });
});

describe("claudeCodeSessionMeta", () => {
  it("is the inner session meta, unchanged, when the config asks for nothing", () => {
    const inner = vi.fn(async () => undefined);
    expect(claudeCodeSessionMeta("a", undefined, undefined, inner)).toBe(inner);
    expect(claudeCodeSessionMeta("a", {}, undefined)).toBeUndefined();
  });

  it("adds the options for the Claude adapter, after the inner meta", async () => {
    const inner = vi.fn(async () => ({ claudeCode: { options: { settings: { hooks: {} } } } }));
    const meta = claudeCodeSessionMeta("a", { settingSources: [], sandbox: "on" }, undefined, inner)!;
    expect(await meta(claude, vi.fn(), 1)).toEqual({
      claudeCode: {
        options: {
          settingSources: [],
          allowDangerouslySkipPermissions: false,
          settings: { hooks: {}, sandbox: claudeSandboxSettings(undefined) },
        },
      },
    });
    expect(inner).toHaveBeenCalledOnce();
  });

  it("refuses an agent that is not the Claude adapter, or does not say", async () => {
    const meta = claudeCodeSessionMeta("a", { settingSources: [], sandbox: "on" }, undefined)!;
    await expect(meta({ name: "codex-acp", version: "1" }, vi.fn(), 1)).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: expect.stringMatching(/says it is codex-acp/),
    });
    await expect(meta(undefined, vi.fn(), 1)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });
});

describe("the agent config", () => {
  it("takes settingSources and sandbox, each source once", () => {
    const parse = (claudeCode: unknown) => AgentSpecSchema.safeParse({ id: "c", command: "x", claudeCode });
    expect(parse({ settingSources: [], sandbox: "on" }).success).toBe(true);
    expect(parse({ sandbox: "on" }).success).toBe(false);
    expect(parse({ settingSources: ["user"], sandbox: "on" }).success).toBe(false);
    expect(parse({ settingSources: ["user", "user"] }).success).toBe(false);
    expect(parse({ settingSources: ["managed"] }).success).toBe(false);
    expect(parse({ sandbox: true }).success).toBe(false);
    expect(parse({ other: 1 }).success).toBe(false);
  });
});
