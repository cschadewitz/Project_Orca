import { afterEach, expect, it } from "vitest";
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceIdentity, renewWorkspaceIdentity } from "../src/workspace-identity.js";
const dirs: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "orca-identity-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it("initializes one stable identity under concurrent startup", async () => {
  const dir = await directory();
  const ids = await Promise.all(Array.from({ length: 8 }, () => workspaceIdentity(dir)));
  expect(new Set(ids).size).toBe(1);
  expect(await workspaceIdentity(dir)).toBe(ids[0]);
});
it("replacement backup retains identity; explicit independent clone renews only identity", async () => {
  const dir = await directory();
  const backup = await directory();
  const id = await workspaceIdentity(dir);
  await writeFile(join(dir, "protected-payload"), "opaque");
  await cp(dir, backup, { recursive: true });
  expect(await workspaceIdentity(backup)).toBe(id);
  expect(await renewWorkspaceIdentity(backup)).not.toBe(id);
  expect(await readFile(join(backup, "protected-payload"), "utf8")).toBe("opaque");
  expect(await workspaceIdentity(dir)).toBe(id);
});
it("missing or corrupt existing metadata requires explicit repair", async () => {
  const dir = await directory();
  await workspaceIdentity(dir);
  await unlink(join(dir, "workspace-identity", "id"));
  await expect(workspaceIdentity(dir)).rejects.toThrow("repair");
  await renewWorkspaceIdentity(dir);
  await writeFile(join(dir, "workspace-identity", "id"), "broken");
  await expect(workspaceIdentity(dir)).rejects.toThrow("repair");
  await rm(join(dir, "workspace-identity"), { recursive: true });
  await expect(workspaceIdentity(dir)).rejects.toThrow("repair");
});
