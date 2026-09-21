/**
 * The two configuration documents the fake bridge serves (#174, #266): a small
 * `orca.config.yaml` with comments in it, and the ADR 0009 sidecar beside it holding one
 * machine-written grant for the same agent.
 *
 * The comment in the YAML is load-bearing for anything testing a `patch` write: the whole
 * reason `config.set` edits a `yaml` Document rather than re-serialising the parsed config
 * is that a comment must survive the round trip, and a fixture with no comments could not
 * catch a fake that forgot.
 *
 * `schema` is written out by hand here rather than derived. The real one is walked off
 * `OrcaConfigSchema` by the daemon, which the app may not import (ADR 0008); this is a
 * plausible subset, enough for a form test to have fields to draw.
 */
import type { ConfigGetResult } from "@orca/protocol";
import { AS_OF } from "./fixtures.js";

export const CONFIG_TEXT = `version: 1
storeDir: .orca

# The agent that does the work. Keep this comment: a patch write must not eat it.
agents:
  - id: claude
    command: claude-code
    roles: [developer]
`;

export const PERMISSIONS_TEXT = `{
  "version": 1,
  "agents": {
    "claude": {
      "rules": [
        {
          "match": { "kind": "edit", "pathPrefix": "src" },
          "decision": "allow",
          "addedAt": "2026-09-20T10:00:00.000Z",
          "grantedFor": "Edit src/index.ts"
        }
      ]
    }
  }
}
`;

/** Content hashes stand in for real ones; a client only ever compares them for equality. */
export const CONFIG_REVISION = "fixture-config-revision";
export const PERMISSIONS_REVISION = "fixture-permissions-revision";

export const CONFIG_GET: ConfigGetResult = {
  config: {
    document: "config",
    path: "/workspace/orca.config.yaml",
    exists: true,
    revision: CONFIG_REVISION,
    text: CONFIG_TEXT,
    parsed: {
      version: 1,
      storeDir: ".orca",
      agents: [{ id: "claude", command: "claude-code", roles: ["developer"] }],
    },
  },
  permissions: {
    document: "permissions",
    path: "/workspace/orca.permissions.json",
    exists: true,
    revision: PERMISSIONS_REVISION,
    text: PERMISSIONS_TEXT,
    parsed: {
      version: 1,
      agents: {
        claude: {
          rules: [
            {
              match: { kind: "edit", pathPrefix: "src" },
              decision: "allow",
              addedAt: "2026-09-20T10:00:00.000Z",
              grantedFor: "Edit src/index.ts",
            },
          ],
        },
      },
    },
  },
  schema: [
    { path: "version", type: "number", required: false, default: 1 },
    { path: "storeDir", type: "string", required: false, default: ".orca" },
    { path: "agents", type: "array", required: false, default: [] },
    { path: "agents[]", type: "object", required: false },
    { path: "agents[].id", type: "string", required: true },
    { path: "agents[].command", type: "string", required: true },
    { path: "agents[].roles", type: "array", required: false, default: [] },
    { path: "humanInput", type: "object", required: false },
    { path: "humanInput.mode", type: "enum", enum: ["pause", "cli", "auto"], required: true },
  ],
  effective: {
    agents: {
      // The sidecar's rule sits *after* the configured one, which is the evaluation order
      // `layerPermissionPolicies` produces and the only thing #175 is allowed to render.
      claude: {
        default: "allow",
        rules: [
          { match: { kind: "execute", titlePattern: "^npm test$" }, decision: "allow", source: "config" },
          {
            match: { kind: "edit", pathPrefix: "src" },
            decision: "allow",
            source: "permissions",
            addedAt: "2026-09-20T10:00:00.000Z",
            grantedFor: "Edit src/index.ts",
          },
        ],
      },
    },
  },
  asOf: AS_OF,
};
