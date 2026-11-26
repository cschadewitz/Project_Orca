/**
 * ORCA's pre-tool hook in a Codex that ORCA starts itself as `codex app-server` (#1161): the
 * session flags that install it, and `NativeToolHookSession.codexAppServer`, which hands the
 * session those flags, the command `hooks/list` must show, and the admission that runs against
 * the app-server process ORCA started. The full admission against the real Codex is in
 * `packages/cli/test/codex-app-server-hook-real-1161.test.ts`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_HOOK_KEY,
  CODEX_PRE_TOOL_TIMEOUT_SECONDS,
  codexHookConfig,
  codexHookSessionFlags,
  codexHookTrustHash,
  nativeToolHookSession,
} from "../src/index.js";

describe("the session flags that install ORCA's hook", () => {
  it("carry the same hook, trust and web search setting as the ACP route's CODEX_CONFIG, as TOML", () => {
    const command = `'/usr/bin/node' '/opt/orca/hook.mjs' "it's"`;
    const flags = codexHookSessionFlags(command);
    expect(flags.filter((_, i) => i % 2 === 0)).toEqual(["-c", "-c", "-c"]);
    const acp = JSON.parse(codexHookConfig(undefined, command)!) as {
      web_search: string;
      hooks: { PreToolUse: unknown; state: Record<string, { trusted_hash: string }> };
    };
    const hash = codexHookTrustHash(command, CODEX_PRE_TOOL_TIMEOUT_SECONDS);
    expect(acp.hooks.state[CODEX_HOOK_KEY]!.trusted_hash).toBe(hash);
    expect(flags[1]).toBe(
      `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command=${JSON.stringify(command)},timeout=${CODEX_PRE_TOOL_TIMEOUT_SECONDS}}]}]`,
    );
    expect(flags[3]).toBe(`hooks.state={${JSON.stringify(CODEX_HOOK_KEY)}={trusted_hash=${JSON.stringify(hash)}}}`);
    expect(flags[5]).toBe(`web_search=${JSON.stringify(acp.web_search)}`);
  });
});

describe("the hook for a Codex app-server session", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orca-1161-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));
  const hook = (more: Partial<Parameters<typeof nativeToolHookSession>[0]> = {}) =>
    nativeToolHookSession({
      agentId: "codex",
      permissions: { rules: [] },
      permissionFiles: [],
      workspaceCwd: dir,
      protectedPaths: { readOnly: [], noAccess: [join(dir, "orca")] },
      contextDir: join(dir, "orca", "hooks"),
      runtime: process.execPath,
      script: "/opt/orca/hook.mjs",
      platform: "linux",
      agentEnv: {},
      ...more,
    });

  it("is refused before the context is written, and on a platform the hook is not verified on", async () => {
    expect(() => hook().codexAppServer()).toThrow(/the hook was not prepared before Codex started/);
    const mac = hook({ platform: "darwin" });
    await mac.prepare();
    try {
      expect(() => mac.codexAppServer()).toThrow(/ORCA has verified the hook with Codex only on linux, not darwin/);
    } finally {
      await mac.cleanup();
    }
  });

  it("names the same command its flags install, and admits against the pid it is given", async () => {
    const codexEnvironment = vi.fn(async () => ({ error: "its environment cannot be read" }));
    const h = hook({ codexEnvironment });
    await h.prepare();
    try {
      const app = h.codexAppServer();
      expect(app.sessionFlags[1]).toContain(JSON.stringify(app.command));
      await expect(app.admit(4242)).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
        message: expect.stringMatching(/its environment cannot be read/),
      });
      expect(codexEnvironment).toHaveBeenCalledWith(4242);
      await expect(app.admit(undefined)).rejects.toMatchObject({
        message: expect.stringMatching(/does not know the Codex app-server's process id/),
      });
      expect(h.status()).toBe("pending");
    } finally {
      await h.cleanup();
    }
  });

  it("stops its admission when the session is cancelled", async () => {
    const h = hook({ codexEnvironment: () => new Promise(() => {}) });
    await h.prepare();
    try {
      const cancelled = new AbortController();
      const admitted = h.codexAppServer().admit(4242, cancelled.signal);
      cancelled.abort();
      await expect(admitted).rejects.toMatchObject({
        message: expect.stringMatching(/the session ended before ORCA's startup checks of the hook finished/),
      });
    } finally {
      await h.cleanup();
    }
  });
});
