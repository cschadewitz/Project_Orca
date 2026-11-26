/**
 * Setting and checking the config a Codex app-server thread runs with (#1160): the session
 * flags, the check of `config/read`, `configRequirements/read` and `hooks/list` answers, and
 * the writable roots a thread's sandbox gives against ORCA's protected paths.
 */
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OrcaError } from "@orca/core";
import {
  codexConfigCheck,
  codexSessionFlags,
  codexWritableRoots,
  codexWritableRootsProblem,
  type CodexThreadPolicy,
} from "../src/index.js";
import { configRead, NO_HOOKS, NO_REQUIREMENTS, WRITE_SANDBOX } from "./codex-config-fixture.js";

const POLICY: CodexThreadPolicy = { approvalPolicy: "on-request", sandbox: "workspace-write" };
const USER = { type: "user", file: "/home/u/.codex/config.toml", profile: null };
const FLAGS = { type: "sessionFlags" };

const check = (
  answers: Partial<{ config: unknown; requirements: unknown; hooks: unknown }> = {},
  policy: CodexThreadPolicy = POLICY,
) =>
  codexConfigCheck("codex", policy, {
    config: configRead(),
    requirements: NO_REQUIREMENTS,
    hooks: NO_HOOKS,
    ...answers,
  });
const refusal = (answers: Parameters<typeof check>[0], policy?: CodexThreadPolicy) => {
  try {
    check(answers, policy);
  } catch (error) {
    return error as OrcaError;
  }
  throw new Error("the check passed");
};
const layer = (
  name: Record<string, unknown>,
  config: Record<string, unknown>,
  disabledReason: string | null = null,
) => ({
  name,
  version: "v",
  config,
  disabledReason,
});
const flagsLayer = layer(FLAGS, {
  approval_policy: "on-request",
  approvals_reviewer: "user",
  sandbox_mode: "workspace-write",
});

describe("the session flags", () => {
  it("set ORCA's approval policy, the reviewer user and the sandbox as TOML strings", () => {
    expect(codexSessionFlags({ approvalPolicy: "on-request", sandbox: "read-only" })).toEqual([
      "-c",
      'approval_policy="on-request"',
      "-c",
      'approvals_reviewer="user"',
      "-c",
      'sandbox_mode="read-only"',
    ]);
  });
});

