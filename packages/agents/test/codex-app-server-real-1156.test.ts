/**
 * ORCA's client against the real pinned `codex app-server` (#1156), when ORCA_CODEX_BIN names
 * it (the Codex app-server protocol workflow sets it; skipped otherwise). In an empty
 * CODEX_HOME: the handshake reports the pinned version and that home, `account/read` reports
 * no login and ORCA's check refuses with `codex login`, a method removed upstream is refused by
 * the pinned protocol, and nothing ORCA does creates Codex credentials there.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_ACCOUNT_READ_PARAMS,
  CodexAppServerClient,
  codexLoginRefused,
  CodexRpcError,
  initializeCodexAppServer,
  stdioLineTransport,
} from "../src/index.js";

const codex = process.env.ORCA_CODEX_BIN;
const children: ChildProcess[] = [];
const homes: string[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function start(): { client: CodexAppServerClient; home: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "orca-1156-home-")));
  homes.push(home);
  const child = spawn(codex!, ["app-server"], {
    env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home },
    stdio: ["pipe", "pipe", "ignore"],
  });
  children.push(child);
  const client = new CodexAppServerClient(stdioLineTransport({ stdin: child.stdin, stdout: child.stdout }), {
    requestTimeoutMs: 20_000,
  });
  return { client, home };
}

describe.skipIf(!codex)("the real pinned codex app-server", () => {
  it("handshakes, reports no login, and ORCA refuses with codex login", async () => {
    const { client, home } = start();
    const handshake = await initializeCodexAppServer(client, { agentId: "codex", orcaVersion: "0.0.0-test" });
    expect(handshake).toMatchObject({ version: "0.171.0", codexHome: home });
    const account = await client.request("account/read", CODEX_ACCOUNT_READ_PARAMS);
    expect(account).toMatchObject({ account: null, requiresOpenaiAuth: true });
    expect(codexLoginRefused("codex", account)?.details).toMatchObject({ reason: "codex-login-required" });
    // ORCA asked for nothing that writes a login.
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    client.close();
  }, 60_000);

  it("refuses a session needing a method the pinned protocol lacks, and Codex agrees it is gone", async () => {
    const { client } = start();
    await expect(
      initializeCodexAppServer(client, {
        agentId: "codex",
        orcaVersion: "0.0.0-test",
        requiredMethods: ["thread/rollback"],
      }),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED", details: { missing: ["thread/rollback"] } });
    const { client: raw } = start();
    await initializeCodexAppServer(raw, { agentId: "codex", orcaVersion: "0.0.0-test" });
    const error = (await raw.request("thread/rollback", {}).catch((e: unknown) => e)) as CodexRpcError;
    expect(error).toBeInstanceOf(CodexRpcError);
    expect(error.message).toContain("unknown variant `thread/rollback`");
    raw.close();
  }, 60_000);
});
