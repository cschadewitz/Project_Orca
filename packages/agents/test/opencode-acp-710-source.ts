/**
 * #710 OpenCode 1.19.4 source witnesses: digest-checked upstream excerpts, type-stripped and
 * imported with synthetic dependencies only. Nothing here installs, launches or imports
 * OpenCode; no shell, file system, network or credential is reachable from the scaffolding.
 * A result from these functions is "source-function-tested", never installed behavior.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import type * as acp from "@agentclientprotocol/sdk";

export const repoRoot = new URL("../../../", import.meta.url);
export const packet = new URL("docs/preparation/opencode-acp-710/", repoRoot);

export interface Excerpt {
  id: string;
  path: string;
  repository: string;
  revision: string;
  upstreamPath: string;
  startLine: number;
  endLine: number;
  sourceBlobSha: string;
  url: string;
  sha256: string;
  bytes: number;
  purpose: string;
}

export interface SourcePins {
  format: string;
  status: string;
  issue: number;
  provider: {
    release: string;
    revision: string;
    installed: string;
    launched: string;
    authenticated: string;
    license: { path: string; sha256: string };
    acp: { command: string[]; sdkVersion: string; initializeProtocolVersion: number };
    npm: { packages: { name: string; version: string; integrity: string; os?: string; cpu?: string }[] };
  };
  excerpts: Excerpt[];
}

export type NativeReply = "once" | "always" | "reject";
export interface NativeRule {
  permission: string;
  pattern: string;
  action: "allow" | "ask" | "deny";
}

/** The OpenCode functions this packet exercises, as the excerpts define them. */
export interface OpenCodeSource {
  pins: SourcePins;
  text: (id: string) => string;
  permissionOptions: acp.PermissionOption[];
  selectedReply: (result: acp.RequestPermissionResponse) => NativeReply;
  toToolKind: (toolName: string) => acp.ToolKind;
  match: (input: string, pattern: string) => boolean;
  evaluate: (permission: string, pattern: string, ...rulesets: NativeRule[][]) => NativeRule;
  fromConfig: (permission: Record<string, string | Record<string, string>>) => NativeRule[];
  merge: (...rulesets: NativeRule[][]) => NativeRule[];
  defaultsFor: (whitelistedDirs: string[]) => NativeRule[];
  deriveSubagentSessionPermission: (input: {
    parentSessionPermission: NativeRule[];
    subagent: { permission: NativeRule[] };
  }) => NativeRule[];
  Bridge: new (input: BridgeInput) => Bridge;
}

/** Synthetic stand-ins for the ACP bridge's collaborators; see `bridgeModule` below. */
export interface BridgeInput {
  session: { tryGet: (sessionID: string) => { id: string; cwd: string } | undefined };
  connection: {
    requestPermission?: (request: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
    writeTextFile?: unknown;
  };
}
export interface PermissionEvent {
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    metadata: Record<string, unknown>;
    tool?: { callID: string };
  };
}
export interface Bridge {
  replies: { requestID: string; reply: NativeReply; directory: string }[];
  writes: { sessionId: string }[];
  process: (event: PermissionEvent) => Promise<void>;
}

function readPins(): SourcePins {
  return JSON.parse(readFileSync(new URL("source-pins.json", packet), "utf8")) as SourcePins;
}

/** Every excerpt is byte- and digest-checked before any of it is evaluated. */
export function verifiedExcerpts(pins: SourcePins = readPins()): Map<string, string> {
  const sources = new Map<string, string>();
  for (const excerpt of pins.excerpts) {
    const bytes = readFileSync(new URL(excerpt.path, repoRoot));
    if (bytes.byteLength !== excerpt.bytes) throw new Error(`${excerpt.id}: ${bytes.byteLength} bytes`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== excerpt.sha256) throw new Error(`${excerpt.id}: digest ${digest}`);
    sources.set(excerpt.id, bytes.toString("utf8"));
  }
  return sources;
}

async function pureModule<T>(source: string): Promise<T> {
  // Only digest-checked excerpts plus the labelled scaffolding in this file; no provider imports.
  const code = stripTypeScriptTypes(source);
  return (await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as T;
}

export async function loadOpenCodeSource(): Promise<OpenCodeSource> {
  const pins = readPins();
  const sources = verifiedExcerpts(pins);
  const text = (id: string): string => {
    const value = sources.get(id);
    if (value === undefined) throw new Error(`no excerpt ${id}`);
    return value;
  };

  const reply = await pureModule<Pick<OpenCodeSource, "permissionOptions" | "selectedReply">>(`
    ${text("acp-permission-options")}
    ${text("acp-permission-selected-reply")}
    export { permissionOptions, selectedReply }
  `);
  const kind = await pureModule<Pick<OpenCodeSource, "toToolKind">>(text("acp-tool-kind"));
  const rules = await pureModule<
    Pick<
      OpenCodeSource,
      "match" | "evaluate" | "fromConfig" | "merge" | "defaultsFor" | "deriveSubagentSessionPermission"
    >
  >(`
    // Synthetic: a fixed home directory instead of the host's, for pattern expansion only.
    const os = { homedir: () => "/fixture/home" };
    ${text("wildcard-match")}
    const Wildcard = { match };
    ${text("permission-from-config")}
    const Permission = { fromConfig, merge };
    ${text("permission-evaluate")}
    export function defaultsFor(whitelistedDirs) {
      ${text("agent-defaults")}
      return defaults;
    }
    ${text("subagent-permissions")}
  `);
  const bridgeModule = await pureModule<Pick<OpenCodeSource, "Bridge">>(`
    // Synthetic: the session lookup is already a value, not an Effect program.
    const Effect = { runPromise: (value) => Promise.resolve(value) };
    // Synthetic: the real projection reads files for edit diffs; the bridge's control flow
    // does not depend on its result, so the fixture carries the tool name as the title.
    async function permissionToolCall(input) {
      return { toolCallId: input.toolCallId, title: input.toolName };
    }
    ${text("acp-permission-options")}
    ${text("acp-permission-selected-reply")}
    export class Bridge {
      replies = [];
      writes = [];
      constructor(input) { this.input = input; }
      // Synthetic sinks for the native reply and the edit mirror the bridge would call.
      async reply(requestID, reply, directory) { this.replies.push({ requestID, reply, directory }); }
      async writeProposedEdit(sessionId) { this.writes.push({ sessionId }); }
    ${text("acp-permission-process")}
    }
  `);
  return { pins, text, ...reply, ...kind, ...rules, ...bridgeModule };
}
