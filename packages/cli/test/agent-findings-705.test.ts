/** `orca agents` names the agent settings that let calls run without asking ORCA (#705): Gemini CLI, pi. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { commands, type CommandContext } from "../src/commands/index.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "orca-705-agents-"));
  await writeFile(
    join(dir, "orca.config.yaml"),
    [
      "version: 1",
      "workflows: []",
      "templates: []",
      "agents:",
      "  - { id: careful, command: gemini, args: [--acp], env: { GEMINI_CLI_HOME: /srv/gemini-home } }",
      "  - { id: loose, command: gemini, args: [--acp, --yolo] }",
      "  - { id: other, command: /bin/false, args: [--acp, --yolo] }",
      "  - { id: pi, command: pi-acp, env: { PI_CODING_AGENT_DIR: /srv/pi-agent } }",
      "",
    ].join("\n"),
    "utf8",
  );
});
afterAll(() => rm(dir, { recursive: true, force: true }));

it("lists each Gemini setting that lets calls run without asking ORCA, under its agent", async () => {
  const lines: string[] = [];
  const c: CommandContext = {
    cwd: dir,
    flags: { quiet: true },
    positionals: [],
    out: (l) => lines.push(l),
    err: () => {},
  };
  expect(await commands.agents!.run(c)).toBe(0);
  const block = (id: string) => {
    const start = lines.findIndex((l) => l.startsWith(`  ${id} `));
    const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
    return lines.slice(start, end === -1 ? undefined : end).join("\n");
  };
  expect(block("careful")).not.toMatch(/ORCA/);
  expect(block("loose")).toMatch(/^ {4}runs without asking ORCA: YOLO mode/m);
  expect(block("loose")).toMatch(/^ {4}outside ORCA: no GEMINI_CLI_HOME/m);
  expect(block("other")).not.toMatch(/ORCA/);
  expect(block("pi")).toMatch(/^ {4}runs without asking ORCA: pi runs every tool call without asking/m);
});
