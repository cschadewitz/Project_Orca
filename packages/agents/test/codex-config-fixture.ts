import { CODEX_VERIFIED_IMAGES } from "../src/codex-image.js";

/** What a stock Codex 0.171.0 answers for ORCA's config checks (#1160), as the real one did. */
export const WRITE_SANDBOX = {
  type: "workspaceWrite",
  writableRoots: [],
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
};

const SESSION_FLAGS = { name: { type: "sessionFlags" }, version: "sha256:flags" };

/** `config/read` with ORCA's session flags in force and nothing else set. */
export const configRead = (
  policy: { approval_policy?: unknown; approvals_reviewer?: unknown; sandbox_mode?: unknown } = {},
  more: { config?: Record<string, unknown>; origins?: Record<string, unknown>; layers?: unknown[] } = {},
) => {
  const flags = {
    approval_policy: "on-request",
    approvals_reviewer: "user",
    sandbox_mode: "workspace-write",
    ...policy,
  };
  return {
    config: { ...flags, mcp_servers: {}, ...more.config },
    origins: {
      approval_policy: SESSION_FLAGS,
      approvals_reviewer: SESSION_FLAGS,
      sandbox_mode: SESSION_FLAGS,
      ...more.origins,
    },
    layers: more.layers ?? [
      // as the real Codex answers: no disabledReason at all on a layer in force
      { name: { type: "sessionFlags" }, version: "sha256:flags", config: flags },
      {
        name: { type: "user", file: "/home/u/.codex/config.toml", profile: null },
        version: "v",
        config: {},
        disabledReason: null,
      },
      { name: { type: "system", file: "/etc/codex/config.toml" }, version: "v", config: {}, disabledReason: null },
    ],
  };
};

export const NO_REQUIREMENTS = { supportsIndependentSpeedModes: true, requirements: null };
export const NO_HOOKS = { data: [{ cwd: "/", hooks: [], warnings: [], errors: [] }] };

/** Responders for the three config requests, answering as a stock Codex. */
export const CONFIG_ANSWERS = {
  "config/read": () => configRead(),
  "configRequirements/read": () => NO_REQUIREMENTS,
  "hooks/list": () => NO_HOOKS,
};

/**
 * The image checks a fake app-server passes (#1162): this "machine" is linux-x64, and the file
 * ORCA starts, and the process it then runs, are the verified Codex 0.171.0 build.
 */
export const PINNED_IMAGE = { sha256: CODEX_VERIFIED_IMAGES["0.171.0"]!["linux-x64"]!, dev: 64769, ino: 1162 };
export const VERIFIED_IMAGE = {
  imageTarget: "linux-x64",
  imageFile: async () => PINNED_IMAGE,
  imageDigest: async () => PINNED_IMAGE,
};

/** The command a fake app-server lists for ORCA's hook (#1161). */
export const HOOK_COMMAND = "orca-hook-command";
/** `hooks/list` showing exactly ORCA's hook, trusted, from its session flags (#1161). */
export const ORCA_HOOK_LISTED = {
  data: [
    {
      cwd: "/",
      hooks: [
        {
          key: "/<session-flags>/config.toml:pre_tool_use:0:0",
          eventName: "preToolUse",
          handlerType: "command",
          command: HOOK_COMMAND,
          async: false,
          matcher: "*",
          source: "sessionFlags",
          enabled: true,
          trustStatus: "trusted",
          currentHash: "sha256:x",
        },
      ],
      warnings: [],
      errors: [],
    },
  ],
};
/** Config answers of a Codex running ORCA's hook (#1161): web search off, ORCA's hook listed. */
export const HOOKED_CONFIG_ANSWERS = {
  "config/read": () => configRead({}, { config: { web_search: "disabled" } }),
  "configRequirements/read": () => NO_REQUIREMENTS,
  "hooks/list": () => ORCA_HOOK_LISTED,
};
