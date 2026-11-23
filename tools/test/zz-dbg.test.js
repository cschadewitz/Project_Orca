import { it } from "vitest";
import { appendFileSync } from "node:fs";
import { childBundle } from "@orca/testing/child-bundle";
import { createWorld } from "../guard-qualification/world.js";
import { modelStandIn } from "../guard-qualification/connected/model-stand-in.js";
import { claudeConnected } from "../guard-qualification/connected/claude.js";
const out = (...a) => appendFileSync("/tmp/claude-0/dbg.log", a.join(" ") + "\n");
it("dbg", async () => {
  const model = await modelStandIn();
  const built = childBundle("claude-pre-tool-hook-706-connected", { entries: { hook: "/home/user/Project_Orca/packages/agents/src/bin/claude-pre-tool-hook.ts" } });
  const path = claudeConnected({ adapter: process.env.ORCA_CLAUDE_ADAPTER, hookScript: built.hook, model });
  const world = await createWorld();
  
  const origAgent = path.agent;
  path.agent = (w, e = {}) => origAgent(w, { ...e, CLAUDE_CODE_SHELL_PREFIX: "/tmp/claude-0/dbg/prefix.sh" });
  const { state } = await path.open(world);
  const origAnswer = state;
  state.answer = (req) => { out("ASK", req.toolCall.toolCallId, req.toolCall.title); return req.options.find(o => o.kind === "allow_once")?.optionId; };
  await path.turn(world, [{ name: "Read", input: { file_path: "/etc/hostname" } }]);
  const seen = await path.turn(world, [{ name: "Bash", input: { command: "echo hi-706" } }, { name: "mcp__github__create_issue", input: {} }]);
  out("SEEN", JSON.stringify(seen).slice(0, 1500));
  out("CALLS", JSON.stringify(model.log.calls));
  await world.dispose();
  model.server.close();
}, 300000);
