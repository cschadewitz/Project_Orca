/**
 * Usage and limits on the Claude Agent SDK route (#1127): each turn's usage reaches the run as a
 * `usage_update`, a subscription limit Claude Code says is close becomes a notice, and a turn a
 * limit ended fails with a clear message and the reset time, never with CLI text. ORCA keeps
 * the SDK's own entrypoint and reads nothing but what Claude Code sends.
 *
 * `claude` here is the SDK stand-in, so no account and no model are involved.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrcaError } from "@orca/core";
import {
  limitName,
  openClaudeSdkSession,
  rateLimitNotice,
  resetTime,
  summarizeUpdate,
  type AgentSession,
  type SessionUpdateEvent,
} from "../src/index.js";

const STAND_IN = fileURLToPath(new URL("./fixtures/claude-sdk-stand-in.mjs", import.meta.url));
const CLI_TEXT = "SENTINEL-1127-cli-text";
/** 1795000000 s since the epoch. */
const RESETS = "2026-11-18T11:06:40.000Z";

let dir: string;
let claude: string;
const sessions: AgentSession[] = [];
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-usage-")));
  claude = join(dir, "claude");
  await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${STAND_IN}" "$@"\n`);
  await chmod(claude, 0o755);
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await rm(dir, { recursive: true, force: true });
});

async function open(clock?: { now: () => number }, env: Record<string, string> = {}) {
  const session = await openClaudeSdkSession({
    agent: { id: "claude-sdk", cancelGraceMs: 2_000 },
    hostId: "local",
    cwd: dir,
    preflight: { executable: claude, env: { PATH: process.env.PATH ?? "", ...env } },
    startupTimeoutMs: 10_000,
    exitGraceMs: 2_000,
    ...(clock ? { clock: { now: clock.now, isoNow: () => new Date(clock.now()).toISOString() } } : {}),
  });
  sessions.push(session);
  return session;
}

function collect(session: AgentSession): SessionUpdateEvent[] {
  const events: SessionUpdateEvent[] = [];
  session.onUpdate((e) => events.push(e));
  return events;
}

/** Before RESETS, so a reached limit is still current. */
const before = { now: () => Date.parse(RESETS) - 60_000 };

