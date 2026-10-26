# Pinned provider source excerpts for #704/#705

Only the Claude decoder and Pi emit/spawn/resolve functions are imported by the
[pure-source tests](../../provider-enforcement-source-704-705.test.js). Other
excerpts support source review and non-executing vectors. None is a provider
distribution or executable launcher. Tests use synthetic parsing/effect/context
dependencies and a synthetic environment; there are no imports from providers.

Original source locations, revisions, line ranges, Git blob identities and exact
excerpt SHA256/byte lengths live in the
[source record](../../../../docs/preparation/provider-enforcement-704-705/source-pins.json).
Excerpts retain original text. Scaffolding in the test is ORCA test code, distinct
from the copied lines. Source and upstream tests do not establish installed
behavior; the Rust and Gemini excerpts are not executed by this test.

Upstream licenses retained beside the excerpts:

- `claude-*`: Zed Industries / claude-agent-acp, Apache-2.0, `license-claude.txt`.
- `codex-*`: OpenAI / Codex, Apache-2.0, `license-codex.txt`.
- `gemini-*`: Google / Gemini CLI, Apache-2.0, `license-gemini.txt`.
- `pi-dispatch`, `pi-emit`, `pi-spawn`, `pi-resolve`: Pi, MIT, `license-pi.txt`.
- `pi-ui`: svkozak/pi-acp, MIT, `license-pi-acp.txt`.
