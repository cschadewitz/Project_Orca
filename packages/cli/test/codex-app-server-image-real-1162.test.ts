/**
 * ORCA starts only a verified Codex build (#1162), with the real pinned `codex app-server` when
 * ORCA_CODEX_BIN names it (skipped otherwise). The pinned binary itself opens in every other
 * real suite; here:
 *
 * - a copy of it with one byte appended (another build, as far as ORCA can tell) is refused,
 *   with its digest, without the host being asked to start it (or to read any secret for it);
 * - npm's `codex` command, a Node script that then starts the binary, is refused the same way;
 * - a process that does not run the very file ORCA checked (here a byte-identical copy, while
 *   the check is shown the original's inode) is started but stopped before ORCA sends it
 *   anything.
 */
import { appendFile, chmod, copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, OrcaError, silentLogger } from "@orca/core";
import {
  CODEX_VERIFIED_IMAGES,
  fileImageIdentity,
  LocalHost,
  openCodexAppServerSession,
  type OpenCodexAppServerSessionOptions,
} from "@orca/agents";

const CODEX = process.env.ORCA_CODEX_BIN;

describe.skipIf(!CODEX)("the Codex image ORCA starts, against the real pinned Codex", () => {
  let root: string;
  let workspace: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orca-1162-")));
    workspace = join(root, "work");
    await mkdir(workspace);
    await mkdir(join(root, "codex-home"));
    return () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const refusal = (command: string, more: Partial<OpenCodexAppServerSessionOptions> = {}) => {
    const host = new LocalHost({ id: "local", type: "local" });
    const spawnAgent = host.spawnAgent.bind(host);
    let spawned = 0;
    host.spawnAgent = (...args: Parameters<typeof spawnAgent>) => (spawned++, spawnAgent(...args));
    return openCodexAppServerSession({
      host,
      agent: AgentSpecSchema.parse({
        id: "codex",
        command,
        driver: "codex-app-server",
        env: { CODEX_HOME: join(root, "codex-home") },
        permissions: { default: "ask" },
      }),
      cwd: workspace,
      thread: { approvalPolicy: "on-request", sandbox: "workspace-write" },
      logger: silentLogger,
      ...more,
    }).then(
      () => expect.unreachable("the session opened"),
      (error: unknown) => ({ error: error as OrcaError, spawned }),
    );
  };

  it("never starts a build whose digest is not the pinned one", async () => {
    const other = join(root, "codex");
    await copyFile(CODEX!, other);
    await appendFile(other, Buffer.from([0]));
    await chmod(other, 0o755);
    const { error, spawned } = await refusal(other);
    expect(spawned).toBe(0);
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toMatch(/the Codex at its command is not a build ORCA verified/);
    expect(error.details).toMatchObject({ reason: "codex-image-unverified", platform: `linux-${process.arch}` });
    const sha256 = (error.details as { sha256: string }).sha256;
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256).not.toBe(CODEX_VERIFIED_IMAGES["0.171.0"]![`linux-${process.arch}`]);
  });

  it("never starts npm's codex command, a Node script", async () => {
    // node_modules/@openai/codex-linux-x64/vendor/<triple>/bin/codex -> node_modules/@openai/codex/bin/codex.js
    const shim = join(dirname(CODEX!), "../../../../codex/bin/codex.js");
    expect(existsSync(shim)).toBe(true);
    const { error, spawned } = await refusal(shim);
    expect(spawned).toBe(0);
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.details).toMatchObject({ reason: "codex-image-unverified" });
    expect(error.message).toMatch(/an npm install's codex command is a Node script/);
  });

  it("stops a started process that does not run the file ORCA checked, before sending it anything", async () => {
    // A byte-identical copy (same digest, another inode) is what starts, while the check is
    // shown the original's identity: only the inode tells them apart.
    const copy = join(root, "codex");
    await copyFile(CODEX!, copy);
    await chmod(copy, 0o755);
    const original = await fileImageIdentity(await realpath(CODEX!));
    const { error, spawned } = await refusal(copy, { imageFile: async () => original });
    expect(spawned).toBe(1);
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toMatch(/the process ORCA started does not run the Codex file ORCA checked/);
    expect(error.details).toMatchObject({ reason: "codex-image-unverified" });
  });
});
