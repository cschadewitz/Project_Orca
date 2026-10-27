# #705 residual contract fixtures

Offline inputs for [`residual-contracts-705.test.js`](../../../residual-contracts-705.test.js)
and the [residual proposal addendum](../../../../../docs/preparation/provider-enforcement-704-705/residual-contract-proposals-705.md).
Nothing here is a provider distribution, an executable launcher or a capability negotiation.

- `gemini/`, `codex/`, `codex-acp/`: unmodified upstream lines at the revision in
  [`manifest.json`](manifest.json), which records line range, Git blob of the whole upstream file,
  SHA-256 and byte length of each excerpt. Gemini excerpts named in the test run with labelled
  synthetic stubs; Codex (Rust) and codex-acp excerpts are only read as text.
- `pi/pi-bash-cwd-addendum.diff`: an ORCA-authored proposal that applies after the merged
  [`pi-proposal/proposed/pi-bash.diff`](../pi-proposal/proposed/pi-bash.diff). It is not upstream code.
- The merged `gemini-proposal/` and `pi-proposal/` fixtures and `source-pins.json` are used
  read-only and checked against their own manifests; none is modified.

Upstream licences, retained:

- `gemini/*`: Google / Gemini CLI, Apache-2.0, `licenses/license-gemini-cli.txt`.
- `codex/*`: OpenAI / Codex, Apache-2.0, `licenses/license-codex.txt`.
- `codex-acp/*`: JetBrains s.r.o. / codex-acp, Apache-2.0, `licenses/license-codex-acp.txt`.
- The Pi addendum proposes a change to Pi (MIT, copyright Mario Zechner); its licence is
  [`../license-pi.txt`](../license-pi.txt).
