/**
 * #701 trusted target check for plain-language rules: only reads and searches whose real targets are inside the
 * workspace and outside protected paths are verified. Real temporary directories and symlinks; no network.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlainRuleJudge, type PlainRuleJudgeInput } from "../src/review-judge/plain-rule.js";
import { verifyPlainRuleTargets } from "../src/review-judge/plain-rule-targets.js";
import type { ProtectedPaths } from "../src/permissions.js";

let base: string;
let ws: string;
let outside: string;
let protectedPaths: ProtectedPaths;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "orca-701-targets-"));
  ws = join(base, "ws");
  outside = join(base, "outside");
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, ".orca"), { recursive: true });
  mkdirSync(join(ws, "secrets"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(ws, "src", "a.ts"), "a");
  writeFileSync(join(ws, "README.md"), "r");
  writeFileSync(join(ws, ".orca", "orca.permissions.json"), "{}");
  writeFileSync(join(ws, "secrets", "key.pem"), "k");
  writeFileSync(join(outside, "passwd"), "p");
  protectedPaths = { readOnly: [join(ws, ".orca")], noAccess: [join(ws, "secrets")] };
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const fileLinks = it.skipIf(process.platform === "win32");

const check = (over: Partial<Parameters<typeof verifyPlainRuleTargets>[0]> = {}) =>
  verifyPlainRuleTargets({ kind: "read", locations: ["src/a.ts"], workspaceCwd: ws, protectedPaths, ...over });

describe("#701 plain-rule target check", () => {
  it("verifies reads and searches inside the workspace, returning real workspace-relative paths", () => {
    expect(check()).toEqual({ targetsVerified: true, locations: ["src/a.ts"] });
    expect(check({ kind: "search", locations: ["src", "README.md"] })).toEqual({
      targetsVerified: true,
      locations: ["src", "README.md"],
    });
    expect(check({ locations: [join(ws, "src", "a.ts")] })).toEqual({ targetsVerified: true, locations: ["src/a.ts"] });
    // A directory link inside the workspace to a directory inside it is reported as its real target.
    symlinkSync(join(ws, "src"), join(ws, "srclink"), "junction");
    expect(check({ locations: ["srclink/a.ts"] })).toEqual({ targetsVerified: true, locations: ["src/a.ts"] });
  });

  // File symlinks need a privilege on Windows; directory links use junctions, which do not.
  fileLinks("reports a file link inside the workspace as its real target", () => {
    symlinkSync(join(ws, "src", "a.ts"), join(ws, "alias.ts"));
    expect(check({ locations: ["alias.ts"] })).toEqual({ targetsVerified: true, locations: ["src/a.ts"] });
  });

  it.each(["execute", "edit", "delete", "move", "fetch", "other", undefined])("refuses kind %s", (kind) => {
    expect(check({ kind })).toEqual({ targetsVerified: false, reason: "kind" });
  });

  it("refuses missing facts", () => {
    expect(check({ locations: [] })).toMatchObject({ reason: "no-location" });
    expect(check({ locations: undefined })).toMatchObject({ reason: "no-location" });
    expect(check({ locations: Array.from({ length: 33 }, () => "src/a.ts") })).toMatchObject({
      reason: "too-many-locations",
    });
    expect(check({ workspaceCwd: undefined })).toMatchObject({ reason: "no-workspace" });
    expect(check({ workspaceCwd: "ws" })).toMatchObject({ reason: "no-workspace" });
    expect(check({ workspaceCwd: join(base, "nope") })).toMatchObject({ reason: "no-workspace" });
    expect(check({ protectedPaths: undefined })).toMatchObject({ reason: "no-protected-paths" });
    expect(check({ locations: ["src/missing.ts"] })).toMatchObject({ reason: "missing" });
    expect(check({ locations: ["src/a.ts\0x"] })).toMatchObject({ reason: "missing" });
  });

  fileLinks("refuses a file link that leads outside the workspace", () => {
    symlinkSync(join(outside, "passwd"), join(ws, "src", "innocent.ts"));
    expect(check({ locations: ["src/innocent.ts"] })).toMatchObject({ reason: "outside-workspace" });
  });

  it("refuses anything whose real path leaves the workspace", () => {
    expect(check({ locations: [join(outside, "passwd")] })).toMatchObject({ reason: "outside-workspace" });
    expect(check({ locations: ["../outside/passwd"] })).toMatchObject({ reason: "outside-workspace" });
    // A linked directory, then `..` taken from where the link leads.
    symlinkSync(outside, join(ws, "linkdir"), "junction");
    expect(check({ locations: ["linkdir/passwd"] })).toMatchObject({ reason: "outside-workspace" });
    mkdirSync(join(outside, "deep"));
    symlinkSync(join(outside, "deep"), join(ws, "deeplink"), "junction");
    expect(check({ locations: ["deeplink/../passwd"] })).toMatchObject({ reason: "outside-workspace" });
    // A prefix that only looks like the workspace.
    mkdirSync(join(base, "ws-evil"));
    writeFileSync(join(base, "ws-evil", "x"), "x");
    expect(check({ locations: [join(base, "ws-evil", "x")] })).toMatchObject({ reason: "outside-workspace" });
  });

  it("refuses protected paths, directly or through a link, and one bad location refuses the call", () => {
    expect(check({ locations: ["secrets/key.pem"] })).toMatchObject({ reason: "protected" });
    symlinkSync(join(ws, "secrets"), join(ws, "src", "s"), "junction");
    expect(check({ locations: ["src/s/key.pem"] })).toMatchObject({ reason: "protected" });
    expect(check({ kind: "search", locations: ["src/a.ts", "secrets"] })).toMatchObject({ reason: "protected" });
    // Read-only ORCA files may be read, so they are not refused here; the rest of the policy still decides.
    expect(check({ locations: [".orca/orca.permissions.json"] })).toMatchObject({ targetsVerified: true });
  });

  it("feeds the judge: an unverified target never reaches the transport", async () => {
    const sent: string[] = [];
    const judge = createPlainRuleJudge({
      transport: {
        version: "fake/v1",
        send: async (frame) => {
          sent.push(frame);
          throw new Error("not reached in the refused case");
        },
      },
    });
    const ask = (locations: string[]): PlainRuleJudgeInput => {
      const t = check({ locations });
      return {
        rules: [{ ruleId: "pr", ruleRevision: "r1", criterion: "Reading anything." }],
        restrictions: { deny: false, ask: false },
        action: {
          kind: "read",
          title: "Read",
          locations: t.targetsVerified ? [...t.locations] : locations,
          inWorkspace: true,
          targetsVerified: t.targetsVerified,
        },
      };
    };
    symlinkSync(outside, join(ws, "src", "p"), "junction");
    expect(await judge(ask(["src/p/passwd"]), new AbortController().signal)).toMatchObject({
      outcome: "no-match",
      verdict: "outside-envelope",
    });
    expect(sent).toHaveLength(0);
    await judge(ask(["src/a.ts"]), new AbortController().signal);
    expect(sent).toHaveLength(1);
  });
});
