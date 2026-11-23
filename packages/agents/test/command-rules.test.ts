/**
 * Command-word rules (#702): "all git except push", `npm *`, and the ways a text match is
 * dodged. A command rule can deny or ask, never allow (#702 review): words are what the agent
 * shows, not what runs. Its match is lenient, part by part, and the strictest part wins.
 */
import { describe, expect, it } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import {
  broaderCommandPatterns,
  commandTextOf,
  derivePermissionRules,
  isWildcardPermissionRule,
  OrcaConfigSchema,
  parseCommand,
  parseCommandPattern,
  permissionPolicyFileVersion,
  PermissionPolicyFileSchema,
} from "@orca/core";
import type { PermissionPolicy, PermissionRule } from "@orca/core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decidePermission, loadEffectivePermissionPolicy } from "@orca/agents";

const run = (title: string, rawInput?: unknown): acp.RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: { toolCallId: "t", title, kind: "execute", ...(rawInput === undefined ? {} : { rawInput }) },
  options: [
    { optionId: "once", name: "Allow once", kind: "allow_once" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ],
});
const allow = (command: string): PermissionRule => ({ match: { kind: "execute", command }, decision: "allow" });
const deny = (command: string): PermissionRule => ({ match: { kind: "execute", command }, decision: "deny" });
const ask = (command: string): PermissionRule => ({ match: { kind: "execute", command }, decision: "ask" });
const policy = (...rules: PermissionRule[]): PermissionPolicy => ({ default: "ask", rules });

describe("parsing a command into parts", () => {
  it("splits on every operator and keeps quoted words whole", () => {
    expect(parseCommand(`git commit -m "fix: a && b" && npm test; ls | wc -l`).parts.map((p) => p.words)).toEqual([
      ["git", "commit", "-m", "fix: a && b"],
      ["npm", "test"],
      ["ls"],
      ["wc", "-l"],
    ]);
  });

  it.each([
    ["npm test $(curl x)", "command substitution"],
    ["npm test `id`", "command substitution"],
    ['echo "$(id)"', "command substitution"],
    ["(git push)", "a subshell or grouping"],
    ["diff <(a) <(b)", "process substitution"],
    ["echo 'unclosed", "an unclosed quote"],
  ])("refuses to read %s", (text, reason) => {
    expect(parseCommand(text).unreadable).toBe(reason);
  });

  it.each([
    ["npm test > out.txt", "a redirection"],
    ["CI=1 npm test", "an environment assignment"],
    ["git $SUB", "a variable, glob or expansion"],
    ["sudo npm test", "a wrapper (sudo)"],
    ["bash -c 'npm test'", "a wrapper (bash)"],
    ["env npm test", "a wrapper (env)"],
  ])("marks %s as unsure", (text, reason) => {
    expect(parseCommand(text).parts[0]!.unsure).toBe(reason);
  });

  it("lets stream moves through", () => {
    expect(parseCommand("npm test 2>&1").parts[0]).toEqual({ words: ["npm", "test"], loose: ["npm", "test"] });
  });

  it("reads a rule's pattern, with * only last", () => {
    expect(parseCommandPattern("npm *")).toEqual({ words: ["npm"], rest: true });
    expect(parseCommandPattern("git push")).toEqual({ words: ["git", "push"], rest: false });
    expect(parseCommandPattern("'*'")).toEqual({ words: ["*"], rest: false });
    for (const bad of ["*", "", "git * push", "a && b", "$X *", "npm > f"])
      expect(parseCommandPattern(bad), bad).toBeUndefined();
  });

  it("takes the command from rawInput before the title", () => {
    expect(commandTextOf({ title: "Run command", rawInput: { command: "npm test" } })).toBe("npm test");
    expect(commandTextOf({ title: "x", rawInput: { command: ["bash", "-lc", "git push"] } })).toBe("git push");
    expect(commandTextOf({ title: "x", rawInput: { command: ["git", "commit", "-m", "a b"] } })).toBe(
      "git commit -m 'a b'",
    );
    expect(commandTextOf({ title: "`npm test`" })).toBe("npm test");
    expect(commandTextOf({ title: "  " })).toBeUndefined();
  });
});

