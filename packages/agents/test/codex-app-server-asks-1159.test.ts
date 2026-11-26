/**
 * Codex app-server asks as ORCA permission requests (#1159): what each ask maps to, which asks
 * ORCA declines without asking anybody, and that no answer is ever one Codex would remember.
 */
import { describe, expect, it } from "vitest";
import { codexAskRequest, codexAskResponse, CODEX_POLICY_ASKS, type CodexAskOutcome } from "../src/index.js";

const TARGET = { threadId: "thr", turnId: "t1", itemId: "i1" };
const COMMAND = { kind: "command", ...TARGET, startedAtMs: 1, environmentId: null, command: "ls", cwd: "/w" };

describe("Codex asks as permission requests", () => {
  it("maps a command with its reason, directory and parsed actions, shown to a person", () => {
    const m = codexAskRequest("thr", "item/commandExecution/requestApproval", {
      ...COMMAND,
      reason: "look around",
      commandActions: [
        { type: "listFiles", command: "ls", path: "/w" },
        { type: "search", command: "rg x", query: "x", path: null },
        { type: "unknown", command: "make" },
      ],
      approvalId: "a1",
    });
    const effect = {
      sessionId: "thr",
      options: [
        { optionId: "accept", name: "Allow once", kind: "allow_once" },
        { optionId: "decline", name: "Decline", kind: "reject_once" },
      ],
      toolCall: {
        status: "pending",
        toolCallId: "a1",
        title: "ls",
        kind: "execute",
        rawInput: { command: "ls", cwd: "/w" },
      },
    };
    expect(m).toEqual({
      target: TARGET,
      effects: [effect],
      review: {
        ...effect,
        toolCall: {
          ...effect.toolCall,
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "look around\nin /w\nCodex reads it as: list files in /w; search for x; run make",
              },
            },
          ],
        },
      },
    });
  });

  it("decides a command's network access as an effect of its own", () => {
    const both = codexAskRequest("thr", "item/commandExecution/requestApproval", {
      ...COMMAND,
      networkApprovalContext: { host: "example.com", protocol: "https" },
    });
    expect(both).toMatchObject({
      effects: [
        { toolCall: { kind: "execute", rawInput: { command: "ls" } } },
        {
          toolCall: {
            kind: "fetch",
            title: "Network access to example.com (https)",
            rawInput: { url: "https://example.com" },
          },
        },
      ],
      review: { toolCall: { kind: "other", title: "ls, with network access to example.com" } },
    });
    const net = codexAskRequest("thr", "item/commandExecution/requestApproval", {
      ...COMMAND,
      command: null,
      networkApprovalContext: { host: "example.com", protocol: "https" },
    });
    expect(net).toMatchObject({ effects: [{ toolCall: { kind: "fetch" } }] });
  });

  it("decides each change of a patch by its own effect, both sides of a move included", () => {
    const file = codexAskRequest(
      "thr",
      "item/fileChange/requestApproval",
      { ...TARGET, startedAtMs: 1 },
      {
        changes: [
          { path: "/w/a", kind: { type: "update", move_path: "/w/b" }, diff: "" },
          { path: "/w/c", kind: { type: "delete" }, diff: "" },
          { path: "/w/d", kind: { type: "add" }, diff: "" },
          { path: "/w/e", kind: { type: "update", move_path: null }, diff: "" },
        ],
      },
    );
    expect(file).toMatchObject({
      effects: [
        { toolCall: { kind: "move", locations: [{ path: "/w/a" }, { path: "/w/b" }] } },
        { toolCall: { kind: "delete", title: "Delete /w/c", locations: [{ path: "/w/c" }] } },
        { toolCall: { kind: "edit", title: "Add /w/d" } },
        { toolCall: { kind: "edit", title: "Edit /w/e" } },
      ],
      review: {
        toolCall: {
          title: "Change 4 files",
          locations: [{ path: "/w/a" }, { path: "/w/b" }, { path: "/w/c" }, { path: "/w/d" }, { path: "/w/e" }],
        },
      },
    });
    const shown = JSON.stringify((file as { review: unknown }).review);
    for (const line of ["Move /w/a to /w/b", "Delete /w/c", "Add /w/d", "Edit /w/e"]) expect(shown).toContain(line);
  });

  it("decides a permissions grant by its extent, and declines one reaching ORCA's files", () => {
    const PERMS = {
      ...TARGET,
      startedAtMs: 1,
      environmentId: null,
      cwd: "/w",
      reason: null,
      permissions: { network: { enabled: true }, fileSystem: { read: ["/r"], write: ["/w/out"] } },
    };
    const perms = codexAskRequest("thr", "item/permissions/requestApproval", PERMS);
    expect(perms).toMatchObject({
      effects: [
        { toolCall: { kind: "fetch" } },
        {
          toolCall: {
            kind: "edit",
            title: "Write anything under /w/out for this turn",
            locations: [{ path: "/w/out" }],
          },
        },
        { toolCall: { kind: "read", locations: [{ path: "/r" }] } },
      ],
      review: {
        toolCall: {
          title: "Codex asks for network access and write access to /w/out and read access to /r for this turn",
        },
      },
    });
    const seen: [readonly string[], string][] = [];
    const refused = codexAskRequest("thr", "item/permissions/requestApproval", PERMS, {
      extentProblem: (paths, access) => (
        seen.push([paths, access]),
        access === "write" ? "overlaps /w/out/.orca" : undefined
      ),
    });
    expect(refused).toMatchObject({ refused: "a permissions ask whose extent overlaps /w/out/.orca" });
    expect(seen).toEqual([[["/w/out"], "write"]]);
  });

  it("declines without asking what it cannot show or would be a standing grant", () => {
    const refused = (method: (typeof CODEX_POLICY_ASKS)[number], params: unknown) => {
      const m = codexAskRequest("thr", method, params);
      return "refused" in m ? m.refused : undefined;
    };
    expect(refused("item/commandExecution/requestApproval", null)).toMatch(/not an object/);
    expect(refused("item/commandExecution/requestApproval", { command: "ls" })).toMatch(/thread, turn and item/);
    expect(refused("item/commandExecution/requestApproval", { ...COMMAND, kind: "other" })).toMatch(/kind/);
    expect(refused("item/commandExecution/requestApproval", { ...COMMAND, kind: "writeStdin" })).toMatch(/terminal/);
    expect(refused("item/commandExecution/requestApproval", { ...COMMAND, command: null })).toMatch(/names no command/);
    expect(refused("item/commandExecution/requestApproval", { ...COMMAND, command: 1 })).toMatch(/command/);
    expect(
      refused("item/commandExecution/requestApproval", { ...COMMAND, commandActions: [{ type: "read" }] }),
    ).toMatch(/parsed command actions/);
    expect(
      refused("item/commandExecution/requestApproval", { ...COMMAND, networkApprovalContext: { host: 1 } }),
    ).toMatch(/network context/);
    expect(refused("item/fileChange/requestApproval", { ...TARGET })).toMatch(/no change ORCA was shown/);
    expect(refused("item/fileChange/requestApproval", { ...TARGET, grantRoot: "/w" })).toMatch(/write root/);
    expect(
      codexAskRequest("thr", "item/fileChange/requestApproval", TARGET, {
        changes: [{ path: "/w/a", kind: { type: "rename" } } as never],
      }),
    ).toMatchObject({ refused: "a file change ORCA cannot show" });
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
