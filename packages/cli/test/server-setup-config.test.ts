// The operator config a new managed server gets from tools/deploy/orca-server-setup.py
// (#881) must start the daemon as written: a fresh server has no agents yet.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { silentLogger } from "@orca/core";
import { bootstrap } from "../src/bootstrap.js";

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/** `SERVER_CONFIG` from the setup script: its adjacent Python string literals, joined. */
async function serverConfig(): Promise<string> {
  // A CRLF checkout (core.autocrlf on Windows) must parse the same as LF.
  const source = (await readFile(join(repo, "tools/deploy/orca-server-setup.py"), "utf8")).replace(/\r\n/g, "\n");
  const block = /^SERVER_CONFIG = \(\n((?: {4}"(?:[^"\\]|\\.)*"\n)+)\)$/m.exec(source)?.[1];
  if (!block) throw new Error("SERVER_CONFIG not found in orca-server-setup.py");
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
}

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("starts the daemon on the config a new server is given, with no agents (#881)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orca-server-config-"));
  dirs.push(dir);
  // The release this checkout would be: its shipped workflows and templates.
  vi.stubEnv("ORCA_RELEASE", repo);
  const config = await serverConfig();
  await writeFile(join(dir, "orca.config.yaml"), config, "utf8");
  await expect(bootstrap({ cwd: dir, ephemeral: true, logger: silentLogger })).resolves.toBeDefined();

  // The line the config suggests for later is refused until agents exist: why it is a comment.
  const suggested = /^#\s+(workflows: .*)$/m.exec(config)?.[1];
  expect(suggested).toBe("workflows: ['${ORCA_RELEASE}/workflows/**/*.yaml']");
  await writeFile(join(dir, "orca.config.yaml"), config.replace("workflows: []", suggested!), "utf8");
  await expect(bootstrap({ cwd: dir, ephemeral: true, logger: silentLogger })).rejects.toMatchObject({
    code: "WORKFLOW_INVALID",
  });
});
