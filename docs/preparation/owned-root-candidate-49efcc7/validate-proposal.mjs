#!/usr/bin/env node
// Read-only validation of the inactive proposals. Uses the already compiled candidate core.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseOrcaConfig } from "../../../packages/core/dist/config.js";
import { renderTemplate } from "../../../packages/core/dist/template/render.js";
import { validateWorkflowInputs } from "../../../packages/core/dist/workflow/inputs.js";
import { parseWorkflow } from "../../../packages/core/dist/workflow/load.js";
import { validateWorkflow } from "../../../packages/core/dist/workflow/validate.js";

const requireFromCore = createRequire(new URL("../../../packages/core/package.json", import.meta.url));
const { parse: parseYaml } = requireFromCore("yaml");
const local = (name) => fileURLToPath(new URL(name, import.meta.url));
const sha = /^[0-9a-f]{40}$/u;

const configText = readFileSync(local("./orca-workspace.proposed.yaml"), "utf8");
const config = parseOrcaConfig(parseYaml(configText));
assert.equal(config.workspace.provider, "git-worktree");
assert.equal(config.workspace.hostId, "local");
assert.equal(config.workspace.isolateRoots, true);
assert.match(config.workspace.baseBranch, sha);

const workflow = parseWorkflow(readFileSync(local("./work-v3.proposed.yaml"), "utf8"), "work-v3.proposed.yaml");
const graph = validateWorkflow(workflow, { hasAgent: (id) => id === "codex-worker" });
assert.deepEqual(graph.errors, []);
assert.equal(graph.ok, true);
assert.equal(workflow.id, "cal-codex-work");
assert.equal(workflow.version, "3");
assert.deepEqual(workflow.inputSchema.fields.expectedHead.enum, [config.workspace.baseBranch]);
assert.equal(workflow.nodes.work.type, "agent");
const prompt = workflow.nodes.work.prompt;
assert.ok(prompt.includes("{{workspace.cwd}}"));
assert.ok(prompt.includes("{{workspace.branch}}"));
assert.ok(prompt.includes("{{workspace.rootProvisioning.baseCommit}}"));
assert.ok(prompt.includes("owner-set admission and capacity limit"));
assert.ok(!prompt.includes("operator-serialized task"));

const smoke = JSON.parse(readFileSync(local("./first-smoke-inputs.json"), "utf8"));
assert.equal(smoke.workflowId, workflow.id);
assert.equal(smoke.vars.expectedHead, config.workspace.baseBranch);
const inputs = validateWorkflowInputs(workflow, smoke.vars);
assert.deepEqual(inputs.validation.errors, []);
assert.equal(inputs.validation.ok, true);
const mismatchedInputs = validateWorkflowInputs(workflow, { ...smoke.vars, expectedHead: "0".repeat(40) });
assert.equal(mismatchedInputs.validation.ok, false);

const rendered = renderTemplate(prompt, {
  workspace: {
    cwd: "/tmp/synthetic-owned-root",
    branch: "orca/roots/synthetic-run",
    rootProvisioning: { baseCommit: config.workspace.baseBranch },
  },
  vars: inputs.vars,
});
assert.ok(rendered.includes("/tmp/synthetic-owned-root"));
assert.ok(rendered.includes("orca/roots/synthetic-run"));
assert.ok(rendered.includes(config.workspace.baseBranch));
assert.ok(!rendered.includes("{{workspace."));
assert.ok(!rendered.includes("{{vars."));

console.log(
  `PASS: inactive config, workflow v3 graph, pinned base/expectedHead, smoke inputs, and synthetic prompt render (${config.workspace.baseBranch})`,
);
