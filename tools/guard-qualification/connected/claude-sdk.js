/**
 * The #706 connected route for the Claude Agent SDK (#1128): a real Claude Code, driven through
 * the Claude Agent SDK, in a session ORCA opened the way the daemon opens a
 * `driver: claude-agent-sdk` agent (`makeSessionFactory`), against the same model stand-in, MCP
 * recorders and shell recorder as `claude-connected`. It proves route `claude-sdk-hook`: ORCA's
 * hook callback, its answer to Claude's ask and the MCP relay, each in the session's process.
 *
 * Everything but the session is `claude-connected`'s (`claude.js`): how calls are made, what is
 * recorded for each and how its outcome follows from independent evidence. Two things differ:
 *
 * - **Claude's own settings.** The SDK session loads none (#1126), so they cannot allow every
 *   tool as on the ACP route. Claude's own check runs in its default mode and asks ORCA
 *   (`canUseTool`) about what it would not do unasked; whatever runs, ORCA allowed.
 * - **ORCA's refusal text.** A refusal reaches the model as the bridge's fixed text
 *   (`CLAUDE_SDK_DENIALS`). The texts a person's answer or its absence leads to are not counted
 *   as ORCA's refusal: those calls are told apart by the ask that reached ORCA for them.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSpecSchema, silentLogger } from "@orca/core";
import { CLAUDE_SDK_DENIALS, LocalHost } from "@orca/agents";
import { makeSessionFactory } from "../../../packages/cli/src/bootstrap.ts";
import { MCP_SERVERS, claudeConnected } from "./claude.js";

/** The daemon's session factory from source, and the types a session is opened with. */
const FROM_SOURCE = {
  makeSessionFactory,
  LocalHost,
  AgentSpecSchema,
  silentLogger,
};

const RECORDER = fileURLToPath(new URL("./mcp-recorder.js", import.meta.url));
const SHELL_RECORDER = fileURLToPath(new URL("./shell-recorder.sh", import.meta.url));

/** ORCA's own refusals on this route; the texts after a person's answer (or none) are not. */
export const SDK_MARKERS = {
  deny: [
    CLAUDE_SDK_DENIALS.search,
    CLAUDE_SDK_DENIALS.protected,
    CLAUDE_SDK_DENIALS.policy,
    CLAUDE_SDK_DENIALS.changed,
    CLAUDE_SDK_DENIALS.noTurn,
  ],
  block: [CLAUDE_SDK_DENIALS.failed],
};

/**
 * @param {{ claude: string, model: { url: string, log: any }, factory?: typeof FROM_SOURCE }} env
 *   `claude`: the Claude Code executable, installed the way a person installs it. `factory`:
 *   where the session factory comes from, by default the sources; the installed receipt passes
 *   the bundle it runs (`installed/claude-sdk-factory.js`).
 */
export function claudeSdkConnected(env) {
  const factory = env.factory ?? FROM_SOURCE;
  const path = claudeConnected({ adapter: "", hookScript: "", model: env.model, markers: SDK_MARKERS });
  path.id = "claude-sdk-connected";
  path.capabilities = ["answerer", "agent-turn", "mcp-grant-allows"];

  /** The agent as ORCA's config would declare it: the SDK driver, the hook opted in. */
  path.agent = (world, extraEnv = {}, command = env.claude) =>
    factory.AgentSpecSchema.parse({
      id: world.agentId,
      driver: "claude-agent-sdk",
      command,
      env: {
        ...extraEnv,
        ANTHROPIC_BASE_URL: env.model.url,
        ANTHROPIC_API_KEY: "sk-orca-706-test",
        CLAUDE_CONFIG_DIR: join(world.root, "claude-config"),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        ENABLE_TOOL_SEARCH: "false",
        CLAUDE_CODE_SHELL_PREFIX: SHELL_RECORDER,
        ORCA_706_SHELL_LOG: join(world.root, "shell-calls.jsonl"),
      },
      mcpServers: Object.entries(MCP_SERVERS).map(([name, tools]) => ({
        name,
        command: process.execPath,
        args: [RECORDER, name, tools.join(",")],
        env: { ORCA_706_MCP_LOG: join(world.root, "mcp-calls.jsonl") },
      })),
      permissions: world.configured,
      nativeToolHook: "experimental",
    });

  /**
   * Open a session the daemon's way. The world's `configured` is read now, as at session open.
   * A world with `withoutAnswerer` set opens its session with no answerer at all, as a run that
   * has nobody to ask: the answerer `claude.js` passes is dropped, not replaced. ORCA's own
   * decision for each tool use is kept (`orcaRecordFor`).
   */
  path.openSession = async (world, { askPermission, extraEnv, host, command } = {}) => {
    await mkdir(join(world.root, "claude-config"), { recursive: true });
    world.orcaRecords ??= new Map();
    const answerer = world.withoutAnswerer ? undefined : askPermission;
    return factory.makeSessionFactory({ configDir: world.configDir, storeDir: ".orca" }, () =>
      Promise.reject(new Error("a driver: claude-agent-sdk agent was opened over ACP")),
    )({
      host: host ?? new factory.LocalHost({ id: "local", type: "local" }),
      agent: path.agent(world, extraEnv, command),
      cwd: world.workspace,
      ...(answerer ? { askPermission: answerer } : {}),
      onPermission: ({ toolCallId, decision }) => {
        if (toolCallId) world.orcaRecords.set(toolCallId, decision);
      },
      logger: factory.silentLogger,
    });
  };

  /** The bridge's last decision for a tool use, as ORCA recorded it. */
  path.orcaRecordFor = (world, toolUseId) => (toolUseId ? world.orcaRecords?.get(toolUseId) : undefined);
  return path;
}
