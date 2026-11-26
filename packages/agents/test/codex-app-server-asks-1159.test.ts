/**
 * Codex app-server asks as ORCA permission requests (#1159): what each ask maps to, which asks
 * ORCA declines without asking anybody, and that no answer is ever one Codex would remember.
 */
import { describe, expect, it } from "vitest";
import { codexAskRequest, codexAskResponse, CODEX_POLICY_ASKS, type CodexAskOutcome } from "../src/index.js";

const TARGET = { threadId: "thr", turnId: "t1", itemId: "i1" };
const COMMAND = { kind: "command", ...TARGET, startedAtMs: 1, environmentId: null, command: "ls", cwd: "/w" };

describe("Codex asks as permission requests", () => {
  it("maps a command with its reason, directory, parsed actions and network context", () => {
    const m = codexAskRequest("thr", "item/commandExecution/requestApproval", {
      ...COMMAND,
      reason: "look around",
      commandActions: [
        { type: "listFiles", command: "ls", path: "/w" },
        { type: "search", command: "rg x", query: "x", path: null },
        { type: "unknown", command: "make" },
      ],
      networkApprovalContext: { host: "example.com", protocol: "https" },
      approvalId: "a1",
    });
    expect(m).toEqual({
      target: TARGET,
      request: {
        sessionId: "thr",
        options: [
          { optionId: "accept", name: "Allow once", kind: "allow_once" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
        toolCall: {
          toolCallId: "a1",
          title: "ls",
          kind: "execute",
          status: "pending",
          rawInput: { command: "ls", cwd: "/w" },
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text:
                  "look around\nin /w\nCodex reads it as: list files in /w; search for x; run make\n" +
                  "with network access to example.com (https)",
              },
            },
          ],
        },
      },
    });
  });

  it("maps a network-only ask, a terminal write, a file change and a permissions ask", () => {
    const net = codexAskRequest("thr", "item/commandExecution/requestApproval", {
      ...COMMAND,
      command: null,
      networkApprovalContext: { host: "example.com", protocol: "https" },
    });
    expect(net).toMatchObject({
      request: { toolCall: { kind: "fetch", title: "Network access to example.com (https)" } },
    });
    const stdin = codexAskRequest("thr", "item/commandExecution/requestApproval", { ...COMMAND, kind: "writeStdin" });
    expect(stdin).toMatchObject({
      request: { toolCall: { kind: "execute", rawInput: { command: "ls", stdin: true } } },
    });
    const file = codexAskRequest("thr", "item/fileChange/requestApproval", { ...TARGET, startedAtMs: 1 }, [
      { path: "/w/a", kind: { type: "update", move_path: "/w/b" }, diff: "" },
      { path: "/w/c", kind: { type: "delete" }, diff: "" },
    ]);
    expect(file).toMatchObject({
      request: {
        toolCall: {
          kind: "move",
          title: "Change 2 files",
          locations: [{ path: "/w/a" }, { path: "/w/b" }, { path: "/w/c" }],
        },
      },
    });
    const perms = codexAskRequest("thr", "item/permissions/requestApproval", {
      ...TARGET,
      startedAtMs: 1,
      environmentId: null,
      cwd: "/w",
      reason: null,
      permissions: { network: null, fileSystem: { read: ["/r"], write: null } },
    });
    expect(perms).toMatchObject({
      request: {
        toolCall: {
          kind: "other",
          title: "Codex asks for read access to /r for this turn",
          locations: [{ path: "/r" }],
        },
      },
    });
  });

  it("declines without asking what it cannot show or would be a standing grant", () => {
    const refused = (method: (typeof CODEX_POLICY_ASKS)[number], params: unknown, changes?: never[]) => {
      const m = codexAskRequest("thr", method, params, changes);
      return "refused" in m ? m.refused : undefined;
    };
    expect(refused("item/commandExecution/requestApproval", null)).toMatch(/not an object/);
    expect(refused("item/commandExecution/requestApproval", { command: "ls" })).toMatch(/thread, turn and item/);
    expect(refused("item/commandExecution/requestApproval", { ...COMMAND, kind: "other" })).toMatch(/kind/);
    expect(refused("item/commandExecution/requestApproval", { ...COMMAND, command: 1 })).toMatch(/command/);
    expect(
      refused("item/commandExecution/requestApproval", { ...COMMAND, commandActions: [{ type: "read" }] }),
    ).toMatch(/parsed command actions/);
    expect(
      refused("item/commandExecution/requestApproval", { ...COMMAND, networkApprovalContext: { host: 1 } }),
    ).toMatch(/network context/);
    expect(refused("item/fileChange/requestApproval", { ...TARGET })).toMatch(/no change ORCA was shown/);
    expect(refused("item/fileChange/requestApproval", { ...TARGET, grantRoot: "/w" })).toMatch(/write root/);
    const PERMS = { ...TARGET, cwd: "/w", reason: null };
    expect(refused("item/permissions/requestApproval", { ...PERMS, permissions: null })).toMatch(
      /without the permissions/,
    );
    expect(
      refused("item/permissions/requestApproval", { ...PERMS, permissions: { network: null, fileSystem: null } }),
    ).toMatch(/for nothing/);
    expect(
      refused("item/permissions/requestApproval", {
        ...PERMS,
        permissions: { network: null, fileSystem: { read: null, write: null, entries: [{}] } },
      }),
    ).toMatch(/entries/);
    expect(
      refused("item/permissions/requestApproval", {
        ...PERMS,
        permissions: { network: null, fileSystem: { read: [1], write: null } },
      }),
    ).toMatch(/not strings/);
  });

  it("answers only one-time decisions, and grants a permissions ask for this turn only", () => {
    const outcomes: CodexAskOutcome[] = ["accept", "decline", "cancel"];
    for (const method of CODEX_POLICY_ASKS)
      for (const outcome of outcomes) {
        const answer = codexAskResponse(method, outcome, {
          permissions: { network: { enabled: true }, fileSystem: { read: ["/r"], write: null, entries: [] } },
        });
        expect(JSON.stringify(answer)).not.toMatch(/ForSession|Amendment|"session"|strictAutoReview/);
        if (method === "item/permissions/requestApproval")
          expect(answer).toEqual(
            outcome === "accept"
              ? { permissions: { network: { enabled: true }, fileSystem: { read: ["/r"], write: [] } }, scope: "turn" }
              : { permissions: {}, scope: "turn" },
          );
        else expect(answer).toEqual({ decision: outcome });
      }
  });
});
