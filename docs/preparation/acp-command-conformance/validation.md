# Validation and review record

Prepared 2026-10-07 from `794e64344e3d6edb64e80c5920f722ff381fa4a5`.
The draft PR supplies the exact published preparation SHA and final readback.
Only new files listed in [README](README.md) are owned. No production or existing
test/configuration/schema files changed. The JSON schema here is a preparation
evidence format, not a runtime protocol schema.

## Results

| Check | Result |
| --- | --- |
| New fixture, Node 22.23.2 | 31 passed, no skipped cases |
| New fixture, Node 24.21.0 | 31 passed, no skipped cases |
| Five selected in-memory suites, Node 22.23.2 | 98 passed: new fixture 31, engine live input 30, engine observation 19, operator reads 16, authority monitor 2 |
| Root and renderer typecheck | Passed |
| Full ESLint and CSS token lint | Passed; changed fixture checked again after final edits |
| Repository Prettier check | Passed; final fixture/schema formatting also checked |
| Design generated-file check | Passed |
| TypeScript project-reference build and Vite renderer build | Passed. Existing renderer large-chunk advisory remains |
| Evidence v1 schema/example/regression samples | Draft 2020-12 schema valid; example accepted; 9 valid and 15 invalid samples behave as expected, including unexpected effects, native execution without ACP, unknown callback delivery, false passes and raw-data restrictions |
| Scope, diff whitespace and relative documentation links | Checked; owned files only |

## Exact check commands

The default shell has no Node/pnpm on PATH. Existing Node 22.23.2 and 24.21.0
executables were used directly, with available dependency binaries from a
checkout with an identical `pnpm-lock.yaml`. Local workspace-package links point
back to this checkout; external dependencies are reused read-only. No dependency
installation completed, and no lockfile changed. Set `ORCA506_NODE` to the already
available executable for the indicated version; the commands' tool entries and
arguments below are the ones exercised. No absolute host/tool installation paths
or raw Vitest JSON reports are published.

```sh
"$ORCA506_NODE" node_modules/vitest/vitest.mjs run \
  packages/agents/test/acp-command-conformance-506.test.ts \
  packages/engine/test/live-input.test.ts \
  packages/daemon/test/mcp-operator-reads.test.ts \
  packages/daemon/test/live-input-authority.test.ts \
  packages/engine/test/live-input-observation.test.ts --maxWorkers=2

# Run the new fixture alone on each supported Node version.
"$ORCA506_NODE" node_modules/vitest/vitest.mjs run \
  packages/agents/test/acp-command-conformance-506.test.ts --maxWorkers=1

"$ORCA506_NODE" node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
"$ORCA506_NODE" node_modules/typescript/bin/tsc -p packages/app/renderer/tsconfig.json --noEmit
"$ORCA506_NODE" node_modules/eslint/bin/eslint.js .
"$ORCA506_NODE" tools/eslint-config/bin/check-css-tokens.js packages/app/renderer packages/design/css/components.css
"$ORCA506_NODE" node_modules/prettier/bin/prettier.cjs --check .
"$ORCA506_NODE" packages/design/build-tokens.js --check
"$ORCA506_NODE" node_modules/typescript/bin/tsc -b tsconfig.build.json --force
"$ORCA506_NODE" packages/app/node_modules/vite/bin/vite.js build --config packages/app/vite.config.ts
git diff --check
```

For dependency tools that launch another synthetic Node process, the selected
existing Node bin directory was prepended to PATH. Success reports were retained
privately with `--reporter=default --reporter=json --outputFile.json=<private-temp-file>`;
only counts/status are reported here. They are not installed-provider receipts.

Evidence validation used already available Python `jsonschema`, without install:

```python
import json, re
from pathlib import Path
import jsonschema
root = Path("docs/preparation/acp-command-conformance")
schema = json.loads((root / "evidence-v1.schema.json").read_text())
jsonschema.Draft202012Validator.check_schema(schema)
example = json.loads(re.search(r"```json\n(.*?)\n```", (root / "evidence-format.md").read_text(), re.S).group(1))
validator = jsonschema.Draft202012Validator(schema)
validator.validate(example)
samples = json.loads((root / "evidence-v1.samples.json").read_text())
for sample in samples["samples"]:
    record = {**samples["base"], **sample["patch"]}
    assert validator.is_valid(record) == sample["valid"], sample["name"]
```

## Blocked / not run

- An additional combined run included unchanged
  `packages/agents/test/live-input-session.test.ts`: 97 passed and 10 failed.
  All 10 subprocess cases failed ACP handshake because their synthetic child
  launches were refused in this sandbox. A bounded diagnostic of that existing
  synthetic peer returned `EPERM`, empty stdout/stderr. No provider was launched,
  and no policy escalation or workaround was used. The final in-memory-only lane
  has one further scope-evidence case and passes 98/98.
- Full repository test/coverage, opt-in production MCP/CLI retry lanes and
  Electron smoke were **not run**: they include subprocess/listener requirements
  unavailable in the current sandbox. No claim of full CI or installed acceptance.
  Published CI results must be evaluated separately on the exact PR head.
- Pinned native parameter/emission/response sources were retrieved during review
  follow-up; installed-artifact correspondence and managed routing remain
  unverified in [source-map](source-map.md). Installed provider/model, live
  daemon/tunnel decisions and actual Cal acceptance were **not run**.
- Early `pnpm exec` attempted automatic dependency synchronization and hit a
  read-only shim write; it was stopped, with no completed install. Direct tool
  entries avoid that synchronization. Early borrowed workspace links caused
  unrelated lint/build resolution errors; local workspace links corrected them
  without changing repository code or dependencies. These setup failures are
  separate from the final successful checks.

## Review

Self-review checked: reserved-file scope; exact source pins; absence of provider
imports, subprocesses, listeners and host effects in the new peer; original lease
and identity use; no standing writer; explicit projection/payload blockers;
credential-free authority injection; bounded schema; disabled live handoff; and
separation of synthetic/source evidence from deployed/actual-Cal proof.
This is not an independent security review. The preparation PR remains a draft,
with `release:none` / `no-changelog` appropriate to test/documentation-only work.
No production fixes, release, merge or deployment are included.

## Cal review follow-up

[Cal's review](https://github.com/cschadewitz/Project_Orca/pull/507#issuecomment-6030356050)
of `3d0920551429ed8f682003570b2c3231fd57748e` identified an evidence-format
blocker: observed execution wrongly required approval and callback delivery even
for failures. The updated contract separates approval path and expected effect
from observations. Unexpected execution remains reportable without fabricated
authorization/delivery; contradictory pass claims are rejected. The committed
sample manifest adds 24 illustrative regression records, not execution receipts.
The source map now reviews the four pinned native sources identified by Cal,
including the callback submission tail. Installed correspondence, actual managed
routing and actual-Cal acceptance remain unverified and unexecuted.

Follow-up changes stay in this preparation directory; production, configuration
and the synthetic callback fixture are unchanged. The check table above records
the rerun on the follow-up tree. Full-suite/live-lane limits above still apply.
