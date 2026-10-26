# Preparation validation

Validated on 26 October 2026 against baseline
`32f92cc16b9faf1748059e930c3f77b3934151ae`, using Node 24.19.0,
Vitest 5.0.2 and pre-existing cached dependencies. No dependency install,
manifest or lockfile change was performed. No `.agents/skills` directory was
present in this checkout or `/workspace`; the repository AGENTS.md and relevant
development, architecture, research and #594 preparation documents were read.

## Existing regression rerun

```sh
node node_modules/vitest/vitest.mjs run \
  packages/agents/test/command-evidence-v1-594.test.ts \
  tools/test/acp-command-evidence-source.test.js \
  packages/agents/test/acp-command-conformance-506.test.ts \
  packages/engine/test/live-input.test.ts \
  packages/daemon/test/live-input-authority.test.ts \
  packages/agents/test/permission-sidecar-session.test.ts --maxWorkers=1
```

Result: **139 passed, six files, zero skips**, exit 0. These rerun existing
source/synthetic assertions. They do not execute the new symbolic corpus or
prove native cached-action enforcement. The broader #328/#331 inventory in the
README was inspected, not all rerun here.

## Data and document checks

Python jsonschema 4.26.0 Draft202012Validator accepted corpus.schema.json and
all 52 scenarios in corpus.v1.json. Separate checks verified unique case IDs.
Five invalid mutations were rejected: status `passed`, invented observed-effect
field, integration `active`, empty checks and unknown `universal` family. These
are preparation-format checks, not runtime security proof.

Reproduce schema/negative checks with the existing Python jsonschema module:

```python
import copy, json
from pathlib import Path
from jsonschema import Draft202012Validator
p = Path("docs/preparation/enforcement-conformance")
s = json.loads((p / "corpus.schema.json").read_text())
d = json.loads((p / "corpus.v1.json").read_text())
Draft202012Validator.check_schema(s)
v = Draft202012Validator(s)
v.validate(d)
assert len({c["id"] for c in d["cases"]}) == len(d["cases"])
for patch in ({"status": "passed"}, {"observedEffect": True},
              {"checks": []}, {"family": "universal"}):
    bad = copy.deepcopy(d)
    bad["cases"][0].update(patch)
    assert list(v.iter_errors(bad))
bad = copy.deepcopy(d)
bad["integration"] = "active"
assert list(v.iter_errors(bad))
```

UTF-8, LF, final newline, trailing whitespace, balanced fences, relative-file
links and `git diff --check` passed. No full suite, coverage, build, platform,
installed-provider, actual-Cal, C6b, privacy authorization or live effect proof
was run. No provider hook, runtime interface, policy default, credential,
activation, service or deployment changed. Executable adapter integration is
pending the parent-agreed #700 interface; all new cases remain `not-run`.