describe("checking Codex's effective config", () => {
  it("passes ORCA's settings from the session flags and records only what it checked", () => {
    expect(check()).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      origins: { approval_policy: "sessionFlags", approvals_reviewer: "sessionFlags", sandbox_mode: "sessionFlags" },
      layers: [
        { type: "sessionFlags", enabled: true },
        { type: "user", enabled: true },
        { type: "system", enabled: true },
      ],
      requirements: false,
    });
  });

  it("refuses a user or project config.toml that sets another policy, reviewer or sandbox, naming the setting and the file", () => {
    for (const [key, value] of [
      ["approval_policy", "never"],
      ["approvals_reviewer", "auto_review"],
      ["sandbox_mode", "danger-full-access"],
    ] as const) {
      const user = refusal({ config: configRead({}, { layers: [flagsLayer, layer(USER, { [key]: value })] }) });
      expect(user.code).toBe("NOT_SUPPORTED");
      expect(user.message).toContain(
        `the user config.toml (/home/u/.codex/config.toml) sets ${key} = "${value}", not ORCA's`,
      );
      expect(user.details).toMatchObject({ setting: key, value, layer: "user" });
      const project = refusal({
        config: configRead(
          {},
          { layers: [flagsLayer, layer({ type: "project", dotCodexFolder: "/w/.codex" }, { [key]: value })] },
        ),
      });
      expect(project.message).toContain(`the project config in /w/.codex sets ${key} = "${value}"`);
    }
  });

  it("passes a config.toml that is not in force, or sets the same as ORCA", () => {
    const untrusted = layer(
      { type: "project", dotCodexFolder: "/w/.codex" },
      { approval_policy: "never" },
      "not trusted",
    );
    const same = layer(USER, { approval_policy: "on-request", sandbox_mode: "workspace-write" });
    expect(check({ config: configRead({}, { layers: [flagsLayer, untrusted, same] }) }).layers).toEqual([
      { type: "sessionFlags", enabled: true },
      { type: "project", enabled: false },
      { type: "user", enabled: true },
    ]);
  });

  it("refuses a managed layer that overrides the session flags, and records one that sets the same", () => {
    const managed = { type: "legacyManagedConfigTomlFromFile", file: "/etc/codex/managed_config.toml" };
    const error = refusal({
      config: configRead(
        { sandbox_mode: "danger-full-access" },
        {
          origins: { sandbox_mode: { name: managed, version: "v" } },
          layers: [layer(managed, { sandbox_mode: "danger-full-access" }), flagsLayer],
        },
      ),
    });
    expect(error.message).toContain(
      `Codex would run with sandbox_mode = "danger-full-access" from the managed config (/etc/codex/managed_config.toml), not ORCA's "workspace-write"`,
    );
    const ok = check({
      config: configRead(
        {},
        {
          origins: { approval_policy: { name: managed, version: "v" } },
          layers: [layer(managed, { approval_policy: "on-request" }), flagsLayer],
        },
      ),
    });
    expect(ok.origins.approval_policy).toBe("legacyManagedConfigTomlFromFile");
  });

  it("refuses a setting Codex does not report at all", () => {
    const error = refusal({
      config: configRead({ approvals_reviewer: null }, { origins: { approvals_reviewer: undefined } }),
    });
    expect(error.message).toContain('Codex would run with approvals_reviewer = nothing, not ORCA\'s "user"');
  });

  it("refuses an MCP server in force, by name only, and passes a disabled one", () => {
    const SECRET = "sk-orca-1160-mcp-secret";
    const error = refusal({
      config: configRead(
        {},
        {
          config: {
            mcp_servers: {
              leak: { command: "echo", env: { TOKEN: SECRET }, enabled: true },
              off: { command: "echo", enabled: false },
            },
          },
        },
      ),
    });
    expect(error.message).toContain("Codex's config adds the MCP server leak.");
    expect(error.details).toMatchObject({ setting: "mcp_servers", servers: ["leak"] });
    expect(JSON.stringify([error.message, error.details])).not.toContain(SECRET);
    expect(check({ config: configRead({}, { config: { mcp_servers: { off: { enabled: false } } } }) }).sandbox).toBe(
      "workspace-write",
    );
  });

  it("refuses managed requirements that leave out ORCA's policy or sandbox, and records ones that allow them", () => {
    const req = (r: Record<string, unknown>) => ({ supportsIndependentSpeedModes: true, requirements: r });
    expect(refusal({ requirements: req({ allowedApprovalPolicies: ["never"] }) }).message).toContain(
      `Codex's managed requirements allow allowedApprovalPolicies "never", without ORCA's "on-request"`,
    );
    expect(refusal({ requirements: req({ allowedSandboxModes: ["read-only"] }) }).details).toMatchObject({
      setting: "allowedSandboxModes",
    });
    expect(
      check({ requirements: req({ allowedApprovalPolicies: ["on-request"], allowedSandboxModes: null }) }).requirements,
    ).toBe(true);
  });

  it("refuses any enabled hook, wherever it comes from, and passes a disabled one", () => {
    const hook = (enabled: boolean, source: string) => ({
      eventName: "preToolUse",
      source,
      enabled,
      command: "echo hi",
    });
    const error = refusal({
      hooks: { data: [{ cwd: "/w", hooks: [hook(false, "user"), hook(true, "project")], warnings: [], errors: [] }] },
    });
    expect(error.message).toContain("Codex would run the hook preToolUse (project)");
    expect(check({ hooks: { data: [{ cwd: "/w", hooks: [hook(false, "plugin")] }] } }).approvalPolicy).toBe(
      "on-request",
    );
  });

  it("never repeats a config value it does not know, in an error or its details", () => {
    const SENTINEL = "sk-orca-1160-sentinel";
    const granular = { granular: { sandbox_approval: true, note: SENTINEL } };
    const cases: Parameters<typeof check>[0][] = [
      // an effective value, from the session flags or a layer above
      { config: configRead({ approval_policy: granular }) },
      { config: configRead({ sandbox_mode: SENTINEL }) },
      { config: configRead({}, { origins: { approvals_reviewer: { name: { type: SENTINEL }, version: "v" } } }) },
      // a layer's value
      { config: configRead({}, { layers: [flagsLayer, layer(USER, { approval_policy: granular })] }) },
      { config: configRead({}, { layers: [flagsLayer, layer(USER, { approvals_reviewer: SENTINEL })] }) },
      {
        config: configRead(
          {},
          {
            layers: [
              flagsLayer,
              layer({ type: "enterpriseManaged", id: "x", name: SENTINEL }, { sandbox_mode: "read-only" }),
            ],
          },
        ),
      },
      // managed requirements
      { requirements: { requirements: { allowedApprovalPolicies: [granular, SENTINEL] } } },
      { requirements: { requirements: { allowedSandboxModes: [SENTINEL] } } },
      // an MCP server's name, and a hook's event and source
      { config: configRead({}, { config: { mcp_servers: { [`x ${SENTINEL}`]: { command: SENTINEL } } } }) },
      { hooks: { data: [{ hooks: [{ eventName: SENTINEL, source: SENTINEL, enabled: true, command: SENTINEL }] }] } },
    ];
    for (const answers of cases) {
      const error = refusal(answers);
      expect(error.code).toBe("NOT_SUPPORTED");
      expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(SENTINEL);
    }
    expect(refusal(cases[0]).message).toContain("approval_policy = a value ORCA does not know");
    expect(refusal(cases[8]).message).toContain("the MCP server (a server whose name ORCA does not repeat)");
    expect(refusal(cases[9]).message).toContain("the hook a hook (unknown source)");
  });

  it("refuses answers it does not know as a protocol error", () => {
    for (const answers of [
      { config: { config: {} } },
      { config: configRead({}, { layers: [{ name: { type: "cloud" }, config: {}, disabledReason: null }] }) },
      { config: configRead({}, { origins: { approval_policy: "sessionFlags" } }) },
      { config: configRead({}, { config: { mcp_servers: ["x"] } }) },
      { requirements: { requirements: "none" } },
      { requirements: { requirements: { allowedSandboxModes: "workspace-write" } } },
      { hooks: { data: [{ hooks: [{ eventName: "stop" }] }] } },
      { hooks: {} },
    ]) {
      const error = refusal(answers);
      expect(error.code).toBe("AGENT_PROTOCOL");
      expect(error.message).toMatch(
        /answered (config\/read|configRequirements\/read|hooks\/list) with a shape ORCA does not know/,
      );
    }
  });
});

