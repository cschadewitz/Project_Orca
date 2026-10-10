# Authorized Windows ARM64 cross-build follow-up - 9 October 2026

The parent authorized the exact official Node 24.19.0 ARM64 import library and a
new draft targeting #584's existing integration branch. This follow-up preserves
combined base `6fcd543a368246c2156f86a225072a871c754435`, code fix
`8969932b3d7f198046a76f88a9bec509ab7dec00`, and x64/Electron evidence
`1094f48fcd3acf816b05b2c719fdf2bf2644eab6` without rewriting them. The original
[x64 acceptance snapshot](windows-msvc-envelope-acceptance.md) and its evidence
retain their original pins and limits.

Only `https://nodejs.org/dist/v24.19.0/SHASUMS256.txt` and
`https://nodejs.org/dist/v24.19.0/win-arm64/node.lib` were fetched. The published
checksum and downloaded 2,987,900-byte library agree with SHA-256
`88dea6ff6656445ee22ed8843816d8d90d707c3d05228bd0a3ad56ea30e8a395`.
It was placed only in the owned verified header tree's `arm64/node.lib`; no
installer, SDK, account, OS permission, security or access setting was changed.

One bounded ARM64 MSVC C11/W4/warnings-as-errors compilation passed with the
installed MSVC 19.44.35229.0, toolset 14.44.35207, SDK 10.0.22621.0, node-gyp
12.4.0, Python 3.10.6 and verified Node 24.19.0 headers/imports. The fixed build
helper selected the ARM64 library in its private node-gyp scratch tree, removed
that tree before final staging, and produced the expected ARM64 PE inventory.
The existing manifest verifier passes both staged architectures; x64 stage
bytes and the previously verified exact Electron runtime copy are unchanged.

The five-input source digest for both architectures is
`3b69d61dc07f1366167f8a151c84925a78d5b70bcc74e7835936c1984a26bdd3`.
The unsigned ARM64 [manifest](native-packaging-evidence/windows-msvc-arm64-manifest.json)
pins clock 859,648 bytes, SHA-256
`0c97bd2185c8de52ca0e4af285bfb0eb1b7707250fe9cfb5b7475962ae32aa90`, and
storage 891,392 bytes, SHA-256
`d285aab75d26eda1f85a0397c682bf34323517d636b5449524a7730d425b9761`.
[Provenance](native-packaging-evidence/windows-msvc-arm64-provenance.json)
records the verified official input, compiler/SDK and closed outcomes.

**No ARM64 code was executed on this x64 desktop.** ARM64 runtime, current-user
DPAPI, clock, storage, interruption and exact Electron behavior still require an
already authorized Windows ARM64 host. Cross-compilation closes only the local
ARM64 build prerequisite, not hardware/runtime acceptance.

Remaining substantial non-Mac work is handed off: full packaged ORCA startup,
connection, restart, privacy/traffic and Windows keyboard/accessibility;
independent review; paired execution, native/crypto/renderer-external high-water
and complete 4 ms/8 MiB/32 MiB gates; second authorized Windows user; physical
sleep/hibernate/reboot/expiry/power-loss; and post-native-rename/pre-result crash.
Actual Mac hardware is still needed for Darwin load, Keychain/TCC, continuous
clock, APFS/native supervisor and physical Mac recovery/accessibility. Signing,
provider inputs and release policy remain owner decisions.

The authorized publication target is
`calcifer/m10-m21-m22-same-boot-config-integration`, the head branch of draft #584
at the checked exact base, rather than main or obsolete #585. No manual CI run,
merge, signing/release/deployment or further substantial acceptance is performed.
The published PR and its exact head are read back separately after creation.
