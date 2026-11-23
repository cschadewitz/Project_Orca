/**
 * The pi module (#705 tiers A and B): recognising a `pi-acp` agent, the findings every pi
 * agent carries (pi never asks), the launch profile, and the qualified adapter version.
 */
import { describe, expect, it } from "vitest";
import {
  PI_ACP_SUPPORT,
  agentProfileFindings,
  isPiAcpAgent,
  piAcpLaunch,
  piAcpSupport,
  piFindings,
} from "../src/index.js";

describe("pi agents (#705)", () => {
  it("recognises pi-acp however it is started, and nothing else", () => {
    expect(isPiAcpAgent({ command: "pi-acp", args: [] })).toBe(true);
    expect(isPiAcpAgent({ command: "/usr/local/bin/pi-acp", args: [] })).toBe(true);
    expect(isPiAcpAgent({ command: "C:\\tools\\pi-acp.cmd", args: [] })).toBe(true);
    expect(isPiAcpAgent({ command: "node", args: ["/opt/x/node_modules/pi-acp/dist/index.js"] })).toBe(true);
    expect(isPiAcpAgent({ command: "npx", args: ["pi-acp"] })).toBe(true);
    expect(isPiAcpAgent({ command: "pi", args: ["--mode", "rpc"] })).toBe(false);
    expect(isPiAcpAgent({ command: "gemini", args: ["--acp"] })).toBe(false);
  });

  it("says pi never asks for every pi agent, launch profile included", () => {
    const launch = piAcpLaunch({ agentDir: "/srv/orca/pi-agent", pi: "/opt/pi/bin/pi" });
    expect(launch).toEqual({
      command: "pi-acp",
      args: [],
      env: { PI_CODING_AGENT_DIR: "/srv/orca/pi-agent", PI_ACP_PI_COMMAND: "/opt/pi/bin/pi" },
    });
    expect(piFindings(launch)).toEqual([expect.objectContaining({ id: "pi-never-asks", effect: "bypass" })]);
    expect(piFindings({ command: "pi-acp", args: [], env: {} }).map((f) => f.id)).toEqual([
      "pi-never-asks",
      "pi-user-agent-dir",
    ]);
    expect(agentProfileFindings({ command: "pi-acp", args: [], env: {} })).toHaveLength(2);
    expect(piFindings({ command: "gemini", args: ["--acp"], env: {} })).toEqual([]);
  });

  it("reports the qualified adapter version only for pi-acp on a covered platform", () => {
    const v = PI_ACP_SUPPORT[0]!.version;
    expect(piAcpSupport({ name: "pi-acp", version: v }, "linux")).toMatchObject({ pi: "1.6.0" });
    expect(piAcpSupport({ name: "pi-acp", version: v }, "darwin")).toBeUndefined();
    expect(piAcpSupport({ name: "pi-acp", version: "0.0.34" }, "linux")).toBeUndefined();
    expect(piAcpSupport({ name: "gemini-cli", version: v }, "linux")).toBeUndefined();
    expect(PI_ACP_SUPPORT.every((e) => e.level !== "execution-guard-certified")).toBe(true);
  });
});