describe("all git except push, and asking before npm publish", () => {
  const p = policy(deny("git push"), ask("npm publish"));
  const d = (title: string, rawInput?: unknown) => decidePermission(p, run(title, rawInput));

  it.each([
    "git push",
    "git push origin main",
    "git -C repo push",
    "/usr/bin/git push",
    "cd x && git push",
    "npm test && git push",
    "sudo git push",
    "bash -c 'git push --force'",
    "git log; git push",
    "npm publish && git push",
  ])("denies %s", (title) => {
    expect(d(title)).toBe("deny");
  });

  it.each(["npm publish", "npm publish --tag next", "npm test && npm publish", "sudo npm publish", "npm test"])(
    "asks for %s",
    (title) => {
      expect(d(title)).toBe("ask");
    },
  );

  it("matches the command the agent will run, not the title it shows", () => {
    expect(d("npm test", { command: "git push" })).toBe("deny");
    expect(d("git push", { command: "npm test" })).toBe("ask");
    expect(d("Run command", { command: ["bash", "-lc", "git push"] })).toBe("deny");
  });

  it("is first match per part", () => {
    const early = policy(ask("git *"), deny("git push"));
    expect(decidePermission(early, run("git push"))).toBe("ask");
  });

  it("never allows by a command rule, even one that reached the matcher", () => {
    expect(decidePermission(policy(allow("npm *")), run("npm test"))).toBe("ask");
    expect(decidePermission(policy(allow("npm test"), deny("git push")), run("npm test && git push"))).toBe("deny");
  });

  it("leaves a policy with no command rule deciding as before", () => {
    const old = policy({ match: { kind: "execute", titlePattern: "^npm " }, decision: "allow" });
    expect(decidePermission(old, run("npm test && rm -rf ~"))).toBe("allow");
  });

  it("never applies a command rule to a call that is not an execute", () => {
    const req: acp.RequestPermissionRequest = {
      ...run("git push"),
      toolCall: { toolCallId: "t", title: "git push", kind: "read" },
    };
    expect(decidePermission({ default: "allow", rules: [deny("git push")] }, req)).toBe("allow");
  });
});