describe("a thread's writable roots", () => {
  it("are none for read-only, and the cwd, its roots, /tmp and $TMPDIR for workspace-write unless excluded", () => {
    expect(codexWritableRoots({ type: "readOnly", networkAccess: false }, "/w", "/t")).toEqual([]);
    expect(codexWritableRoots({ ...WRITE_SANDBOX, writableRoots: ["/extra"] }, "/w", "/t")).toEqual([
      "/w",
      "/extra",
      "/tmp",
      "/t",
    ]);
    expect(
      codexWritableRoots({ ...WRITE_SANDBOX, excludeSlashTmp: true, excludeTmpdirEnvVar: true }, "/w", "/t"),
    ).toEqual(["/w"]);
    for (const unknown of [{ type: "dangerFullAccess" }, { type: "workspaceWrite" }, null])
      expect(codexWritableRoots(unknown, "/w", "/t")).toBeUndefined();
  });

  it("compares real paths segment by segment, and fails closed when one cannot be resolved", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "orca-1160-paths-")));
    try {
      await mkdir(join(base, "work"));
      await mkdir(join(base, "real"));
      await symlink(join(base, "real"), join(base, "link"));
      await symlink(join(base, "loop"), join(base, "loop"));
      // a descendant whose name starts with two dots is inside, not a parent
      expect(codexWritableRootsProblem([join(base, "work")], [join(base, "work", "..orca")])).toBe(
        `the thread could write ${join(base, "work")}, which overlaps ORCA's protected ${join(base, "work", "..orca")}`,
      );
      // a sibling that merely shares a prefix is not
      expect(codexWritableRootsProblem([join(base, "work")], [join(base, "work-orca")])).toBeUndefined();
      // a sidecar not created yet, under a linked directory, is where the link leads
      expect(codexWritableRootsProblem([join(base, "real")], [join(base, "link", "sidecar", "x.json")])).toMatch(
        /overlaps ORCA's protected .*link\/sidecar\/x\.json$/,
      );
      expect(codexWritableRootsProblem([join(base, "link", "deeper")], [join(base, "real")])).toMatch(/overlaps/);
      // what cannot be resolved is refused
      expect(codexWritableRootsProblem([join(base, "work")], [join(base, "loop", "sidecar")])).toBe(
        `ORCA could not resolve where its protected ${join(base, "loop", "sidecar")} is`,
      );
      expect(codexWritableRootsProblem([`${base}/work/../real`], [join(base, "other")])).toMatch(
        /could not resolve where the writable root/,
      );
      expect(codexWritableRootsProblem(["relative/root"], [join(base, "other")])).toMatch(/could not resolve/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("may not hold, or sit inside, a path ORCA protects", () => {
    expect(codexWritableRootsProblem(["/w", "/tmp"], ["/home/u/.orca"])).toBeUndefined();
    expect(codexWritableRootsProblem(["/w", "/tmp"], ["/tmp/orca-sidecar"])).toBe(
      "the thread could write /tmp, which overlaps ORCA's protected /tmp/orca-sidecar",
    );
    expect(codexWritableRootsProblem(["/home/u/.orca/work"], ["/home/u/.orca"])).toMatch(
      /could write \/home\/u\/\.orca\/work/,
    );
  });
});
