/** The narrow emitted auth import retains identical stores, fresh admin processes and real revocation. */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { PROTOCOL_VERSION, ResponseMessageSchema } from "@orca/protocol";
import { ProductionFixture, root } from "./mcp-operator-production-fixture.js";

it("uses the identical emitted auth implementation in distinct completed credential-admin processes", async () => {
  // The regression is about process identity, so this is the one fixture that keeps a process per operation.
  const f = await ProductionFixture.create(undefined, { freshAdmin: true });
  try {
    const url = (path: string) => JSON.stringify(pathToFileURL(join(root, path)).href);
    const identity = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { openAuthDirectory as barrel } from ${url("packages/daemon/dist/index.js")};
         import { openAuthDirectory as narrow } from ${url("packages/daemon/dist/auth/bootstrap.js")};
         if (barrel !== narrow) throw new Error('Emitted auth implementation differs');
         process.stdout.write('identical');`,
      ],
      { cwd: f.dir, env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" }, timeout: 10_000, maxBuffer: 32_768 },
    );
    expect(identity.stdout).toBe("identical");

    const issued = await f.issue({ principal: "fixture-regression", preset: "owner" });
    const hello = { client: "fixture-regression", protocol: PROTOCOL_VERSION };
    expect(await f.rpc("hello", hello, issued.token)).toMatchObject({ ok: true });
    await f.revoke(issued.credential.id);
    // Authentication refusal precedes request decoding, so its response ID is zero.
    const refusal = await fetch(`${f.endpoint}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "request", id: "revoked", method: "hello", params: hello }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(refusal.status).toBe(401);
    expect(ResponseMessageSchema.parse(await refusal.json())).toMatchObject({
      id: 0,
      ok: false,
      error: { code: "AUTH_INVALID" },
    });

    // Initial owner issue, the separate issue above, and revoke each completed in a fresh process.
    const admins = f.processes.filter(({ child }) => child.spawnargs.includes("--input-type=module"));
    expect(admins).toHaveLength(3);
    const pids = admins.map(({ child }) => {
      expect(child.exitCode).toBe(0);
      expect(child.pid).toBeDefined();
      return child.pid;
    });
    expect(new Set(pids).size).toBe(3);
  } finally {
    await f.close();
  }
});
