# Pi final-action proposal fixtures for #705

Offline data for the [Pi patch proposal](../../../../../docs/preparation/provider-enforcement-704-705/pi-patch-proposal.md)
and its [regression test](../../../pi-final-authorization-705.test.js). Nothing here
is submitted upstream, installed, launched or negotiated with a real provider.

## Verbatim upstream bytes

`upstream/*.ts.txt` are whole, unmodified files; the `.txt` suffix keeps them out of
every build, typecheck and lint pass. [manifest.json](manifest.json) records each
file's repository, revision, path, Git blob SHA, SHA-256 and byte length, and the
test recomputes all three digests before using a byte of it.

| File | Upstream | Licence |
| --- | --- | --- |
| `upstream/pi-bash.ts.txt` | `earendil-works/pi` `4a080252f06caf63a525d7873c5d94d3c23887e0` `packages/coding-agent/src/core/tools/bash.ts` | MIT, Mario Zechner, `license-pi.txt` |
| `upstream/pi-rpc-mode.ts.txt` | same revision, `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | MIT, `license-pi.txt` |
| `upstream/pi-acp-session.ts.txt` | `svkozak/pi-acp` `b0581c9c1d675e634234674484247008b03d69b4` `src/acp/session.ts` | MIT, Sergii Kozak, `license-pi-acp.txt` |
| `upstream/pi-acp-process.ts.txt` | same revision, `src/pi-rpc/process.ts` | MIT, `license-pi-acp.txt` |

The two licence files are the upstream `LICENSE` bytes at those revisions (the Pi
file has no final newline upstream; the sibling #713 copy adds one). Pi 1.4.0 and
pi-acp 0.0.34 are research pins only. Which Pi binary an external pi-acp launch
actually selects is unknown; no guarantee from another fork is assumed.

## Proposed diffs

`proposed/*.diff` are ORCA-authored proposals against those exact blobs, written
with `git diff --full-index` so each `index` line names the pinned pre-image and
the expected post-image blob. They are not upstream code and carry no upstream
review.

| Diff | Evidence in this repository |
| --- | --- |
| `pi-bash.diff` | Strictly applied to the pinned bytes in the test, post-image blob checked, and the whole patched module executed with stubbed imports |
| `pi-rpc-mode.diff` | Strictly applied; the pinned one-shot dialog channel plus the proposed parser, request builder, binding and negotiation executed |
| `pi-acp-session.diff` | Strictly applied; the pinned generic UI handlers and the proposed typed handler executed against synthetic connections |
| `pi-acp-process.diff` | Applies to the pinned blob (checked in this session with `git apply --check`); type-only plus one request method, not executed |
| `pi-agent-session.diff` | Pre-image blob equals the #713 `pi-dispatch` record; applies in this session; the 164 KB file is not vendored, so the test checks only its header |

No patched file was type-checked against Pi or pi-acp dependencies; all five
parse with Node's TypeScript stripper. Test scaffolding replaces imports with
in-memory stubs: `spawn` only records its arguments, so no command string reaches a
shell, process, network or provider.