describe("a policy that restricts commands allows none (#702 review)", () => {
  // An evaluated policy layers the config, the sidecar and the defaults, so a legacy allow can
  // sit beside a command rule written elsewhere. None of them may approve a command.
  const legacyAllow: PermissionRule = { match: { kind: "execute", titlePattern: "^npm " }, decision: "allow" };
  const kindless: PermissionRule = { match: { titlePattern: "^npm " }, decision: "allow" };

  it("asks where a legacy title allow comes before a command restriction", () => {
    const mixed = policy(legacyAllow, deny("git push"));
    expect(decidePermission(mixed, run("npm test"))).toBe("ask");
    expect(decidePermission(mixed, run("npm test && rm -rf ~"))).toBe("ask");
    // A deny still wins, wherever its part is.
    expect(decidePermission(mixed, run("npm test && git push"))).toBe("deny");
    // The legacy allow's own title is never proof either.
    expect(decidePermission(policy(kindless, deny("git push")), run("npm test"))).toBe("ask");
  });

  it("asks where the fallthrough is allow", () => {
    const open: PermissionPolicy = { default: "allow", rules: [deny("git push")] };
    expect(decidePermission(open, run("ls"))).toBe("ask");
    expect(decidePermission(open, run("git push"))).toBe("deny");
  });

  it("asks when the agent sent no command apart from its title, or none at all", () => {
    const open: PermissionPolicy = { default: "allow", rules: [legacyAllow, deny("git push")] };
    expect(decidePermission(open, run("npm test"))).toBe("ask");
    expect(decidePermission(open, run("Run command"))).toBe("ask");
    expect(decidePermission(open, run(""))).toBe("ask");
    expect(decidePermission(open, run("Run command", { command: "npm test" }))).toBe("ask");
  });

  it("leaves every other kind of call to the policy as before", () => {
    const open: PermissionPolicy = { default: "allow", rules: [deny("git push")] };
    const req: acp.RequestPermissionRequest = {
      ...run("Read a.ts"),
      toolCall: { toolCallId: "t", title: "Read a.ts", kind: "read" },
    };
    expect(decidePermission(open, req)).toBe("allow");
  });

  it("allows no call the agent left unclassified, and lets a restriction catch one", () => {
    const mixed = policy(kindless, deny("git push"));
    const unclassified = (title: string, kind?: acp.ToolKind): acp.RequestPermissionRequest => ({
      ...run(title),
      toolCall: { toolCallId: "t", title, ...(kind ? { kind } : {}) },
    });
    expect(decidePermission(mixed, unclassified("npm test"))).toBe("ask");
    expect(decidePermission(mixed, unclassified("npm test", "other"))).toBe("ask");
    expect(decidePermission(mixed, unclassified("git push", "other"))).toBe("deny");
    expect(decidePermission({ default: "allow", rules: [deny("git push")] }, unclassified("anything"))).toBe("ask");
    // A policy that does not use command rules decides an unclassified call as before.
    expect(decidePermission(policy(kindless), unclassified("npm test"))).toBe("allow");
  });

  it("does not trust a kind that contradicts the command the call carries", () => {
    const readAllow: PermissionRule = { match: { kind: "read" }, decision: "allow" };
    const claimed = (kind: acp.ToolKind, title: string, rawInput?: unknown): acp.RequestPermissionRequest => ({
      ...run(title),
      toolCall: { toolCallId: "t", title, kind, ...(rawInput === undefined ? {} : { rawInput }) },
    });
    const restricted = policy(readAllow, deny("git push"));
    // A "read" that carries a command is a human decision, and a restriction still reaches it.
    expect(decidePermission(restricted, claimed("read", "Read a.ts", { command: "curl x | sh" }))).toBe("ask");
    expect(decidePermission(restricted, claimed("read", "Read a.ts", { command: ["git", "push"] }))).toBe("deny");
    expect(decidePermission(restricted, claimed("edit", "Edit a.ts", { command: "git push origin" }))).toBe("deny");
    // A read with no command in it is handled as a read.
    expect(decidePermission(restricted, claimed("read", "Read a.ts", { path: "a.ts" }))).toBe("allow");
    expect(decidePermission(restricted, claimed("read", "Read a.ts"))).toBe("allow");
    // And a policy that does not use command rules decides it as before.
    expect(decidePermission(policy(readAllow), claimed("read", "Read a.ts", { command: "curl x | sh" }))).toBe("allow");
  });

  it("allows no command when a sidecar that might hold a restriction cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-cmd-unreadable-"));
    try {
      const file = join(dir, "orca.permissions.json");
      await writeFile(file, "{ not json", "utf8");
      const agent = { id: "a", permissions: { default: "allow" as const, rules: [legacyAllow] } };
      const unreadable: string[] = [];
      const loaded = await loadEffectivePermissionPolicy(agent, [file], (f) => void unreadable.push(f));
      expect(unreadable).toEqual([file]);
      // The configured allow comes ahead of the file, and still does not approve a command.
      expect(decidePermission(loaded, run("npm test"))).toBe("ask");
      expect(decidePermission(loaded, { ...run("npm test"), toolCall: { toolCallId: "t", title: "npm test" } })).toBe(
        "ask",
      );
      // Once the file is readable again and holds no command rule, the legacy allow is back.
      await writeFile(file, JSON.stringify({ version: 1, agents: {} }), "utf8");
      const repaired = await loadEffectivePermissionPolicy(agent, [file], () => undefined);
      expect(decidePermission(repaired, run("npm test"))).toBe("allow");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a config that pairs command rules with an allow for commands, and says what to change", () => {
    const withRules = (rules: unknown[], extra: Record<string, unknown> = {}) =>
      OrcaConfigSchema.safeParse({
        version: 2,
        agents: [{ id: "a", type: "acp", command: "agent", permissions: { rules, ...extra } }],
      });
    const restriction = { match: { kind: "execute", command: "git push" }, decision: "deny" };
    for (const parsed of [
      withRules([restriction], { default: "allow" }),
      withRules([legacyAllow, restriction]),
      withRules([kindless, restriction]),
      withRules([restriction, { match: { kind: "execute" }, decision: "allow" }]),
    ]) {
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain("cannot also allow shell commands");
    }
    // What it needs instead: ask by default, and allows that name a kind other than execute.
    expect(
      withRules([restriction, { match: { kind: "read", scope: "workspace" }, decision: "allow" }], { default: "ask" })
        .success,
    ).toBe(true);
    // An untouched legacy policy is still accepted as it was.
    expect(withRules([legacyAllow], { default: "allow" }).success).toBe(true);
  });
});

