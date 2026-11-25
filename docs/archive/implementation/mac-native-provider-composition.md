# Held native production bindings

This substantive delta is based on privacy head
`dccde5ddd8a0539827a194ccdd882c718745c9ce`. The final published commit/tree is
recorded in #584 metadata. It composes provider-independent production source;
the approved private catalog/invitation service, native policy selection and installed
manifest pin remain owner inputs. Main supplies no authority and its separate activation
gate stays false. Diagnostics remain disabled. No native execution or installation occurred.

## Concrete bindings and limits

`mac-native-providers.ts` binds the existing #583 Python validator to a closed JSON
interface. Both delivery containers retain the original signature, publisher/certificate,
code inventory, notarization, containment, sealed identity and actual daemon checks.
Fixed-path saved bundles use that same image verifier, with logical `ORCA.app` inventory
names; no bundle is renamed or launched to verify it. The actual builder copies all five
existing/new helper files with their relative import layout intact.

The native executor reuses an already installed Command Line Tools Python at its fixed
path. Missing tooling refuses; the system Python installer shim is never invoked.
Actual Darwin arm64 execution and native tooling availability remain device acceptance.
Native tools retain #583's bounded command/output/cleanup behavior. Cancellation joins
the helper's cleanup before the download is removed and discards any late positive result;
cleanup may outlive the approval operation deadline. Failed detach retains private evidence.

Continuity reads the existing admission-intent journal through its established validation
and decryption path. It unwraps existing diagnostic control/session envelopes through the
unchanged Mac safeStorage adapter, rejects re-encryption requests and incomplete wrappers,
and reads camera/microphone/screen and accessibility grants without requesting permission.
Only digests reach the fixed-pair owner. No Keychain/TCC export, fresh wrapping, journal
write, key regeneration, prompt, migration or reset is part of this read. This compares
the supported ORCA observations; it does not claim to inventory all system permission state.

Closed startup reuses `startBundledDaemon` with one captured child, `--read-only`,
`--no-resume` and the existing one-use kernel capability. Ordinary children strip inherited
update permits; closed children do not inherit ordinary enrollment authority. A startup
timeout never retries a port or force-kills that child. Main requires authenticated hello
without refresh/fallback and matches its PID/instance/store against metadata emitted by the
captured child, not metadata copied from the HTTP peer. One requested clean stop sends one
SIGTERM; an uncertain stop remains uncertain after late exit and never escalates.

The CLI emits its independent instance, fence and store observation while its existing
closed bootstrap leases remain held. The source-supported file-reader compatibility
identifier is `orca-file-stores-v1`; it is not read from the candidate manifest. An approved
image must independently declare the matching supported identifier. This is a narrow
empty-work startup binding, not a migration or plugin/continuation restoration promise.
Any retained run, request admission or retry history is conservatively parked. A pending,
orphaned, corrupt or inconsistent retry journal stays parked/unsupported. The observer
never repairs publications, advances a retry cursor, adopts old execution or reopens admission.
Custom external store layouts remain unavailable through the current managed owner contract.

## Focused source evidence

Installed Node 24.19.0, Vitest 5.0.2 and TypeScript 7.0.2 were used.

- The first provider selection passed 137 cases across eight files; the actual main
  integration file passed 25 separately. Two additional refusal cases then passed with
  their affected files (17 native-provider and 12 retry-store cases). There are 164 distinct
  passing cases across nine files, including 28 new cases. Repeats are not added.
- The existing Python candidate file passes 15 tests, including two new saved-image/runtime
  cases. Controlled native ports are synthetic evidence, not signed Mac acceptance.
- Root TypeScript, scoped lint/formatting and whitespace checks pass. No broad suite,
  coverage run, dependency install, workflow edit or CI dispatch was performed.
- Reuse the earlier 69 selected cases and pinned constituent map only for unchanged
  interfaces. The 123 composition cases at `88fc825` are prior evidence; they did not all
  rerun on this delta. The 18 privacy cases at `dccde5d` remain separately pinned evidence.

Self-review covered independent policy pins, actual image proof parsing, saved-root
containment, cancellation/cleanup settlement, absence of prompts/fresh keys, captured
process identity, one-use launch/stop behavior and conservative read-only store observation.
The main publication/CI/merge hold remains in effect; no milestone/native gate is closed.