describe("usage on the Claude Agent SDK route (#1127)", () => {
  it("reports each turn's context, tokens and estimated cost as a usage_update", async () => {
    const session = await open();
    const events = collect(session);
    expect((await session.prompt("usage")).stopReason).toBe("end_turn");
    const usage = events.find((e) => e.raw.sessionUpdate === "usage_update");
    expect(usage?.raw).toMatchObject({
      sessionUpdate: "usage_update",
      // The last main-loop call: input, cache reads and writes, and output.
      used: 32_000,
      size: 200_000,
      cost: { amount: 0.4249, currency: "USD" },
      _meta: {
        orca: { tokens: { input: 1200, output: 300, cacheRead: 30000, cacheCreation: 500 }, costIsEstimate: true },
      },
    });
    // What the run's event log keeps.
    expect(usage?.summary).toEqual({
      kind: "usage_update",
      text: "32,000 of 200,000 context tokens used · ~$0.42 so far (estimate)",
    });
    // A turn with no model window reported (the stand-in's other turns) adds no usage line.
    const count = events.filter((e) => e.raw.sessionUpdate === "usage_update").length;
    await session.prompt("hello");
    expect(events.filter((e) => e.raw.sessionUpdate === "usage_update").length).toBe(count);
  });

  it("measures only a sample from this turn, against that call's own model's window (#1319 review)", async () => {
    const window = (contextWindow: number) => ({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 2,
      webSearchRequests: 0,
      costUSD: 0.005,
      contextWindow,
      maxOutputTokens: 32000,
    });
    const session = await open();
    const events = collect(session);
    const usages = () => events.filter((e) => e.raw.sessionUpdate === "usage_update");
    await session.prompt("usage");
    expect(usages()).toHaveLength(1);
    // A later turn with no main-loop call of its own reports no context, not the previous turn's.
    await session.prompt(
      `usagejson ${JSON.stringify({ model: null, modelUsage: { "claude-stand-in": window(200000) } })}`,
    );
    expect(usages()).toHaveLength(1);
    // Several models: the window is the calling model's, not the largest; totals cover all of them.
    await session.prompt(
      `usagejson ${JSON.stringify({ model: "claude-a", modelUsage: { "claude-a": window(200000), "claude-b": window(1000000) } })}`,
    );
    expect(usages()).toHaveLength(2);
    expect(usages()[1]!.raw).toMatchObject({
      used: 15,
      size: 200000,
      _meta: { orca: { tokens: { input: 20, output: 10, cacheRead: 2, cacheCreation: 4 } } },
    });
    // A call whose model the result has no window for is not measured against another's.
    await session.prompt(
      `usagejson ${JSON.stringify({ model: "claude-c", modelUsage: { "claude-b": window(1000000) } })}`,
    );
    expect(usages()).toHaveLength(2);
  });

  it("turns a near limit into a notice with the reset time", async () => {
    const session = await open();
    const events = collect(session);
    expect((await session.prompt("usage 0.85")).stopReason).toBe("end_turn");
    const notice = events.find((e) => e.raw.sessionUpdate === "notice");
    expect(notice?.raw).toMatchObject({
      severity: "warning",
      title: "Claude is close to the 5-hour limit of its subscription (85% used)",
      _meta: { orca: { rateLimit: { status: "allowed_warning", type: "five_hour", resetsAt: RESETS } } },
    });
    expect(notice?.summary.text).toBe(
      `Claude is close to the 5-hour limit of its subscription (85% used). It resets at ${RESETS}.`,
    );
  });

  it("ends a step a subscription limit stopped with a clear message and its reset time, and no CLI text", async () => {
    const session = await open(before);
    const events = collect(session);
    const failure = (await session.prompt("limit").catch((e: unknown) => e)) as OrcaError;
    expect(failure).toMatchObject({
      code: "AGENT_TRANSPORT",
      details: { reason: "usage-limit", limit: "seven_day", resetsAt: RESETS },
    });
    expect(failure.message).toBe(
      `agent claude-sdk: Claude reached the weekly limit of its subscription, so the step ended. ` +
        `It resets at ${RESETS}; run the step again after that.`,
    );
    expect(JSON.stringify(failure)).not.toContain(CLI_TEXT);
    expect(events.find((e) => e.raw.sessionUpdate === "notice")?.raw).toMatchObject({
      severity: "error",
      title: "Claude reached the weekly limit of its subscription",
    });
    // The session stays usable; a turn that goes through says the limit has lifted, so a later
    // failure of another kind is not taken for it.
    expect((await session.prompt("hello")).stopReason).toBe("end_turn");
    const other = (await session.prompt("fail now").catch((e: unknown) => e)) as OrcaError;
    expect(other.code).toBe("AGENT_PROTOCOL");
  });

  it("says when Claude Code gave no reset time, and tells an API key's 429 apart", async () => {
    const session = await open(before);
    const noReset = (await session.prompt("limit none").catch((e: unknown) => e)) as OrcaError;
    expect(noReset.details).toMatchObject({ reason: "usage-limit", limit: "seven_day" });
    expect(noReset.details).not.toHaveProperty("resetsAt");
    expect(noReset.message).toMatch(/did not say when it resets/);
    // Right after it, a failure with no rate-limit evidence of its own is not taken for the limit.
    const unrelated = (await session.prompt("fail now").catch((e: unknown) => e)) as OrcaError;
    expect(unrelated.code).toBe("AGENT_PROTOCOL");

    // A limit type ORCA does not know is not kept: it is just "the usage limit".
    const events = collect(session);
    const unknown = (await session.prompt("limit 1795000000 SENTINEL_1127_type").catch((e: unknown) => e)) as OrcaError;
    expect(unknown.details).toMatchObject({ reason: "usage-limit", resetsAt: RESETS });
    expect(unknown.details).not.toHaveProperty("limit");
    expect(unknown.message).toMatch(/reached the usage limit of its subscription/);
    const notice = events.find((e) => e.raw.sessionUpdate === "notice");
    expect(notice?.raw).toMatchObject({ _meta: { orca: { rateLimit: { status: "rejected", resetsAt: RESETS } } } });
    expect(JSON.stringify([unknown, notice])).not.toContain("SENTINEL_1127_type");

    const api = await open(before);
    const throttled = (await api.prompt("throttle").catch((e: unknown) => e)) as OrcaError;
    expect(throttled).toMatchObject({ code: "AGENT_TRANSPORT", details: { reason: "rate-limit" } });
    expect(throttled.message).toMatch(/API rate limit was hit \(HTTP 429\)/);
    expect(JSON.stringify(throttled)).not.toContain(CLI_TEXT);
  });

  it("does not take a reached limit whose reset has passed for the reason a later turn failed", async () => {
    let now = Date.parse(RESETS) - 60_000;
    const session = await open({ now: () => now });
    await session.prompt("limit").catch(() => undefined);
    now = Date.parse(RESETS) + 60_000;
    const later = (await session.prompt("fail now").catch((e: unknown) => e)) as OrcaError;
    expect(later.code).toBe("AGENT_PROTOCOL");
  });

  it("keeps the SDK's own entrypoint: ORCA sets none", async () => {
    const session = await open();
    const events = collect(session);
    await session.prompt("env");
    const text = events.map((e) => e.summary.text ?? "").join("");
    const env = JSON.parse(text) as Record<string, string>;
    expect(env["CLAUDE_CODE_ENTRYPOINT"]).toBe("sdk-ts");
    // Nor does ORCA's own source name another product's.
    const source = await readFile(fileURLToPath(new URL("../src/claude-sdk/launch.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/CLAUDE_CODE_ENTRYPOINT\s*[:=]/);
  });
});

describe("limit wording", () => {
  it("names known limits, and reads reset times in seconds or milliseconds", () => {
    expect(limitName({ status: "rejected", rateLimitType: "seven_day_opus" })).toBe("the weekly Opus limit");
    expect(limitName({ status: "rejected" })).toBe("the usage limit");
    expect(resetTime(1795000000)).toBe(RESETS);
    expect(resetTime(1795000000_000)).toBe(RESETS);
    expect(resetTime(undefined)).toBeUndefined();
    expect(resetTime(-1)).toBeUndefined();
    expect(rateLimitNotice({ status: "allowed", rateLimitType: "five_hour" })).toBeUndefined();
    expect(summarizeUpdate({ sessionUpdate: "usage_update", used: 10, size: 100 })).toEqual({
      kind: "usage_update",
      text: "10 of 100 context tokens used",
    });
  });
});