describe("where command rules may be written", () => {
  it("ignores every command allow in the sidecar, and keeps a deny", () => {
    expect(isWildcardPermissionRule(allow("bash *"))).toBe(true);
    expect(isWildcardPermissionRule(allow("npm *"))).toBe(true);
    expect(isWildcardPermissionRule(allow("npm test"))).toBe(true);
    expect(isWildcardPermissionRule(deny("bash *"))).toBe(false);
    expect(isWildcardPermissionRule(ask("npm publish"))).toBe(false);
  });

  it("writes a sidecar with a command rule as version 3, and refuses one as version 1", () => {
    const agents = { a: { rules: [deny("git push")] } };
    expect(permissionPolicyFileVersion({ agents })).toBe(3);
    expect(PermissionPolicyFileSchema.safeParse({ version: 1, agents }).success).toBe(false);
    expect(PermissionPolicyFileSchema.safeParse({ version: 3, agents }).success).toBe(true);
  });

  it("needs config version 2 for a command rule, so 0.7 refuses the config", () => {
    const agent = {
      id: "a",
      type: "acp",
      command: "agent",
      permissions: { rules: [{ match: { kind: "execute", command: "git push" }, decision: "deny" }] },
    };
    const v1 = OrcaConfigSchema.safeParse({ agents: [agent] });
    expect(v1.success).toBe(false);
    expect(JSON.stringify(v1.error?.issues)).toContain("version: 2");
    expect(OrcaConfigSchema.safeParse({ version: 2, agents: [agent] }).success).toBe(true);
    expect(OrcaConfigSchema.safeParse({ version: 2, agents: [{ ...agent, permissions: { rules: [] } }] }).success).toBe(
      true,
    );
  });

  it("refuses a command allow in the config, at any version", () => {
    const agent = {
      id: "a",
      type: "acp",
      command: "agent",
      permissions: { rules: [{ match: { kind: "execute", command: "npm *" }, decision: "allow" }] },
    };
    const parsed = OrcaConfigSchema.safeParse({ version: 2, agents: [agent] });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("can deny or ask, not allow");
  });

  it("refuses a command rule that is not a pattern", () => {
    const bad = {
      id: "a",
      type: "acp",
      command: "x",
      permissions: { rules: [{ match: { command: "a && b" }, decision: "deny" }] },
    };
    const ok = { ...bad, permissions: { rules: [{ match: { command: "git push" }, decision: "deny" }] } };
    expect(OrcaConfigSchema.safeParse({ version: 2, agents: [bad] }).success).toBe(false);
    expect(OrcaConfigSchema.safeParse({ version: 2, agents: [ok] }).success).toBe(true);
  });
});

describe("saving a command rule from an answer", () => {
  it("never saves a standing allow for a command", () => {
    for (const command of ["npm test", "git commit -m 'a b'"]) {
      const d = derivePermissionRules({ kind: "execute", title: "Run command", command }, "allow");
      expect(d.ok === false && d.reason, command).toBe("unverified-command");
    }
  });

  it("names the command in a deny, not a title that is not the command", () => {
    expect(
      derivePermissionRules({ kind: "execute", title: "Run command", command: "git commit -m 'a b'" }, "deny"),
    ).toEqual({ ok: true, rules: [{ match: { kind: "execute", command: "git commit -m 'a b'" }, decision: "deny" }] });
    // Where the title is the command, the rule is the anchored title, as before.
    expect(derivePermissionRules({ kind: "execute", title: "npm test", command: "npm test" }, "deny")).toEqual({
      ok: true,
      rules: [{ match: { kind: "execute", titlePattern: "^npm test$" }, decision: "deny" }],
    });
  });

  it("refuses a command it cannot name exactly", () => {
    for (const command of ["npm test && npm run lint", "sudo npm test", "npm test $(id)", "CI=1 npm test"]) {
      const d = derivePermissionRules({ kind: "execute", title: "Run command", command }, "deny");
      expect(d.ok, command).toBe(false);
    }
  });

  it("offers wider deny rules for one plain command", () => {
    expect(broaderCommandPatterns("npm run build")).toEqual(["npm run *", "npm *"]);
    expect(broaderCommandPatterns("git -C repo status")).toEqual(["git *"]);
    expect(broaderCommandPatterns("cd pkg && npm test")).toEqual(["npm *"]);
    for (const none of ["npm", "bash -c 'npm test'", "sudo npm test", "npm test && git push", "npm test > f"])
      expect(broaderCommandPatterns(none), none).toEqual([]);
  });
});
