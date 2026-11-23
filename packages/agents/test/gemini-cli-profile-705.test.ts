/**
 * The Gemini CLI module (#705 tiers A and B): recognising a Gemini agent from its command line,
 * the settings that let calls run without asking ORCA, the launch profile with none of them,
 * and what each of Gemini 0.70.0's permission options does.
 */
import { describe, expect, it } from "vitest";
import {
  GEMINI_CLI_SUPPORT,
  agentProfileFindings,
  geminiCliFindings,
  geminiCliLaunch,
  geminiCliSupport,
  geminiOptionEffect,
  isGeminiCliAgent,
} from "../src/index.js";

const isolated = { GEMINI_CLI_HOME: "/srv/orca/gemini-home" };
const ids = (args: string[], env: Record<string, unknown> = isolated, command = "gemini") =>
  geminiCliFindings({ command, args, env }).map((f) => f.id);

describe("Gemini CLI agents (#705)", () => {
  it("recognises gemini in ACP mode, however it is started, and nothing else", () => {
    expect(isGeminiCliAgent({ command: "gemini", args: ["--acp"] })).toBe(true);
    expect(isGeminiCliAgent({ command: "/usr/local/bin/gemini", args: ["--experimental-acp"] })).toBe(true);
    expect(isGeminiCliAgent({ command: "C:\\tools\\gemini.cmd", args: ["--acp"] })).toBe(true);
    expect(
      isGeminiCliAgent({
        command: "node",
        args: ["/opt/x/node_modules/@google/gemini-cli/bundle/gemini.js", "--acp"],
      }),
    ).toBe(true);
    expect(isGeminiCliAgent({ command: "npx", args: ["gemini", "--acp"] })).toBe(true);
    // Not in ACP mode, or not Gemini.
    expect(isGeminiCliAgent({ command: "gemini", args: [] })).toBe(false);
    expect(isGeminiCliAgent({ command: "codex-acp", args: ["--acp"] })).toBe(false);
    expect(isGeminiCliAgent({ command: "node", args: ["--acp", "geminiish.js"] })).toBe(false);
  });

  it("finds nothing in the launch profile, and nothing for another agent", () => {
    const launch = geminiCliLaunch({ home: "/srv/orca/gemini-home" });
    expect(launch).toEqual({ command: "gemini", args: ["--acp"], env: { GEMINI_CLI_HOME: "/srv/orca/gemini-home" } });
    expect(geminiCliFindings(launch)).toEqual([]);
    expect(geminiCliFindings({ command: "codex-acp", args: ["--yolo"], env: {} })).toEqual([]);
    expect(agentProfileFindings({ command: "codex-acp", args: ["--yolo"], env: {} })).toEqual([]);
  });

  it("names each flag that lets calls run without asking", () => {
    expect(ids(["--acp", "--yolo"])).toEqual(["yolo"]);
    expect(ids(["--acp", "-y"])).toEqual(["yolo"]);
    expect(ids(["--acp", "--approval-mode", "yolo"])).toEqual(["yolo"]);
    expect(ids(["--acp", "--approval-mode=auto_edit"])).toEqual(["auto-edit"]);
    expect(ids(["--acp", "--approval-mode", "default"])).toEqual([]);
    expect(ids(["--acp", "--approval-mode", "plan"])).toEqual([]);
    expect(ids(["--acp", "--allowed-tools", "run_shell_command"])).toEqual(["allowed-tools"]);
    expect(ids(["--acp", "--policy=/etc/p.toml"])).toEqual(["policy-files"]);
    expect(ids(["--acp", "--admin-policy", "/etc/p.toml"])).toEqual(["policy-files"]);
    // With its own home and no trust flag, the workspace is untrusted and Gemini keeps its
    // default mode; anything that can trust it makes the flag a bypass.
    expect(geminiCliFindings({ command: "gemini", args: ["--acp", "--yolo"], env: isolated })[0]).toMatchObject({
      effect: "outside",
      message: expect.stringContaining("inert"),
    });
    expect(
      geminiCliFindings({ command: "gemini", args: ["--acp", "--yolo", "--skip-trust"], env: isolated })[0],
    ).toMatchObject({
      effect: "bypass",
    });
    expect(geminiCliFindings({ command: "gemini", args: ["--acp", "--yolo"], env: {} })[0]).toMatchObject({
      effect: "bypass",
    });
  });

  it("names the settings ORCA does not control", () => {
    expect(ids(["--acp"], {})).toEqual(["user-home"]);
    expect(ids(["--acp"], { GEMINI_CLI_HOME: "" })).toEqual(["user-home"]);
    // A secret reference still sets it.
    expect(ids(["--acp"], { GEMINI_CLI_HOME: { secret: "home" } })).toEqual([]);
    expect(ids(["--acp", "--skip-trust"])).toEqual(["trusted-workspace"]);
    expect(ids(["--acp"], { ...isolated, GEMINI_CLI_TRUST_WORKSPACE: "true" })).toEqual(["trusted-workspace"]);
    expect(
      ids(["--acp"], {
        ...isolated,
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/x",
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: "/y",
        GEMINI_CLI_TRUSTED_FOLDERS_PATH: "/z",
      }),
    ).toEqual([
      "gemini-cli-system-settings-path",
      "gemini-cli-system-defaults-path",
      "gemini-cli-trusted-folders-path",
    ]);
    expect(geminiCliFindings({ command: "gemini", args: ["--acp"], env: {} })[0]).toMatchObject({ effect: "outside" });
  });

  it("says what each Gemini 0.70.0 option does, and nothing for an id it does not define", () => {
    expect(geminiOptionEffect("proceed_once")).toBe("once");
    expect(geminiOptionEffect("proceed_always")).toBe("session");
    expect(geminiOptionEffect("proceed_always_tool")).toBe("session");
    expect(geminiOptionEffect("proceed_always_server")).toBe("session");
    expect(geminiOptionEffect("proceed_always_and_save")).toBe("saved");
    expect(geminiOptionEffect("cancel")).toBe("reject");
    expect(geminiOptionEffect("modify_with_editor")).toBe("unknown");
    expect(geminiOptionEffect("toString")).toBe("unknown");
  });

  it("reports the qualified version only for Gemini CLI on a covered platform", () => {
    const v = GEMINI_CLI_SUPPORT[0]!.version;
    expect(geminiCliSupport({ name: "gemini-cli", version: v }, "linux")).toMatchObject({ level: "approval-tested" });
    expect(geminiCliSupport({ name: "gemini-cli", version: v }, "win32")).toBeUndefined();
    expect(geminiCliSupport({ name: "gemini-cli", version: "0.69.0" }, "linux")).toBeUndefined();
    expect(geminiCliSupport({ name: "codex-acp", version: v }, "linux")).toBeUndefined();
    expect(geminiCliSupport(undefined, "linux")).toBeUndefined();
    // Nothing is claimed above tier B.
    expect(GEMINI_CLI_SUPPORT.every((e) => e.level !== "execution-guard-certified")).toBe(true);
  });
});
