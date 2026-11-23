/**
 * #702: a rule with a lifetime must never be read by a released 0.7.x binary as a grant with
 * no end. Those releases read version 1 and strip `expiresAt`; this build writes any timed
 * rule as version 3, which they refuse. The released code under test is the verbatim copy in
 * `fixtures/released-0.7-permission-reader.ts`.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decidePermission,
  loadEffectivePermissionPolicy,
  permissionPolicyPath,
  readPermissionPolicyFile,
  recordAlwaysDecision,
  replacePermissionPolicyFile,
} from "@orca/agents";
import { AgentSpecSchema } from "@orca/core";
import {
  releasedLoadEffectivePermissionPolicy,
  releasedReadPermissionPolicyFile,
  releasedRefuseUnsupportedPolicyReplacement,
} from "./fixtures/released-0.7-permission-reader.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-lifetime-"));
  dirs.push(dir);
  return dir;
}

// The default policy (no `default:`), so an in-workspace edit is allowed by the floor.
const agent = AgentSpecSchema.parse({ id: "claude", command: "claude-code-acp" });
const T0 = Date.parse("2026-11-23T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const request = (dir: string, kind: string, path: string) =>
  ({
    sessionId: "s",
    toolCall: { toolCallId: "t", title: `${kind} ${path}`, kind, locations: [{ path: join(dir, path) }] },
    options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
  }) as never;

describe("a timed rule across a rollback to 0.7.x and back", () => {
  it("is refused by the released reader, which then asks instead of granting anything, and survives the round trip", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    // A permanent deny and a timed allow, both written by this build.
    await recordAlwaysDecision({
      file,
      agentId: agent.id,
      request: request(dir, "edit", "secret.ts"),
      decision: "deny",
      workspaceCwd: dir,
    });
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
    await recordAlwaysDecision({
      file,
      agentId: agent.id,
      request: request(dir, "execute", "make"),
      decision: "allow",
      workspaceCwd: dir,
      expiresAt: new Date(T0 + HOUR).toISOString(),
      now: () => new Date(T0),
    });
    const bytes = await readFile(file, "utf8");
    expect(JSON.parse(bytes).version).toBe(3);

    // 0.7.x reopening the workspace: the file is unreadable to it...
    await expect(releasedReadPermissionPolicyFile(file)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    // ...so its session skips it and caps every later allow to ask: the timed allow is not a
    // permanent one there, and the floor's in-workspace edit allow is asked rather than given.
    const skipped: string[] = [];
    const released = await releasedLoadEffectivePermissionPolicy(agent, [file], (f) => skipped.push(f));
    expect(skipped).toEqual([file]);
    const scope = { workspaceCwd: dir };
    expect(decidePermission(released, request(dir, "execute", "make"), scope)).toBe("ask");
    expect(decidePermission(released, request(dir, "edit", "other.ts"), scope)).toBe("ask");
    // Its writers cannot erase the lifetime: the replace guard refuses, and its "always"
    // append reads the file first, which throws as above.
    await expect(releasedRefuseUnsupportedPolicyReplacement(file)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readFile(file, "utf8")).toBe(bytes);

    // Back on this build: everything is still there, lifetime included.
    const doc = await readPermissionPolicyFile(file);
    expect(doc.agents[agent.id]?.rules.map((rule) => rule.expiresAt)).toEqual([undefined, "2026-11-23T11:00:00.000Z"]);
    const at = (ms: number) => loadEffectivePermissionPolicy(agent, [file], undefined, undefined, () => ms);
    expect(decidePermission(await at(T0), request(dir, "execute", "make"), scope)).toBe("allow");
    expect(decidePermission(await at(T0 + HOUR), request(dir, "execute", "make"), scope)).toBe("ask");
    expect(decidePermission(await at(T0), request(dir, "edit", "secret.ts"), scope)).toBe("deny");
  });

  it("goes back to version 1 when the last timed rule is removed, so 0.7.x reads the file again", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    await recordAlwaysDecision({
      file,
      agentId: agent.id,
      request: request(dir, "execute", "make"),
      decision: "allow",
      workspaceCwd: dir,
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
    });
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(3);
    const doc = await readPermissionPolicyFile(file);
    const rules = doc.agents[agent.id]!.rules.map(({ expiresAt: _drop, ...rule }) => rule);
    // A client may still send the version it read; the writer stamps the one the content needs.
    await replacePermissionPolicyFile(file, { version: 3, agents: { [agent.id]: { rules } } });
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
    expect((await releasedReadPermissionPolicyFile(file)).agents[agent.id]?.rules).toHaveLength(1);
  });

  it("refuses a version 1 file carrying expiresAt, the one shape 0.7.x would read as permanent", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        agents: {
          claude: {
            rules: [
              {
                match: { kind: "execute", titlePattern: "^make$" },
                decision: "allow",
                expiresAt: "2000-01-01T00:00:00.000Z",
              },
            ],
          },
        },
      }),
    );
    // The hazard, shown on the released reader: the lifetime is stripped and the grant stands.
    expect((await releasedReadPermissionPolicyFile(file)).agents["claude"]?.rules[0]).not.toHaveProperty("expiresAt");
    // This build refuses the file rather than agree with either reading.
    await expect(readPermissionPolicyFile(file)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
