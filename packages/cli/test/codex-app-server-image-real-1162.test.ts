/**
 * The Codex ORCA starts is attested against the verified builds (#1162), with the real pinned
 * `codex app-server` when ORCA_CODEX_BIN names it (skipped otherwise). The pinned binary itself
 * opens in every other real suite; here:
 *
 * - a copy of it with one byte appended (another build, as far as ORCA can tell) is refused,
 *   with its digest, before ORCA sends it anything;
 * - npm's `codex` command, which starts Node and then the binary, is refused too: the process
 *   ORCA started runs Node, and ORCA does not search below it.
 */
import { appendFile, chmod, copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentSpecSchema, OrcaError, silentLogger } from "@orca/core";
import { CODEX_VERIFIED_IMAGES, LocalHost, openCodexAppServerSession } from "@orca/agents";

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

  const refusal = (command: string) =>
    openCodexAppServerSession({
      host: new LocalHost({ id: "local", type: "local" }),
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
    }).then(
      () => expect.unreachable("the session opened"),
      (error: unknown) => error as OrcaError,
    );

  it("refuses a build whose digest is not the pinned one", async () => {
    const other = join(root, "codex");
    await copyFile(CODEX!, other);
    await appendFile(other, Buffer.from([0]));
    await chmod(other, 0o755);
    const error = await refusal(other);
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.message).toMatch(/the Codex it started is not a build ORCA verified/);
    expect(error.details).toMatchObject({ reason: "codex-image-unverified", platform: `linux-${process.arch}` });
    const sha256 = (error.details as { sha256: string }).sha256;
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256).not.toBe(CODEX_VERIFIED_IMAGES["0.171.0"]![`linux-${process.arch}`]);
  });

  it("refuses npm's codex command, whose process runs Node", async () => {
    // node_modules/@openai/codex-linux-x64/vendor/<triple>/bin/codex -> node_modules/@openai/codex/bin/codex.js
    const shim = join(dirname(CODEX!), "../../../../codex/bin/codex.js");
    expect(existsSync(shim)).toBe(true);
    const error = await refusal(shim);
    expect(error.code).toBe("NOT_SUPPORTED");
    expect(error.details).toMatchObject({ reason: "codex-image-unverified" });
    expect(error.message).toMatch(/an npm install's codex command starts Node/);
  });
});
