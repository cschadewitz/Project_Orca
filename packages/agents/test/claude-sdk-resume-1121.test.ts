/**
 * Resume and context recovery on the Claude Agent SDK route (#1121), with the guarantees of the
 * ACP route's `session/load` (`context-recovery-357.test.ts`): a resumed session continues its
 * transcript; a required recovery that fails is refused with the same errors and opens nothing
 * fresh; an optional one falls back to a fresh session and says so.
 *
 * `claude` here is the stand-in (fixtures/claude-sdk-stand-in.mjs), which keeps each session's
 * prompts under the id it was given and fails a resume of an unknown id as Claude Code does.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrcaError } from "@orca/core";
import {
  openClaudeSdkSession,
  startupTermination,
  type AgentSession,
  type ClaudeSdkSessionOptions,
  type SessionContinuity,
} from "../src/index.js";

const STAND_IN = fileURLToPath(new URL("./fixtures/claude-sdk-stand-in.mjs", import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let dir: string;
let claude: string;
let transcripts: string;
let log: string;
const sessions: AgentSession[] = [];
beforeEach(async () => {
  dir = realpathSync(await mkdtemp(join(tmpdir(), "orca-claude-sdk-resume-")));
  claude = join(dir, "claude");
  transcripts = join(dir, "transcripts");
  log = join(dir, "stand-in.log");
  await mkdir(transcripts);
  await writeFile(claude, `#!/bin/sh\nexec "${process.execPath}" "${STAND_IN}" "$@"\n`);
  await chmod(claude, 0o755);
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await rm(dir, { recursive: true, force: true });
});

async function open(extra: Partial<ClaudeSdkSessionOptions> = {}, env: Record<string, string> = {}) {
  const continuity: SessionContinuity[] = [];
  const session = await openClaudeSdkSession({
    agent: { id: "claude-sdk", cancelGraceMs: 2_000 },
    hostId: "local",
    cwd: dir,
    preflight: {
      executable: claude,
      env: { PATH: process.env.PATH ?? "", STAND_IN_TRANSCRIPTS: transcripts, STAND_IN_LOG: log, ...env },
    },
    startupTimeoutMs: 3_000,
    exitGraceMs: 2_000,
    onSessionContinuity: (c) => continuity.push(c),
    ...extra,
  });
  sessions.push(session);
  return { session, continuity };
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected the open to fail");
    },
    (e: unknown) => e as OrcaError,
  );

async function history(session: AgentSession): Promise<string[]> {
  const texts: string[] = [];
  const off = session.onUpdate((e) => {
    if (e.summary.kind === "agent_message_chunk") texts.push(e.summary.text ?? "");
  });
  await session.prompt("history");
  off();
  return JSON.parse(texts.join("")) as string[];
}

/** The argv of every Claude Code the stand-in log saw start. */
async function launches(): Promise<string[][]> {
  const lines = (await readFile(log, "utf8")).split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l) as { argv?: string[] }).flatMap((l) => (l.argv ? [l.argv] : []));
}

