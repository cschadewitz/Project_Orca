/**
 * Account status and usage limits on the Codex app-server route (#1164): reading the account
 * Codex reports, checking and merging usage-limit snapshots, the failure a usage-limit turn
 * ends with, and that no ORCA source calls a login, logout or token method.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexAccountIdentity,
  codexRateLimitsProblem,
  codexStopReason,
  codexUsageLimitFailure,
  codexAccountContinuity,
  codexResetTime,
  mergeCodexRateLimits,
  type CodexRateLimits,
} from "../src/index.js";

const RESET = 1_795_000_000; // 2026-11-17T...Z in unix seconds
const LIMITS: CodexRateLimits = mergeCodexRateLimits(undefined, {
  limitId: "codex",
  limitName: null,
  primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESET },
  secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: RESET + 86_400 },
  planType: "plus",
  rateLimitReachedType: "rate_limit_reached",
});

describe("the account Codex reports", () => {
  it("keeps the kind and ChatGPT plan, never the email or workspace", () => {
    const chatgpt = codexAccountIdentity({
      account: { type: "chatgpt", email: "someone@example.com", planType: "pro", workspaceName: "Team" },
      userId: "user-1",
      requiresOpenaiAuth: true,
    });
    expect(chatgpt).toEqual({ status: { kind: "chatgpt", planType: "pro" }, userId: "user-1", signedOut: false });
    expect(JSON.stringify(chatgpt)).not.toContain("example.com");
    expect(codexAccountIdentity({ account: { type: "apiKey" }, userId: null, requiresOpenaiAuth: true })).toEqual({
      status: { kind: "apiKey", planType: null },
      userId: null,
      signedOut: false,
    });
  });

  it("is signed out only with no account where one is needed", () => {
    expect(codexAccountIdentity({ account: null, userId: null, requiresOpenaiAuth: true })?.signedOut).toBe(true);
    expect(codexAccountIdentity({ account: null, userId: null, requiresOpenaiAuth: false })?.signedOut).toBe(false);
  });

  it("refuses shapes it does not know", () => {
    for (const answer of [
      null,
      { account: { type: "apiKey" } },
      { account: { type: "sso" }, requiresOpenaiAuth: true },
      { account: { type: "chatgpt", planType: 3 }, requiresOpenaiAuth: true },
      { account: null, userId: 7, requiresOpenaiAuth: true },
    ])
      expect(codexAccountIdentity(answer)).toBeUndefined();
  });

  it("is the same account only with the same kind and a matching user id", () => {
    const a = codexAccountIdentity({
      account: { type: "chatgpt", planType: "pro" },
      userId: "u1",
      requiresOpenaiAuth: true,
    })!;
    const b = codexAccountIdentity({
      account: { type: "chatgpt", planType: "plus" },
      userId: "u1",
      requiresOpenaiAuth: true,
    })!;
    const c = codexAccountIdentity({
      account: { type: "chatgpt", planType: "pro" },
      userId: "u2",
      requiresOpenaiAuth: true,
    })!;
    const d = codexAccountIdentity({ account: { type: "apiKey" }, userId: "u1", requiresOpenaiAuth: true })!;
    expect(codexAccountContinuity(a, b)).toBe("same");
    expect(codexAccountContinuity(a, c)).toBe("different");
    expect(codexAccountContinuity(a, d)).toBe("different");
  });

  it("does not claim the same account when Codex reports no user id", () => {
    const key = codexAccountIdentity({ account: { type: "apiKey" }, userId: null, requiresOpenaiAuth: true })!;
    const chatgpt = codexAccountIdentity({
      account: { type: "chatgpt", planType: "pro" },
      userId: "u1",
      requiresOpenaiAuth: true,
    })!;
    const anonymous = { ...chatgpt, userId: null };
    expect(codexAccountContinuity(key, key)).toBe("unverifiable");
    expect(codexAccountContinuity(chatgpt, anonymous)).toBe("unverifiable");
    expect(codexAccountContinuity(anonymous, chatgpt)).toBe("unverifiable");
    // another kind of login is another account, id or not
    expect(codexAccountContinuity(key, anonymous)).toBe("different");
  });
});

describe("usage limits", () => {
  it("checks the fields ORCA reads", () => {
    expect(codexRateLimitsProblem({ primary: null, secondary: null })).toBeUndefined();
    expect(codexRateLimitsProblem(null)).toMatch(/not an object/);
    expect(codexRateLimitsProblem({ primary: { usedPercent: "100" } })).toMatch(/primary usage-limit window/);
    expect(codexRateLimitsProblem({ secondary: { usedPercent: 1, resetsAt: "soon" } })).toMatch(/secondary/);
    expect(codexRateLimitsProblem({ planType: 1 })).toMatch(/planType/);
  });

  it("merges a sparse update into what was known", () => {
    const merged = mergeCodexRateLimits(LIMITS, {
      limitId: null,
      limitName: null,
      primary: { usedPercent: 50, windowDurationMins: null, resetsAt: null },
      secondary: null,
      planType: null,
      rateLimitReachedType: null,
    });
    expect(merged).toEqual({
      ...LIMITS,
      primary: { usedPercent: 50, windowDurationMins: null, resetsAt: null },
    });
  });

  it("names the window that ran out and its reset time on a usage-limit failure", () => {
    const error = codexUsageLimitFailure("codex", "usageLimitExceeded", [LIMITS])!;
    expect(error.message).toBe(
      `agent codex: Codex stopped the turn because the usage limit of its login is reached: the 5-hour window is 100% used and resets at ${new Date(RESET * 1000).toISOString()}.`,
    );
    expect(error.details).toEqual({
      agentId: "codex",
      reason: "codex-usage-limit",
      window: { durationMins: 300, usedPercent: 100, resetsAt: new Date(RESET * 1000).toISOString() },
    });
    const weekly = mergeCodexRateLimits(undefined, {
      primary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: null },
    });
    expect(codexUsageLimitFailure("codex", "rateLimitExceeded", [weekly])!.message).toContain(
      "the rate limit of its login is reached: the weekly window is 100% used, and Codex reported no reset time.",
    );
    const none = codexUsageLimitFailure("codex", "usageLimitExceeded", [])!;
    expect(none.message).toContain("Codex reported no single window at its limit for this turn");
    expect(none.details).toMatchObject({ reason: "codex-usage-limit", window: null });
    expect(codexUsageLimitFailure("codex", "contextWindowExceeded", [LIMITS])).toBeUndefined();
  });

  it("names no window when the evidence names more than one, across buckets too", () => {
    const other = mergeCodexRateLimits(undefined, {
      limitId: "codex_other",
      primary: { usedPercent: 100, windowDurationMins: 60, resetsAt: RESET },
    });
    const both = codexUsageLimitFailure("codex", "usageLimitExceeded", [LIMITS, other])!;
    expect(both.message).toContain("Codex reported no single window at its limit for this turn");
    expect(both.details).toMatchObject({ window: null });
    // a bucket with no window at its limit adds nothing
    const calm = mergeCodexRateLimits(undefined, {
      limitId: "codex_other",
      primary: { usedPercent: 10, windowDurationMins: 60, resetsAt: RESET },
    });
    expect(codexUsageLimitFailure("codex", "usageLimitExceeded", [LIMITS, calm])!.message).toContain(
      "the 5-hour window is 100% used",
    );
  });

  it("keeps a snapshot apart from another bucket's", () => {
    const other = mergeCodexRateLimits(LIMITS, {
      limitId: "codex_other",
      primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: null },
    });
    expect(other).toEqual({
      limitId: "codex_other",
      limitName: null,
      primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: null },
      secondary: null,
      planType: null,
      rateLimitReachedType: null,
    });
  });

  it("leaves out a reset time no date can hold, and keeps the reason", () => {
    expect(codexResetTime(1e20)).toBeUndefined();
    expect(codexResetTime(null)).toBeUndefined();
    expect(codexResetTime(RESET)).toBe(new Date(RESET * 1000).toISOString());
    const far = mergeCodexRateLimits(undefined, {
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1e20 },
    });
    const error = codexUsageLimitFailure("codex", "usageLimitExceeded", [far])!;
    expect(error.message).toContain("the 5-hour window is 100% used, and Codex reported no reset time.");
    expect(error.details).toEqual({
      agentId: "codex",
      reason: "codex-usage-limit",
      window: { durationMins: 300, usedPercent: 100, resetsAt: null },
    });
  });

  it("is what a failed turn ends with", () => {
    expect(() =>
      codexStopReason(
        "codex",
        { id: "t", status: "failed", error: { message: "limit", codexErrorInfo: "usageLimitExceeded" } },
        [LIMITS],
      ),
    ).toThrow(/the 5-hour window is 100% used and resets at/);
    expect(() =>
      codexStopReason("codex", { id: "t", status: "failed", error: { message: "boom", codexErrorInfo: "other" } }),
    ).toThrow("Codex failed the turn: boom");
  });
});

describe("ORCA's own sign-in", () => {
  it("is never attempted: no source calls a login, logout or token method", async () => {
    const dir = join(import.meta.dirname, "../src");
    const files = (await readdir(dir)).filter((f) => f.startsWith("codex-app-server") && f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      // the code, without its comments (which name what ORCA never calls)
      const text = (await readFile(join(dir, file), "utf8"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // a method name in a string: a request ORCA could send
      expect(text, file).not.toMatch(/["'`]account\/(login|logout)/);
      expect(text, file).not.toMatch(/["'`](getAuthStatus|account\/gatewayOAuth|mcpServer\/oauth)/);
      expect(text, file).not.toMatch(/refreshToken\s*:/);
      expect(text, file).not.toMatch(/auth\.json/);
    }
  });
});
