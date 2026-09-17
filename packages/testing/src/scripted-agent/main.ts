#!/usr/bin/env node
/**
 * Entry point: `orca-scripted-agent --playbook pb.yaml [--state s.json] [--log prompts.jsonl]`
 * Speaks ACP over stdio. Also honours ORCA_PLAYBOOK / ORCA_PLAYBOOK_JSON env vars.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import * as acp from "@agentclientprotocol/sdk";
import { stdioAcpStream } from "@orca/agents";
import { parse as parseYaml } from "yaml";
import { ScriptedAgent } from "./agent.js";
import { parsePlaybook } from "./playbook.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      playbook: { type: "string" },
      state: { type: "string" },
      log: { type: "string" },
      name: { type: "string" },
    },
  });
  let raw: unknown = {};
  const file = values.playbook ?? process.env.ORCA_PLAYBOOK;
  if (process.env.ORCA_PLAYBOOK_JSON) raw = JSON.parse(process.env.ORCA_PLAYBOOK_JSON);
  else if (file) raw = parseYaml(await readFile(file, "utf8"));
  const agent = new ScriptedAgent({
    playbook: parsePlaybook(raw),
    ...(values.state ? { stateFile: values.state } : {}),
    ...(values.log ? { promptLog: values.log } : {}),
    ...(values.name ? { name: values.name } : {}),
  });
  const stream = stdioAcpStream(process.stdin, process.stdout);
  const conn = agent.register(acp.agent({ name: "orca-scripted-agent" })).connect(stream);
  await conn.closed;
}

main().catch((e) => {
  process.stderr.write(`scripted agent failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