describe("Claude Agent SDK resume and context recovery (#1121)", () => {
  it("gives a new session a Claude Code session id of ORCA's choosing, and says it is fresh", async () => {
    const { session, continuity } = await open();
    expect(session.acpSessionId).toMatch(UUID);
    expect(continuity).toEqual([{ mode: "fresh", reason: "new" }]);
    const [argv] = await launches();
    expect(argv).toContain(`--session-id=${session.acpSessionId}`);
    expect(argv).not.toContain("--no-session-persistence");
  });

  it("continues an earlier session's transcript under the same id, required or not", async () => {
    const first = await open();
    await first.session.prompt("hello there");
    const id = first.session.acpSessionId;
    await first.session.close();

    for (const requireContextRecovery of [false, true]) {
      const { session, continuity } = await open({ resumeSessionId: id, requireContextRecovery });
      expect(session.acpSessionId).toBe(id);
      expect(continuity).toEqual([{ mode: "loaded", reason: "load-supported" }]);
      // The earlier turn is part of what the resumed session sees.
      expect((await history(session))[0]).toBe("hello there");
      await session.close();
    }
    const resumes = (await launches()).filter((a) => a.some((f) => f.startsWith("--resume")));
    expect(resumes).toHaveLength(2);
    for (const argv of resumes) {
      expect(argv).toContain(`--resume=${id}`);
      expect(argv.some((a) => a.startsWith("--session-id"))).toBe(false);
    }
  });

  it("refuses a required recovery with no session id before anything starts", async () => {
    for (const resumeSessionId of [undefined, "", "   "]) {
      const error = await failure(open({ requireContextRecovery: true, resumeSessionId }));
      expect(error).toBeInstanceOf(OrcaError);
      expect(error.code).toBe("CONFIG_INVALID");
      expect(error.details).toMatchObject({ contextRecoveryReason: "missing-session-id" });
    }
    await expect(readFile(log, "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("refuses a required recovery of an unknown session: nothing fresh, no CLI text, the process gone", async () => {
    const error = await failure(open({ requireContextRecovery: true, resumeSessionId: crypto.randomUUID() }));
    expect(error.code).toBe("AGENT_PROTOCOL");
    expect(error.details).toEqual({ contextRecoveryReason: "load-failed" });
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain("SENTINEL");
    await expect(startupTermination(error)).resolves.toBeUndefined();
    expect(await launches()).toHaveLength(1);
  });

  it("never passes on an id that is not a Claude Code session id: Claude would match it as a title", async () => {
    const error = await failure(open({ requireContextRecovery: true, resumeSessionId: "my favourite session" }));
    expect(error.details).toEqual({ contextRecoveryReason: "load-failed" });
    await expect(readFile(log, "utf8")).rejects.toThrow(/ENOENT/);

    const { session, continuity } = await open({ resumeSessionId: "my favourite session" });
    expect(continuity).toEqual([{ mode: "fresh", reason: "load-failed" }]);
    expect(session.acpSessionId).toMatch(UUID);
    const argv = await launches();
    expect(argv).toHaveLength(1);
    expect(argv[0]!.some((a) => a.startsWith("--resume"))).toBe(false);
  });

  it("refuses a required recovery that times out as a load timeout", async () => {
    const known = crypto.randomUUID();
    await writeFile(join(transcripts, known), "");
    const timedOut = await failure(
      open(
        { requireContextRecovery: true, resumeSessionId: known, startupTimeoutMs: 300 },
        { STAND_IN_RESUME_SILENT: "1" },
      ),
    );
    expect(timedOut.code).toBe("AGENT_TRANSPORT");
    expect(timedOut.details).toEqual({ contextRecoveryReason: "load-timeout" });
    await expect(startupTermination(timedOut)).resolves.toBeUndefined();
  });

  it("falls back to a fresh session when optional recovery fails, after the refused process is gone", async () => {
    const { session, continuity } = await open({ resumeSessionId: crypto.randomUUID() });
    expect(continuity).toEqual([{ mode: "fresh", reason: "load-failed" }]);
    expect(session.acpSessionId).toMatch(UUID);
    expect(await history(session)).toEqual(["history"]);
    const argv = await launches();
    expect(argv).toHaveLength(2);
    expect(argv[0]!.some((a) => a.startsWith("--resume="))).toBe(true);
    expect(argv[1]!.some((a) => a.startsWith("--session-id="))).toBe(true);
  });

  it("does not fall back when the open is cancelled while resuming", async () => {
    const known = crypto.randomUUID();
    await writeFile(join(transcripts, known), "");
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const error = await failure(
      open({ resumeSessionId: known, signal: abort.signal, startupTimeoutMs: 5_000 }, { STAND_IN_RESUME_SILENT: "1" }),
    );
    expect(error.code).toBe("CANCELLED");
    expect(await launches()).toHaveLength(1);
  });
});
