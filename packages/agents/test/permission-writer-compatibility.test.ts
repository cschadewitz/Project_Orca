/** Version refusal is a property of the existing-file writer, not just its input parser. */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPermissionPolicyFile, recordAlwaysDecision, replacePermissionPolicyFile } from "@orca/agents";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(version: unknown = 2) {
  const root = await mkdtemp(join(tmpdir(), "orca-writer-compat-"));
  roots.push(root);
  const file = join(root, "orca.permissions.json");
  // Opaque synthetic restriction: this test does not establish a typed storage schema.
  const bytes = `${JSON.stringify({ version, agents: {}, strictRules: { restriction: "must-survive" } })}\n`;
  await writeFile(file, bytes);
  return { root, file, bytes, revision: createHash("sha256").update(bytes).digest("hex") };
}

const replacement = { version: 1, agents: {} };

describe("permission writer existing-document compatibility", () => {
  it("the existing reader and append writer refuse version 2 and preserve its bytes", async () => {
    const { file, bytes } = await fixture();
    await expect(readPermissionPolicyFile(file)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      recordAlwaysDecision({
        file,
        agentId: "synthetic-agent",
        request: {
          sessionId: "synthetic-session",
          toolCall: { toolCallId: "synthetic-call", title: "Read", kind: "read" },
          options: [],
        },
        decision: "deny",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it.each([false, true])("refuses replacing version 2 (matching revision: %s)", async (compare) => {
    const { root, file, bytes, revision } = await fixture();
    const authorize = vi.fn(async () => {});
    await expect(
      replacePermissionPolicyFile(file, replacement, {
        ...(compare ? { expectedRevision: revision } : {}),
        authorize,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readFile(file, "utf8")).toBe(bytes);
    expect(await readdir(root)).toEqual(["orca.permissions.json"]);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it.each([0, 3, "2", null])("preserves an unsupported explicit version %j", async (version) => {
    const { file, bytes, revision } = await fixture(version);
    await expect(replacePermissionPolicyFile(file, replacement, { expectedRevision: revision })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("still reports stale before checking document compatibility", async () => {
    const { file, bytes } = await fixture();
    await expect(replacePermissionPolicyFile(file, replacement, { expectedRevision: "" })).rejects.toMatchObject({
      code: "CONFIG_STALE",
    });
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it.each(["", "{", '{"version":1,"agents":', '{"agents":{}}', '{"version":1,"agents":{}}'])(
    "retains explicit legacy repair/replacement behavior for %j",
    async (bytes) => {
      const { file } = await fixture();
      await writeFile(file, bytes);
      const authorize = vi.fn(async () => {});
      await replacePermissionPolicyFile(file, replacement, {
        expectedRevision: createHash("sha256").update(bytes).digest("hex"),
        authorize,
      });
      expect(await readPermissionPolicyFile(file)).toEqual(replacement);
      expect(authorize).toHaveBeenCalledTimes(2);
    },
  );

  it("does not create a document when original authority is lost", async () => {
    const { file, bytes } = await fixture();
    const authorize = vi.fn(async () => {
      throw new Error("permissions.grant revoked");
    });
    await expect(replacePermissionPolicyFile(file, replacement, { authorize })).rejects.toThrow(
      "permissions.grant revoked",
    );
    expect(await readFile(file, "utf8")).toBe(bytes);
  });
});
