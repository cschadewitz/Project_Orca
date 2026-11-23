/**
 * `permissions.saveJudgedRule` (protocol 2.12, #701): the app's save method for a plain-language
 * rule, over a real config directory. The rule lands in the sidecar as version 4, the effective
 * typed policy `config.get` reports is unchanged, and `config.changed` announces the write.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEffectivePermissionPolicy } from "@orca/agents";
import { AgentSpecSchema, FakeClock } from "@orca/core";
import {
  PERMISSIONS_SAVE_JUDGED_RULE_METHOD,
  PROTOCOL_VERSION,
  PermissionsSaveJudgedRuleParamsSchema,
  PermissionsSaveJudgedRuleResultSchema,
} from "@orca/protocol";
import { ConfigModel, dispatch, methodsFor, type MethodContext } from "@orca/daemon";

const CONFIG = `version: 1
agents:
  - id: claude
    command: claude-code
    permissions:
      default: ask
`;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "orca-save-judged-"));
  dirs.push(dir);
  const configFile = join(dir, "orca.config.yaml");
  await writeFile(configFile, CONFIG, "utf8");
  const clock = new FakeClock(Date.UTC(2026, 10, 23, 12, 0, 0));
  const model = new ConfigModel({ configDir: dir, configFile, clock });
  return { dir, model, clock, sidecar: join(dir, "orca.permissions.json") };
}

const RULE = {
  agentId: "claude",
  match: { kind: "read" as const, scope: "workspace" as const },
  criterion: "Reading source, tests and docs, but never .env files.",
};

describe("permissions.saveJudgedRule", () => {
  it("saves the rule to a version-4 sidecar, stamped on the daemon's clock", async () => {
    const { model, sidecar } = await workspace();
    const result = PermissionsSaveJudgedRuleResultSchema.parse(
      await model.saveJudgedRule({ ...RULE, durationMs: 60 * 60 * 1000 }),
    );
    expect(result).toEqual({
      agentId: "claude",
      ruleId: "sidecar:0",
      outcome: "added",
      expiresAt: "2026-11-23T13:00:00.000Z",
      asOf: "2026-11-23T12:00:00.000Z",
    });
    const doc = JSON.parse(await readFile(sidecar, "utf8"));
    expect(doc.version).toBe(4);
    expect(doc.agents.claude.rules).toEqual([
      {
        match: RULE.match,
        judge: { criterion: RULE.criterion },
        addedAt: "2026-11-23T12:00:00.000Z",
        expiresAt: "2026-11-23T13:00:00.000Z",
      },
    ]);
    // The session's loader reads it as a judged rule, after nothing typed.
    const agent = AgentSpecSchema.parse({ id: "claude", command: "x", permissions: { default: "ask" } });
    const policy = await loadEffectivePermissionPolicy(agent, [sidecar], undefined, undefined, () =>
      Date.UTC(2026, 10, 23, 12, 30),
    );
    expect(policy.judged?.map((r) => r.ruleId)).toEqual(["sidecar:0"]);
  });

  it("leaves the typed effective policy as it was, and announces the write", async () => {
    const { model } = await workspace();
    const before = (await model.get()).effective;
    const heard = vi.fn();
    model.onChange(heard);
    await model.saveJudgedRule(RULE);
    // The typed rules are as they were; the saved rule is listed apart from them (#701).
    const after = (await model.get()).effective.agents["claude"]!;
    expect(after.rules).toEqual(before.agents["claude"]!.rules);
    expect(after.default).toBe(before.agents["claude"]!.default);
    expect(after.judged).toEqual([
      {
        ruleId: "sidecar:0",
        source: "permissions",
        match: RULE.match,
        criterion: RULE.criterion,
        addedAt: "2026-11-23T12:00:00.000Z",
      },
    ]);
    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ document: "permissions" }));
    heard.mockClear();
    expect((await model.saveJudgedRule(RULE)).outcome).toBe("already-present");
    expect(heard).not.toHaveBeenCalled();
  });

  it("refuses an agent the configuration does not declare, and writes nothing", async () => {
    const { model, sidecar } = await workspace();
    await expect(model.saveJudgedRule({ ...RULE, agentId: "nobody" })).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    await expect(readFile(sidecar, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a path outside the workspace", async () => {
    const { model } = await workspace();
    await expect(
      model.saveJudgedRule({ ...RULE, match: { kind: "read", path: "../other/secret.txt" } }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses the same invalid rule through a whole-file config.set", async () => {
    const { model } = await workspace();
    const text = JSON.stringify({
      version: 4,
      agents: { claude: { rules: [{ match: { kind: "read", path: "/etc/passwd" }, judge: { criterion: "x" } }] } },
    });
    await expect(model.set({ document: "permissions", expectedRevision: "", text })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("checks authority before and under the lock", async () => {
    const { model, sidecar } = await workspace();
    let calls = 0;
    const authorize = async () => {
      if (++calls > 1) throw new Error("revoked");
    };
    await expect(model.saveJudgedRule(RULE, authorize)).rejects.toThrow("revoked");
    await expect(readFile(sidecar, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("takes only the kinds the judged lane can open for, and no command, over the wire", () => {
    const parse = (match: unknown) => PermissionsSaveJudgedRuleParamsSchema.safeParse({ ...RULE, match }).success;
    expect(parse({ kind: "read" })).toBe(true);
    expect(parse({ kind: "search", pathPrefix: "docs/" })).toBe(true);
    expect(parse({})).toBe(false);
    expect(parse({ kind: "edit" })).toBe(false);
    expect(parse({ kind: "execute" })).toBe(false);
    expect(parse({ kind: "read", command: "cat x" })).toBe(false);
    expect(PermissionsSaveJudgedRuleParamsSchema.safeParse({ ...RULE, criterion: " " }).success).toBe(false);
    expect(PermissionsSaveJudgedRuleParamsSchema.safeParse({ ...RULE, durationMs: 91 * 86_400_000 }).success).toBe(
      false,
    );
  });

  it("is advertised only by a daemon that writes, and is unknown on a read-only one", async () => {
    const { model } = await workspace();
    const context = (readOnly: boolean): MethodContext => ({
      orcaVersion: "0.1.0-test",
      capabilities: readOnly ? ["runs.read"] : ["runs.read", "runs.control"],
      reads: { runsList: () => ({}) } as never,
      config: model,
      ...(readOnly ? {} : { control: {} as never }),
    });
    const call = async (ctx: MethodContext, method: string, params: unknown) =>
      (await dispatch(JSON.stringify({ kind: "request", id: 1, method, params }), methodsFor(ctx), ctx)) as {
        ok: boolean;
        result?: { methods?: string[] };
        error?: { code: string };
      };
    const hello = { client: "test", protocol: PROTOCOL_VERSION };
    expect((await call(context(false), "hello", hello)).result?.methods).toContain(PERMISSIONS_SAVE_JUDGED_RULE_METHOD);
    expect((await call(context(true), "hello", hello)).result?.methods).not.toContain(
      PERMISSIONS_SAVE_JUDGED_RULE_METHOD,
    );
    const readOnly = await call(context(true), PERMISSIONS_SAVE_JUDGED_RULE_METHOD, RULE);
    expect(readOnly.error?.code).toBe("PROTOCOL_METHOD");
    const saved = await call(context(false), PERMISSIONS_SAVE_JUDGED_RULE_METHOD, RULE);
    expect(saved).toMatchObject({ ok: true, result: { ruleId: "sidecar:0", outcome: "added" } });
  });
});

describe("config.set and judged rules (#701 review: same authority on both routes)", () => {
  const typed = { match: { kind: "read", path: "README.md" }, decision: "allow" };
  const judged = { match: { kind: "read", scope: "workspace" }, judge: { criterion: "Reading the docs." } };
  const sidecarText = (rules: unknown[], version = 4) => JSON.stringify({ version, agents: { claude: { rules } } });
  /** config.write and config.read, and a separate judged authority that refuses unless granted. */
  const authority = (grant: boolean) => {
    const calls = { plain: 0, judged: 0 };
    return {
      calls,
      plain: async () => void calls.plain++,
      judged: async () => {
        calls.judged++;
        if (!grant) throw new Error("missing-permission:permissions.grant");
      },
    };
  };

  it("needs the grant to add, change or remove a judged rule through the whole document", async () => {
    const { model, sidecar } = await workspace();
    const without = authority(false);
    await expect(
      model.set(
        { document: "permissions", expectedRevision: "", text: sidecarText([judged]) },
        without.plain,
        without.judged,
      ),
    ).rejects.toThrow("permissions.grant");
    await expect(readFile(sidecar, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const owner = authority(true);
    const added = await model.set(
      { document: "permissions", expectedRevision: "", text: sidecarText([judged]) },
      owner.plain,
      owner.judged,
    );
    // Before the lock, then under it before the compare and again before the rename.
    expect(owner.calls.judged).toBeGreaterThanOrEqual(3);

    const edited = sidecarText([{ ...judged, judge: { criterion: "Reading anything." } }]);
    await expect(
      model.set(
        { document: "permissions", expectedRevision: added.document.revision, text: edited },
        without.plain,
        without.judged,
      ),
    ).rejects.toThrow("permissions.grant");
    await expect(
      model.set(
        { document: "permissions", expectedRevision: added.document.revision, text: sidecarText([], 1) },
        without.plain,
        without.judged,
      ),
    ).rejects.toThrow("permissions.grant");
    expect(JSON.parse(await readFile(sidecar, "utf8")).agents.claude.rules).toEqual([judged]);
  });

  it("keeps ordinary grants and unrelated edits on config.write alone, judged rows untouched", async () => {
    const { model, sidecar } = await workspace();
    const owner = authority(true);
    const first = await model.set(
      { document: "permissions", expectedRevision: "", text: sidecarText([judged]) },
      owner.plain,
      owner.judged,
    );
    const without = authority(false);
    await model.set(
      { document: "permissions", expectedRevision: first.document.revision, text: sidecarText([typed, judged]) },
      without.plain,
      without.judged,
    );
    expect(without.calls.judged).toBe(0);
    expect(JSON.parse(await readFile(sidecar, "utf8")).agents.claude.rules).toEqual([typed, judged]);

    // A typed-only sidecar never needs it either.
    const fresh = await workspace();
    await fresh.model.set(
      { document: "permissions", expectedRevision: "", text: sidecarText([typed], 1) },
      without.plain,
      without.judged,
    );
    expect(without.calls.judged).toBe(0);
  });

  it("needs the grant for a judged rule written into the config file too", async () => {
    const { model } = await workspace();
    const without = authority(false);
    const current = await model.read("config");
    await expect(
      model.set(
        {
          document: "config",
          expectedRevision: current.revision,
          text: `${CONFIG}      rules:\n        - match: { kind: read, scope: workspace }\n          judge: { criterion: "Reading the docs." }\n`,
        },
        without.plain,
        without.judged,
      ),
    ).rejects.toThrow("permissions.grant");
  });

  it("needs the grant to repair an unreadable sidecar into one with judged rules, not into one without", async () => {
    const { model, sidecar } = await workspace();
    // A judged row in a version-3 file: the reader refuses the file, so no judged rule is in force.
    const unreadable = sidecarText([typed, judged], 3);
    await writeFile(sidecar, unreadable, "utf8");
    const before = await model.read("permissions");
    const without = authority(false);
    // Same row text, now readable: that brings a judged rule into force.
    await expect(
      model.set(
        { document: "permissions", expectedRevision: before.revision, text: sidecarText([typed, judged]) },
        without.plain,
        without.judged,
      ),
    ).rejects.toThrow("permissions.grant");
    expect(await readFile(sidecar, "utf8")).toBe(unreadable);
    // Repaired to typed rules only: nothing judged comes into force, so config.write is enough.
    await model.set(
      { document: "permissions", expectedRevision: before.revision, text: sidecarText([typed], 1) },
      without.plain,
      without.judged,
    );
    expect(without.calls.judged).toBe(1);
    expect(JSON.parse(await readFile(sidecar, "utf8")).agents.claude.rules).toEqual([typed]);
  });

  it("fences a config write against the file it replaces, so a stale ordinary edit cannot drop a judged change", async () => {
    const { model, dir } = await workspace();
    const configFile = join(dir, "orca.config.yaml");
    const withJudged = `${CONFIG}      rules:\n        - match: { kind: read, scope: workspace }\n          judge: { criterion: "Reading the docs." }\n`;
    const current = await model.read("config");
    let calls = 0;
    // A judged change lands after this write was decided under the lock and before its rename.
    const plain = async () => {
      if (++calls === 4) await writeFile(configFile, withJudged, "utf8");
    };
    await expect(
      model.set(
        { document: "config", expectedRevision: current.revision, text: `${CONFIG}# an ordinary edit\n` },
        plain,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "CONFIG_STALE" });
    expect(await readFile(configFile, "utf8")).toBe(withJudged);
  });
});
