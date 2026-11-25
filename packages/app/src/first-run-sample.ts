/** Immutable JEV-free first-run sample and #420 task/instruction/result bindings. No provider is configured. */
// rename-keep-start: the sample's id and bytes stay as first-run setup wrote them into existing
// workspaces. verifyFirstRunSampleAssets and the guided launch compare those files and their
// revision byte for byte, so a renamed sample would refuse every existing first-run workspace.
export const FIRST_RUN_SAMPLE_ID = "orca-beta-local-check" as const;
export const FIRST_RUN_SAMPLE_VERSION = "1" as const;
export const FIRST_RUN_SAMPLE_REVISION =
  "sha256:31027c78fb1ea553caf218b8366e7ea08d6a141efce5cb53b32e781fd7390567" as const;
export const FIRST_RUN_SAMPLE_TASK =
  "Check this selected local workspace without starting an agent or changing project files." as const;
export const FIRST_RUN_SAMPLE_ASSETS = {
  task: {
    path: "first-run/task.json",
    revision: "sha256:e469b7e51814c23dece7089f39f42df481b5c536d438e904d8079a63f7aff72a",
  },
  instruction: {
    path: "first-run/instruction.md",
    revision: "sha256:fd107d3f97cc68e178f801d1106ac2cae938bb39ca44017c079a1d25c893abfb",
  },
  result: {
    path: "first-run/result.json",
    revision: "sha256:3e87c838fc4a4a1fa510920c413774e70f36db43d77086767a7c877bced2f015",
  },
} as const;
export const FIRST_RUN_SAMPLE_FILES = {
  "first-run/workflow.yaml":
    '{\n  "id": "orca-beta-local-check",\n  "name": "Harmless local sample",\n  "version": "1",\n  "description": "Agent-free local launch check. Coding-fix and real-agent acceptance remain separate.",\n  "vars": {},\n  "inputs": {\n    "task": "The fixed harmless local-check task."\n  },\n  "inputSchema": {\n    "fields": {\n      "task": {\n        "type": "string",\n        "required": true,\n        "enum": [\n          "Check this selected local workspace without starting an agent or changing project files."\n        ]\n      }\n    },\n    "unknown": "reject"\n  },\n  "meta": {\n    "firstRunSample": {\n      "assets": {\n        "task": {\n          "path": "first-run/task.json",\n          "revision": "sha256:e469b7e51814c23dece7089f39f42df481b5c536d438e904d8079a63f7aff72a"\n        },\n        "instruction": {\n          "path": "first-run/instruction.md",\n          "revision": "sha256:fd107d3f97cc68e178f801d1106ac2cae938bb39ca44017c079a1d25c893abfb"\n        },\n        "result": {\n          "path": "first-run/result.json",\n          "revision": "sha256:3e87c838fc4a4a1fa510920c413774e70f36db43d77086767a7c877bced2f015"\n        }\n      },\n      "codingFixture": {\n        "id": "beta-first-job-v1",\n        "assets": {\n          "examples/beta-first-job/template/shipping.js": "sha256:f4397e480bfd679cd29ba53c3723a92adfda184acdfbcf138e8cae6fce8266da",\n          "examples/beta-first-job/template/shipping.test.js": "sha256:afdf5e654d0823a75f71665eab992791efe19c934687237f1f6cd8bce8401ec2",\n          "examples/beta-first-job/template/README.md": "sha256:646080bfb94e94b0fcbdf267411b4a8c6ca2a703b857029ef955749c56936067",\n          "docs/preparation/beta-first-job/reference.patch": "sha256:f917b37c20170a71eff371fa02bd45110f7df1215a820094fef2c0bf48bf42c9"\n        }\n      }\n    }\n  },\n  "start": "start",\n  "nodes": {\n    "start": {\n      "type": "start"\n    },\n    "record": {\n      "type": "set",\n      "vars": {\n        "sampleResult": {\n          "kind": "agent-free-local-check",\n          "assets": {\n            "task": {\n              "path": "first-run/task.json",\n              "revision": "sha256:e469b7e51814c23dece7089f39f42df481b5c536d438e904d8079a63f7aff72a"\n            },\n            "instruction": {\n              "path": "first-run/instruction.md",\n              "revision": "sha256:fd107d3f97cc68e178f801d1106ac2cae938bb39ca44017c079a1d25c893abfb"\n            },\n            "result": {\n              "path": "first-run/result.json",\n              "revision": "sha256:3e87c838fc4a4a1fa510920c413774e70f36db43d77086767a7c877bced2f015"\n            }\n          }\n        }\n      }\n    },\n    "end": {\n      "type": "end",\n      "outcome": "success",\n      "message": "Harmless local sample completed. No agent was started and no project files were changed."\n    }\n  },\n  "edges": [\n    {\n      "from": "start",\n      "to": "record"\n    },\n    {\n      "from": "record",\n      "to": "end"\n    }\n  ]\n}\n',
  "first-run/task.json":
    '{\n  "id": "orca-beta-local-check-task",\n  "version": "1",\n  "task": "Check this selected local workspace without starting an agent or changing project files.",\n  "codingFixture": "beta-first-job-v1",\n  "realAgentTask": "Fix the shipping-fee bug in this disposable repository. Shipping costs 499 cents below a subtotal of 5000 cents, and is free at 5000 cents or more. Inputs are nonnegative integer cents. Run `node shipping.test.js` before and after the smallest change to `shipping.js`; leave the tests and README unchanged. Report the diff, both test outputs and exit codes, and whether the work completed. Work only here. Do not install, use network tools, change permissions, commit, push or open a PR. Stop if the selected workspace or runtime is wrong."\n}\n',
  "first-run/instruction.md":
    "# Harmless local sample instructions\n\nRun only the fixed agent-free start, set and end graph through the reviewed guided launch. It records a synthetic result marker in run variables and the terminal step message. It performs no agent session, command execution, checkout edit, permission grant or network tool operation. The bundled daemon stores this run in the separately selected app workspace.\n\nThe beta-first-job-v1 coding task from accepted #420 is a separate step. Its disposable fixture, baseline failure, one-character reference fix, unchanged tests/README/sentinel and five passing checks remain the #420 contract. This local marker is not coding-fix evidence. Real-agent setup requires explicit tool/sign-in, transmission/cost, workspace, permission and stop-limit review; configure it separately in Config. Never auto-launch a provider from this sample.\n",
  "first-run/result.json":
    '{\n  "id": "orca-beta-local-check-result",\n  "version": "1",\n  "kind": "agent-free-local-check",\n  "terminalStatus": "succeeded",\n  "terminalNode": "end",\n  "terminalMessage": "Harmless local sample completed. No agent was started and no project files were changed.",\n  "requiredEvidence": [\n    "actual run ID",\n    "workflow ID/version/revision",\n    "selected workspace and instance identity",\n    "terminal succeeded status"\n  ],\n  "codingFixProven": false,\n  "realAgentProven": false\n}\n',
} as const;
// rename-keep-end
export const FIRST_RUN_SAMPLE = {
  id: FIRST_RUN_SAMPLE_ID,
  version: FIRST_RUN_SAMPLE_VERSION,
  revision: FIRST_RUN_SAMPLE_REVISION,
} as const;
