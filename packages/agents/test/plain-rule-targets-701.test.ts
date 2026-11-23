/**
 * #701 trusted target check for plain-language rules: only reads and searches whose real targets are inside the
 * workspace and outside protected paths are verified. Real temporary directories and symlinks; no network.
 */
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlainRuleJudge, type PlainRuleJudgeInput } from "../src/review-judge/plain-rule.js";
import { verifyPlainRuleTargets, type PlainRuleTargetIo } from "../src/review-judge/plain-rule-targets.js";
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
  it("verifies reads and searches of files inside the workspace, returning real workspace-relative paths", () => {
    expect(check()).toEqual({ targetsVerified: true, locations: ["src/a.ts"] });
    expect(check({ kind: "search", locations: ["src/a.ts", "README.md"] })).toEqual({
      targetsVerified: true,
      locations: ["src/a.ts", "README.md"],
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

  it("refuses directories, the workspace included: a verified root does not verify what a recursive search reaches", () => {
    expect(check({ locations: ["src"] })).toMatchObject({ reason: "not-a-file" });
    expect(check({ kind: "search", locations: ["src"] })).toMatchObject({ reason: "not-a-file" });
    expect(check({ kind: "search", locations: ["."] })).toMatchObject({ reason: "not-a-file" });
    expect(check({ kind: "search", locations: [ws] })).toMatchObject({ reason: "not-a-file" });
    // A directory that holds a protected path, or a link out, is refused before anyone would have to walk it.
    symlinkSync(outside, join(ws, "src", "out"), "junction");
    expect(check({ kind: "search", locations: ["src"] })).toMatchObject({ reason: "not-a-file" });
    expect(check({ kind: "search", locations: ["src/a.ts", "src"] })).toMatchObject({ reason: "not-a-file" });
  });

  it("refuses a file with another hard link, whose other name no path check can see", () => {
    linkSync(join(outside, "passwd"), join(ws, "src", "hard.ts"));
    expect(check({ locations: ["src/hard.ts"] })).toMatchObject({ reason: "linked-file" });
    linkSync(join(ws, "secrets", "key.pem"), join(ws, "src", "key.ts"));
    expect(check({ locations: ["src/key.ts"] })).toMatchObject({ reason: "linked-file" });
    linkSync(join(ws, "README.md"), join(ws, "src", "readme-copy.md"));
    expect(check({ locations: ["README.md"] })).toMatchObject({ reason: "linked-file" });
  });

  it("refuses protected paths, directly or through a link, and one bad location refuses the call", () => {
    expect(check({ locations: ["secrets/key.pem"] })).toMatchObject({ reason: "protected" });
    symlinkSync(join(ws, "secrets"), join(ws, "src", "s"), "junction");
    expect(check({ locations: ["src/s/key.pem"] })).toMatchObject({ reason: "protected" });
    expect(check({ kind: "search", locations: ["src/a.ts", "secrets"] })).toMatchObject({ reason: "protected" });
    expect(check({ kind: "search", locations: ["src/a.ts", "secrets/key.pem"] })).toMatchObject({
      reason: "protected",
    });
    expect(check({ protectedPaths: { readOnly: [], noAccess: ["secrets"] } })).toMatchObject({
      reason: "no-protected-paths",
    });
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

  /**
   * A file system that ignores case, which this host may not have: paths resolve and identify case-insensitively,
   * and the real path is spelled as `spell` says. Built over the real temporary tree.
   */
  function caseInsensitiveIo(spell: (real: string) => string): PlainRuleTargetIo {
    const files = new Map<string, { dir: boolean; ino: bigint }>();
    let next = 1n;
    const add = (path: string, dir: boolean) => files.set(path.toLowerCase(), { dir, ino: next++ });
    for (const dir of ["/", "/case", "/case/ws", "/case/ws/src", "/case/ws/secrets", "/case/out"]) add(dir, true);
    for (const file of ["/case/ws/src/a.ts", "/case/ws/secrets/key.pem", "/case/out/x"]) add(file, false);
    const find = (path: string) => {
      const hit = files.get(path.replace(/\/+$/, "").toLowerCase() || "/");
      if (!hit) throw new Error("ENOENT");
      return hit;
    };
    return {
      realpath: (path) => (find(path), spell(path)),
      stat: (path) => {
        const hit = find(path);
        return { isFile: () => !hit.dir, isDirectory: () => hit.dir, dev: 1n, ino: hit.ino, nlink: 1n };
      },
    };
  }

  const onPosix = it.skipIf(process.platform === "win32");

  onPosix(
    "does not fold case for containment: a real path differing from the workspace only by case is refused",
    () => {
      const asTyped = caseInsensitiveIo((path) => path);
      const at = (over: Partial<Parameters<typeof verifyPlainRuleTargets>[0]>) =>
        verifyPlainRuleTargets({
          kind: "read",
          locations: ["src/a.ts"],
          workspaceCwd: "/case/ws",
          protectedPaths: { readOnly: [], noAccess: [] },
          io: asTyped,
          ...over,
        });
      expect(at({})).toEqual({ targetsVerified: true, locations: ["src/a.ts"] });
      // Same file by identity, spelled differently: the text no longer proves containment, so it is refused.
      expect(at({ locations: ["/CASE/WS/src/a.ts"] })).toMatchObject({ reason: "outside-workspace" });
      expect(at({ locations: ["/case/out/x"] })).toMatchObject({ reason: "outside-workspace" });
      // Text that looks contained but whose ancestors are no longer the workspace by identity (the workspace directory
      // was swapped while the target was resolved) is refused too.
      let swapped = false;
      const lying: PlainRuleTargetIo = {
        realpath: (path) => {
          if (path.endsWith("a.ts")) swapped = true;
          return asTyped.realpath(path);
        },
        stat: (path) => {
          const s = asTyped.stat(path);
          return swapped && path === "/case/ws" ? { ...s, ino: 999n } : s;
        },
      };
      expect(at({ io: lying })).toMatchObject({ reason: "outside-workspace" });
    },
  );

  onPosix("over-matches protection: a no-access path matches by identity and ignoring case", () => {
    const io = caseInsensitiveIo((path) => path);
    const at = (location: string, noAccess: string[]) =>
      verifyPlainRuleTargets({
        kind: "read",
        locations: [location],
        workspaceCwd: "/case/ws",
        protectedPaths: { readOnly: [], noAccess },
        io,
      });
    // The guard is spelled in another case than the target; the shared protected-path check alone would miss it here.
    expect(at("secrets/key.pem", ["/case/ws/SECRETS"])).toMatchObject({ reason: "protected" });
    expect(at("SECRETS/key.pem", ["/case/ws/secrets"])).toMatchObject({ reason: "protected" });
    expect(at("secrets/key.pem", ["/case/ws/Secrets/KEY.pem"])).toMatchObject({ reason: "protected" });
    // A guard that does not exist still over-matches by case-folded text.
    expect(at("src/a.ts", ["/CASE/WS/SRC"])).toMatchObject({ reason: "protected" });
    expect(at("src/a.ts", ["/case/ws/secrets"])).toEqual({ targetsVerified: true, locations: ["src/a.ts"] });
  });
});
