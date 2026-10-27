/**
 * Release canary audit (#363): `orca run`, `status`, `events`, `answer` and the interactive
 * terminal port never print a sensitive launch value, and public store files never hold it.
 * Every canary is synthetic. Encrypted private records are checked for plaintext only.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "@orca/core";
import { bootstrap } from "../src/bootstrap.js";
import { cliHumanInput } from "../src/human-input-cli.js";
import { main } from "../src/main.js";

// Every third tail character is i/l/o/u: no ULID or hex digest can contain a window of it.
const TOKEN = "SYNTHETIC-CANARY-CLITOKEN-r4uM8lQ2oV6iX9uB";
const COPY = "SYNTHETIC-CANARY-CLICOPY-z1iT5oK8lN3uD7iF";
const CANARIES = [TOKEN, COPY];

/** Any six-character window of a canary's tail, ignoring case, counts as printed. */
function exposed(text: string): string[] {
  const lower = text.toLowerCase();
  return CANARIES.flatMap((canary) => {
    const tail = canary.slice(canary.lastIndexOf("-") + 1).toLowerCase();
    return Array.from({ length: tail.length - 5 }, (_, i) => tail.slice(i, i + 6)).filter((w) => lower.includes(w));
  });
}

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const WORKFLOW = {
  id: "ship",
  name: "Ship",
  version: "1",
  inputSchema: {
    fields: {
      token: { type: "string", sensitive: true },
      strict: { type: "string", sensitive: true, pattern: "^never$" },
    },
  },
  start: "s",
  nodes: {
    s: { type: "start" },
    copy: { type: "set", vars: { copied: "=vars.token" } },
    gate: { type: "gate", question: "Ship {{vars.token}} as {{vars.copied}}?", options: ["ship", "stop"] },
    done: { type: "end", outcome: "success" },
  },
  edges: [
    { from: "s", to: "copy" },
    { from: "copy", to: "gate" },
    { from: "gate", to: "done" },
  ],
};

async function fixture(humanInput = "pause") {
  const dir = await mkdtemp(join(tmpdir(), "orca-cli-canary-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "orca.config.yaml"),
    `workflows: [ship.yaml]\ntemplates: []\nhumanInput: { mode: ${humanInput} }\n`,
  );
  await writeFile(join(dir, "ship.yaml"), JSON.stringify(WORKFLOW));
  return dir;
}

/** Run `orca` in-process and return everything it wrote to stdout and stderr. */
async function orca(args: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const record = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(record);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(record);
  try {
    return { code: await main(args), out: chunks.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

describe("CLI terminal output", () => {
  it("run, status, events, answer and resume print redaction markers, never the value", async () => {
    const dir = await fixture();
    const run = await orca([
      "run",
      "ship",
      "--cwd",
      dir,
      "--config",
      join(dir, "orca.config.yaml"),
      "--var",
      `token=${TOKEN}`,
    ]);
    expect(run.code, run.out).toBe(3);
    const runId = /run (run_[0-9A-Z]+) is paused/.exec(run.out)?.[1];
    const requestId = /(hi_[0-9A-Z]+)\s+run=/.exec(run.out)?.[1];
    expect(runId && requestId, run.out).toBeTruthy();
    const config = ["--cwd", dir, "--config", join(dir, "orca.config.yaml")];
    const status = await orca(["status", runId!, ...config]);
    const events = await orca(["events", runId!, "--json", ...config]);
    const answered = await orca(["answer", requestId!, "ship", ...config]);
    expect([status.code, events.code, answered.code]).toEqual([0, 0, 0]);
    const printed = [run.out, status.out, events.out, answered.out].join("\n");
    expect(printed).toContain("Ship [REDACTED] as [REDACTED]?");
    expect(exposed(printed)).toEqual([]);

    // Public store files carry no plaintext. Private records exist and are ciphertext.
    const stored = await files(dir);
    const isPrivate = (file: string) => /^\.orca[\\/]private-/.test(relative(dir, file));
    expect(stored.some(isPrivate)).toBe(true);
    for (const file of stored) {
      if (file.endsWith(".yaml")) continue;
      expect(exposed(await readFile(file, "utf8")), relative(dir, file)).toEqual([]);
    }
  });

  it("refuses malformed sensitive input on stderr without the value, pattern or details echo", async () => {
    const dir = await fixture();
    const refused = await orca([
      "run",
      "ship",
      "--cwd",
      dir,
      "--config",
      join(dir, "orca.config.yaml"),
      "--var",
      `token=${TOKEN}`,
      "--var",
      `strict=${COPY}`,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("error [WORKFLOW_INPUT_INVALID]");
    expect(refused.out).toContain("vars.strict");
    expect(exposed(refused.out)).toEqual([]);
    expect(refused.out).not.toContain("^never$");
  });

  it("the interactive terminal port shows the published question, not the authoritative one", async () => {
    const dir = await fixture("cli");
    const input = new PassThrough();
    let shown = "";
    // Answer only once the prompt is up, as a person would; earlier input would be dropped.
    const output = new Writable({
      write(chunk: Buffer, _encoding, done) {
        shown += chunk.toString();
        if (shown.endsWith("> ")) setImmediate(() => input.write("1\n"));
        done();
      },
    });
    const app = await bootstrap({ cwd: dir, logger: silentLogger, humanInput: cliHumanInput(input, output) });
    const state = await app.orchestrator.startAndRun({ workflowId: "ship", vars: { token: TOKEN } });
    expect(state.run.status, JSON.stringify(state.run.error)).toBe("completed");
    expect(state.steps[state.stepOrder.at(-2)!]?.result?.choice).toBe("ship");
    expect(shown).toContain("Ship [REDACTED] as [REDACTED]?");
    expect(exposed(shown)).toEqual([]);
  });
});
