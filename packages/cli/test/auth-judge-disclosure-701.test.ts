/** `orca auth issue --judge-disclosure` writes the owner's plain-rule judge disclosure grant (#701). */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plainRuleDisclosureQuery } from "@orca/agents/review-judge";
import { openAuthDirectory } from "@orca/daemon";
import { authCommand } from "../src/commands/auth.js";
import type { CommandContext } from "../src/commands/index.js";

let dir: string;
const judge = {
  provider: { kind: "anthropic" },
  destination: "https://judge.invalid/v1/messages",
  credential: "judge-key",
};
async function writeConfig(withJudge: boolean) {
  await writeFile(
    join(dir, "orca.config.yaml"),
    [
      "version: 1",
      "workflows: []",
      "templates: []",
      "secrets:",
      `  judge-key: { host: local, provider: env, name: JUDGE_KEY, destination: '${judge.destination}' }`,
      ...(withJudge
        ? [
            "review:",
            "  plainRules:",
            "    judge:",
            "      provider: { kind: anthropic }",
            `      destination: '${judge.destination}'`,
            "      credential: judge-key",
          ]
        : []),
      "",
    ].join("\n"),
    "utf8",
  );
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-auth-disclosure-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const issue = (principal: string, flags: CommandContext["flags"]) =>
  authCommand({
    cwd: dir,
    flags: { json: true, ...flags },
    positionals: ["issue", principal],
    out: () => {},
    err: () => {},
  });
const stored = (principal: string) =>
  openAuthDirectory(join(dir, "auth"))
    .credentials.list()
    .find((c) => c.principal === principal);

describe("auth issue --judge-disclosure", () => {
  it("grants exactly the disclosure the configured judge asks for", async () => {
    await writeConfig(true);
    expect(await issue("casey", { preset: "owner", "judge-disclosure": true })).toBe(0);
    expect(stored("casey")!.disclosures).toEqual([plainRuleDisclosureQuery(judge)]);
  });

  it("is never granted without the flag, including by the owner preset", async () => {
    await writeConfig(true);
    expect(await issue("casey", { preset: "owner" })).toBe(0);
    expect(stored("casey")!.disclosures).toBeUndefined();
  });

  it("refuses without a complete judge config, and issues nothing", async () => {
    await writeConfig(false);
    await expect(issue("casey", { preset: "owner", "judge-disclosure": true })).rejects.toThrow(
      /review\.plainRules\.judge/,
    );
    expect(stored("casey")).toBeUndefined();
  });

  it("adds each experimental kind named, as its own entry, and only with --judge-disclosure", async () => {
    await writeConfig(true);
    expect(
      await issue("casey", {
        preset: "owner",
        "judge-disclosure": true,
        "judge-disclosure-kind": ["edits", "mcp-calls", "edits"],
      }),
    ).toBe(0);
    expect(stored("casey")!.disclosures).toEqual([
      plainRuleDisclosureQuery(judge),
      plainRuleDisclosureQuery(judge, "edit"),
      plainRuleDisclosureQuery(judge, "mcp"),
    ]);
    await expect(issue("cal", { preset: "owner", "judge-disclosure-kind": ["edits"] })).rejects.toThrow(
      /needs --judge-disclosure/,
    );
    await expect(
      issue("cal", { preset: "owner", "judge-disclosure": true, "judge-disclosure-kind": ["everything"] }),
    ).rejects.toThrow(/edits, mcp-calls, commands/);
    expect(stored("cal")).toBeUndefined();
  });
});
