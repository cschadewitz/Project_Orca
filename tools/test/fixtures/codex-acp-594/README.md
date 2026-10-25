# Pinned upstream loss witness

`CommandUtils.ts.txt` is an unmodified 300-byte source file from
[codex-acp 2.2.2, commit 202e66e63343ec4f5a5e35ab590251d813d129ca](https://github.com/agentclientprotocol/codex-acp/blob/202e66e63343ec4f5a5e35ab590251d813d129ca/src/CommandUtils.ts).
It is distributed under the adjacent upstream Apache 2.0 license notice
(Copyright 2025 JetBrains s.r.o.). SHA256:
`ca8042763f4bb36a2cbf9641beb647fed95338a4f4f827ddecaeb143b2628890`.
The same bytes were recorded for 2.1.1 in the historical #506 disposition.

The test verifies the source digest before removing TypeScript annotations and
importing this pure string helper in memory. The .txt suffix preserves upstream
formatting. Only this reviewed function is executed; test command strings are
data and are never passed to a shell, provider, or command runner. No network
request or installed-provider discovery happens during the test.

This witnesses irreversible presentation loss. It does not implement evidence
validation, authenticate a native request, or prove installed/actual-Cal delivery.
See the [decision proposal](../../../../docs/implementation/594-provider-evidence-contract.md).
